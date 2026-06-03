import { describe, it, expect, vi } from "vitest";

import { BusClient } from "../src/bus-client";
import { pairingFromString, topicFromSubject, rpcSubject } from "../src/subjects";

describe("subjects", () => {
  it("builds rpc subjects and parses event topics", () => {
    expect(rpcSubject("i1", "config.get")).toBe("dp.i1.rpc.config.get");
    expect(topicFromSubject("dp.i1.h2c.event.budget:alert")).toBe("budget:alert");
    expect(topicFromSubject("dp.i1.rpc.config.get")).toBeNull();
  });

  it("parses a pairing link (incl. wsUrl)", () => {
    const payload = { v: 1, instanceId: "i1", url: "tls://h:4222", wsUrl: "wss://h:8443", jwt: "ey", seed: "SU" };
    const link = `desktopproxy://pair?d=${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
    expect(pairingFromString(link)).toEqual(payload);
    expect(pairingFromString("garbage")).toBeNull();
  });
});

describe("BusClient", () => {
  it("publishes an RPC to the right subject + inbox and resolves on reply", async () => {
    const sent: Array<{ subject: string; reply?: string; payload: string }> = [];
    const bus = new BusClient("i1", "c1", (subject, reply, payload) => sent.push({ subject, reply, payload }));

    const p = bus.request<{ ok: boolean }>("config.get", { a: 1 });
    expect(sent[0].subject).toBe("dp.i1.rpc.config.get");
    expect(sent[0].reply).toBe("_INBOX.c1.1");
    expect(JSON.parse(sent[0].payload)).toEqual({ a: 1 });

    // Simulate the hub's reply on the inbox.
    bus.handleMessage("_INBOX.c1.1", JSON.stringify({ kind: "res", ok: true, result: { ok: true } }));
    await expect(p).resolves.toEqual({ ok: true });
  });

  it("rejects on an error reply", async () => {
    const bus = new BusClient("i1", "c1", () => {});
    const p = bus.request("fs.read", {});
    bus.handleMessage("_INBOX.c1.1", JSON.stringify({ kind: "res", ok: false, error: "forbidden" }));
    await expect(p).rejects.toThrow("forbidden");
  });

  it("times out without a reply", async () => {
    vi.useFakeTimers();
    const bus = new BusClient("i1", "c1", () => {}, { timeoutMs: 1000 });
    const p = bus.request("config.get");
    const assertion = expect(p).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
    vi.useRealTimers();
  });

  it("dispatches events by topic", () => {
    const bus = new BusClient("i1", "c1", () => {});
    const seen: unknown[] = [];
    bus.subscribe("budget:alert", (d) => seen.push(d));
    bus.handleMessage("dp.i1.h2c.event.budget:alert", JSON.stringify({ data: { scope: "daily", spent: 6 } }));
    bus.handleMessage("dp.i1.h2c.event.other", JSON.stringify({ data: { x: 1 } })); // no subscriber
    expect(seen).toEqual([{ scope: "daily", spent: 6 }]);
  });

  it("rejectAll fails in-flight requests", async () => {
    const bus = new BusClient("i1", "c1", () => {});
    const p = bus.request("config.get");
    bus.rejectAll("disconnected");
    await expect(p).rejects.toThrow("disconnected");
  });
});
