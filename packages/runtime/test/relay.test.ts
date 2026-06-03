import { describe, it, expect } from "vitest";

import { joinUpstream, buildForwardHeaders, filterResponseHeaders, rewriteModel } from "../src/net/relay";

describe("joinUpstream", () => {
  it("dedups a shared version segment (base /v1 + path /v1/...)", () => {
    expect(joinUpstream("https://api.openai.com/v1", "/v1/responses")).toBe("https://api.openai.com/v1/responses");
    expect(joinUpstream("http://127.0.0.1:57321/v1", "/v1/chat/completions")).toBe("http://127.0.0.1:57321/v1/chat/completions");
  });

  it("appends when the path has no version segment", () => {
    expect(joinUpstream("https://api.openai.com/v1", "/responses")).toBe("https://api.openai.com/v1/responses");
  });

  it("trims trailing slashes on the base", () => {
    expect(joinUpstream("https://x.com/", "/v1/models")).toBe("https://x.com/v1/models");
    expect(joinUpstream("https://x.com//", "v1/models")).toBe("https://x.com/v1/models");
  });

  it("handles the exact version path and preserves the query string", () => {
    expect(joinUpstream("https://x.com/v1", "/v1")).toBe("https://x.com/v1");
    expect(joinUpstream("https://x.com/v1", "/v1/responses?stream=true")).toBe("https://x.com/v1/responses?stream=true");
  });

  it("does not dedup a different version (v1 base, v2 path)", () => {
    expect(joinUpstream("https://x.com/v1", "/v2/responses")).toBe("https://x.com/v1/v2/responses");
  });
});

describe("buildForwardHeaders", () => {
  it("strips hop-by-hop/length headers and forces identity encoding", () => {
    const out = buildForwardHeaders({
      host: "127.0.0.1:8788",
      connection: "keep-alive",
      "content-length": "42",
      "accept-encoding": "gzip, br",
      "content-type": "application/json",
      "x-keep": "yes",
    });
    expect(out.host).toBeUndefined();
    expect(out.connection).toBeUndefined();
    expect(out["content-length"]).toBeUndefined();
    expect(out["accept-encoding"]).toBe("identity");
    expect(out["content-type"]).toBe("application/json");
    expect(out["x-keep"]).toBe("yes");
  });

  it("injects Authorization when a key is given and none is present", () => {
    const out = buildForwardHeaders({ "content-type": "application/json" }, { apiKey: "sk-test" });
    expect(out.authorization).toBe("Bearer sk-test");
  });

  it("overrides the client Authorization when an apiKey is set (relay holds the key)", () => {
    const out = buildForwardHeaders({ Authorization: "Bearer client" }, { apiKey: "sk-relay" });
    expect(out.authorization).toBe("Bearer sk-relay");
    expect(out.Authorization).toBeUndefined();
  });

  it("passes the client Authorization through when no apiKey is set", () => {
    const out = buildForwardHeaders({ Authorization: "Bearer client" });
    expect(out.Authorization).toBe("Bearer client");
  });
});

describe("rewriteModel", () => {
  const map = { "gpt-5.4-mini": "deepseek-v4-flash", "gpt-5.4": "deepseek-v4-pro", "gpt-5*": "deepseek-v4-pro" };

  it("prefers an exact match over a wildcard", () => {
    expect(rewriteModel("gpt-5.4-mini", map)).toBe("deepseek-v4-flash");
    expect(rewriteModel("gpt-5.4", map)).toBe("deepseek-v4-pro");
  });

  it("falls back to a prefix wildcard", () => {
    expect(rewriteModel("gpt-5.4-turbo", map)).toBe("deepseek-v4-pro");
    expect(rewriteModel("gpt-5o", map)).toBe("deepseek-v4-pro");
  });

  it("returns the input unchanged when nothing matches", () => {
    expect(rewriteModel("deepseek-v4-pro", map)).toBe("deepseek-v4-pro");
    expect(rewriteModel("claude-4", {})).toBe("claude-4");
  });
});

describe("filterResponseHeaders", () => {
  it("drops content-encoding/length and hop-by-hop, keeps the rest", () => {
    const out = filterResponseHeaders({
      "content-type": "text/event-stream",
      "content-encoding": "gzip",
      "content-length": "100",
      "transfer-encoding": "chunked",
      connection: "keep-alive",
      "x-request-id": "abc",
    });
    expect(out["content-type"]).toBe("text/event-stream");
    expect(out["x-request-id"]).toBe("abc");
    expect(out["content-encoding"]).toBeUndefined();
    expect(out["content-length"]).toBeUndefined();
    expect(out["transfer-encoding"]).toBeUndefined();
    expect(out.connection).toBeUndefined();
  });
});
