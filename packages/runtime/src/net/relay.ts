/**
 * Local capture + control relay (cornerstone of the model-control layer).
 *
 * A small HTTP server the IDE's model client points at (e.g. Codex's Rust core
 * via `~/.codex/config.toml` `base_url`). It forwards each request to a
 * configured upstream — optionally through a proxy (e.g. `http://127.0.0.1:7897`
 * for CN networks) — streams the response back, and feeds the framework's
 * traffic recorder so the model traffic shows up in the Network inspector and
 * streams to a paired phone over the bus.
 *
 * Why this exists: out-of-process model clients (Codex's `codex app-server`,
 * Windsurf's `language_server`) are invisible to Electron injection, so the only
 * way to observe/redirect/race their model requests is to redirect them here.
 *
 * Forwarding uses `undici.request` (not global `fetch`/`http`) on purpose: our
 * own Node interceptor patches `fetch`/`http`/`https`, and undici's separate
 * socket stack bypasses it, so the relay never captures or races itself.
 */

import http from "node:http";
import { request as undiciRequest, ProxyAgent, type Dispatcher } from "undici";

import { responsesToChat, ResponsesStreamConverter } from "./protocol/responses-chat.js";
import { applySystemTransforms, applyParams, transformsActive, type RelayTransforms } from "./transform.js";

export interface RelayObservedRequest {
  id: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
  bodyEncoding: "utf8" | "base64";
}

export interface RelayObservedResponse {
  requestId: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string | null;
}

export interface RelayOptions {
  /** Local port to listen on (127.0.0.1 only). 0 = ephemeral. */
  port: number;
  /** Upstream base URL, e.g. "https://api.openai.com/v1" or "http://127.0.0.1:57321/v1". */
  upstream: string;
  /** Optional outbound proxy, e.g. "http://127.0.0.1:7897". */
  proxy?: string;
  /** Inject "Authorization: Bearer <key>" when the client didn't send one. */
  apiKey?: string;
  /** Cap on recorded body size (bytes). 0 = unlimited. */
  maxBodyBytes?: number;
  /**
   * Rewrite the JSON body's `model` before forwarding. Keys may be exact
   * ("gpt-5.4") or a `prefix*` wildcard ("gpt-5*"); first match wins. Fixes IDEs
   * that send model names the upstream rejects (e.g. Codex → DeepSeek backend).
   */
  modelMap?: Record<string, string>;
  /**
   * If the (rewritten) request errors with a `retryStatuses` code, retry the
   * same request with each of these models in order until one is accepted.
   */
  fallbackModels?: string[];
  /** Status codes that trigger failover to the next fallback model. */
  retryStatuses?: number[];
  /**
   * Upstream wire protocol. "chat" makes the relay translate Codex's Responses
   * API (`/v1/responses`) to/from Chat Completions (`/v1/chat/completions`) so
   * chat-only backends (DeepSeek, most relays) work. Default "responses" (passthrough).
   */
  upstreamApi?: "responses" | "chat";
  /** In-flight request transforms (system prompt / rules / params) applied before forwarding. */
  transforms?: RelayTransforms;
}

export interface RelayHooks {
  log: (level: string, ...args: unknown[]) => void;
  /** Called when a request is received (for the traffic recorder). */
  onRequest?: (r: RelayObservedRequest) => void;
  /** Called when the response finishes (for the traffic recorder). */
  onResponse?: (r: RelayObservedResponse) => void;
}

export interface RelayHandle {
  port: number;
  close(): Promise<void>;
}

// Hop-by-hop / length / encoding headers that must not be forwarded verbatim.
const STRIP_REQ = new Set(["host", "connection", "keep-alive", "proxy-connection", "content-length", "transfer-encoding", "accept-encoding"]);
const STRIP_RES = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "content-length", "content-encoding"]);

/**
 * Join an upstream base URL with the incoming request path. If both carry the
 * same version segment (e.g. base `…/v1` + path `/v1/responses`), the duplicate
 * is dropped so the result is `…/v1/responses`, not `…/v1/v1/responses`.
 */
export function joinUpstream(upstream: string, reqUrl: string): string {
  const base = upstream.replace(/\/+$/, "");
  let path = reqUrl || "/";
  const baseTail = /\/(v\d+)$/.exec(base)?.[1];
  if (baseTail && new RegExp(`^/${baseTail}(/|$|\\?)`).test(path)) {
    path = path.replace(new RegExp(`^/${baseTail}`), "");
  }
  if (path === "") return base;
  if (!path.startsWith("/")) path = `/${path}`;
  return base + path;
}

/**
 * Build the forwarded request headers: drop hop-by-hop/length/encoding, force
 * `accept-encoding: identity` (so the body stays readable for capture and a
 * verbatim passthrough is correct), and inject auth if absent.
 */
export function buildForwardHeaders(
  incoming: Record<string, string>,
  opts: { apiKey?: string } = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (STRIP_REQ.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  out["accept-encoding"] = "identity";
  if (opts.apiKey) {
    // The relay holds the real upstream key: replace whatever the client sent
    // (Codex sends the provider's placeholder token; we swap in the real one).
    for (const k of Object.keys(out)) if (k.toLowerCase() === "authorization") delete out[k];
    out["authorization"] = `Bearer ${opts.apiKey}`;
  }
  return out;
}

/**
 * Resolve a model name through a rewrite map. Exact key wins; otherwise the
 * first `prefix*` wildcard whose prefix matches. Returns the input unchanged
 * when nothing matches.
 */
export function rewriteModel(model: string, map: Record<string, string>): string {
  if (Object.prototype.hasOwnProperty.call(map, model)) return map[model];
  for (const [k, v] of Object.entries(map)) {
    if (k.endsWith("*") && model.startsWith(k.slice(0, -1))) return v;
  }
  return model;
}

/** Strip hop-by-hop/length/encoding from the upstream response before relaying. */
export function filterResponseHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (STRIP_RES.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

function flattenIncoming(headers: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    out[k] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  return out;
}

function flattenUndici(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    out[k] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  return out;
}

function decodeBody(buf: Buffer): { body: string | null; bodyEncoding: "utf8" | "base64" } {
  if (buf.length === 0) return { body: null, bodyEncoding: "utf8" };
  // Heuristic: if it round-trips as UTF-8, store text; otherwise base64.
  const text = buf.toString("utf8");
  if (Buffer.from(text, "utf8").equals(buf)) return { body: text, bodyEncoding: "utf8" };
  return { body: buf.toString("base64"), bodyEncoding: "base64" };
}

let counter = 0;
function newId(): string {
  counter = (counter + 1) % 1_000_000;
  return `relay-${Date.now().toString(36)}-${counter.toString(36)}`;
}

/**
 * Start the relay server. Resolves once it is listening. Forwarding bypasses the
 * framework's own fetch/http patches (undici), so it never self-captures.
 */
export function startRelay(opts: RelayOptions, hooks: RelayHooks): Promise<RelayHandle> {
  const cap = opts.maxBodyBytes ?? 1024 * 1024;
  const dispatcher: Dispatcher | undefined = opts.proxy ? new ProxyAgent(opts.proxy) : undefined;

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((e) => {
      hooks.log("warn", `relay: handler error: ${String(e)}`);
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      if (!res.writableEnded) res.end(JSON.stringify({ error: { message: `relay error: ${String(e)}` } }));
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const id = newId();
    const method = (req.method ?? "GET").toUpperCase();
    // Translate Codex's Responses API to chat/completions when the upstream is
    // chat-only; the forward path becomes /v1/chat/completions.
    const translate = opts.upstreamApi === "chat" && /\/responses(\?|$)/.test(req.url ?? "");
    const target = translate
      ? joinUpstream(opts.upstream, "/v1/chat/completions")
      : joinUpstream(opts.upstream, req.url ?? "/");

    // Buffer the (small) request body.
    const reqChunks: Buffer[] = [];
    let reqTotal = 0;
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      reqChunks.push(buf);
      reqTotal += buf.length;
    }
    const reqBuf = Buffer.concat(reqChunks, reqTotal);
    const incoming = flattenIncoming(req.headers);
    const fwdHeaders = buildForwardHeaders(incoming, { apiKey: opts.apiKey });
    const isBodyless = method === "GET" || method === "HEAD";

    // Build the candidate model list from a JSON body: the mapped model first,
    // then any fallbacks. `baseObj` lets us re-serialize per attempt.
    let baseObj: Record<string, unknown> | null = null;
    let originalModel: string | null = null;
    let candidates: string[] = [];
    if (!isBodyless && reqBuf.length > 0 && /json/i.test(incoming["content-type"] ?? "")) {
      try {
        const parsedRaw = JSON.parse(reqBuf.toString("utf8")) as Record<string, unknown>;
        // In-flight transforms (system prompt / rules) apply to the original body
        // before translation, so they carry through either protocol; params apply
        // to the final forwarded body.
        const shaped = applySystemTransforms(parsedRaw, opts.transforms);
        const translated = translate ? (responsesToChat(shaped) as Record<string, unknown>) : shaped;
        const parsed = applyParams(translated, opts.transforms);
        if (translate || typeof parsed.model === "string" || transformsActive(opts.transforms)) baseObj = parsed;
        if (typeof parsed.model === "string") {
          originalModel = parsed.model;
          const mapped = rewriteModel(parsed.model, opts.modelMap ?? {});
          candidates = [mapped, ...(opts.fallbackModels ?? []).filter((m) => m !== mapped)];
        }
      } catch {
        /* not a JSON body we can translate/rewrite — forward verbatim */
      }
    }

    const retry = new Set(opts.retryStatuses ?? [429, 500, 502, 503]);
    const attempts: (string | null)[] = candidates.length > 0 ? candidates : [null];

    let upstream: Dispatcher.ResponseData | null = null;
    let sentBody = baseObj ? Buffer.from(JSON.stringify(baseObj)) : reqBuf;
    let sentModel = originalModel;

    for (let i = 0; i < attempts.length; i++) {
      const m = attempts[i];
      if (m !== null && baseObj) {
        baseObj.model = m;
        sentBody = Buffer.from(JSON.stringify(baseObj));
        sentModel = m;
      }
      try {
        upstream = await undiciRequest(target, {
          method: method as Dispatcher.HttpMethod,
          headers: fwdHeaders,
          body: isBodyless ? undefined : sentBody,
          dispatcher,
        });
      } catch (e) {
        if (i < attempts.length - 1) {
          hooks.log("warn", `relay: attempt "${sentModel}" failed (${String(e)}); trying next`);
          continue;
        }
        hooks.log("warn", `relay: upstream failed ${target}: ${String(e)}`);
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `relay upstream failed: ${String(e)}` } }));
        hooks.onResponse?.({ requestId: id, status: 502, statusText: "Bad Gateway", headers: {}, body: String(e) });
        return;
      }
      if (i < attempts.length - 1 && retry.has(upstream.statusCode)) {
        hooks.log("info", `relay: model "${sentModel}" → ${upstream.statusCode}; failing over to "${attempts[i + 1]}"`);
        try {
          await upstream.body.dump();
        } catch {
          /* ignore drain error */
        }
        continue;
      }
      break;
    }
    if (!upstream) return; // unreachable, but satisfies the type checker

    if (originalModel && sentModel !== originalModel) {
      hooks.log("info", `relay: rewrote model "${originalModel}" → "${sentModel}"`);
    }

    // Record the request as actually forwarded (post-rewrite), paired with the response.
    const reqDecoded = decodeBody(sentBody.subarray(0, cap > 0 ? cap : sentBody.length));
    hooks.onRequest?.({ id, method, url: target, headers: fwdHeaders, ...reqDecoded });

    const resHeaders = flattenUndici(upstream.headers as Record<string, string | string[] | undefined>);
    res.writeHead(upstream.statusCode, filterResponseHeaders(resHeaders));

    // Translate mode: convert the chat/completions SSE into the Responses event
    // stream Codex expects, teeing the converted (Responses) bytes for the recorder.
    if (translate && /event-stream/i.test(resHeaders["content-type"] ?? "")) {
      const conv = new ResponsesStreamConverter();
      const recT: Buffer[] = [];
      let recN = 0;
      const emit = (s: string): void => {
        if (!s) return;
        res.write(s);
        if (cap <= 0 || recN < cap) {
          const b = Buffer.from(s, "utf8");
          recT.push(recN + b.length > cap && cap > 0 ? b.subarray(0, cap - recN) : b);
          recN += b.length;
        }
      };
      upstream.body.on("data", (chunk: Buffer) => emit(conv.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk))));
      upstream.body.on("end", () => {
        emit(conv.finish());
        res.end();
        hooks.onResponse?.({
          requestId: id,
          status: upstream!.statusCode,
          statusText: "",
          headers: resHeaders,
          body: decodeBody(Buffer.concat(recT)).body,
        });
      });
      upstream.body.on("error", (e) => {
        hooks.log("warn", `relay: upstream stream error: ${String(e)}`);
        if (!res.writableEnded) res.destroy();
      });
      return;
    }

    // Stream the body to the client while teeing a capped copy for the recorder.
    const recChunks: Buffer[] = [];
    let recTotal = 0;
    upstream.body.on("data", (chunk: Buffer) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (cap <= 0 || recTotal < cap) {
        const room = cap <= 0 ? buf.length : cap - recTotal;
        recChunks.push(room < buf.length ? buf.subarray(0, room) : buf);
        recTotal += buf.length;
      }
    });
    upstream.body.on("end", () => {
      const decoded = decodeBody(Buffer.concat(recChunks));
      hooks.onResponse?.({
        requestId: id,
        status: upstream.statusCode,
        statusText: "",
        headers: resHeaders,
        body: decoded.body,
      });
    });
    upstream.body.on("error", (e) => {
      hooks.log("warn", `relay: upstream stream error: ${String(e)}`);
      if (!res.writableEnded) res.destroy();
    });
    upstream.body.pipe(res);
  }

  return new Promise<RelayHandle>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : opts.port;
      hooks.log(
        "info",
        `relay listening on http://127.0.0.1:${port} → ${opts.upstream}${opts.proxy ? ` (via ${opts.proxy})` : ""}`,
      );
      resolve({
        port,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}
