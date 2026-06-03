/**
 * Bus client (pure) — RPC request/reply + event subscription over NATS subjects,
 * matching the desktop hub. Transport-agnostic: you inject a `publish` function
 * (wired to the WebSocket via buildPub) and feed it incoming MSG payloads.
 *
 * RPC: PUB dp.<id>.rpc.<method> reply=_INBOX.<cid>.<rid> → the hub replies on the
 * inbox with a `{kind:"res", ok, result|error}` envelope. Events arrive on
 * dp.<id>.h2c.event.<topic> as `{data, src}`.
 */

import { rpcSubject, clientEventSubscription, topicFromSubject } from "./subjects.js";

// Timers exist on every target (Node, browser, RN, UTS); declared here since the
// portable lib config doesn't pull DOM/Node globals.
declare function setTimeout(handler: () => void, ms: number): number;
declare function clearTimeout(id: number): void;

export type PublishFn = (subject: string, reply: string | undefined, payload: string) => void;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: number | null;
}

export interface BusClientOptions {
  timeoutMs?: number;
  /** Override the time source / id seq for deterministic tests. */
  now?: () => number;
}

export class BusClient {
  private seq = 0;
  private pending = new Map<string, Pending>();
  private subs = new Map<string, Set<(data: unknown) => void>>();
  private readonly timeoutMs: number;

  constructor(
    private readonly instanceId: string,
    private readonly clientId: string,
    private readonly publish: PublishFn,
    opts: BusClientOptions = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? 15000;
  }

  /** Subject to SUB for hub→client events. */
  eventSubscription(): string {
    return clientEventSubscription(this.instanceId);
  }
  /** Wildcard inbox to SUB for RPC replies. */
  inboxSubscription(): string {
    return `${this.inboxPrefix()}>`;
  }
  private inboxPrefix(): string {
    return `_INBOX.${this.clientId}.`;
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const rid = `${++this.seq}`;
    const inbox = this.inboxPrefix() + rid;
    return new Promise<T>((resolve, reject) => {
      const timer =
        this.timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(rid);
              reject(new Error(`request "${method}" timed out`));
            }, this.timeoutMs)
          : null;
      this.pending.set(rid, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        this.publish(rpcSubject(this.instanceId, method), inbox, JSON.stringify(params ?? null));
      } catch (e) {
        this.pending.delete(rid);
        if (timer) clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  subscribe(topic: string, handler: (data: unknown) => void): () => void {
    let set = this.subs.get(topic);
    if (!set) {
      set = new Set();
      this.subs.set(topic, set);
    }
    set.add(handler);
    return () => {
      this.subs.get(topic)?.delete(handler);
    };
  }

  /** Feed a received NATS MSG (subject + decoded UTF-8 payload). */
  handleMessage(subject: string, payload: string): void {
    if (subject.startsWith(this.inboxPrefix())) {
      const rid = subject.slice(this.inboxPrefix().length);
      const p = this.pending.get(rid);
      if (!p) return;
      this.pending.delete(rid);
      if (p.timer) clearTimeout(p.timer);
      try {
        const env = JSON.parse(payload) as { ok?: boolean; result?: unknown; error?: string };
        if (env.ok === false) p.reject(new Error(env.error ?? "request failed"));
        else p.resolve(env.result);
      } catch (e) {
        p.reject(e instanceof Error ? e : new Error(String(e)));
      }
      return;
    }
    const topic = topicFromSubject(subject);
    if (topic == null) return;
    const set = this.subs.get(topic);
    if (!set || set.size === 0) return;
    let data: unknown;
    try {
      const env = JSON.parse(payload) as { data?: unknown };
      data = env.data;
    } catch {
      return;
    }
    for (const fn of [...set]) {
      try {
        fn(data);
      } catch {
        /* handler error must not break dispatch */
      }
    }
  }

  /** Fail all in-flight requests (e.g. on disconnect). */
  rejectAll(reason: string): void {
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }
}
