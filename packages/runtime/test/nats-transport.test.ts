import { describe, it, expect } from "vitest";
import { JSONCodec } from "nats";

import { createNatsHubTransport } from "../src/net/nats-transport";
import type { Envelope } from "@desktop-proxy/plugin-sdk";

const jc = JSONCodec<unknown>();
const tick = () => new Promise((r) => setTimeout(r, 0));

/** A minimal pushable async-iterable subscription. */
function channel() {
  const q: unknown[] = [];
  const waiters: Array<(v: unknown) => void> = [];
  return {
    push: (v: unknown) => {
      const w = waiters.shift();
      if (w) w(v);
      else q.push(v);
    },
    [Symbol.asyncIterator]() {
      return {
        next: () =>
          q.length
            ? Promise.resolve({ value: q.shift(), done: false })
            : new Promise<{ value: unknown; done: boolean }>((res) => waiters.push((v) => res({ value: v, done: false }))),
      };
    },
  };
}

function mockNats() {
  const chans = new Map<string, ReturnType<typeof channel>>();
  const published: Array<{ subject: string; data: Uint8Array }> = [];
  const nc = {
    subscribe: (subject: string) => {
      const c = channel();
      chans.set(subject, c);
      return c;
    },
    publish: (subject: string, data: Uint8Array) => published.push({ subject, data }),
  };
  return { nc, chans, published };
}

describe("createNatsHubTransport", () => {
  it("maps an inbound client event to an event envelope", async () => {
    const { nc, chans } = mockNats();
    const seen: Envelope[] = [];
    const t = createNatsHubTransport(nc as never, "i1", () => {});
    t.setReceiver((env) => seen.push(env));

    chans.get("dp.i1.c2h.event.>")!.push({
      subject: "dp.i1.c2h.event.hello",
      data: jc.encode({ data: { n: 1 }, src: "devA" }),
    });
    await tick();
    expect(seen).toEqual([{ kind: "event", topic: "hello", data: { n: 1 }, src: "devA" }]);
  });

  it("turns an inbound RPC into a req and replies via the message", async () => {
    const { nc, chans } = mockNats();
    let captured: Envelope | null = null;
    let responded: unknown = null;
    const t = createNatsHubTransport(nc as never, "i1", () => {});
    t.setReceiver((env) => {
      captured = env;
    });

    chans.get("dp.i1.rpc.>")!.push({
      subject: "dp.i1.rpc.traffic.list",
      data: jc.encode({ q: "category:ai" }),
      respond: (data: Uint8Array) => {
        responded = jc.decode(data);
      },
    });
    await tick();
    expect(captured).toMatchObject({ kind: "req", method: "traffic.list", params: { q: "category:ai" } });

    const id = (captured as unknown as { id: string }).id;
    t.send({ kind: "res", id, ok: true, result: { count: 3 } });
    expect(responded).toMatchObject({ kind: "res", ok: true, result: { count: 3 } });
  });

  it("publishes hub→client events on the h2c subject", () => {
    const { nc, published } = mockNats();
    const t = createNatsHubTransport(nc as never, "i1", () => {});
    t.send({ kind: "event", topic: "config:changed", data: { logLevel: "info" } });
    expect(published).toHaveLength(1);
    expect(published[0].subject).toBe("dp.i1.h2c.event.config:changed");
    expect(jc.decode(published[0].data)).toMatchObject({ data: { logLevel: "info" } });
  });
});
