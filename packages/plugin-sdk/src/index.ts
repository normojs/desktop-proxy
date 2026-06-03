/**
 * desktop-proxy Plugin SDK
 *
 * TypeScript type definitions for the Plugin API available to plugins
 * running in the desktop-proxy injection framework.
 */

// Framework-internal message bus (transport-agnostic protocol; used by the
// runtime/preload and the remote NATS transport).
export * from "./bus";

// ── Plugin Manifest ──────────────────────────────────────────────────────────

export interface PluginManifest {
  /** Unique reverse-domain identifier (e.g. "com.example.my-plugin") */
  id: string;
  /** Human-readable name */
  name: string;
  /** Semantic version */
  version: string;
  /** Short description */
  description: string;
  /** Plugin author */
  author?: string;
  /** Entry point file relative to plugin root */
  main: string;
  /** Execution scope */
  scope: "main" | "renderer" | "both";
  /** Icon URL (data: or https:) */
  iconUrl?: string;
  /** GitHub repository (owner/repo) for update checks */
  githubRepo?: string;
  /** Minimum desktop-proxy version required */
  minDesktopProxyVersion?: string;
  /** Capabilities the plugin requests (e.g. "cdp"). Gates powerful APIs. */
  permissions?: string[];
}

// ── Plugin API (available to plugins at runtime) ─────────────────────────────

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Order used to compare levels; "silent" suppresses everything. */
const LOG_ORDER: Record<LogLevel | "silent", number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

/** True if `target` messages should be emitted given a `threshold` level. */
export function isLevelEnabled(target: LogLevel, threshold: string): boolean {
  const t = (LOG_ORDER as Record<string, number>)[threshold] ?? LOG_ORDER.info;
  return LOG_ORDER[target] >= t;
}

export interface PluginLogger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  /** Guard expensive log construction: only build/log when the level is active. */
  isEnabled(level: LogLevel): boolean;
}

export interface PluginStorage {
  get<T = unknown>(key: string, defaultValue?: T): T;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  all(): Record<string, unknown>;
}

export interface SettingsSection {
  id: string;
  title: string;
  render(root: HTMLElement): void | (() => void);
}

export interface SettingsPage {
  id: string;
  title: string;
  iconSvg?: string;
  description?: string;
  render(root: HTMLElement): void | (() => void);
}

export type UnregisterHandle = { unregister(): void };

export interface PluginSettings {
  registerSection(section: SettingsSection): UnregisterHandle;
  registerPage(page: SettingsPage): UnregisterHandle;
}

export interface ReactAPI {
  /** Get the React fiber node for a DOM node */
  getFiber(node: Node): unknown;
  /** Walk up the fiber tree to find an owner by component name */
  findOwnerByName(node: Node, name: string): unknown;
  /** Wait for a DOM element to appear (MutationObserver-based) */
  waitForElement(selector: string, timeoutMs?: number): Promise<Element>;
}

export type UnsubscribeFn = () => void;

export interface PluginIPC {
  on(channel: string, handler: (...args: unknown[]) => void): UnsubscribeFn;
  send(channel: string, ...args: unknown[]): void;
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>;
}

/**
 * Pub/sub event bus that spans the main process, all renderers, and plugins —
 * routed through the main process. Use it for cross-plugin / cross-process
 * coordination without hand-rolling IPC channel names. The framework also
 * publishes well-known topics like `config:changed` and `plugins:changed`.
 */
export interface PluginEvents {
  on(topic: string, handler: (data: unknown) => void): UnsubscribeFn;
  emit(topic: string, data?: unknown): void;
}

// ── Network Interception (primary use case) ──────────────────────────────────

/** Where an intercepted request/response was observed. */
export type NetworkSource = "renderer-cdp" | "node-http" | "web-request" | "renderer-hook" | "relay";

export interface NetworkRequest {
  id: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
  timestamp: number;
  /** Type discriminator */
  _type: "fetch" | "xhr" | "node" | "websocket";
  /** Interception surface this came from (optional for back-compat). */
  source?: NetworkSource;
  /** Encoding of `body` ("utf8" by default; "base64" for binary). */
  bodyEncoding?: "utf8" | "base64";
}

export interface NetworkResponse {
  id: string;
  requestId: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string | null;
  timestamp: number;
  /** True if `body` was truncated at the configured cap. */
  truncated?: boolean;
  /** Interception surface this came from (optional for back-compat). */
  source?: NetworkSource;
  /** Encoding of `body` ("utf8" by default; "base64" for binary). */
  bodyEncoding?: "utf8" | "base64";
}

export type NetworkRequestHandler = (request: NetworkRequest) => NetworkRequest | void | Promise<NetworkRequest | void>;
export type NetworkResponseHandler = (response: NetworkResponse) => NetworkResponse | void | Promise<NetworkResponse | void>;

export interface NetworkContinueMods {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  bodyEncoding?: "utf8" | "base64";
}

export interface NetworkFulfill {
  status: number;
  headers?: Record<string, string>;
  body?: string;
  bodyEncoding?: "utf8" | "base64";
}

/** Decide a paused request's fate. The first handler to act wins. */
export interface NetworkRequestControl {
  /** Let it proceed, optionally with modifications. */
  continue(mods?: NetworkContinueMods): void;
  /** Short-circuit with a synthetic (mock) response. */
  fulfill(response: NetworkFulfill): void;
  /** Block the request. */
  fail(reason?: string): void;
}

export type NetworkInterceptHandler = (
  request: NetworkRequest,
  control: NetworkRequestControl,
) => void | Promise<void>;

export interface NetworkInterceptFilter {
  /** Only run for URLs containing one of these substrings. */
  urls?: string[];
}

/** Decide a real (already-received) response's fate. The first handler to act wins. */
export interface NetworkResponseControl {
  /** Pass the response through unchanged. */
  continue(): void;
  /** Replace parts of the response (unspecified fields keep their real values). */
  fulfill(response: {
    status?: number;
    headers?: Record<string, string>;
    body?: string;
    bodyEncoding?: "utf8" | "base64";
  }): void;
}

export type NetworkResponseInterceptHandler = (
  response: NetworkResponse,
  control: NetworkResponseControl,
) => void | Promise<void>;

export interface StreamTransformContext {
  /** Send observation data back to the plugin (async; for telemetry/capture). */
  emit(data: unknown): void;
}

/**
 * Transform a streaming response chunk-by-chunk. Runs IN THE PAGE (main world),
 * so it must be SELF-CONTAINED — no closures over plugin scope, no imports.
 * Return a string to emit, `null` to drop the chunk, or `undefined` to pass it
 * through unchanged.
 */
export type StreamTransformFn = (chunk: string, ctx: StreamTransformContext) => string | null | undefined | void;

export interface StreamTransformOptions {
  /** "chunk" = per decoded chunk; "sse" = buffered to `\n\n` event boundaries. */
  mode?: "chunk" | "sse";
  /** Receives data passed to `ctx.emit(...)` from the page (runs in the plugin). */
  onEmit?: (data: unknown) => void;
}

// ── WebSocket ────────────────────────────────────────────────────────────────

/** A WebSocket lifecycle/frame event observed via CDP (passive). */
export interface WebSocketEvent {
  /** CDP requestId identifying the socket (stable for its lifetime). */
  id: string;
  type: "open" | "sent" | "received" | "close" | "error";
  /** Present on "open". */
  url?: string;
  /** Frame payload: text for opcode 1, otherwise base64 binary. Present on sent/received. */
  data?: string;
  /** WebSocket opcode: 1 text, 2 binary, 8 close, 9 ping, 10 pong. */
  opcode?: number;
  /** True when the frame is binary (opcode !== 1). */
  binary?: boolean;
  /** Present on "error". */
  error?: string;
  source?: NetworkSource;
  timestamp: number;
}

export type WebSocketHandler = (evt: WebSocketEvent) => void;

export interface WsTransformContext {
  /** The socket URL. */
  url: string;
  /** "send" = outbound (page → server); "receive" = inbound (server → page). */
  direction: "send" | "receive";
  /** Send observation data back to the plugin (runs in the plugin). */
  emit(data: unknown): void;
}

/**
 * Transform a WebSocket text frame in either direction. Runs IN THE PAGE (main
 * world), so it must be SELF-CONTAINED. Inspect `ctx.direction` to tell outbound
 * ("send") from inbound ("receive"). Return a string to replace the frame,
 * `null` to drop it, or `undefined` to pass it through unchanged. Binary frames
 * (ArrayBuffer/Blob) are passed through untouched.
 */
export type WsTransformFn = (data: string, ctx: WsTransformContext) => string | null | undefined | void;

export interface WsTransformOptions {
  /** Receives data passed to `ctx.emit(...)` from the page (runs in the plugin). */
  onEmit?: (data: unknown) => void;
}

// ── Request racing / failover ────────────────────────────────────────────────

/** A variant request derived from the original (e.g. a different key/endpoint/model). */
export interface RaceVariant {
  url?: string;
  method?: string;
  /** Headers to merge over the original (e.g. a different Authorization). */
  headers?: Record<string, string>;
  /** Replacement body (defaults to the original request body). */
  body?: string | null;
}

/** The original request, passed to `variants(...)`. */
export interface RaceRequestContext {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

export interface RaceAttempt {
  index: number;
  status: number | null;
  ok: boolean;
  error?: string;
  ms: number;
}

export interface RaceResult {
  /** Index of the accepted variant, or null if none were accepted. */
  winnerIndex: number | null;
  attempts: RaceAttempt[];
  totalMs: number;
  /** True if the total timeout fired. */
  timedOut?: boolean;
}

export interface RaceRequestOptions {
  /** Produce the variants to try for a matched request. */
  variants: (req: RaceRequestContext) => RaceVariant[];
  /**
   * "race" = fire variants concurrently (up to `concurrency`) and take the first
   * accepted; "fallback" = try sequentially, moving on only when one is rejected.
   * Default "race".
   */
  mode?: "race" | "fallback";
  /** Max concurrent in-flight variants in "race" mode (default: all). */
  concurrency?: number;
  /** Abort an individual variant after this many ms (0 = no limit). */
  perRequestTimeoutMs?: number;
  /** Abort the whole race after this many ms (0 = no limit). */
  totalTimeoutMs?: number;
  /**
   * Decide whether a variant's response is acceptable, from status + headers
   * only (so the body keeps streaming). Default: 2xx.
   */
  accept?: (status: number, headers: Record<string, string>) => boolean;
  /** Telemetry callback with the race outcome. */
  onResult?: (result: RaceResult) => void;
}

export interface PluginNetwork {
  onRequest(handler: NetworkRequestHandler): UnsubscribeFn;
  onResponse(handler: NetworkResponseHandler): UnsubscribeFn;
  /**
   * Intercept requests with full control (continue/modify, fulfill/mock, fail/block).
   * Requires CDP request interception to be enabled (config `cdpIntercept`).
   */
  intercept(handler: NetworkInterceptHandler, filter?: NetworkInterceptFilter): UnsubscribeFn;
  /**
   * Modify real responses. Only URLs matching `filter` are buffered+rewritten
   * (so other responses keep streaming); pass a `filter.urls` to scope it.
   * Requires `cdpIntercept`.
   */
  interceptResponse(handler: NetworkResponseInterceptHandler, filter?: NetworkInterceptFilter): UnsubscribeFn;
  /**
   * Transform a streaming response (e.g. SSE token streams) chunk-by-chunk while
   * preserving streaming. The transform runs in the page's main world. Requires
   * `cdpStreamTransform`.
   */
  transformStream(
    filter: NetworkInterceptFilter,
    transform: StreamTransformFn,
    opts?: StreamTransformOptions,
  ): UnsubscribeFn;
  /**
   * Observe WebSocket lifecycle and frames (open/sent/received/close/error) for
   * renderer sockets, captured passively via CDP. Requires `cdpNetwork`.
   */
  onWebSocket(handler: WebSocketHandler): UnsubscribeFn;
  /**
   * Rewrite WebSocket text frames in both directions (outbound before send,
   * inbound before the page sees them) — branch on `ctx.direction`. The transform
   * runs in the page's main world. Requires `cdpWsTransform`.
   */
  transformWebSocket(
    filter: NetworkInterceptFilter,
    transform: WsTransformFn,
    opts?: WsTransformOptions,
  ): UnsubscribeFn;
  /**
   * Race / fail over a matched request across several variants (e.g. multiple
   * API keys, endpoints, or models) and return the first ACCEPTED response —
   * streaming-safe (acceptance is decided from status + headers, the winner's
   * body streams through, losers are aborted). Main-scope; currently applies to
   * main-process `fetch` (undici) requests.
   */
  raceRequest(filter: NetworkInterceptFilter, opts: RaceRequestOptions): UnsubscribeFn;
}

// ── Sandboxed Filesystem ─────────────────────────────────────────────────────

export type FileEncoding = "utf8" | "base64";

export interface PluginFileStat {
  size: number;
  isFile: boolean;
  isDirectory: boolean;
  mtimeMs: number;
}

/**
 * Sandboxed filesystem access. All paths are relative to (and confined within)
 * the plugin's private data directory; paths that escape it are rejected. Use
 * "base64" encoding for binary data.
 */
export interface PluginFS {
  read(path: string, encoding?: FileEncoding): Promise<string>;
  write(path: string, data: string, encoding?: FileEncoding): Promise<void>;
  exists(path: string): Promise<boolean>;
  list(path?: string): Promise<string[]>;
  delete(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  stat(path: string): Promise<PluginFileStat>;
}

// ── Chrome DevTools Protocol (CDP) ───────────────────────────────────────────

export interface CDPEvaluateOptions {
  /** Await a returned promise before resolving (default true). */
  awaitPromise?: boolean;
  /** Return the value by value rather than a remote object handle (default true). */
  returnByValue?: boolean;
}

/**
 * The minimal CDP surface each process implements (renderer targets its own
 * webContents; main targets the focused/first window). Requires the "cdp"
 * permission. Backed by Electron's in-process `webContents.debugger` (no remote
 * debugging port). Enable the relevant domain (e.g. `send("Network.enable")`)
 * before its events are delivered to `on(...)`.
 */
export interface PluginCDPCore {
  attach(): Promise<void>;
  detach(): Promise<void>;
  isAttached(): Promise<boolean>;
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  on(event: string, handler: (params: unknown) => void): UnsubscribeFn;
}

export interface CDPResponseMeta {
  requestId: string;
  url: string;
  status: number;
  mimeType: string;
  headers: Record<string, string>;
  /** Fetch the response body (available once the response has finished loading). */
  getBody(): Promise<{ body: string; base64Encoded: boolean }>;
}

export interface CDPInterceptedRequest {
  requestId: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  resourceType: string;
}

export interface CDPFulfillResponse {
  responseCode: number;
  responseHeaders?: { name: string; value: string }[];
  /** Response body, base64-encoded. */
  body?: string;
}

export interface CDPRequestControl {
  continue(): Promise<void>;
  fulfill(response: CDPFulfillResponse): Promise<void>;
  fail(errorReason?: string): Promise<void>;
}

export interface PluginCDP extends PluginCDPCore {
  /** Convenience wrapper around `Runtime.evaluate` (runs in the page's main world). */
  evaluate<T = unknown>(expression: string, options?: CDPEvaluateOptions): Promise<T>;
  /** Enable the Network domain and observe responses; `getBody()` fetches lazily. */
  onResponse(handler: (response: CDPResponseMeta) => void): Promise<UnsubscribeFn>;
  /** Enable the Fetch domain and intercept requests; resolve each via the control object. */
  onRequestPaused(
    handler: (request: CDPInterceptedRequest, control: CDPRequestControl) => void,
  ): Promise<UnsubscribeFn>;
}

/** Build the full CDP API (evaluate + Network/Fetch helpers) from the core methods. */
export function createCDP(core: PluginCDPCore): PluginCDP {
  return {
    attach: () => core.attach(),
    detach: () => core.detach(),
    isAttached: () => core.isAttached(),
    send: <T = unknown>(method: string, params?: Record<string, unknown>) => core.send<T>(method, params),
    on: (event, handler) => core.on(event, handler),

    evaluate: async <T = unknown>(expression: string, options?: CDPEvaluateOptions): Promise<T> => {
      const result = await core.send<{ result?: { value?: unknown } }>("Runtime.evaluate", {
        expression,
        awaitPromise: options?.awaitPromise ?? true,
        returnByValue: options?.returnByValue ?? true,
      });
      return result?.result?.value as T;
    },

    onResponse: async (handler) => {
      await core.send("Network.enable");
      return core.on("Network.responseReceived", (params) => {
        const p = params as {
          requestId: string;
          response: { url: string; status: number; mimeType: string; headers?: Record<string, string> };
        };
        handler({
          requestId: p.requestId,
          url: p.response.url,
          status: p.response.status,
          mimeType: p.response.mimeType,
          headers: p.response.headers ?? {},
          getBody: () =>
            core.send<{ body: string; base64Encoded: boolean }>("Network.getResponseBody", {
              requestId: p.requestId,
            }),
        });
      });
    },

    onRequestPaused: async (handler) => {
      await core.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
      return core.on("Fetch.requestPaused", (params) => {
        const p = params as {
          requestId: string;
          request: { url: string; method: string; headers?: Record<string, string> };
          resourceType: string;
        };
        handler(
          {
            requestId: p.requestId,
            url: p.request.url,
            method: p.request.method,
            headers: p.request.headers ?? {},
            resourceType: p.resourceType,
          },
          {
            continue: () =>
              core.send("Fetch.continueRequest", { requestId: p.requestId }).then(() => undefined),
            fulfill: (r) =>
              core
                .send("Fetch.fulfillRequest", {
                  requestId: p.requestId,
                  responseCode: r.responseCode,
                  responseHeaders: r.responseHeaders,
                  body: r.body,
                })
                .then(() => undefined),
            fail: (errorReason) =>
              core
                .send("Fetch.failRequest", {
                  requestId: p.requestId,
                  errorReason: errorReason ?? "Failed",
                })
                .then(() => undefined),
          },
        );
      });
    },
  };
}

// ── App Info ─────────────────────────────────────────────────────────────────

export interface AppInfo {
  name: string;
  version: string;
  electronVersion: string;
  platform: string;
  runtimeDir: string;
  userRoot: string;
}

export interface WindowInfo {
  id: number;
  title: string;
  url: string;
  focused: boolean;
}

export interface PluginApp {
  getInfo(): Promise<AppInfo>;
  getWindows(): Promise<WindowInfo[]>;
}

// ── UI helpers ───────────────────────────────────────────────────────────────

export interface ToastOptions {
  /** Auto-dismiss delay in milliseconds (default 3000). */
  durationMs?: number;
  type?: "info" | "success" | "error";
}

/** Small DOM conveniences for renderer plugins. */
export interface PluginUI {
  /** Inject a stylesheet into the page; returns a remover. */
  injectCSS(css: string): UnsubscribeFn;
  /** Show a transient notification in a host-isolated overlay. */
  toast(message: string, options?: ToastOptions): void;
}

// ── Full Plugin API ──────────────────────────────────────────────────────────

export interface PluginAPI {
  manifest: PluginManifest;
  process: "main" | "renderer";

  log: PluginLogger;
  storage: PluginStorage;
  settings: PluginSettings;
  react: ReactAPI;
  ipc: PluginIPC;
  events: PluginEvents;
  network: PluginNetwork;
  fs: PluginFS;
  cdp: PluginCDP;
  ui: PluginUI;
  app: PluginApp;
}

// ── Plugin Module Shape ──────────────────────────────────────────────────────

export interface PluginModule {
  start(api: PluginAPI): void | Promise<void>;
  stop?(): void | Promise<void>;
}

// ── Versioning ───────────────────────────────────────────────────────────────

/** Normalize a version/tag (`v1.2.3-beta+1` → `1.2.3`) to its numeric core. */
function normalizeVersion(v: string): number[] {
  return v
    .trim()
    .replace(/^v/i, "")
    .split(/[-+]/)[0]
    .split(".")
    .map((n) => parseInt(n, 10) || 0);
}

/** Compare two semver-ish versions: -1 if a<b, 0 if equal, 1 if a>b. */
export function compareVersions(a: string, b: string): number {
  const pa = normalizeVersion(a);
  const pb = normalizeVersion(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/** True if `version` is >= `min` (or `min` is unset). */
export function satisfiesMinVersion(version: string, min: string | undefined): boolean {
  if (!min) return true;
  return compareVersions(version, min) >= 0;
}

// ── Validation ───────────────────────────────────────────────────────────────

export function validateManifest(m: unknown): { valid: true; manifest: PluginManifest } | { valid: false; errors: string[] } {
  const errors: string[] = [];
  if (!m || typeof m !== "object") return { valid: false, errors: ["manifest must be an object"] };

  const manifest = m as Record<string, unknown>;

  if (typeof manifest.id !== "string" || !manifest.id) errors.push("id must be a non-empty string");
  if (typeof manifest.name !== "string" || !manifest.name) errors.push("name must be a non-empty string");
  if (typeof manifest.version !== "string" || !manifest.version) errors.push("version must be a non-empty string");
  if (typeof manifest.main !== "string" || !manifest.main) errors.push("main must be a non-empty string");
  if (!["main", "renderer", "both"].includes(manifest.scope as string)) errors.push('scope must be "main", "renderer", or "both"');
  if (manifest.permissions !== undefined && (!Array.isArray(manifest.permissions) || manifest.permissions.some((p) => typeof p !== "string"))) {
    errors.push("permissions must be an array of strings");
  }

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, manifest: m as PluginManifest };
}
