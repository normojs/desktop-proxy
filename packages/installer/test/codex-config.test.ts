import { describe, it, expect } from "vitest";

import {
  currentProvider,
  applyCodexRelay,
  removeCodexRelay,
  hasDproxRelay,
  DPROX_PROVIDER,
} from "../src/codex-config.js";

// A realistic config.toml resembling a CodexPlusPlus relay-injected setup.
const SAMPLE = `model_provider = "CodexPlusPlus"

notify = ["x", "turn-ended"]

[model_providers.CodexPlusPlus]
name = "CodexPlusPlus"
wire_api = "responses"
requires_openai_auth = true
base_url = "http://127.0.0.1:57321/v1"
experimental_bearer_token = "sk-abc123"

[features]
js_repl = false
`;

describe("currentProvider", () => {
  it("reads the active provider's base_url and token", () => {
    const p = currentProvider(SAMPLE);
    expect(p?.name).toBe("CodexPlusPlus");
    expect(p?.baseUrl).toBe("http://127.0.0.1:57321/v1");
    expect(p?.token).toBe("sk-abc123");
  });

  it("returns null when no model_provider is set", () => {
    expect(currentProvider(`[features]\njs_repl = false\n`)).toBeNull();
  });
});

describe("applyCodexRelay / removeCodexRelay", () => {
  it("flips model_provider to dprox and appends a managed section", () => {
    const out = applyCodexRelay(SAMPLE, { baseUrl: "http://127.0.0.1:8788/v1", token: "sk-abc123" });
    expect(hasDproxRelay(out)).toBe(true);

    // The active provider is now dprox, pointing at our relay.
    const p = currentProvider(out);
    expect(p?.name).toBe(DPROX_PROVIDER);
    expect(p?.baseUrl).toBe("http://127.0.0.1:8788/v1");
    expect(p?.token).toBe("sk-abc123");

    // Top-level model_provider appears exactly once (TOML forbids duplicates).
    expect(out.match(/^[ \t]*model_provider\s*=/gm)?.length).toBe(1);

    // The original provider section + unrelated sections are untouched.
    expect(out).toContain("[model_providers.CodexPlusPlus]");
    expect(out).toContain('base_url = "http://127.0.0.1:57321/v1"');
    expect(out).toContain("[features]");
    // model_provider stays above the first [section] (TOML top-level rule).
    expect(out.indexOf("model_provider =")).toBeLessThan(out.indexOf("["));
  });

  it("round-trips back to the original active provider", () => {
    const applied = applyCodexRelay(SAMPLE, { baseUrl: "http://127.0.0.1:8788/v1", token: "sk-abc123" });
    const removed = removeCodexRelay(applied);
    expect(hasDproxRelay(removed)).toBe(false);
    expect(currentProvider(removed)?.name).toBe("CodexPlusPlus");
    expect(removed).not.toContain(DPROX_PROVIDER);
  });

  it("is idempotent (re-applying replaces, not stacks)", () => {
    const once = applyCodexRelay(SAMPLE, { baseUrl: "http://127.0.0.1:8788/v1", token: "t" });
    const twice = applyCodexRelay(once, { baseUrl: "http://127.0.0.1:9999/v1", token: "t2" });
    expect(twice.match(new RegExp(`\\[model_providers\\.${DPROX_PROVIDER}\\]`, "g"))?.length).toBe(1);
    expect(currentProvider(twice)?.baseUrl).toBe("http://127.0.0.1:9999/v1");
    // Removal still restores the very first provider.
    expect(currentProvider(removeCodexRelay(twice))?.name).toBe("CodexPlusPlus");
  });

  it("works when there is no existing model_provider", () => {
    const base = `[model_providers.foo]\nbase_url = "http://x/v1"\n`;
    const out = applyCodexRelay(base, { baseUrl: "http://127.0.0.1:8788/v1" });
    expect(currentProvider(out)?.name).toBe(DPROX_PROVIDER);
    expect(out.indexOf("model_provider =")).toBeLessThan(out.indexOf("["));
  });
});
