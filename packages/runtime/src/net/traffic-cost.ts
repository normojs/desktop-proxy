/**
 * AI token usage + cost estimation (pure).
 *
 * Parses token usage from an LLM response body (OpenAI / Anthropic / Google
 * shapes) and estimates USD cost from a best-effort price table. Prices are
 * approximate (USD per 1M tokens, [input, output]) and clearly an estimate.
 * No I/O — unit-testable.
 */

export interface Usage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** Estimated USD cost, when the model is in the price table. */
  costUsd?: number;
}

// USD per 1,000,000 tokens: [input, output]. Matched by model-name prefix.
const PRICES: Array<[RegExp, number, number]> = [
  [/^gpt-4o-mini/i, 0.15, 0.6],
  [/^gpt-4o/i, 2.5, 10],
  [/^gpt-4\.1-mini/i, 0.4, 1.6],
  [/^gpt-4\.1/i, 2, 8],
  [/^gpt-4-turbo/i, 10, 30],
  [/^o1-mini/i, 1.1, 4.4],
  [/^o3-mini/i, 1.1, 4.4],
  [/^o1/i, 15, 60],
  [/^claude-3-5-haiku|claude-haiku/i, 0.8, 4],
  [/^claude-3-5-sonnet|claude-sonnet|claude-4|claude-3-7/i, 3, 15],
  [/^claude-3-opus|claude-opus/i, 15, 75],
  [/^gemini-1\.5-flash|gemini-2\.0-flash|gemini-flash/i, 0.1, 0.4],
  [/^gemini-1\.5-pro|gemini-pro/i, 1.25, 5],
  [/^deepseek-reasoner/i, 0.55, 2.19],
  [/^deepseek/i, 0.27, 1.1],
];

function parseJson(text: string | null | undefined): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function priceFor(model: string | undefined, prompt: number, completion: number): number | undefined {
  if (!model) return undefined;
  for (const [re, inP, outP] of PRICES) {
    if (re.test(model)) return (prompt / 1e6) * inP + (completion / 1e6) * outP;
  }
  return undefined;
}

/** Pull a usage object from a parsed payload (top-level or nested under response). */
function pickUsage(obj: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!obj) return null;
  const nested = (obj.response as Record<string, unknown> | undefined)?.usage;
  const u = (obj.usage ?? obj.usageMetadata ?? nested) as Record<string, unknown> | undefined;
  return u && typeof u === "object" ? u : null;
}

/**
 * Extract token usage + estimated cost from an LLM response body. Handles a plain
 * JSON body and a Server-Sent Events stream (e.g. the OpenAI "responses"/chat
 * streaming APIs, where usage rides on a late `response.completed`/final chunk).
 */
export function extractUsage(model: string | undefined, resBody: string | null | undefined): Usage | null {
  if (!resBody) return null;

  let u: Record<string, unknown> | null = null;
  if (/(^|\n)\s*data:/.test(resBody) || /(^|\n)\s*event:/.test(resBody)) {
    // SSE: scan `data:` payloads; keep the last one that carries usage.
    for (const line of resBody.split(/\r?\n/)) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      const found = pickUsage(parseJson(payload));
      if (found) u = found;
    }
  } else {
    u = pickUsage(parseJson(resBody));
  }
  if (!u) return null;

  const prompt = num(u.prompt_tokens) ?? num(u.input_tokens) ?? num(u.promptTokenCount);
  const completion = num(u.completion_tokens) ?? num(u.output_tokens) ?? num(u.candidatesTokenCount);
  if (prompt == null && completion == null) return null;

  const total = num(u.total_tokens) ?? num(u.totalTokenCount) ?? (prompt ?? 0) + (completion ?? 0);
  const costUsd = priceFor(model, prompt ?? 0, completion ?? 0);

  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: total,
    ...(costUsd != null ? { costUsd } : {}),
  };
}
