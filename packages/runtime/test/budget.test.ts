import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { rollover, addSpend, checkBudget, emptyState, createBudgetTracker } from "../src/net/budget";

const d1 = new Date("2026-06-03T10:00:00Z");
const d2 = new Date("2026-06-04T10:00:00Z"); // next day, same month
const d3 = new Date("2026-07-01T10:00:00Z"); // next month

describe("budget core", () => {
  it("rolls over day and month counters", () => {
    const s = { day: "2026-06-03", month: "2026-06", daySpent: 5, monthSpent: 20 };
    expect(rollover(s, d1)).toEqual(s);
    expect(rollover(s, d2)).toEqual({ day: "2026-06-04", month: "2026-06", daySpent: 0, monthSpent: 20 });
    expect(rollover(s, d3)).toEqual({ day: "2026-07-01", month: "2026-07", daySpent: 0, monthSpent: 0 });
  });

  it("accumulates spend (ignoring non-positive costs)", () => {
    let s = emptyState(d1);
    s = addSpend(s, 1.5, d1);
    s = addSpend(s, 0.5, d1);
    s = addSpend(s, -9, d1);
    expect(s.daySpent).toBeCloseTo(2.0, 6);
    expect(s.monthSpent).toBeCloseTo(2.0, 6);
  });

  it("flags over daily and monthly caps", () => {
    const s = { day: "2026-06-03", month: "2026-06", daySpent: 3, monthSpent: 50 };
    expect(checkBudget(s, { dailyUsd: 5 }, d1).over).toBe(false);
    expect(checkBudget(s, { dailyUsd: 3 }, d1)).toMatchObject({ over: true, scope: "daily" });
    expect(checkBudget(s, { monthlyUsd: 40 }, d1)).toMatchObject({ over: true, scope: "monthly" });
  });
});

describe("createBudgetTracker", () => {
  it("persists spend and enforces a cap across reloads", () => {
    const dir = mkdtempSync(join(tmpdir(), "dprox-budget-"));
    const file = join(dir, "b.json");
    try {
      const cfg = { dailyUsd: 1, action: "block" as const };
      const t1 = createBudgetTracker(file, () => cfg);
      expect(t1.check().over).toBe(false);
      t1.record(0.6);
      t1.record(0.6); // total 1.2 ≥ 1
      expect(t1.check().over).toBe(true);
      // reload from disk → still over
      const t2 = createBudgetTracker(file, () => cfg);
      expect(t2.check()).toMatchObject({ over: true, scope: "daily" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is inert with no config", () => {
    const dir = mkdtempSync(join(tmpdir(), "dprox-budget-"));
    try {
      const t = createBudgetTracker(join(dir, "b.json"), () => undefined);
      t.record(100);
      expect(t.check().over).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
