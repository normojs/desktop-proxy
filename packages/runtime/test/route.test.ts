import { describe, it, expect } from "vitest";

import { requestText, matchRoute, selectRouteModel, type RouteRule } from "../src/net/route";

const chat = (text: string, n = 1) => ({
  model: "gpt-5.5",
  messages: [
    { role: "system", content: "sys" },
    ...Array.from({ length: n }, () => ({ role: "user", content: text })),
  ],
});

describe("requestText", () => {
  it("extracts text from chat messages and responses input", () => {
    expect(requestText(chat("hello world"))).toContain("hello world");
    expect(
      requestText({ instructions: "do X", input: [{ content: [{ type: "input_text", text: "deep dive" }] }] }),
    ).toContain("deep dive");
  });
});

describe("matchRoute / selectRouteModel", () => {
  const routes: RouteRule[] = [
    { when: { contentMatches: "think step by step" }, model: "deepseek-reasoner" },
    { when: { maxChars: 20 }, model: "deepseek-v4-flash" },
    { when: { minChars: 21 }, model: "deepseek-v4-pro" },
  ];

  it("routes by content regex (first match wins)", () => {
    expect(selectRouteModel(chat("please think step by step about this"), "gpt-5.5", routes)).toBe("deepseek-reasoner");
  });

  it("routes short prompts to the cheap model, long to premium", () => {
    expect(selectRouteModel(chat("hi"), "gpt-5.5", routes)).toBe("deepseek-v4-flash");
    expect(selectRouteModel(chat("this is a much longer prompt than twenty chars"), "gpt-5.5", routes)).toBe(
      "deepseek-v4-pro",
    );
  });

  it("matches by incoming model wildcard", () => {
    expect(matchRoute(chat("x"), "gpt-5.4-mini", { when: { modelMatches: "gpt-*" }, model: "m" })).toBe(true);
    expect(matchRoute(chat("x"), "claude-3", { when: { modelMatches: "gpt-*" }, model: "m" })).toBe(false);
  });

  it("matches by message count", () => {
    expect(matchRoute(chat("x", 5), "gpt-5.5", { when: { minMessages: 4 }, model: "m" })).toBe(true);
    expect(matchRoute(chat("x", 1), "gpt-5.5", { when: { minMessages: 4 }, model: "m" })).toBe(false);
  });

  it("returns null when nothing matches or no routes", () => {
    expect(selectRouteModel(chat("mid length prompt here"), "gpt-5.5", [{ when: { modelMatches: "claude-*" }, model: "m" }])).toBeNull();
    expect(selectRouteModel(chat("x"), "gpt-5.5", undefined)).toBeNull();
  });

  it("an empty `when` matches everything (catch-all)", () => {
    expect(selectRouteModel(chat("anything"), "gpt-5.5", [{ model: "fallback-model" }])).toBe("fallback-model");
  });
});
