/**
 * Relay summary for the remote bus (`relay.summary` RPC) — a compact, credential-free
 * snapshot the phone/CLI shows on its Overview screen: relay state + today's spend.
 * Pure; the caller supplies the relay config and the persisted budget state.
 */

import type { BudgetState } from "./budget.js";

export interface RelaySummary {
  enabled: boolean;
  port: number;
  upstream: string | null;
  upstreamApi: "responses" | "chat";
  /** Masked (never the raw key). */
  apiKeyMasked: string | null;
  modelMap: Record<string, string>;
  routes: number;
  guardrails: number;
  budget: {
    dailyUsd: number | null;
    monthlyUsd: number | null;
    action: string;
    daySpent: number;
    monthSpent: number;
  } | null;
}

interface RelayCfgLike {
  enabled?: boolean;
  port?: number;
  upstream?: string;
  upstreamApi?: "responses" | "chat";
  apiKey?: string;
  modelMap?: Record<string, string>;
  routes?: unknown[];
  guardrails?: unknown[];
  budget?: { dailyUsd?: number; monthlyUsd?: number; action?: string };
}

function mask(key?: string): string | null {
  if (!key) return null;
  return key.length > 8 ? `${key.slice(0, 6)}…` : "***";
}

export function buildRelaySummary(relay?: RelayCfgLike, budget?: BudgetState): RelaySummary {
  const r = relay ?? {};
  const b = r.budget;
  return {
    enabled: r.enabled === true,
    port: r.port ?? 8788,
    upstream: r.upstream ?? null,
    upstreamApi: r.upstreamApi ?? "responses",
    apiKeyMasked: mask(r.apiKey),
    modelMap: r.modelMap ?? {},
    routes: Array.isArray(r.routes) ? r.routes.length : 0,
    guardrails: Array.isArray(r.guardrails) ? r.guardrails.length : 0,
    budget: b
      ? {
          dailyUsd: b.dailyUsd ?? null,
          monthlyUsd: b.monthlyUsd ?? null,
          action: b.action ?? "warn",
          daySpent: budget?.daySpent ?? 0,
          monthSpent: budget?.monthSpent ?? 0,
        }
      : null,
  };
}
