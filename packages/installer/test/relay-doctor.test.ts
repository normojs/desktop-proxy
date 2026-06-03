import { describe, it, expect } from "vitest";

import { buildRelayDiagnostics, overallStatus } from "../src/relay-doctor.js";

const LOCAL = "http://127.0.0.1:8788/v1";

describe("buildRelayDiagnostics", () => {
  it("flags a disabled / unconfigured relay", () => {
    const checks = buildRelayDiagnostics({ localBase: LOCAL });
    expect(checks.find((c) => c.name === "relay enabled")?.status).toBe("fail");
    expect(checks.find((c) => c.name === "upstream configured")?.status).toBe("fail");
    expect(overallStatus(checks)).toBe("fail");
  });

  it("detects a self-loop upstream", () => {
    const checks = buildRelayDiagnostics({ enabled: true, upstream: LOCAL, localBase: LOCAL });
    expect(checks.find((c) => c.name === "no self-loop")?.status).toBe("fail");
  });

  it("passes a healthy Codex config-redirect setup", () => {
    const checks = buildRelayDiagnostics({
      enabled: true,
      upstream: "https://api.deepseek.com/v1",
      localBase: LOCAL,
      modelMap: { "gpt-*": "deepseek-v4-flash" },
      upstreamApi: "chat",
      codexConfigPresent: true,
      codexHasRelay: true,
      codexProviderBaseUrl: LOCAL,
      codexAuthPresent: true,
    });
    expect(checks.find((c) => c.name === "Codex → relay")?.status).toBe("ok");
    expect(checks.find((c) => c.name === "Codex login bypass (auth.json)")?.status).toBe("ok");
    expect(checks.find((c) => c.name === "protocol translation")?.status).toBe("ok");
    // no network checks here → static portion is all ok/warn (model map ok)
    expect(overallStatus(checks)).toBe("ok");
  });

  it("warns when Codex isn't pointed at the relay or login bypass is missing", () => {
    const checks = buildRelayDiagnostics({
      enabled: true,
      upstream: "https://api.deepseek.com/v1",
      localBase: LOCAL,
      codexConfigPresent: true,
      codexHasRelay: false,
      codexProviderBaseUrl: "https://api.openai.com/v1",
      codexAuthPresent: false,
    });
    expect(checks.find((c) => c.name === "Codex → relay")?.status).toBe("warn");
    expect(checks.find((c) => c.name === "Codex login bypass (auth.json)")?.status).toBe("warn");
    expect(overallStatus(checks)).toBe("warn");
  });
});
