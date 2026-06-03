import { describe, it, expect } from "vitest";

import { analyzeEntry, type AnalyzeInput } from "../src/net/traffic-analyze";

const base: AnalyzeInput = { method: "GET", url: "https://example.com/", reqHeaders: {}, resHeaders: {} };

describe("analyzeEntry — category & service", () => {
  it("classifies an OpenAI streaming chat completion", () => {
    const a = analyzeEntry({
      method: "POST",
      url: "https://api.openai.com/v1/chat/completions",
      postData: '{"model":"gpt-4o","stream":true,"messages":[]}',
      resHeaders: { "content-type": "text/event-stream" },
      reqHeaders: { authorization: "Bearer sk-x" },
      status: 200,
    });
    expect(a.category).toBe("ai");
    expect(a.service).toBe("OpenAI");
    expect(a.kind).toBe("sse");
    expect(a.model).toBe("gpt-4o");
    expect(a.tags).toEqual(expect.arrayContaining(["stream", "auth"]));
    expect(a.label).toContain("OpenAI chat completion");
  });

  it("classifies Anthropic messages", () => {
    const a = analyzeEntry({ ...base, method: "POST", url: "https://api.anthropic.com/v1/messages" });
    expect(a.category).toBe("ai");
    expect(a.service).toBe("Anthropic");
    expect(a.kind).toBe("https");
  });

  it("classifies auth, telemetry, asset, update, api, websocket", () => {
    expect(analyzeEntry({ ...base, url: "https://auth.cursor.sh/token" }).category).toBe("auth");
    expect(analyzeEntry({ ...base, url: "https://telemetry.acme.io/events/batch" }).category).toBe("telemetry");
    expect(analyzeEntry({ ...base, url: "https://cdn.acme.io/x.svg", resHeaders: { "content-type": "image/svg+xml" } }).category).toBe("asset");
    expect(analyzeEntry({ ...base, url: "https://update.acme.io/latest.yml" }).category).toBe("update");
    expect(analyzeEntry({ ...base, url: "https://api.acme.io/v1/data" }).category).toBe("api");
    expect(analyzeEntry({ ...base, url: "wss://rt.acme.io/socket", resourceType: "websocket" }).category).toBe("websocket");
  });

  it("detects kind by scheme and content-type", () => {
    expect(analyzeEntry({ ...base, url: "http://x/y" }).kind).toBe("http");
    expect(analyzeEntry({ ...base, url: "https://x/y" }).kind).toBe("https");
    expect(analyzeEntry({ ...base, url: "wss://x/y", resourceType: "websocket" }).kind).toBe("ws");
    expect(analyzeEntry({ ...base, url: "https://x/y", resHeaders: { "content-type": "text/event-stream" } }).kind).toBe("sse");
  });

  it("tags errors and falls back to other", () => {
    const a = analyzeEntry({ ...base, url: "https://random.example/thing", status: 503 });
    expect(a.category).toBe("other");
    expect(a.tags).toContain("error");
  });

  it("classifies relay traffic to a localhost upstream as AI, naming the service from the model", () => {
    const a = analyzeEntry({
      method: "POST",
      url: "http://127.0.0.1:57321/v1/responses",
      source: "relay",
      postData: '{"model":"deepseek-v4-flash","stream":true}',
      status: 200,
    });
    expect(a.category).toBe("ai");
    expect(a.service).toBe("DeepSeek");
    expect(a.model).toBe("deepseek-v4-flash");
    expect(a.tags).toContain("relay");
  });
});
