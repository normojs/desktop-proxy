import { describe, it, expect } from "vitest";

import { buildRelaySummary } from "../src/net/relay-summary";
import { isRemoteMethodAllowed } from "../src/net/remote-subjects";
import { redactConfigForRemote } from "../src/net/redact";

describe("buildRelaySummary", () => {
  it("summarizes a configured relay without leaking the key", () => {
    const s = buildRelaySummary(
      {
        enabled: true,
        port: 8788,
        upstream: "https://api.deepseek.com/v1",
        upstreamApi: "chat",
        apiKey: "sk-abcdef1234567890",
        modelMap: { "gpt-*": "deepseek-v4-flash" },
        routes: [{ model: "x" }, { model: "y" }],
        guardrails: [{ pattern: "a", action: "block" }],
        budget: { dailyUsd: 5, action: "block" },
      },
      { day: "2026-06-03", month: "2026-06", daySpent: 1.25, monthSpent: 12 },
    );
    expect(s.enabled).toBe(true);
    expect(s.upstreamApi).toBe("chat");
    expect(s.apiKeyMasked).toBe("sk-abc…");
    expect(s.apiKeyMasked).not.toContain("1234567890");
    expect(s.routes).toBe(2);
    expect(s.guardrails).toBe(1);
    expect(s.budget).toMatchObject({ dailyUsd: 5, action: "block", daySpent: 1.25, monthSpent: 12 });
  });

  it("handles an empty / disabled relay", () => {
    const s = buildRelaySummary(undefined);
    expect(s).toMatchObject({ enabled: false, port: 8788, upstream: null, apiKeyMasked: null, budget: null });
  });
});

describe("isRemoteMethodAllowed", () => {
  it("permits the inspector + control surface", () => {
    for (const m of ["config.get", "config.set", "plugin.toggle", "traffic.list", "relay.summary"]) {
      expect(isRemoteMethodAllowed(m)).toBe(true);
    }
  });
  it("blocks filesystem / unknown methods from remote callers", () => {
    for (const m of ["fs.read", "fs.write", "fs.delete", "cdp.send", "anything.else"]) {
      expect(isRemoteMethodAllowed(m)).toBe(false);
    }
  });
});

describe("redactConfigForRemote", () => {
  it("masks the relay key and remote creds, leaving the original intact", () => {
    const cfg = {
      relay: { enabled: true, apiKey: "sk-abcdef1234567890", upstream: "x" },
      remote: { url: "tls://h", seed: "SUASECRET", jwt: "ey.j.w.t" },
      logLevel: "info",
    };
    const out = redactConfigForRemote(cfg);
    expect(out.relay.apiKey).toMatch(/\*\*\*$/);
    expect(out.relay.apiKey).not.toContain("1234567890");
    expect(out.remote.seed).toBe("***redacted***");
    expect(out.remote.jwt).toBe("***redacted***");
    expect(out.remote.url).toBe("tls://h"); // non-secret preserved
    expect(out.logLevel).toBe("info");
    // original untouched
    expect(cfg.relay.apiKey).toBe("sk-abcdef1234567890");
  });
});
