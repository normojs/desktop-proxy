/**
 * Node-side request interceptor (observe).
 *
 * Electron's session.webRequest only sees Chromium-originated traffic, NOT
 * requests made from the main process through Node. The runtime is loaded before
 * the app's main entry, so monkey-patching here makes that traffic visible:
 *   - `http` / `https`        (axios/got/node-fetch/...)
 *   - global `fetch`          (undici — Node's built-in fetch)
 *   - `http2`                 (client sessions)
 *
 * Observe-only (request — including body — and response). Modification / block /
 * mock arrive with the unified `intercept` control API. We never change the
 * original call's behavior: on any error we fall back to the original, and body
 * capture is transparent (wraps write/end; reads a clone for fetch).
 *
 * Note: renderer-side `fetch`/`XHR`/`EventSource`/`WebSocket` are observed at the
 * network layer by the CDP observer; main-process `EventSource` is rare and not
 * patched here.
 */

import type * as http from "node:http";
import { Writable } from "node:stream";

import type { NetworkRequest, NetworkResponse, RaceRequestOptions, RaceVariant } from "@desktop-proxy/plugin-sdk";

import { runRace, type RaceFetch, type RaceResponseLike } from "./race.js";

type HttpRequestFn = (
  url: string,
  options: { method?: string; headers?: Record<string, string> },
  cb: (res: http.IncomingMessage) => void,
) => http.ClientRequest;

type Logger = (level: string, ...args: unknown[]) => void;

export interface NodeInterceptDeps {
  /** Skip all work when no plugin is listening. */
  hasHandlers: () => boolean;
  observeRequest: (req: NetworkRequest) => void;
  observeResponse: (res: NetworkResponse) => void;
  /** Max captured body bytes (0 = unlimited). */
  maxBodyBytes: () => number;
  log: Logger;
  /** First race/failover rule matching a url (replaces the request if matched). */
  raceFor?: (url: string) => { opts: RaceRequestOptions } | null;
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

/** Normalize a fetch/Headers/array/record into a flat record (lowercased keys). */
export function headersToRecord(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  // A Headers instance (or anything with forEach(value, key)).
  if (typeof (headers as { forEach?: unknown }).forEach === "function" && !Array.isArray(headers)) {
    (headers as { forEach: (cb: (value: string, key: string) => void) => void }).forEach((value, key) => {
      out[String(key).toLowerCase()] = String(value);
    });
    return out;
  }
  if (Array.isArray(headers)) {
    for (const pair of headers as Array<[unknown, unknown]>) {
      if (Array.isArray(pair) && pair.length >= 2) out[String(pair[0]).toLowerCase()] = String(pair[1]);
    }
    return out;
  }
  if (typeof headers === "object") {
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
      if (value != null) out[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
    }
  }
  return out;
}

interface FetchRequestInfo {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

/** Best-effort method/url/headers/body from `fetch(input, init)` arguments. */
export function fetchRequestInfo(input: unknown, init: unknown): FetchRequestInfo {
  const initObj = (init && typeof init === "object" ? init : {}) as Record<string, unknown>;
  let url = "";
  let method = "GET";
  let headersSrc: unknown = initObj.headers;

  if (typeof input === "string") {
    url = input;
  } else if (input instanceof URL) {
    url = input.href;
  } else if (input && typeof input === "object") {
    const reqLike = input as Record<string, unknown>;
    url = String(reqLike.url ?? "");
    if (reqLike.method) method = String(reqLike.method);
    if (headersSrc == null) headersSrc = reqLike.headers;
  }
  if (initObj.method) method = String(initObj.method);

  let body: string | null = null;
  const b = initObj.body;
  if (typeof b === "string") body = b;
  else if (b && typeof (b as { toString?: unknown }).toString === "function" && b instanceof URLSearchParams) {
    body = b.toString();
  }

  return { method: method.toUpperCase(), url, headers: headersToRecord(headersSrc), body };
}

/** Join an http2 authority + `:path` pseudo-header into an absolute URL. */
export function http2Url(authority: string, path: string): string {
  const auth = authority || "";
  const hasScheme = /^[a-z]+:\/\//i.test(auth);
  const base = hasScheme ? auth : `https://${auth}`;
  try {
    return new URL(path || "/", base).href;
  } catch {
    return `${base.replace(/\/$/, "")}${path || "/"}`;
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
  // Capture the ORIGINAL request fns first, so race variants use them and don't
  // recurse back into our patched request (which could re-match the race rule).
  const httpFetchImpl = makeHttpFetchImpl(httpModule.request as HttpRequestFn, httpsModule.request as HttpRequestFn);
  patchModule(httpModule, "http:", deps, httpFetchImpl);
  patchModule(httpsModule, "https:", deps, httpFetchImpl);
  patchGlobalFetch(deps);
  patchHttp2(deps);
  deps.log("info", "node http/https/fetch/http2 interceptor installed");
}

function patchModule(
  mod: Record<string, unknown>,
  protocol: "http:" | "https:",
  deps: NodeInterceptDeps,
  httpFetchImpl: RaceFetch,
): void {
  for (const name of ["request", "get"] as const) {
    const original = mod[name];
    if (typeof original !== "function") continue;
    const orig = original as (...a: unknown[]) => unknown;

    const wrapper = function (this: unknown, ...args: unknown[]): unknown {
      let info: NormalizedRequest;
      try {
        info = normalizeHttpArgs(protocol, args);
      } catch {
        return orig.apply(this, args);
      }

      // Request racing / failover: replace a matched request with a fake
      // ClientRequest that races variants and emits the winner's response.
      const rule = deps.raceFor?.(info.url);
      if (rule) {
        try {
          const fake = makeRaceClientRequest(info, rule.opts, httpFetchImpl, deps.log);
          // http.request(url, opts, cb) attaches `cb` as the 'response' listener
          // internally; replicate that since we returned our own request object.
          const cb = args.find((a) => typeof a === "function") as ((res: http.IncomingMessage) => void) | undefined;
          if (cb) fake.once("response", cb);
          if (name === "get") fake.end();
          return fake;
        } catch (e) {
          deps.log("warn", "node http: race failed, using original request:", String(e));
          return orig.apply(this, args);
        }
      }

      if (!deps.hasHandlers()) return orig.apply(this, args);

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

// ── http/https request racing ─────────────────────────────────────────────────

function makeHttpFetchImpl(origHttpRequest: HttpRequestFn, origHttpsRequest: HttpRequestFn): RaceFetch {
  return (url, init) =>
    new Promise<RaceResponseLike>((resolve, reject) => {
      const reqFn = /^https:/i.test(url) ? origHttpsRequest : origHttpRequest;
      let req: http.ClientRequest;
      try {
        req = reqFn(url, { method: init.method, headers: init.headers }, (res) => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: {
              cancel: () => {
                res.destroy();
              },
            },
            raw: res,
          });
        });
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      req.on("error", (e) => reject(e));
      const signal = init.signal;
      if (signal) {
        if (signal.aborted) {
          req.destroy(new Error("aborted"));
          reject(new Error("aborted"));
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            req.destroy(new Error("aborted"));
            reject(new Error("aborted"));
          },
          { once: true },
        );
      }
      if (init.body != null) req.write(init.body);
      req.end();
    });
}

function makeRaceClientRequest(
  info: NormalizedRequest,
  opts: RaceRequestOptions,
  httpFetchImpl: RaceFetch,
  log: Logger,
): http.ClientRequest {
  const chunks: Buffer[] = [];
  const parent = new AbortController();

  const fake = new Writable({
    // Don't auto-destroy on 'finish' — that would call destroy() → abort the
    // in-flight race before the winner's response arrives.
    autoDestroy: false,
    write(chunk: unknown, _enc: unknown, cb: (e?: Error | null) => void) {
      try {
        if (chunk != null && typeof chunk !== "function") {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        }
      } catch {
        /* ignore */
      }
      cb();
    },
    final(cb: (e?: Error | null) => void) {
      const body = chunks.length ? Buffer.concat(chunks).toString("utf8") : null;
      const ctx = { method: info.method, url: info.url, headers: info.headers, body };
      let variants: RaceVariant[];
      try {
        variants = opts.variants(ctx);
      } catch (e) {
        log("warn", "node http race: variants() threw:", String(e));
        variants = [];
      }
      if (!variants || variants.length === 0) variants = [{}]; // fall back to the original request
      void runRace(ctx, variants, opts, httpFetchImpl, parent.signal)
        .then(({ response }) => {
          fake.emit("response", response.raw);
        })
        .catch((e) => {
          // Every variant errored — fall back to the original request so a
          // misconfigured race doesn't break an otherwise-working call.
          httpFetchImpl(ctx.url, { method: ctx.method, headers: ctx.headers, body: ctx.body }).then(
            (r) => fake.emit("response", r.raw),
            () => fake.emit("error", e instanceof Error ? e : new Error(String(e))),
          );
        });
      cb();
    },
  });

  // Minimal http.ClientRequest compatibility surface.
  const f = fake as unknown as Record<string, unknown>;
  f.abort = () => {
    parent.abort();
    fake.destroy();
  };
  const origDestroy = fake.destroy.bind(fake);
  f.destroy = (err?: Error) => {
    parent.abort();
    return origDestroy(err);
  };
  f.setTimeout = () => fake;
  f.setHeader = () => fake;
  f.getHeader = () => undefined;
  f.removeHeader = () => undefined;
  f.flushHeaders = () => undefined;

  return fake as unknown as http.ClientRequest;
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

// ── Global fetch (undici) ────────────────────────────────────────────────────

const PATCHED = "__dpPatched";

interface StreamReaderLike {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(): Promise<void>;
}
interface FetchResponseLike {
  status: number;
  statusText: string;
  headers: unknown;
  body: { getReader(): StreamReaderLike } | null;
  clone(): FetchResponseLike;
}

function urlOf(input: unknown): string {
  if (typeof input === "string") return input;
  if (input && typeof input === "object") {
    const u = (input as { url?: unknown; href?: unknown }).url ?? (input as { href?: unknown }).href;
    if (typeof u === "string") return u;
  }
  return "";
}

function extractSignal(input: unknown, init: unknown): AbortSignal | undefined {
  const fromInit = (init as { signal?: AbortSignal } | undefined)?.signal;
  if (fromInit) return fromInit;
  if (input && typeof input === "object") return (input as { signal?: AbortSignal }).signal;
  return undefined;
}

function patchGlobalFetch(deps: NodeInterceptDeps): void {
  const g = globalThis as Record<string, unknown>;
  const orig = g.fetch;
  if (typeof orig !== "function" || (orig as unknown as Record<string, unknown>)[PATCHED]) return;
  const origFetch = orig as (input: unknown, init?: unknown) => Promise<FetchResponseLike>;

  const wrapper = async function (this: unknown, input: unknown, init?: unknown): Promise<FetchResponseLike> {
    // Request racing / failover: replace a matched request with the first accepted
    // variant. Check the (cheap) url first so idle fetches skip full parsing.
    const rule = deps.raceFor?.(urlOf(input));
    if (rule) {
      try {
        const info = fetchRequestInfo(input, init);
        const variants = rule.opts.variants(info);
        if (variants.length > 0) {
          const raceFetch: RaceFetch = (vurl, vinit) =>
            origFetch.call(this, vurl, vinit) as unknown as Promise<RaceResponseLike>;
          const { response } = await runRace(info, variants, rule.opts, raceFetch, extractSignal(input, init));
          return response as unknown as FetchResponseLike;
        }
      } catch (e) {
        deps.log("warn", "node fetch: race failed, using original request:", String(e));
        return origFetch.call(this, input, init);
      }
    }

    if (!deps.hasHandlers()) return origFetch.call(this, input, init);
    const info = fetchRequestInfo(input, init);
    const id = `nodefetch-${++counter}-${Date.now()}`;
    try {
      deps.observeRequest({
        id,
        source: "node-http",
        _type: "node",
        method: info.method,
        url: info.url,
        headers: info.headers,
        body: info.body,
        bodyEncoding: "utf8",
        timestamp: Date.now(),
      });
    } catch (e) {
      deps.log("warn", "node fetch: request observe failed:", String(e));
    }

    const res = await origFetch.call(this, input, init);
    try {
      void observeFetchResponse(res, id, deps);
    } catch (e) {
      deps.log("warn", "node fetch: response observe failed:", String(e));
    }
    return res;
  };
  (wrapper as unknown as Record<string, unknown>)[PATCHED] = true;

  try {
    g.fetch = wrapper;
  } catch {
    try {
      Object.defineProperty(g, "fetch", { value: wrapper, writable: true, configurable: true });
    } catch (e) {
      deps.log("warn", "node intercept: cannot patch global fetch:", String(e));
    }
  }
}

async function observeFetchResponse(res: FetchResponseLike, requestId: string, deps: NodeInterceptDeps): Promise<void> {
  const headers = headersToRecord(res.headers);
  const contentType = headers["content-type"] ?? "";
  const base = {
    id: `resp-${requestId}`,
    requestId,
    source: "node-http" as const,
    status: res.status,
    statusText: res.statusText,
    headers,
    timestamp: Date.now(),
  };

  // No body, binary, or streaming (event-stream): metadata only — reading the
  // clone of a stream would buffer indefinitely.
  const isText = contentType === "" || TEXT_CONTENT_TYPE.test(contentType);
  if (!res.body || !isText || /event-stream/i.test(contentType)) {
    deps.observeResponse({ ...base, body: null });
    return;
  }

  let clone: FetchResponseLike;
  try {
    clone = res.clone();
  } catch {
    deps.observeResponse({ ...base, body: null });
    return;
  }
  if (!clone.body) {
    deps.observeResponse({ ...base, body: null });
    return;
  }

  const cap = deps.maxBodyBytes();
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  const reader = clone.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const room = cap <= 0 ? value.length : cap - total;
      if (room > 0) {
        const slice = room < value.length ? value.subarray(0, room) : value;
        chunks.push(Buffer.from(slice));
        total += slice.length;
      }
      if (cap > 0 && total >= cap) {
        truncated = true;
        void reader.cancel().catch(() => undefined);
        break;
      }
    }
  } catch {
    // partial body is still useful
  }
  deps.observeResponse({
    ...base,
    body: chunks.length ? Buffer.concat(chunks).toString("utf8") : "",
    truncated,
  });
}

// ── http2 client ─────────────────────────────────────────────────────────────

interface Http2StreamLike {
  write: (...a: unknown[]) => unknown;
  end: (...a: unknown[]) => unknown;
  once(event: string, cb: (...a: unknown[]) => void): unknown;
  on(event: string, cb: (...a: unknown[]) => void): unknown;
  removeListener(event: string, cb: (...a: unknown[]) => void): unknown;
}
interface Http2SessionLike {
  request?: (...a: unknown[]) => Http2StreamLike;
}

function patchHttp2(deps: NodeInterceptDeps): void {
  let http2: Record<string, unknown>;
  try {
    http2 = require("node:http2") as Record<string, unknown>;
  } catch {
    return; // http2 unavailable
  }
  const origConnect = http2.connect;
  if (typeof origConnect !== "function" || (origConnect as unknown as Record<string, unknown>)[PATCHED]) return;
  const connect = origConnect as (...a: unknown[]) => unknown;

  const wrapper = function (this: unknown, ...args: unknown[]): unknown {
    const session = connect.apply(this, args);
    try {
      instrumentHttp2Session(session as Http2SessionLike, String(args[0] ?? ""), deps);
    } catch (e) {
      deps.log("warn", "node http2: session instrument failed:", String(e));
    }
    return session;
  };
  (wrapper as unknown as Record<string, unknown>)[PATCHED] = true;

  try {
    http2.connect = wrapper;
  } catch {
    try {
      Object.defineProperty(http2, "connect", { value: wrapper, writable: true, configurable: true });
    } catch (e) {
      deps.log("warn", "node intercept: cannot patch http2.connect:", String(e));
    }
  }
}

function instrumentHttp2Session(session: Http2SessionLike, authority: string, deps: NodeInterceptDeps): void {
  const origRequest = session.request;
  if (typeof origRequest !== "function") return;
  const bound = origRequest.bind(session);

  session.request = function (this: unknown, headers?: unknown, options?: unknown): Http2StreamLike {
    const stream = bound(headers, options);
    if (!deps.hasHandlers()) return stream;
    try {
      const h = flattenHeaders(headers);
      const method = String(h[":method"] ?? "GET").toUpperCase();
      const path = String(h[":path"] ?? "/");
      instrumentHttp2Stream(stream, { id: `http2-${++counter}-${Date.now()}`, method, url: http2Url(authority, path), headers: h }, deps);
    } catch (e) {
      deps.log("warn", "node http2: stream instrument failed:", String(e));
    }
    return stream;
  } as typeof session.request;
}

function instrumentHttp2Stream(
  stream: Http2StreamLike,
  info: NormalizedRequest & { id: string },
  deps: NodeInterceptDeps,
): void {
  const cap = deps.maxBodyBytes();
  const reqChunks: Buffer[] = [];
  let reqBytes = 0;
  let dispatched = false;

  const capture = (chunk: unknown): void => {
    if (chunk == null || typeof chunk === "function") return;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    if (cap <= 0 || reqBytes < cap) {
      reqChunks.push(buf);
      reqBytes += buf.length;
    }
  };

  const origWrite = stream.write.bind(stream);
  const origEnd = stream.end.bind(stream);
  stream.write = function (chunk: unknown, ...rest: unknown[]): unknown {
    try {
      capture(chunk);
    } catch {
      /* ignore */
    }
    return origWrite(chunk, ...rest);
  };
  stream.end = function (chunk: unknown, ...rest: unknown[]): unknown {
    try {
      if (chunk && typeof chunk !== "function") capture(chunk);
    } catch {
      /* ignore */
    }
    dispatchRequest();
    return origEnd(chunk, ...rest);
  };

  const dispatchRequest = (): void => {
    if (dispatched) return;
    dispatched = true;
    const { body, bodyEncoding } = decodeBody(reqChunks, cap);
    deps.observeRequest({
      id: info.id,
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
  stream.once("finish", dispatchRequest);

  stream.once("response", (respHeaders: unknown) => {
    try {
      const rh = flattenHeaders(respHeaders);
      observeHttp2Response(stream, info.id, Number(rh[":status"] ?? 0), rh, deps);
    } catch (e) {
      deps.log("warn", "node http2: response observe failed:", String(e));
    }
  });
}

function observeHttp2Response(
  stream: Http2StreamLike,
  requestId: string,
  status: number,
  headers: Record<string, string>,
  deps: NodeInterceptDeps,
): void {
  const contentType = headers["content-type"] ?? "";
  const base = {
    id: `resp-${requestId}`,
    requestId,
    source: "node-http" as const,
    status,
    statusText: "",
    headers,
    timestamp: Date.now(),
  };

  // Binary or streaming (event-stream): metadata only.
  if (contentType !== "" && (!TEXT_CONTENT_TYPE.test(contentType) || /event-stream/i.test(contentType))) {
    deps.observeResponse({ ...base, body: null });
    return;
  }

  const cap = deps.maxBodyBytes();
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  const onData = (chunk: unknown): void => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    if (cap <= 0 || total < cap) {
      const room = cap <= 0 ? buf.length : cap - total;
      const slice = room < buf.length ? buf.subarray(0, room) : buf;
      chunks.push(slice);
      total += slice.length;
      if (cap > 0 && total >= cap) truncated = true;
    }
  };
  const cleanup = (): void => {
    stream.removeListener("data", onData);
  };
  stream.on("data", onData);
  stream.once("end", () => {
    cleanup();
    deps.observeResponse({ ...base, body: Buffer.concat(chunks).toString("utf8"), truncated });
  });
  stream.once("error", cleanup);
}
