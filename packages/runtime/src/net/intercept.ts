/**
 * Request-interception decision core (pure, unit-tested).
 *
 * Plugins register `intercept` handlers that receive a request + a control
 * object and call `continue`/`fulfill`/`fail`. The first handler to act decides;
 * if none act the request continues unmodified.
 */

import type {
  NetworkRequest,
  NetworkResponse,
  NetworkRequestControl,
  NetworkResponseControl,
  NetworkContinueMods,
  NetworkFulfill,
  NetworkInterceptFilter,
  NetworkInterceptHandler,
  NetworkResponseInterceptHandler,
} from "@desktop-proxy/plugin-sdk";

export type NetDecision =
  | { action: "continue"; mods?: NetworkContinueMods }
  | { action: "fulfill"; response: NetworkFulfill }
  | { action: "fail"; reason?: string };

export type NetResponseDecision =
  | { action: "continue" }
  | { action: "fulfill"; response: { status?: number; headers?: Record<string, string>; body?: string; bodyEncoding?: "utf8" | "base64" } };

export interface InterceptRegistration {
  handler: NetworkInterceptHandler;
  filter?: NetworkInterceptFilter;
}

export interface ResponseInterceptRegistration {
  handler: NetworkResponseInterceptHandler;
  filter?: NetworkInterceptFilter;
}

/** Build a control object that records the first decision made. */
export function makeControl(): { control: NetworkRequestControl; getDecision: () => NetDecision | null } {
  let decision: NetDecision | null = null;
  const control: NetworkRequestControl = {
    continue(mods) {
      if (!decision) decision = { action: "continue", mods };
    },
    fulfill(response) {
      if (!decision) decision = { action: "fulfill", response };
    },
    fail(reason) {
      if (!decision) decision = { action: "fail", reason };
    },
  };
  return { control, getDecision: () => decision };
}

export function matchesFilter(url: string, filter?: NetworkInterceptFilter): boolean {
  if (!filter?.urls || filter.urls.length === 0) return true;
  return filter.urls.some((u) => url.includes(u));
}

/**
 * Run intercept registrations in order; the first that produces a decision wins.
 * Returns `{ action: "continue" }` if none decide.
 */
export async function runInterceptors(
  registrations: Iterable<InterceptRegistration>,
  req: NetworkRequest,
): Promise<NetDecision> {
  for (const reg of registrations) {
    if (!matchesFilter(req.url, reg.filter)) continue;
    const { control, getDecision } = makeControl();
    try {
      await reg.handler(req, control);
    } catch {
      // a faulty handler must not block the request
      continue;
    }
    const decision = getDecision();
    if (decision) return decision;
  }
  return { action: "continue" };
}

/** Build a response control object that records the first decision made. */
export function makeResponseControl(): { control: NetworkResponseControl; getDecision: () => NetResponseDecision | null } {
  let decision: NetResponseDecision | null = null;
  const control: NetworkResponseControl = {
    continue() {
      if (!decision) decision = { action: "continue" };
    },
    fulfill(response) {
      if (!decision) decision = { action: "fulfill", response };
    },
  };
  return { control, getDecision: () => decision };
}

/** Run response interceptors matching `url`; the first that calls fulfill wins. */
export async function runResponseInterceptors(
  registrations: Iterable<ResponseInterceptRegistration>,
  res: NetworkResponse,
  url: string,
): Promise<NetResponseDecision> {
  for (const reg of registrations) {
    if (!matchesFilter(url, reg.filter)) continue;
    const { control, getDecision } = makeResponseControl();
    try {
      await reg.handler(res, control);
    } catch {
      continue;
    }
    const decision = getDecision();
    if (decision && decision.action === "fulfill") return decision;
  }
  return { action: "continue" };
}

/** True if any registration's filter matches `url`. */
export function anyResponseInterceptMatches(
  registrations: Iterable<ResponseInterceptRegistration>,
  url: string,
): boolean {
  for (const reg of registrations) {
    if (matchesFilter(url, reg.filter)) return true;
  }
  return false;
}

/** Convert a header record to CDP's HeaderEntry[] form. */
export function toHeaderEntries(headers: Record<string, string>): Array<{ name: string; value: string }> {
  return Object.entries(headers).map(([name, value]) => ({ name, value: String(value) }));
}

/** Convert CDP HeaderEntry[] back to a record. */
export function fromHeaderEntries(entries: Array<{ name: string; value: string }> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of entries ?? []) out[e.name] = e.value;
  return out;
}
