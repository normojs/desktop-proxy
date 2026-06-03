/**
 * Request racing / failover engine (pure, injectable fetch for testing).
 *
 * Given an original request and a set of variants (e.g. different API keys,
 * endpoints, or models), it fires them per `mode`:
 *   - "race":     up to `concurrency` concurrent; first ACCEPTED wins.
 *   - "fallback": sequential; move to the next only when one is rejected.
 *
 * Streaming-safe: acceptance is decided from status + headers only (the body is
 * never read here), so the winner's body streams straight through. Losers are
 * aborted as soon as a winner is found (cost control) — but the winner's own
 * AbortController is left intact so its stream isn't cancelled. If none are
 * accepted, the last real response is returned (so the caller sees a genuine
 * upstream error like 402/429), or — if every variant errored — it throws.
 */

import type { RaceVariant, RaceRequestContext, RaceRequestOptions, RaceResult } from "@desktop-proxy/plugin-sdk";

export type { RaceVariant, RaceRequestContext, RaceResult };
export type RaceOptionsResolved = Omit<RaceRequestOptions, "variants">;

export interface RaceResponseLike {
  status: number;
  headers: unknown; // Headers instance or record
  body?: { cancel(): Promise<void> | void } | null;
  /** Underlying transport object (e.g. an http.IncomingMessage) for non-fetch layers. */
  raw?: unknown;
}

export interface RaceInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | null;
  signal?: AbortSignal;
}

export type RaceFetch = (url: string, init: RaceInit) => Promise<RaceResponseLike>;

export class RaceAllFailedError extends Error {
  constructor(public result: RaceResult) {
    super("all race variants failed");
    this.name = "RaceAllFailedError";
  }
}

function headersToRecord(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (typeof (headers as { forEach?: unknown }).forEach === "function") {
    (headers as { forEach: (cb: (v: string, k: string) => void) => void }).forEach((v, k) => {
      out[String(k).toLowerCase()] = String(v);
    });
    return out;
  }
  if (typeof headers === "object") {
    for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
      if (v != null) out[k.toLowerCase()] = String(v);
    }
  }
  return out;
}

function buildInit(req: RaceRequestContext, v: RaceVariant, signal: AbortSignal): RaceInit {
  return {
    method: v.method ?? req.method,
    headers: { ...req.headers, ...(v.headers ?? {}) },
    body: v.body !== undefined ? v.body : req.body,
    signal,
  };
}

function cancelBody(res: RaceResponseLike | null): void {
  try {
    void res?.body?.cancel?.();
  } catch {
    /* ignore */
  }
}

export interface RaceOutcome {
  response: RaceResponseLike;
  result: RaceResult;
}

export async function runRace(
  req: RaceRequestContext,
  variants: RaceVariant[],
  opts: RaceOptionsResolved,
  fetchImpl: RaceFetch,
  parentSignal?: AbortSignal,
): Promise<RaceOutcome> {
  const mode = opts.mode === "fallback" ? "fallback" : "race";
  const accept = opts.accept ?? ((s: number) => s >= 200 && s < 300);
  const cap = mode === "fallback" ? 1 : opts.concurrency && opts.concurrency > 0 ? opts.concurrency : variants.length;
  const perTimeout = opts.perRequestTimeoutMs ?? 0;
  const totalTimeout = opts.totalTimeoutMs ?? 0;

  const start = Date.now();
  const attempts: RaceAttemptMut[] = [];
  const controllers = new Map<number, AbortController>();

  let settled = false; // a winner was found
  let timedOut = false;
  // Held in an object so the closure assignments below aren't narrowed to `never`.
  const sel: {
    winner: { response: RaceResponseLike; index: number } | null;
    last: { response: RaceResponseLike; index: number } | null;
  } = { winner: null, last: null };
  let nextIndex = 0;

  const abortExcept = (keep: number): void => {
    for (const [i, c] of controllers) if (i !== keep) c.abort();
  };
  const abortAll = (): void => {
    for (const [, c] of controllers) c.abort();
  };

  const totalTimer =
    totalTimeout > 0
      ? setTimeout(() => {
          timedOut = true;
          settled = true;
          abortAll();
        }, totalTimeout)
      : null;
  const onParentAbort = (): void => {
    settled = true;
    abortAll();
  };
  parentSignal?.addEventListener("abort", onParentAbort, { once: true });

  async function runOne(): Promise<void> {
    if (settled) return;
    const index = nextIndex++;
    if (index >= variants.length) return;

    const ctrl = new AbortController();
    controllers.set(index, ctrl);
    const perTimer = perTimeout > 0 ? setTimeout(() => ctrl.abort(), perTimeout) : null;
    const t0 = Date.now();

    try {
      const res = await fetchImpl(variants[index].url ?? req.url, buildInit(req, variants[index], ctrl.signal));
      if (perTimer) clearTimeout(perTimer);
      const ok = accept(res.status, headersToRecord(res.headers));
      attempts.push({ index, status: res.status, ok, ms: Date.now() - t0 });

      if (settled) {
        cancelBody(res);
        return;
      }
      if (ok) {
        settled = true;
        sel.winner = { response: res, index };
        cancelBody(sel.last?.response ?? null);
        abortExcept(index); // keep the winner's stream alive
        return;
      }
      // Not accepted: keep as the fallback-return (cancel the previous), try next.
      cancelBody(sel.last?.response ?? null);
      sel.last = { response: res, index };
      await runOne();
    } catch (e) {
      if (perTimer) clearTimeout(perTimer);
      attempts.push({ index, status: null, ok: false, error: String(e), ms: Date.now() - t0 });
      if (!settled) await runOne();
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(cap, variants.length); i++) workers.push(runOne());
  await Promise.all(workers);

  if (totalTimer) clearTimeout(totalTimer);
  parentSignal?.removeEventListener("abort", onParentAbort);

  attempts.sort((a, b) => a.index - b.index);
  const result: RaceResult = {
    winnerIndex: sel.winner ? sel.winner.index : null,
    attempts,
    totalMs: Date.now() - start,
    ...(timedOut ? { timedOut: true } : {}),
  };
  opts.onResult?.(result);

  if (sel.winner) return { response: sel.winner.response, result };
  if (sel.last) return { response: sel.last.response, result };
  throw new RaceAllFailedError(result);
}

interface RaceAttemptMut {
  index: number;
  status: number | null;
  ok: boolean;
  error?: string;
  ms: number;
}
