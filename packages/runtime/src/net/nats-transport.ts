/**
 * NATS transports for the message bus.
 *
 * - `createNatsHubTransport`: desktop (hub) side. Subscribes to client→hub
 *   events and RPC; publishes hub→client events; replies to RPC via the request
 *   message. Add it to the main BusRouter alongside the IPC transport.
 * - `createNatsClientTransport`: phone/CLI (leaf) side. Subscribes hub→client
 *   events; publishes client→hub events; issues RPC via NATS request/reply.
 *
 * Live use needs a reachable NATS server (see docs/nats-deploy.md). The subject
 * mapping is unit-tested with a mock connection.
 */

import { JSONCodec, type NatsConnection, type Msg } from "nats";

import type { BusTransport, Envelope } from "@desktop-proxy/plugin-sdk";

import {
  eventSubjectIn,
  eventSubjectOut,
  rpcSubject,
  hubSubscriptions,
  clientSubscriptions,
  topicFromSubject,
  methodFromSubject,
} from "./remote-subjects.js";

type Logger = (level: string, ...args: unknown[]) => void;

let idc = 0;
function newId(): string {
  idc = (idc + 1) % Number.MAX_SAFE_INTEGER;
  return `n${idc.toString(36)}-${Date.now().toString(36)}`;
}

const jc = JSONCodec<unknown>();

/** Desktop (hub) side transport. */
export function createNatsHubTransport(nc: NatsConnection, instanceId: string, log: Logger): BusTransport {
  let receiver: ((env: Envelope, source: string) => void) | undefined;
  const replies = new Map<string, Msg>();
  const subs = hubSubscriptions(instanceId);

  void (async () => {
    const sub = nc.subscribe(subs.events);
    for await (const m of sub) {
      try {
        const topic = topicFromSubject(m.subject);
        if (!topic) continue;
        const payload = (m.data.length ? jc.decode(m.data) : {}) as { data?: unknown; src?: string };
        receiver?.({ kind: "event", topic, data: payload?.data, src: payload?.src }, "");
      } catch (e) {
        log("warn", "nats hub: event decode failed:", String(e));
      }
    }
  })();

  void (async () => {
    const sub = nc.subscribe(subs.rpc);
    for await (const m of sub) {
      try {
        const method = methodFromSubject(m.subject);
        if (!method) continue;
        const params = m.data.length ? jc.decode(m.data) : undefined;
        const id = newId();
        replies.set(id, m);
        receiver?.({ kind: "req", id, method, params }, "");
      } catch (e) {
        log("warn", "nats hub: rpc decode failed:", String(e));
      }
    }
  })();

  return {
    send: (env) => {
      try {
        if (env.kind === "event") {
          nc.publish(eventSubjectOut(instanceId, env.topic), jc.encode({ data: env.data, src: env.src }));
        } else if (env.kind === "res") {
          const m = replies.get(env.id);
          if (m) {
            m.respond(jc.encode(env));
            replies.delete(env.id);
          }
        }
        // hub→device RPC (approvals) is added in a later phase.
      } catch (e) {
        log("warn", "nats hub: send failed:", String(e));
      }
    },
    setReceiver: (fn) => {
      receiver = fn;
    },
  };
}

/** Phone/CLI (leaf) side transport. */
export function createNatsClientTransport(
  nc: NatsConnection,
  instanceId: string,
  log: Logger,
  requestTimeoutMs = 15000,
): BusTransport {
  let receiver: ((env: Envelope, source: string) => void) | undefined;
  const subs = clientSubscriptions(instanceId);

  void (async () => {
    const sub = nc.subscribe(subs.events);
    for await (const m of sub) {
      try {
        const topic = topicFromSubject(m.subject);
        if (!topic) continue;
        const payload = (m.data.length ? jc.decode(m.data) : {}) as { data?: unknown; src?: string };
        receiver?.({ kind: "event", topic, data: payload?.data, src: payload?.src }, "");
      } catch (e) {
        log("warn", "nats client: event decode failed:", String(e));
      }
    }
  })();

  return {
    send: (env) => {
      try {
        if (env.kind === "event") {
          nc.publish(eventSubjectIn(instanceId, env.topic), jc.encode({ data: env.data, src: env.src }));
          return;
        }
        if (env.kind === "req") {
          nc.request(rpcSubject(instanceId, env.method), jc.encode(env.params), { timeout: requestTimeoutMs }).then(
            (m) => {
              const res = (m.data.length ? jc.decode(m.data) : {}) as Partial<Envelope>;
              receiver?.({ kind: "res", id: env.id, ok: (res as { ok?: boolean }).ok ?? true, result: (res as { result?: unknown }).result, error: (res as { error?: string }).error }, "");
            },
            (err: unknown) => receiver?.({ kind: "res", id: env.id, ok: false, error: String(err) }, ""),
          );
        }
        // res from a client is not expected (clients don't host RPC yet).
      } catch (e) {
        log("warn", "nats client: send failed:", String(e));
      }
    },
    setReceiver: (fn) => {
      receiver = fn;
    },
  };
}
