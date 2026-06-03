import { describe, it, expect } from "vitest";

import { createBusRouter, type BusTransport, type Envelope } from "@desktop-proxy/plugin-sdk";

/** A pair of in-memory transports wired to each other (a two-party link). */
function link(): [BusTransport, BusTransport] {
  const rx: Array<((e: Envelope, s: string) => void) | undefined> = [undefined, undefined];
  const mk = (self: number, other: number): BusTransport => ({
    send: (env) => rx[other]?.(env, ""),
    setReceiver: (fn) => {
      rx[self] = fn;
    },
  });
  return [mk(0, 1), mk(1, 0)];
}

/** A multi-peer hub transport (models the main IPC transport with N renderers). */
function makeHub() {
  const peers = new Map<string, (e: Envelope) => void>();
  let hubRx: ((e: Envelope, s: string) => void) | undefined;
  let n = 0;
  const hubTransport: BusTransport = {
    send: (env, target) => {
      if (target != null) {
        peers.get(String(target))?.(env);
        return;
      }
      for (const [id, rx] of peers) {
        if (env.src != null && String(env.src) === id) continue; // exclude origin peer
        rx(env);
      }
    },
    setReceiver: (fn) => {
      hubRx = fn;
    },
  };
  function addLeaf(): BusTransport {
    const peerId = `p${++n}`;
    let leafRx: ((e: Envelope, s: string) => void) | undefined;
    peers.set(peerId, (env) => leafRx?.(env, ""));
    return {
      send: (env) => hubRx?.({ ...env, src: peerId }, ""), // tag the origin peer
      setReceiver: (fn) => {
        leafRx = fn;
      },
    };
  }
  return { hubTransport, addLeaf };
}

describe("BusRouter", () => {
  it("resolves a local RPC handler without a transport", async () => {
    const r = createBusRouter();
    r.handle("add", (p) => {
      const { a, b } = p as { a: number; b: number };
      return a + b;
    });
    expect(await r.request<number>("add", { a: 2, b: 3 })).toBe(5);
  });

  it("routes RPC across a transport (request → handler → response)", async () => {
    const a = createBusRouter();
    const b = createBusRouter();
    const [ta, tb] = link();
    a.addTransport("wire", ta);
    b.addTransport("wire", tb);

    b.handle("echo", (p) => p);
    expect(await a.request("echo", { hi: 1 })).toEqual({ hi: 1 });
  });

  it("delivers pub/sub events across a transport", async () => {
    const a = createBusRouter();
    const b = createBusRouter();
    const [ta, tb] = link();
    a.addTransport("wire", ta);
    b.addTransport("wire", tb);

    const seen: unknown[] = [];
    b.subscribe("topic", (d) => seen.push(d));
    a.publish("topic", { n: 7 });
    expect(seen).toEqual([{ n: 7 }]);
  });

  it("hub fans out an event to sibling leaves but not the origin", async () => {
    const { hubTransport, addLeaf } = makeHub();
    const main = createBusRouter({ bridge: true });
    main.addTransport("ipc", hubTransport);
    const leaf1 = createBusRouter();
    const leaf2 = createBusRouter();
    leaf1.addTransport("up", addLeaf());
    leaf2.addTransport("up", addLeaf());

    const got1: unknown[] = [];
    const got2: unknown[] = [];
    const gotMain: unknown[] = [];
    leaf1.subscribe("ping", (d) => got1.push(d));
    leaf2.subscribe("ping", (d) => got2.push(d));
    main.subscribe("ping", (d) => gotMain.push(d));

    leaf1.publish("ping", "hello");
    // Each receives exactly once: origin via local delivery, others via the hub
    // (the hub excludes the origin peer, so there's no duplicate network echo).
    expect(got1).toEqual(["hello"]);
    expect(got2).toEqual(["hello"]);
    expect(gotMain).toEqual(["hello"]);
  });

  it("serves a leaf→hub RPC handled on the hub", async () => {
    const { hubTransport, addLeaf } = makeHub();
    const main = createBusRouter({ bridge: true });
    main.addTransport("ipc", hubTransport);
    main.handle("sq", (p) => (p as number) * (p as number));
    const leaf = createBusRouter();
    leaf.addTransport("up", addLeaf());
    expect(await leaf.request<number>("sq", 9)).toBe(81);
  });

  it("rejects an RPC that never gets a response after the timeout", async () => {
    // No transports and no handler → nothing ever responds → timeout.
    const a = createBusRouter({ requestTimeoutMs: 20 });
    await expect(a.request("nowhere")).rejects.toThrow(/timed out/);
  });

  it("rejects immediately when the peer has no handler", async () => {
    const a = createBusRouter();
    const b = createBusRouter();
    const [ta, tb] = link();
    a.addTransport("wire", ta);
    b.addTransport("wire", tb);
    await expect(a.request("missing")).rejects.toThrow(/no handler/);
  });

  it("propagates a handler error as a rejected request", async () => {
    const a = createBusRouter();
    const b = createBusRouter();
    const [ta, tb] = link();
    a.addTransport("wire", ta);
    b.addTransport("wire", tb);
    b.handle("boom", () => {
      throw new Error("kaboom");
    });
    await expect(a.request("boom")).rejects.toThrow(/kaboom/);
  });

  it("applies canReceive ACL to inbound transport messages", async () => {
    const a = createBusRouter();
    const b = createBusRouter({ canReceive: (env) => env.kind !== "event" || env.topic.startsWith("ok.") });
    const [ta, tb] = link();
    a.addTransport("wire", ta);
    b.addTransport("wire", tb);

    const seen: string[] = [];
    b.subscribe("blocked.x", () => seen.push("blocked"));
    b.subscribe("ok.x", () => seen.push("ok"));
    a.publish("blocked.x", 1);
    a.publish("ok.x", 1);
    expect(seen).toEqual(["ok"]);
  });
});
