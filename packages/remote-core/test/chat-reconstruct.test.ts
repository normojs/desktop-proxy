import { describe, it, expect } from "vitest";

import { parseTurns, reconstructSessions, sessionKey, type TrafficLike } from "../src/chat-reconstruct";

describe("parseTurns", () => {
  it("parses chat messages incl. tool calls", () => {
    const turns = parseTurns(
      JSON.stringify({
        messages: [
          { role: "system", content: "You are an agent" },
          { role: "user", content: "fix the bug" },
          { role: "assistant", content: null, tool_calls: [{ function: { name: "exec_command", arguments: '{"cmd":"ls"}' } }] },
          { role: "tool", content: "file1\nfile2" },
        ],
      }),
    );
    expect(turns.map((t) => t.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(turns[2].toolCalls?.[0].name).toBe("exec_command");
    expect(turns[3].text).toBe("file1\nfile2");
  });

  it("parses Responses input (instructions + function_call/output)", () => {
    const turns = parseTurns(
      JSON.stringify({
        instructions: "system rules",
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
          { type: "function_call", name: "apply_patch", arguments: "{}" },
          { type: "function_call_output", output: "ok" },
          { type: "reasoning", summary: [{ text: "thinking" }] },
        ],
      }),
    );
    expect(turns.map((t) => t.role)).toEqual(["system", "user", "assistant", "tool"]); // reasoning skipped
    expect(turns[2].toolCalls?.[0].name).toBe("apply_patch");
  });
});

describe("reconstructSessions", () => {
  const conv = (userMsg: string, extra: object[] = []) =>
    JSON.stringify({ messages: [{ role: "system", content: "agent" }, { role: "user", content: userMsg }, ...extra] });

  it("groups requests of one conversation and uses the fullest history", () => {
    const entries: TrafficLike[] = [
      { startedDateTime: "2026-06-03T10:00:00Z", model: "deepseek-v4-flash", reqBody: conv("build a game"), usage: { totalTokens: 100, costUsd: 0.001 } },
      {
        startedDateTime: "2026-06-03T10:01:00Z",
        model: "deepseek-v4-flash",
        reqBody: conv("build a game", [{ role: "assistant", content: "ok" }, { role: "user", content: "add sound" }]),
        usage: { totalTokens: 200, costUsd: 0.002 },
      },
    ];
    const sessions = reconstructSessions(entries);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].title).toBe("build a game");
    expect(sessions[0].requestCount).toBe(2);
    expect(sessions[0].turnCount).toBe(4); // the fullest request
    expect(sessions[0].totalCostUsd).toBeCloseTo(0.003, 6);
    expect(sessions[0].lastActivity).toBe("2026-06-03T10:01:00Z");
  });

  it("separates distinct conversations and sorts newest first", () => {
    const sessions = reconstructSessions([
      { startedDateTime: "2026-06-03T09:00:00Z", reqBody: conv("task A") },
      { startedDateTime: "2026-06-03T11:00:00Z", reqBody: conv("task B") },
    ]);
    expect(sessions.map((s) => s.title)).toEqual(["task B", "task A"]);
  });

  it("ignores entries with no parseable history", () => {
    expect(reconstructSessions([{ reqBody: "not json" }, { reqBody: null }])).toEqual([]);
  });

  it("sessionKey is stable for the same conversation prefix", () => {
    expect(sessionKey(parseTurns(conv("same")))).toBe(sessionKey(parseTurns(conv("same", [{ role: "user", content: "more" }]))));
  });
});
