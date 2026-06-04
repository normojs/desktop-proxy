import { describe, it, expect } from "vitest";

import {
  eventSubjectOut,
  eventSubjectIn,
  rpcSubject,
  hubSubscriptions,
  clientSubscriptions,
  topicFromSubject,
  methodFromSubject,
  buildPairingPayload,
  pairingToString,
  pairingFromString,
  hubPermissions,
  devicePermissions,
} from "../src/net/remote-subjects";

describe("subjects", () => {
  it("builds directional event + rpc subjects", () => {
    expect(eventSubjectOut("abc", "config:changed")).toBe("dp.abc.h2c.event.config:changed");
    expect(eventSubjectIn("abc", "config:changed")).toBe("dp.abc.c2h.event.config:changed");
    expect(rpcSubject("abc", "traffic.list")).toBe("dp.abc.rpc.traffic.list");
  });
  it("builds wildcard subscriptions for hub and client", () => {
    expect(hubSubscriptions("abc")).toEqual({ events: "dp.abc.c2h.event.>", rpc: "dp.abc.rpc.>" });
    expect(clientSubscriptions("abc")).toEqual({ events: "dp.abc.h2c.event.>" });
  });
  it("parses topic/method back out of subjects", () => {
    expect(topicFromSubject("dp.abc.c2h.event.traffic:entry")).toBe("traffic:entry");
    expect(topicFromSubject("dp.abc.h2c.event.x.y")).toBe("x.y");
    expect(topicFromSubject("dp.abc.rpc.foo")).toBeNull();
    expect(methodFromSubject("dp.abc.rpc.traffic.list")).toBe("traffic.list");
    expect(methodFromSubject("dp.abc.c2h.event.x")).toBeNull();
  });
});

describe("pairing", () => {
  it("round-trips a pairing payload (incl. wsUrl for browser/phone clients)", () => {
    const p = buildPairingPayload({
      instanceId: "i1",
      url: "tls://host:4222",
      wsUrl: "wss://host:8443",
      jwt: "ey.j.w.t",
      seed: "SUASEED",
      name: "My Mac",
    });
    const s = pairingToString(p);
    expect(s.startsWith("dprox://pair?d=")).toBe(true);
    const back = pairingFromString(s);
    expect(back).toEqual(p);
    expect(back?.wsUrl).toBe("wss://host:8443");
  });
  it("rejects malformed pairing strings", () => {
    expect(pairingFromString("nope")).toBeNull();
    expect(pairingFromString("dprox://pair?d=%%%")).toBeNull();
  });
});

describe("ACL permissions", () => {
  it("scopes a device to its instance subjects only", () => {
    const perm = devicePermissions("i1");
    expect(perm.publish).toContain("dp.i1.c2h.event.>");
    expect(perm.publish).toContain("dp.i1.rpc.>");
    expect(perm.subscribe).toContain("dp.i1.h2c.event.>");
    // a device cannot subscribe to the inbound (hub-facing) subjects
    expect(perm.subscribe).not.toContain("dp.i1.c2h.event.>");
    // and is confined to its own instance
    expect(perm.publish.every((s) => s.startsWith("dp.i1.") || s.startsWith("_INBOX"))).toBe(true);
  });
  it("gives the hub the complementary permissions", () => {
    const perm = hubPermissions("i1");
    expect(perm.publish).toContain("dp.i1.h2c.event.>");
    expect(perm.subscribe).toContain("dp.i1.c2h.event.>");
    expect(perm.subscribe).toContain("dp.i1.rpc.>");
  });
});
