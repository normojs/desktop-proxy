import { describe, it, expect } from "vitest";

import { extractUsage } from "../src/net/traffic-cost";

describe("extractUsage", () => {
  it("parses OpenAI usage and estimates cost", () => {
    const u = extractUsage("gpt-4o", '{"usage":{"prompt_tokens":1000,"completion_tokens":500,"total_tokens":1500}}');
    expect(u).toMatchObject({ promptTokens: 1000, completionTokens: 500, totalTokens: 1500 });
    // 1000/1e6*2.5 + 500/1e6*10 = 0.0025 + 0.005 = 0.0075
    expect(u!.costUsd).toBeCloseTo(0.0075, 6);
  });

  it("parses Anthropic usage shape", () => {
    const u = extractUsage("claude-3-5-sonnet-latest", '{"usage":{"input_tokens":200,"output_tokens":100}}');
    expect(u).toMatchObject({ promptTokens: 200, completionTokens: 100, totalTokens: 300 });
    expect(u!.costUsd).toBeCloseTo(200 / 1e6 * 3 + 100 / 1e6 * 15, 6);
  });

  it("parses Google usageMetadata shape", () => {
    const u = extractUsage("gemini-1.5-flash", '{"usageMetadata":{"promptTokenCount":50,"candidatesTokenCount":20,"totalTokenCount":70}}');
    expect(u).toMatchObject({ promptTokens: 50, completionTokens: 20, totalTokens: 70 });
  });

  it("returns tokens without cost for an unknown model", () => {
    const u = extractUsage("some-unknown-llm", '{"usage":{"prompt_tokens":10,"completion_tokens":5}}');
    expect(u).toMatchObject({ promptTokens: 10, completionTokens: 5 });
    expect(u!.costUsd).toBeUndefined();
  });

  it("returns null when there is no usage", () => {
    expect(extractUsage("gpt-4o", '{"choices":[]}')).toBeNull();
    expect(extractUsage("gpt-4o", "not json")).toBeNull();
    expect(extractUsage("gpt-4o", null)).toBeNull();
  });

  it("parses usage from an SSE responses-API stream (nested response.usage)", () => {
    const sse = [
      'event: response.created',
      'data: {"type":"response.created","response":{"id":"r1"}}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"r1","usage":{"input_tokens":1200,"output_tokens":300}}}',
      '',
      'data: [DONE]',
      '',
    ].join("\n");
    const u = extractUsage("deepseek-v4-pro", sse);
    expect(u).toMatchObject({ promptTokens: 1200, completionTokens: 300, totalTokens: 1500 });
    // DeepSeek price table → cost computed.
    expect(u!.costUsd).toBeGreaterThan(0);
  });

  it("parses usage from an SSE chat-completions stream (final chunk)", () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"hi"}}]}',
      'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":40,"completion_tokens":12}}',
      'data: [DONE]',
    ].join("\n");
    const u = extractUsage("gpt-4o", sse);
    expect(u).toMatchObject({ promptTokens: 40, completionTokens: 12, totalTokens: 52 });
  });
});
