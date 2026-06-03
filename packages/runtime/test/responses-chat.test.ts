import { describe, it, expect } from "vitest";

import { responsesToChat, ResponsesStreamConverter, chatUsageToResponses } from "../src/net/protocol/responses-chat";

describe("responsesToChat (request translation)", () => {
  it("maps instructions+input to messages and options", () => {
    const chat = responsesToChat({
      model: "deepseek-v4-flash",
      instructions: "You are Codex.",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] },
      ],
      max_output_tokens: 256,
      temperature: 0.2,
      stream: true,
    });
    expect(chat.model).toBe("deepseek-v4-flash");
    expect(chat.messages).toEqual([
      { role: "system", content: "You are Codex." },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    expect(chat.max_tokens).toBe(256);
    expect(chat.temperature).toBe(0.2);
    expect(chat.stream).toBe(true);
    expect((chat.stream_options as Record<string, unknown>).include_usage).toBe(true);
  });

  it("carries a reasoning item onto the next assistant message (thinking-mode round-trip)", () => {
    const chat = responsesToChat({
      model: "deepseek-v4-flash",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "q" }] },
        { type: "reasoning", summary: [{ type: "summary_text", text: "let me think" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "a" }] },
      ],
    });
    const messages = chat.messages as Array<Record<string, unknown>>;
    const assistant = messages.find((m) => m.role === "assistant")!;
    expect(assistant.content).toBe("a");
    expect(assistant.reasoning_content).toBe("let me think");
  });

  it("translates function_call / function_call_output and tools", () => {
    const chat = responsesToChat({
      model: "m",
      input: [
        { type: "function_call", call_id: "c1", name: "read_file", arguments: '{"path":"a"}' },
        { type: "function_call_output", call_id: "c1", output: "contents" },
      ],
      tools: [{ type: "function", name: "read_file", description: "read", parameters: { type: "object" } }],
    });
    const messages = chat.messages as Array<Record<string, unknown>>;
    expect(messages[0].tool_calls).toEqual([
      { id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } },
    ]);
    expect(messages[1]).toEqual({ role: "tool", tool_call_id: "c1", content: "contents" });
    expect(chat.tools).toEqual([
      { type: "function", function: { name: "read_file", description: "read", parameters: { type: "object" } } },
    ]);
  });

  it("groups consecutive (parallel) function_calls into one assistant message", () => {
    const chat = responsesToChat({
      model: "m",
      input: [
        { type: "function_call", call_id: "c1", name: "a", arguments: "{}" },
        { type: "function_call", call_id: "c2", name: "b", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: "r1" },
        { type: "function_call_output", call_id: "c2", output: "r2" },
      ],
    });
    const messages = chat.messages as Array<Record<string, unknown>>;
    // One assistant message with BOTH tool_calls, then the two tool results.
    expect(messages).toHaveLength(3);
    expect((messages[0].tool_calls as unknown[]).length).toBe(2);
    expect(messages[1]).toMatchObject({ role: "tool", tool_call_id: "c1" });
    expect(messages[2]).toMatchObject({ role: "tool", tool_call_id: "c2" });
  });
});

describe("chatUsageToResponses", () => {
  it("maps prompt/completion tokens to input/output", () => {
    expect(chatUsageToResponses({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })).toMatchObject({
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
    });
  });
});

describe("ResponsesStreamConverter (chat SSE → responses SSE)", () => {
  it("converts a text stream into the Responses event sequence", () => {
    const conv = new ResponsesStreamConverter();
    let out = "";
    out += conv.push('data: {"id":"chatcmpl-1","model":"deepseek-v4-flash","choices":[{"delta":{"content":"He"}}]}\n\n');
    out += conv.push('data: {"choices":[{"delta":{"content":"llo"}}]}\n\n');
    out += conv.push('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n');
    out += conv.finish();

    expect(out).toContain("event: response.created");
    expect(out).toContain("event: response.output_item.added");
    expect(out).toContain("event: response.output_text.delta");
    // Deltas carry the text pieces.
    expect(out).toContain('"delta":"He"');
    expect(out).toContain('"delta":"llo"');
    expect(out).toContain("event: response.output_text.done");
    expect(out).toContain('"text":"Hello"');
    expect(out).toContain("event: response.completed");
    expect(out).toContain('"input_tokens":3');
    expect(out).toContain('"output_tokens":2');
    expect(out.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("converts a reasoner stream (reasoning_content → reasoning summary, before text)", () => {
    const conv = new ResponsesStreamConverter();
    let out = "";
    out += conv.push('data: {"id":"c","choices":[{"delta":{"reasoning_content":"thinking..."}}]}\n\n');
    out += conv.push('data: {"choices":[{"delta":{"content":"answer"}}]}\n\n');
    out += conv.push('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
    out += conv.finish();

    expect(out).toContain('"type":"reasoning"');
    expect(out).toContain("event: response.reasoning_summary_text.delta");
    expect(out).toContain('"delta":"thinking..."');
    expect(out).toContain("event: response.reasoning_summary_text.done");
    // reasoning item is closed before the text item opens
    expect(out.indexOf("reasoning_summary_text.done")).toBeLessThan(out.indexOf("output_text.delta"));
    expect(out).toContain('"delta":"answer"');
  });

  it("converts a function tool-call stream", () => {
    const conv = new ResponsesStreamConverter();
    let out = "";
    out += conv.push('data: {"id":"c","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"run","arguments":"{\\"a\\""}}]}}]}\n\n');
    out += conv.push('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":1}"}}]}}]}\n\n');
    out += conv.push('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n');
    out += conv.finish();

    expect(out).toContain('"type":"function_call"');
    expect(out).toContain('"name":"run"');
    expect(out).toContain('"call_id":"call_1"');
    expect(out).toContain("event: response.function_call_arguments.delta");
    expect(out).toContain("event: response.function_call_arguments.done");
    expect(out).toContain('"arguments":"{\\"a\\":1}"');
    expect(out).toContain("event: response.completed");
  });
});
