/**
 * Conditional model routing for the relay (pure).
 *
 * `modelMap` is a static model→model rewrite. Routes add *conditional* selection:
 * pick a model based on the request itself — the incoming model (exact/`prefix*`),
 * a regex over the prompt text, the prompt size, or message count. First matching
 * route wins and takes precedence over `modelMap` (which remains the fallback).
 *
 * Example: a cheap model for short prompts, a premium one for long/complex ones,
 * or a reasoner when the prompt mentions "think step by step".
 */

export interface RouteWhen {
  /** Match the incoming model name (exact or `prefix*`). */
  modelMatches?: string;
  /** Case-insensitive regex tested against the request's prompt text. */
  contentMatches?: string;
  /** Minimum prompt-text length (chars). */
  minChars?: number;
  /** Maximum prompt-text length (chars). */
  maxChars?: number;
  /** Minimum number of messages / input items. */
  minMessages?: number;
}

export interface RouteRule {
  when?: RouteWhen;
  /** Model to route to when `when` matches. */
  model: string;
}

function asText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((seg) => (seg && typeof (seg as Record<string, unknown>).text === "string" ? ((seg as Record<string, unknown>).text as string) : ""))
      .join(" ");
  }
  return "";
}

/** Extract the prompt text from a Chat (`messages`) or Responses (`instructions`/`input`) body. */
export function requestText(body: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof body.instructions === "string") parts.push(body.instructions);
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) parts.push(asText((m as Record<string, unknown>)?.content));
  }
  if (Array.isArray(body.input)) {
    for (const it of body.input) {
      const r = it as Record<string, unknown>;
      parts.push(asText(r?.content ?? r?.text));
    }
  }
  return parts.join("\n").trim();
}

function messageCount(body: Record<string, unknown>): number {
  if (Array.isArray(body.messages)) return body.messages.length;
  if (Array.isArray(body.input)) return body.input.length;
  return 0;
}

function wildMatch(pattern: string, value: string): boolean {
  if (pattern.endsWith("*")) return value.startsWith(pattern.slice(0, -1));
  return pattern === value;
}

export function matchRoute(body: Record<string, unknown>, originalModel: string, rule: RouteRule): boolean {
  const w = rule.when ?? {};
  if (w.modelMatches && !wildMatch(w.modelMatches, originalModel)) return false;

  const needsText = !!w.contentMatches || w.minChars != null || w.maxChars != null;
  const text = needsText ? requestText(body) : "";
  if (w.contentMatches) {
    try {
      if (!new RegExp(w.contentMatches, "i").test(text)) return false;
    } catch {
      return false; // invalid regex never matches
    }
  }
  if (w.minChars != null && text.length < w.minChars) return false;
  if (w.maxChars != null && text.length > w.maxChars) return false;
  if (w.minMessages != null && messageCount(body) < w.minMessages) return false;
  return true;
}

/** First matching route's model, or null if none match. */
export function selectRouteModel(
  body: Record<string, unknown>,
  originalModel: string,
  routes?: RouteRule[],
): string | null {
  if (!routes || routes.length === 0) return null;
  for (const r of routes) {
    if (matchRoute(body, originalModel, r)) return r.model;
  }
  return null;
}
