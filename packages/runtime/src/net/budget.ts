/**
 * Cost budgets for the relay.
 *
 * Accumulates estimated USD spend per day/month and enforces a cap: "warn" logs
 * when over, "block" rejects new requests (HTTP 402) until the window rolls over.
 * Spend is known only after a response (token usage), so the gate is post-hoc:
 * each completed response adds to the accumulator, and the *next* request is
 * checked against it. State is persisted so budgets survive restarts.
 *
 * The pure functions (rollover/addSpend/checkBudget) are unit tested; the tracker
 * factory adds file persistence used by the relay daemon and injected runtime.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface BudgetConfig {
  dailyUsd?: number;
  monthlyUsd?: number;
  /** What to do when over budget. Default "warn". */
  action?: "warn" | "block";
}

export interface BudgetState {
  day: string; // YYYY-MM-DD
  month: string; // YYYY-MM
  daySpent: number;
  monthSpent: number;
}

export interface BudgetVerdict {
  over: boolean;
  scope?: "daily" | "monthly";
  spent: number;
  limit: number;
}

export function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}
export function monthKey(now: Date): string {
  return now.toISOString().slice(0, 7);
}

export function emptyState(now: Date): BudgetState {
  return { day: dayKey(now), month: monthKey(now), daySpent: 0, monthSpent: 0 };
}

/** Reset the day/month counters when the window rolls over. Pure. */
export function rollover(state: BudgetState, now: Date): BudgetState {
  const d = dayKey(now);
  const m = monthKey(now);
  return {
    day: d,
    month: m,
    daySpent: state.day === d ? state.daySpent : 0,
    monthSpent: state.month === m ? state.monthSpent : 0,
  };
}

export function addSpend(state: BudgetState, costUsd: number, now: Date): BudgetState {
  const s = rollover(state, now);
  const add = costUsd > 0 ? costUsd : 0;
  return { ...s, daySpent: s.daySpent + add, monthSpent: s.monthSpent + add };
}

/** Is the (rolled-over) state over either configured cap? Pure. */
export function checkBudget(state: BudgetState, cfg: BudgetConfig, now: Date): BudgetVerdict {
  const s = rollover(state, now);
  if (cfg.dailyUsd != null && s.daySpent >= cfg.dailyUsd) {
    return { over: true, scope: "daily", spent: s.daySpent, limit: cfg.dailyUsd };
  }
  if (cfg.monthlyUsd != null && s.monthSpent >= cfg.monthlyUsd) {
    return { over: true, scope: "monthly", spent: s.monthSpent, limit: cfg.monthlyUsd };
  }
  return { over: false, spent: s.daySpent, limit: cfg.dailyUsd ?? cfg.monthlyUsd ?? 0 };
}

export interface BudgetTracker {
  /** Add a response's cost; persists. */
  record(costUsd: number): void;
  /** Verdict against the current config (rolled over). */
  check(): BudgetVerdict;
  state(): BudgetState;
}

/** File-backed budget tracker. `getConfig` is read each check so live edits apply. */
export function createBudgetTracker(filePath: string, getConfig: () => BudgetConfig | undefined): BudgetTracker {
  let state: BudgetState;
  try {
    state = JSON.parse(readFileSync(filePath, "utf8")) as BudgetState;
  } catch {
    state = emptyState(new Date());
  }

  function save(): void {
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, JSON.stringify(state));
    } catch {
      /* best effort */
    }
  }

  return {
    record(costUsd: number): void {
      state = addSpend(state, costUsd, new Date());
      save();
    },
    check(): BudgetVerdict {
      const cfg = getConfig();
      if (!cfg || (cfg.dailyUsd == null && cfg.monthlyUsd == null)) return { over: false, spent: 0, limit: 0 };
      const v = checkBudget(state, cfg, new Date());
      state = rollover(state, new Date());
      return v;
    },
    state(): BudgetState {
      return state;
    },
  };
}
