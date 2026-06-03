import { describe, it, expect } from "vitest";

import { renderStats, RELAY_UI_HTML, type UiEntry } from "../src/net/relay-ui";

const entries: UiEntry[] = [
  { status: 200, service: "DeepSeek", model: "deepseek-v4-flash", usage: { totalTokens: 100, costUsd: 0.001 } },
  { status: 200, service: "DeepSeek", model: "deepseek-v4-flash", usage: { totalTokens: 200, costUsd: 0.002 } },
  { status: 400, service: "DeepSeek", model: "deepseek-v4-pro", usage: { totalTokens: 0, costUsd: 0 } },
  { status: 200, service: "OpenAI", model: "gpt-x", usage: null },
];

describe("renderStats", () => {
  it("aggregates totals, errors, and per-model/service buckets", () => {
    const s = renderStats(entries);
    expect(s.count).toBe(4);
    expect(s.errors).toBe(1);
    expect(s.totalTokens).toBe(300);
    expect(s.totalCostUsd).toBeCloseTo(0.003, 6);
    expect(s.byModel["deepseek-v4-flash"]).toEqual({ count: 2, tokens: 300, costUsd: 0.003 });
    expect(s.byService.DeepSeek.count).toBe(3);
    expect(s.byService.OpenAI).toEqual({ count: 1, tokens: 0, costUsd: 0 });
  });

  it("handles empty input", () => {
    expect(renderStats([])).toEqual({ count: 0, errors: 0, totalTokens: 0, totalCostUsd: 0, byModel: {}, byService: {} });
  });

  it("serves a self-contained HTML page", () => {
    expect(RELAY_UI_HTML).toContain("<!doctype html>");
    expect(RELAY_UI_HTML).toContain("/api/traffic");
    expect(RELAY_UI_HTML).toContain("/api/stats");
  });
});
