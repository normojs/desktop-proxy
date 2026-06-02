/**
 * Node http/https request interceptor (observe).
 *
 * Electron's session.webRequest only sees Chromium-originated traffic, NOT
 * requests made through Node's `http`/`https` modules (axios/got/node-fetch/...).
 * The runtime is loaded before the app's main entry, so monkey-patching the
 * `http`/`https` singletons here makes every subsequent request visible.
 *
 * v1 is observe-only (request — including body — and response). Modification /
 * block / mock arrive with the unified `intercept` control API. We never change
 * the original call's behavior: on any error we fall back to the original, and
 * request-body capture wraps write/end transparently.
 */

import type * as http from "node:http";

import type { NetworkRequest, NetworkResponse } from "@desktop-proxy/plugin-sdk";

type Logger = (level: string, ...args: unknown[]) => void;

export interface NodeInterceptDeps {
  /** Skip all work when no plugin is listening. */
  hasHandlers: () => boolean;
  observeRequest: (req: NetworkRequest) => void;
  observeResponse: (res: NetworkResponse) => void;
  /** Max captured body bytes (0 = unlimited). */
  maxBodyBytes: () => number;
  log: Logger;
}

interface NormalizedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
}

const TEXT_CONTENT_TYPE = /(json|text|xml|javascript|event-stream|x-www-form-urlencoded)/i;

let installed = false;
let counter = 0;

// ── Pure helpers (unit-tested) ───────────────────────────────────────────────

export function flattenHeaders(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers && typeof headers === "object") {
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
      if (Array.isArray(value)) out[key] = value.join(", ");
      else if (value != null) out[key] = String(value);
    }
  }
  return out;
}

/** Best-effort reconstruction of method/url/headers from http.request(...) args. */
export function normalizeHttpArgs(defaultProtocol: "http:" | "https:", args: readonly unknown[]): NormalizedRequest {
  let url: URL | null = null;
  let options: Record<string, unknown> = {};

  const first = args[0];
  if (typeof first === "string") {
    url = tryUrl(first);
  } else if (first instanceof URL) {
    url = first;
  } else if (first && typeof first === "object") {
    options = first as Record<string, unknown>;
  }
  if ((typeof first === "string" || first instanceof URL) && args[1] && typeof args[1] === "object") {
    options = args[1] as Record<string, unknown>;
  }

  const protocol = String(options.protocol ?? url?.protocol ?? defaultProtocol);
  const rawHost = String(options.hostname ?? options.host ?? url?.host ?? "localhost");
  // Split a trailing :port (best-effort; keeps bracketed IPv6 intact).
  const hostMatch = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(rawHost);
  const host = hostMatch ? hostMatch[1] : rawHost;
  const portFromHost = hostMatch?.[2] ?? "";
  const port = options.port != null ? String(options.port) : url?.port || portFromHost || "";
  const path = String(options.path ?? (url ? url.pathname + url.search : "/"));
  const method = String(options.method ?? "GET").toUpperCase();
  const portPart = port ? `:${port}` : "";

  return {
    method,
    url: `${protocol}//${host}${portPart}${path}`,
    headers: flattenHeaders(options.headers),
  };
}

/** Decode captured chunks to a (capped) string, choosing utf8 vs base64. */
export function decodeBody(
  chunks: Buffer[],
  cap: number,
): { body: string | null; bodyEncoding: "utf8" | "base64"; truncated: boolean } {
  if (chunks.length === 0) return { body: null, bodyEncoding: "utf8", truncated: false };
  let buf = Buffer.concat(chunks);
  let truncated = false;
  if (cap > 0 && buf.length > cap) {
    buf = buf.subarray(0, cap);
    truncated = true;
  }
  const binary = buf.includes(0);
  return {
    body: binary ? buf.toString("base64") : buf.toString("utf8"),
    bodyEncoding: binary ? "base64" : "utf8",
    truncated,
  };
}

function tryUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

// ── Patching ─────────────────────────────────────────────────────────────────

export function installNodeIntercept(deps: NodeInterceptDeps): void {
  if (installed) return;
  installed = true;
  // Use require() (not `import *`) so we get the real, mutable module object —
  // an ESM namespace import exposes read-only getters that can't be patched.
  const httpModule = require("node:http") as Record<string, unknown>;
  const httpsModule = require("node:https") as Record<string, unknown>;
  patchModule(httpModule, "http:", deps);
  patchModule(httpsModule, "https:", deps);
  deps.log("info", "node http/https interceptor installed");
}

function patchModule(mod: Record<string, unknown>, protocol: "http:" | "https:", deps: NodeInterceptDeps): void {
  for (const name of ["request", "get"] as const) {
    const original = mod[name];
    if (typeof original !== "function") continue;
    const orig = original as (...a: unknown[]) => unknown;

    const wrapper = function (this: unknown, ...args: unknown[]): unknown {
      if (!deps.hasHandlers()) return orig.apply(this, args);

      let info: NormalizedRequest | null = null;
      try {
        info = normalizeHttpArgs(protocol, args);
      } catch {
        return orig.apply(this, args);
      }

      const clientReq = orig.apply(this, args);
      try {
        instrument(clientReq as http.ClientRequest, info, deps);
      } catch (e) {
        deps.log("warn", "node intercept instrument failed:", String(e));
      }
      return clientReq;
    };

    try {
      mod[name] = wrapper;
    } catch {
      try {
        Object.defineProperty(mod, name, { value: wrapper, writable: true, configurable: true });
      } catch (e) {
        deps.log("warn", `node intercept: cannot patch ${name}:`, String(e));
      }
    }
  }
}

function instrument(req: http.ClientRequest, info: NormalizedRequest, deps: NodeInterceptDeps): void {
  const id = `node-${++counter}-${Date.now()}`;
  const cap = deps.maxBodyBytes();
  const reqChunks: Buffer[] = [];
  let reqBytes = 0;
  let dispatched = false;

  const capture = (chunk: unknown): void => {
    if (chunk == null) return;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    if (cap <= 0 || reqBytes < cap) {
      reqChunks.push(buf);
      reqBytes += buf.length;
    }
  };

  const origWrite = req.write.bind(req);
  const origEnd = req.end.bind(req);
  req.write = function (chunk: unknown, ...rest: unknown[]): boolean {
    try {
      if (typeof chunk !== "function") capture(chunk);
    } catch {
      // ignore capture errors
    }
    return (origWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
  } as typeof req.write;
  req.end = function (chunk: unknown, ...rest: unknown[]): http.ClientRequest {
    try {
      if (chunk && typeof chunk !== "function") capture(chunk);
    } catch {
      // ignore
    }
    dispatchRequest();
    return (origEnd as (...a: unknown[]) => http.ClientRequest)(chunk, ...rest);
  } as typeof req.end;

  const dispatchRequest = (): void => {
    if (dispatched) return;
    dispatched = true;
    const { body, bodyEncoding } = decodeBody(reqChunks, cap);
    deps.observeRequest({
      id,
      source: "node-http",
      _type: "node",
      method: info.method,
      url: info.url,
      headers: info.headers,
      body,
      bodyEncoding,
      timestamp: Date.now(),
    });
  };
  req.once("finish", dispatchRequest);

  req.once("response", (res: http.IncomingMessage) => observeResponse(res, id, deps));
}

function observeResponse(res: http.IncomingMessage, requestId: string, deps: NodeInterceptDeps): void {
  const headers = flattenHeaders(res.headers);
  const contentType = headers["content-type"] ?? "";
  const base = {
    id: `resp-${requestId}`,
    requestId,
    source: "node-http" as const,
    status: res.statusCode ?? 0,
    statusText: res.statusMessage ?? "",
    headers,
    timestamp: Date.now(),
  };

  // Binary (or no plugin interest in bodies): metadata only, don't touch the stream.
  if (contentType !== "" && !TEXT_CONTENT_TYPE.test(contentType)) {
    deps.observeResponse({ ...base, body: null });
    return;
  }

  // Text: accumulate a capped copy. Adding a 'data' listener puts the stream in
  // flowing mode, which coexists with consumers using 'data'/pipe/async-iter
  // (the common case for http clients).
  const cap = deps.maxBodyBytes();
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;

  const onData = (chunk: Buffer | string): void => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (cap <= 0 || total < cap) {
      const room = cap <= 0 ? buf.length : cap - total;
      const slice = room < buf.length ? buf.subarray(0, room) : buf;
      chunks.push(slice);
      total += slice.length;
      if (cap > 0 && total >= cap) truncated = true;
    }
  };
  const cleanup = (): void => {
    res.removeListener("data", onData);
  };

  res.on("data", onData);
  res.once("end", () => {
    cleanup();
    deps.observeResponse({ ...base, body: Buffer.concat(chunks).toString("utf8"), truncated });
  });
  res.once("error", cleanup);
}
