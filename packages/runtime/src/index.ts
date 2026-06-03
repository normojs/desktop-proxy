/**
 * Main process runtime entry point.
 *
 * This module is required by the loader stub BEFORE the target app's original
 * entry point. It hooks Electron's session system to register our preload
 * script in every BrowserWindow, manages plugin lifecycle, and sets up the
 * IPC bridge between main and renderer processes.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { randomBytes } from "node:crypto";

import { createCDP, satisfiesMinVersion } from "@desktop-proxy/plugin-sdk";
import type { PluginCDPCore } from "@desktop-proxy/plugin-sdk";

import { createMainNetwork, type MainNetwork } from "./network";
import { createMainCDP, type MainCDP } from "./cdp";
import { createCdpNetworkObserver, type CdpNetworkObserver } from "./net/cdp-network";
import { createMainWorldHost, type MainWorldHost } from "./net/main-world";
import { createTrafficRecorder, type TrafficRecorder } from "./net/traffic-recorder";
import { createRendererInterceptRouter, type RendererInterceptRouter } from "./net/renderer-intercept";
import { createTrafficWriter } from "./net/traffic-persist";
import { createPluginStorage } from "./storage";
import { createBusRouter, type BusRouter } from "@desktop-proxy/plugin-sdk";
import { createMainIpcTransport } from "./bus-ipc";
import type { NetDecision } from "./net/intercept";
import { createLogger, parseLevel, type Logger } from "./logger";
import {
  pluginDataDir,
  fsRead,
  fsWrite,
  fsExists,
  fsList,
  fsDelete,
  fsMkdir,
  fsStat,
} from "./fs-sandbox";

// Resolve user data paths from environment variables set by loader.
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`desktop-proxy runtime started without ${name} env var`);
  }
  return value;
}

const userRoot = requireEnv("DESKTOP_PROXY_USER_ROOT");
const runtimeDir = requireEnv("DESKTOP_PROXY_RUNTIME");

/** Framework version, used to enforce a plugin's minDesktopProxyVersion. */
const FRAMEWORK_VERSION = "0.1.0";

const PRELOAD_PATH = path.resolve(runtimeDir, "preload.js");
const PLUGINS_DIR = path.join(userRoot, "plugins");
const LOG_DIR = path.join(userRoot, "log");
const CONFIG_FILE = path.join(userRoot, "config.json");
const SAFE_MODE_FILE = path.join(userRoot, "safe-mode");

// Ensure directories exist
fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(PLUGINS_DIR, { recursive: true });

// Unified plugin KV store (single backend for api.storage in both scopes).
const pluginStorage = createPluginStorage(userRoot);

// Message bus (hub). One protocol for events (pub/sub) and RPC over pluggable
// transports — Electron IPC now, NATS for remote/phone later. The main router is
// the hub (bridge: true); renderer routers are leaves.
let _bus: BusRouter | null = null;

// Methods a REMOTE client (phone/CLI over NATS) may invoke. In-app (IPC) callers
// have full access; remote is limited to inspector + control, never fs/cdp/etc.
const REMOTE_METHODS = new Set([
  "config.get",
  "config.set",
  "plugin.list",
  "plugin.toggle",
  "traffic.list",
  "traffic.detail",
  "traffic.replay",
  "traffic.clear",
  "traffic.export",
]);

function getBus(): BusRouter {
  if (!_bus) {
    const electron = getElectron();
    _bus = createBusRouter({
      bridge: true,
      canReceive: (env, source) => {
        if (source !== "nats") return true; // in-app IPC: full access
        if (env.kind === "req") return REMOTE_METHODS.has(env.method); // remote: allowlist only
        return true; // events/responses pass
      },
    });
    _bus.addTransport("ipc", createMainIpcTransport(electron, ch("bus"), log));
  }
  return _bus;
}

/** Stable per-install id used in NATS subjects; generated + persisted on first use. */
function getInstanceId(): string {
  const cfg = readConfig();
  if (cfg.instanceId) return cfg.instanceId;
  const id = randomBytes(8).toString("hex");
  writeConfig({ ...cfg, instanceId: id });
  return id;
}

// Remote (NATS) transport lifecycle. Off by default; connecting attaches a
// second transport to the hub router so the same protocol reaches CLI/phone.
let _natsConn: { close(): Promise<void> } | null = null;

async function syncRemote(): Promise<void> {
  const r = readConfig().remote;
  const wantOn = r?.enabled === true && typeof r.url === "string" && r.url.length > 0;

  if (wantOn && !_natsConn) {
    try {
      const { connect } = await import("nats");
      const name = `desktop-proxy:${getInstanceId()}`;
      const tls = r!.caFile ? { tls: { caFile: r!.caFile } } : {};
      let nc;
      if (r!.accountSeed && r!.accountId) {
        // Decentralized JWT: mint our own hub credentials locally.
        const [{ mintHubCreds }, { jwtAuthenticator }] = await Promise.all([import("./net/remote-jwt.js"), import("nats")]);
        const creds = await mintHubCreds(r!.accountSeed, r!.accountId, getInstanceId());
        nc = await connect({
          servers: r!.url,
          authenticator: jwtAuthenticator(creds.jwt, new TextEncoder().encode(creds.seed)),
          name,
          ...tls,
        });
      } else {
        nc = await connect({ servers: r!.url, user: r!.user, pass: r!.pass, name, ...tls });
      }
      _natsConn = nc;
      const { createNatsHubTransport } = await import("./net/nats-transport.js");
      getBus().addTransport("nats", createNatsHubTransport(nc, getInstanceId(), log));
      log("info", "remote bus connected:", r!.url);
      void (async () => {
        for await (const s of nc.status()) log("debug", "nats status:", s.type);
      })();
    } catch (e) {
      log("warn", "remote bus connect failed:", String(e));
    }
  } else if (!wantOn && _natsConn) {
    getBus().removeTransport("nats");
    try {
      await _natsConn.close();
    } catch {
      /* ignore */
    }
    _natsConn = null;
    log("info", "remote bus disconnected");
  }
}

function emitEvent(topic: string, data: unknown): void {
  getBus().publish(topic, data);
}

function onEvent(topic: string, handler: (data: unknown) => void): () => void {
  return getBus().subscribe(topic, (data) => handler(data));
}

// ── Logging ──────────────────────────────────────────────────────────────────

const LOG_FILE = path.join(LOG_DIR, "main.log");

// Level resolution order: env var → config.json → "info" default. The log file
// is size-capped so it cannot grow without bound.
const rootLogger: Logger = createLogger({
  file: LOG_FILE,
  level: parseLevel(process.env.DESKTOP_PROXY_LOG_LEVEL ?? readConfig().logLevel, "info"),
  mirrorErrorsToStderr: true,
});

function log(level: string, ...args: unknown[]): void {
  rootLogger.log(level, ...args);
}

// ── Config ───────────────────────────────────────────────────────────────────

interface Config {
  autoUpdate?: boolean;
  safeMode?: boolean;
  /** When true, minimize the framework's detectable footprint in renderers. */
  stealth?: boolean;
  /** Minimum log level: "debug" | "info" | "warn" | "error" | "silent". */
  logLevel?: string;
  /** When true, plugins must declare fs/network permissions to use those APIs. */
  enforcePermissions?: boolean;
  /** Max bytes of a response body captured for plugins (0 = unlimited). */
  maxResponseBodyBytes?: number;
  /** Observe renderer requests via CDP (catches all page requests; attaches the debugger). */
  cdpNetwork?: boolean;
  /** Enable CDP Fetch request interception so api.network.intercept can modify/block/mock. */
  cdpIntercept?: boolean;
  /** Inject a main-world wrapper so api.network.transformStream can rewrite streaming responses. */
  cdpStreamTransform?: boolean;
  /** Inject a main-world wrapper so api.network.transformWebSocket can rewrite outbound WS frames. */
  cdpWsTransform?: boolean;
  /** Inject a main-world wrapper so api.network.raceRequest also races renderer-origin fetches. */
  cdpRaceRequest?: boolean;
  /** Record recent network traffic for the built-in Network viewer + HAR export. */
  captureTraffic?: boolean;
  /** Also append finalized traffic to disk (log/traffic.ndjson) for post-mortem. */
  persistTraffic?: boolean;
  /**
   * Local model-traffic relay. Point an out-of-process model client (e.g. Codex's
   * core via ~/.codex/config.toml base_url) at http://127.0.0.1:<port> so its
   * requests are captured (inspector + bus) and forwarded upstream. See
   * `dprox relay`. The only way to observe model traffic that lives outside the
   * Electron processes (Codex Rust core, Windsurf language server).
   */
  relay?: {
    enabled?: boolean;
    /** Local port to listen on (default 8788). */
    port?: number;
    /** Upstream base URL, e.g. https://api.openai.com/v1 or http://127.0.0.1:57321/v1. */
    upstream?: string;
    /** Optional outbound proxy for the forward (e.g. http://127.0.0.1:7897). */
    proxy?: string;
    /** Inject Authorization: Bearer <key> when the client didn't send one. */
    apiKey?: string;
    /** Rewrite the request body's `model` (exact or `prefix*`) before forwarding. */
    modelMap?: Record<string, string>;
    /** Retry with these models (in order) if the request errors. */
    fallbackModels?: string[];
  };
  /** Stable id for this install, used in NATS subjects (auto-generated). */
  instanceId?: string;
  /** Remote bus over NATS (for CLI/phone). See docs/architecture-remote-bus.md. */
  remote?: {
    enabled?: boolean;
    /** NATS server URL, e.g. tls://host:4222 or wss://host:443. */
    url?: string;
    /** Path to a CA cert to trust (for self-signed TLS). */
    caFile?: string;
    /**
     * Decentralized JWT mode (recommended; zero server ops after one-time setup):
     * the account signing-key seed + account public id let the desktop mint its
     * own hub/device credentials. See docs/nats-deploy.md.
     */
    accountSeed?: string;
    accountId?: string;
    /** Static fallback: pre-provisioned user/pass (hub + device). */
    user?: string;
    pass?: string;
    deviceUser?: string;
    devicePass?: string;
  };
  plugins?: Record<string, { enabled: boolean }>;
}

// In-memory cache so the hot paths (per-request maxResponseBodyBytes,
// isPluginEnabled, etc.) don't synchronously read the file every time. The file
// watcher invalidates it on external edits. Callers must not mutate the result.
let _configCache: Config | null = null;

function readConfig(): Config {
  if (_configCache) return _configCache;
  try {
    _configCache = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as Config;
  } catch {
    _configCache = {};
  }
  return _configCache;
}

function invalidateConfigCache(): void {
  _configCache = null;
}

function writeConfig(c: Config): void {
  try {
    // Atomic write (tmp + rename) so concurrent writers (runtime, CLI) can't
    // observe or leave a half-written file.
    const tmp = `${CONFIG_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(c, null, 2));
    fs.renameSync(tmp, CONFIG_FILE);
    _configCache = c;
  } catch (e) {
    log("warn", "writeConfig failed:", String(e));
  }
}

function isSafeModeEnabled(): boolean {
  return fs.existsSync(SAFE_MODE_FILE) || readConfig().safeMode === true;
}

function isStealthEnabled(): boolean {
  return readConfig().stealth === true;
}

// IPC channel prefix. In stealth mode it is randomized per session so the host
// app's main process cannot enumerate handlers by a known name; otherwise it is
// the stable "desktop-proxy" prefix. The renderer learns it via config-sync.
const CHANNEL_PREFIX = isStealthEnabled()
  ? `dp-${randomBytes(6).toString("hex")}`
  : "desktop-proxy";

function ch(name: string): string {
  return `${CHANNEL_PREFIX}:${name}`;
}

function isPluginEnabled(id: string): boolean {
  if (isSafeModeEnabled()) return false;
  const cfg = readConfig();
  return cfg.plugins?.[id]?.enabled !== false;
}

// ── Lazy Electron Import ─────────────────────────────────────────────────────
// We don't import Electron until the loader has set up Module.globalPaths,
// because the runtime lives outside the app. The app's Electron is resolved
// via Module.globalPaths pointing into app.asar's node_modules or the
// Electron Framework's built-in module resolution.

let _electron: typeof import("electron") | null = null;

function getElectron(): typeof import("electron") {
  if (!_electron) {
    _electron = require("electron");
  }
  return _electron!;
}

// Single main-process network hub shared by all main-scope plugins, so each
// gets a real, independently-removable subscription (Electron's webRequest
// events only allow one listener each).
let _mainNetwork: MainNetwork | null = null;

// Return the network hub only if it already exists — used by diagnostics so we
// don't instantiate it (and patch Node http) just to check whether it's in use.
function peekMainNetwork(): MainNetwork | null {
  return _mainNetwork;
}

function getMainNetwork(): MainNetwork {
  if (!_mainNetwork) {
    const electron = getElectron();
    _mainNetwork = createMainNetwork(
      () => electron.session.defaultSession,
      () => electron.app.whenReady().then(() => undefined),
      log,
      () => readConfig().maxResponseBodyBytes ?? 1024 * 1024,
    );
  }
  return _mainNetwork;
}

// Single CDP hub shared across the runtime (manages webContents.debugger).
let _mainCDP: MainCDP | null = null;

function getMainCDP(): MainCDP {
  if (!_mainCDP) {
    _mainCDP = createMainCDP(log);
  }
  return _mainCDP;
}

// Passive CDP Network observer for renderer requests (config-gated).
let _cdpNetObserver: CdpNetworkObserver | null = null;

function getCdpNetworkObserver(): CdpNetworkObserver {
  if (!_cdpNetObserver) {
    const net = getMainNetwork();
    _cdpNetObserver = createCdpNetworkObserver(getMainCDP(), {
      observeRequest: (req) => net.observeRequest(req),
      observeResponse: (res) => net.observeResponse(res),
      maxBodyBytes: () => readConfig().maxResponseBodyBytes ?? 1024 * 1024,
      log,
      interceptEnabled: () => readConfig().cdpIntercept === true,
      hasResponseInterceptors: (wc) => net.hasResponseInterceptors() || getRendererInterceptRouter().wantsResponse(wc.id),
      responseInterceptMatches: (url, wc) =>
        net.responseInterceptMatches(url) || getRendererInterceptRouter().responseUrlsMatch(wc.id, url),
      dispatchIntercept: async (req, wc) => {
        const main = await net.dispatchIntercept(req);
        if (acted(main)) return main;
        return getRendererInterceptRouter().dispatchRequest(wc, req);
      },
      dispatchInterceptResponse: async (res, url, wc) => {
        const main = await net.dispatchInterceptResponse(res, url);
        if (main.action !== "continue") return main;
        return getRendererInterceptRouter().dispatchResponse(wc, res, url);
      },
      observeWebSocket: (evt) => net.observeWebSocket(evt),
      hasWebSocketHandlers: () => net.hasWebSocketHandlers(),
    });
  }
  return _cdpNetObserver;
}

// A decision "acts" if it blocks, mocks, or modifies — so main-scope wins and we
// skip the renderer round-trip; a plain "continue" lets the renderer decide.
function acted(d: NetDecision): boolean {
  return d.action !== "continue" || (d.mods != null && Object.keys(d.mods).length > 0);
}

// Routes renderer-scope intercept/interceptResponse decisions over IPC.
let _rendererIntercept: RendererInterceptRouter | null = null;
// wc ids we've already warned about (renderer intercept while cdpIntercept off).
const regWarned = new Set<number>();

function getRendererInterceptRouter(): RendererInterceptRouter {
  if (!_rendererIntercept) {
    _rendererIntercept = createRendererInterceptRouter({
      sendReqPaused: (wc, pauseId, req) => {
        if (!wc.isDestroyed()) wc.send(ch("net:req-paused"), { pauseId, req });
      },
      sendResPaused: (wc, pauseId, res, url) => {
        if (!wc.isDestroyed()) wc.send(ch("net:res-paused"), { pauseId, res, url });
      },
      log,
    });
  }
  return _rendererIntercept;
}

// Main-world injector for page-side wrappers: streaming-response transform +
// outbound WebSocket transform (config-gated).
let _mainWorldHost: MainWorldHost | null = null;

function getMainWorldHost(): MainWorldHost {
  if (!_mainWorldHost) {
    const net = getMainNetwork();
    _mainWorldHost = createMainWorldHost(getMainCDP(), {
      streamRegs: () => net.transformRegistrations(),
      wsRegs: () => net.wsTransformRegistrations(),
      raceRegs: () => net.raceRegistrations(),
      onEmit: (id, data) => net.dispatchTransformEmit(id, data),
      log,
    });
    net.setTransformListener((reg) => getMainWorldHost().registerStream(reg));
    net.setWsTransformListener((reg) => getMainWorldHost().registerWs(reg));
    net.setRaceListener((reg) => getMainWorldHost().registerRace(reg));
  }
  return _mainWorldHost;
}

// Recent-traffic ring for the built-in Network viewer + HAR export (config-gated).
let _trafficRecorder: TrafficRecorder | null = null;

function getTrafficRecorder(): TrafficRecorder {
  if (!_trafficRecorder) {
    _trafficRecorder = createTrafficRecorder(getMainNetwork(), () => FRAMEWORK_VERSION);
  }
  return _trafficRecorder;
}

let _trafficWriter: import("./net/traffic-persist").TrafficWriter | null = null;

// Subscribe/unsubscribe the recorder + persistence sink to match the config.
function syncTrafficCapture(): void {
  try {
    const cfg = readConfig();
    const rec = getTrafficRecorder();
    rec.setEnabled(cfg.captureTraffic === true);

    if (cfg.persistTraffic === true && cfg.captureTraffic === true) {
      if (!_trafficWriter) {
        const dir = path.join(LOG_DIR, "traffic.ndjson");
        _trafficWriter = createTrafficWriter(dir);
        rec.setSink((entry) => _trafficWriter?.write(entry));
        log("info", "traffic persistence enabled:", dir);
      }
    } else if (_trafficWriter) {
      rec.setSink(null);
      _trafficWriter.close();
      _trafficWriter = null;
    }
  } catch (e) {
    log("warn", "traffic capture sync failed:", String(e));
  }
}

// Local model-traffic relay (config-gated). Starts/stops to match config.relay,
// feeding captured req/resp into the same network hub the recorder + plugins use
// (tagged source "relay"), so out-of-process model traffic shows up everywhere.
let _relay: import("./net/relay").RelayHandle | null = null;
let _relayKey = ""; // signature of the applied config, to avoid needless restarts

async function syncRelay(): Promise<void> {
  try {
    const cfg = readConfig();
    const r = cfg.relay;
    const want = r?.enabled === true && typeof r.upstream === "string" && r.upstream.length > 0;
    const key = want
      ? JSON.stringify({ p: r!.port ?? 8788, u: r!.upstream, x: r!.proxy ?? "", k: r!.apiKey ? 1 : 0, m: r!.modelMap ?? {}, f: r!.fallbackModels ?? [] })
      : "";
    if (key === _relayKey) return; // unchanged

    if (_relay) {
      await _relay.close().catch(() => undefined);
      _relay = null;
    }
    _relayKey = key;
    if (!want) return;

    const { startRelay } = await import("./net/relay.js");
    const net = getMainNetwork();
    _relay = await startRelay(
      {
        port: r!.port ?? 8788,
        upstream: r!.upstream!,
        proxy: r!.proxy,
        apiKey: r!.apiKey,
        modelMap: r!.modelMap,
        fallbackModels: r!.fallbackModels,
        maxBodyBytes: readConfig().maxResponseBodyBytes ?? 1024 * 1024,
      },
      {
        log,
        onRequest: (req) =>
          net.observeRequest({
            id: req.id,
            source: "relay",
            _type: "node",
            method: req.method,
            url: req.url,
            headers: req.headers,
            body: req.body,
            bodyEncoding: req.bodyEncoding,
            timestamp: Date.now(),
          }),
        onResponse: (resp) =>
          net.observeResponse({
            id: `resp-${resp.requestId}`,
            requestId: resp.requestId,
            source: "relay",
            status: resp.status,
            statusText: resp.statusText,
            headers: resp.headers,
            body: resp.body,
            timestamp: Date.now(),
          }),
      },
    );
  } catch (e) {
    log("warn", "relay sync failed:", String(e));
    _relayKey = ""; // allow a retry on the next config change
  }
}

// CDP core for a main-process plugin. Targets the focused window (or the first
// available one), caching the webContents across calls so attach/send/on agree.
function createMainCDPCore(
  manifest: import("@desktop-proxy/plugin-sdk").PluginManifest,
): PluginCDPCore {
  const granted = Array.isArray(manifest.permissions) && manifest.permissions.includes("cdp");
  const hub = getMainCDP();
  let cached: Electron.WebContents | null = null;

  function target(): Electron.WebContents {
    if (cached && !cached.isDestroyed()) return cached;
    const electron = getElectron();
    const wc =
      electron.BrowserWindow.getFocusedWindow()?.webContents ??
      electron.BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())?.webContents ??
      null;
    if (!wc) throw new Error("cdp: no available window to attach to");
    cached = wc;
    return wc;
  }

  function requireGrant(): void {
    if (!granted) throw new Error(`Plugin ${manifest.id} lacks the "cdp" permission`);
  }

  return {
    attach: async () => {
      requireGrant();
      await hub.attach(target());
    },
    detach: async () => {
      requireGrant();
      hub.detach(target());
    },
    isAttached: async () => {
      requireGrant();
      return hub.isAttached(target());
    },
    send: async <T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> => {
      requireGrant();
      return hub.send(target(), method, params) as Promise<T>;
    },
    on: (event: string, handler: (params: unknown) => void) => {
      requireGrant();
      return hub.onEvent(target(), (method, params) => {
        if (method === event) handler(params);
      });
    },
  };
}

// ── Preload Registration ─────────────────────────────────────────────────────

function registerPreload(session: Electron.Session, label: string): void {
  try {
    // Prefer the modern API (Electron >= 35); fall back to the deprecated
    // setPreloads on older versions. The target app's Electron version varies,
    // so feature-detect rather than assume.
    const s = session as unknown as {
      registerPreloadScript?: (script: { type: string; filePath: string }) => string;
      getPreloadScripts?: () => Array<{ filePath?: string }>;
    };

    if (typeof s.registerPreloadScript === "function") {
      const existing = s.getPreloadScripts?.() ?? [];
      if (existing.some((p) => p.filePath === PRELOAD_PATH)) {
        log("info", `preload already registered on ${label}`);
        return;
      }
      s.registerPreloadScript({ type: "frame", filePath: PRELOAD_PATH });
      log("info", `preload registered (registerPreloadScript) on ${label}:`, PRELOAD_PATH);
      return;
    }

    const existing = session.getPreloads();
    if (!existing.includes(PRELOAD_PATH)) {
      session.setPreloads([...existing, PRELOAD_PATH]);
      log("info", `preload registered (setPreloads) on ${label}:`, PRELOAD_PATH);
    } else {
      log("info", `preload already registered on ${label}`);
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("existing ID") || msg.includes("already")) {
      log("info", `preload already registered on ${label}`);
      return;
    }
    log("error", `preload registration on ${label} failed:`, msg);
  }
}

// ── Plugin Manager (Main Process) ────────────────────────────────────────────

interface PluginMeta {
  manifest: import("@desktop-proxy/plugin-sdk").PluginManifest;
  dir: string;
  entry: string;
}

let discoveredPlugins: PluginMeta[] = [];

function discoverPlugins(): PluginMeta[] {
  const result: PluginMeta[] = [];
  try {
    for (const name of fs.readdirSync(PLUGINS_DIR)) {
      const pluginDir = path.join(PLUGINS_DIR, name);
      const manifestPath = path.join(pluginDir, "manifest.json");
      if (!fs.statSync(pluginDir).isDirectory()) continue;
      if (!fs.existsSync(manifestPath)) continue;

      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        const { valid } = require("@desktop-proxy/plugin-sdk").validateManifest(manifest);
        if (!valid) {
          log("warn", `Invalid manifest for plugin ${name}`);
          continue;
        }

        const entry = path.join(pluginDir, manifest.main);
        result.push({ manifest, dir: pluginDir, entry });
      } catch (e) {
        log("warn", `Failed to read plugin ${name}:`, String(e));
      }
    }
  } catch {
    // plugins dir might not exist
  }
  discoveredPlugins = result;
  return result;
}

function loadMainProcessPlugins(): void {
  discoverPlugins();

  for (const plugin of discoveredPlugins) {
    const { manifest, entry } = plugin;
    if (manifest.scope !== "main" && manifest.scope !== "both") continue;
    if (!isPluginEnabled(manifest.id)) continue;
    if (!satisfiesMinVersion(FRAMEWORK_VERSION, manifest.minDesktopProxyVersion)) {
      log("warn", `Plugin ${manifest.id} needs desktop-proxy >= ${manifest.minDesktopProxyVersion} (have ${FRAMEWORK_VERSION}); skipping`);
      continue;
    }
    if (!fs.existsSync(entry)) {
      log("warn", `Plugin ${manifest.id} entry not found: ${entry}`);
      continue;
    }

    try {
      const pluginModule = require(entry);
      const mod = pluginModule.default ?? pluginModule;

      if (typeof mod?.start === "function") {
        const api = createMainProcessAPI(manifest);
        Promise.resolve(mod.start(api)).catch((e: unknown) => {
          log("error", `Plugin ${manifest.id} start failed:`, String(e));
        });
        log("info", `Loaded main-process plugin: ${manifest.id}`);
      }
    } catch (e) {
      log("error", `Failed to load plugin ${manifest.id}:`, String(e));
    }
  }
}

function createMainProcessAPI(manifest: import("@desktop-proxy/plugin-sdk").PluginManifest): import("@desktop-proxy/plugin-sdk").PluginAPI {
  const electron = getElectron();

  return {
    manifest,
    process: "main",
    log: {
      debug: (...args) => log("debug", `[${manifest.id}]`, ...args),
      info: (...args) => log("info", `[${manifest.id}]`, ...args),
      warn: (...args) => log("warn", `[${manifest.id}]`, ...args),
      error: (...args) => log("error", `[${manifest.id}]`, ...args),
      isEnabled: (level) => rootLogger.isEnabled(level),
    },
    storage: {
      get: <T>(key: string, defaultValue?: T): T => pluginStorage.get<T>(manifest.id, key, defaultValue),
      set: (key: string, value: unknown) => pluginStorage.set(manifest.id, key, value),
      delete: (key: string) => pluginStorage.delete(manifest.id, key),
      all: () => pluginStorage.all(manifest.id),
    },
    events: {
      on: (topic: string, handler: (data: unknown) => void) => onEvent(topic, handler),
      emit: (topic: string, data?: unknown) => emitEvent(topic, data),
    },
    settings: {
      registerSection: () => ({ unregister: () => {} }),
      registerPage: () => ({ unregister: () => {} }),
    },
    react: {
      getFiber: () => null,
      findOwnerByName: () => null,
      waitForElement: () => Promise.reject(new Error("Not available in main process")),
    },
    ipc: {
      on: (channel: string, handler: (...args: unknown[]) => void) => {
        const fullChannel = ch(`${manifest.id}:${channel}`);
        electron.ipcMain.on(fullChannel, (_e, ...args) => handler(...args));
        return () => electron.ipcMain.removeAllListeners(fullChannel);
      },
      // Main-process IPC doesn't have direct send to renderer without a window reference.
      // Plugins should use app.getWindows() to target specific windows.
      send: () => { log("warn", `[${manifest.id}] ipc.send not available in main process`); },
      invoke: async <T>(channel: string, ..._args: unknown[]): Promise<T> => {
        log("warn", `[${manifest.id}] ipc.invoke(${channel}) not available in main process`);
        return undefined as T;
      },
    },
    network: getMainNetwork(),
    fs: (() => {
      const root = pluginDataDir(userRoot, manifest.id);
      return {
        read: async (p: string, encoding?: import("@desktop-proxy/plugin-sdk").FileEncoding) => fsRead(root, p, encoding),
        write: async (p: string, data: string, encoding?: import("@desktop-proxy/plugin-sdk").FileEncoding) => { fsWrite(root, p, data, encoding); },
        exists: async (p: string) => fsExists(root, p),
        list: async (p?: string) => fsList(root, p),
        delete: async (p: string) => { fsDelete(root, p); },
        mkdir: async (p: string) => { fsMkdir(root, p); },
        stat: async (p: string) => fsStat(root, p),
      };
    })(),
    cdp: createCDP(createMainCDPCore(manifest)),
    // UI helpers are renderer-only; main-process plugins get safe no-ops.
    ui: {
      injectCSS: () => () => {},
      toast: () => log("warn", `[${manifest.id}] ui.toast is not available in the main process`),
    },
    app: {
      getInfo: async () => {
        return {
          name: electron.app.getName(),
          version: electron.app.getVersion(),
          electronVersion: process.versions.electron || "unknown",
          platform: process.platform,
          runtimeDir,
          userRoot,
        };
      },
      getWindows: async () => {
        return electron.BrowserWindow.getAllWindows()
          .filter((w) => !w.isDestroyed())
          .map((w) => ({
            id: w.id,
            title: w.getTitle(),
            url: w.webContents.getURL(),
            focused: w.isFocused(),
          }));
      },
    },
  };
}

// ── IPC Bridge (Main → Renderer) ─────────────────────────────────────────────

function setupIPCBridge(): void {
  const electron = getElectron();

  // Plugin source reading — preload fetches plugin source via this channel
  electron.ipcMain.handle(ch("read-plugin-source"), async (_e, entryPath: string) => {
    try {
      return fs.readFileSync(entryPath, "utf8");
    } catch (e) {
      log("error", "read-plugin-source failed:", entryPath, String(e));
      throw e;
    }
  });

  // Plugin listing — preload asks main for the plugin list
  electron.ipcMain.handle(ch("list-plugins"), async () => getBus().request("plugin.list"));

  // User paths — preload needs to know the user root
  electron.ipcMain.handle(ch("user-paths"), async () => ({
    userRoot,
    runtimeDir,
    pluginsDir: PLUGINS_DIR,
  }));

  // Config read
  electron.ipcMain.handle(ch("get-config"), async () => getBus().request("config.get"));

  // Toggle plugin enabled state
  electron.ipcMain.handle(ch("toggle-plugin"), async (_e, id: string, enabled: boolean) =>
    getBus().request("plugin.toggle", { id, enabled }),
  );

  // Toggle safe mode
  electron.ipcMain.handle(ch("toggle-safe-mode"), async (_e, enabled: boolean) => {
    if (enabled) {
      fs.writeFileSync(SAFE_MODE_FILE, "");
    } else {
      try { fs.unlinkSync(SAFE_MODE_FILE); } catch {}
    }
    return { safeMode: enabled };
  });

  // Merge a partial config (used by the in-app management page). The config
  // watcher then applies it live (log level immediately; plugins/safeMode reload).
  electron.ipcMain.handle(ch("set-config"), async (_e, patch: Record<string, unknown>) =>
    getBus().request("config.set", patch),
  );

  // Renderer-scope interception: the renderer reports which kinds of interceptors
  // it has (so main only round-trips when needed) and returns pause decisions.
  electron.ipcMain.on(ch("net:reg"), (e, state: { request: boolean; responseUrls: string[] }) => {
    const wants = state?.request === true || (Array.isArray(state?.responseUrls) && state.responseUrls.length > 0);
    getRendererInterceptRouter().setRegistration(e.sender.id, {
      request: state?.request === true,
      responseUrls: Array.isArray(state?.responseUrls) ? state.responseUrls : [],
    });
    if (wants && readConfig().cdpIntercept !== true && !regWarned.has(e.sender.id)) {
      regWarned.add(e.sender.id);
      log("warn", `renderer plugin registered intercept but cdpIntercept is OFF — enable: desktop-proxy config set cdpIntercept true`);
    }
  });
  electron.ipcMain.on(ch("net:decision"), (_e, msg: { pauseId: string; decision: unknown }) => {
    if (msg?.pauseId) getRendererInterceptRouter().resolve(msg.pauseId, msg.decision as NetDecision);
  });

  // Network traffic viewer (built-in "Network" page) + HAR export.
  electron.ipcMain.handle(ch("traffic:list"), async (_e, query?: string) => getBus().request("traffic.list", query));
  electron.ipcMain.handle(ch("traffic:detail"), async (_e, id: string) => getBus().request("traffic.detail", id));
  electron.ipcMain.handle(
    ch("traffic:replay"),
    async (_e, id: string, overrides?: { url?: string; method?: string; headers?: Record<string, string>; body?: string }) =>
      getBus().request("traffic.replay", { id, overrides }),
  );
  electron.ipcMain.handle(ch("traffic:clear"), async () => getBus().request("traffic.clear"));
  electron.ipcMain.handle(ch("traffic:export"), async (_e, query?: string) => getBus().request("traffic.export", query));

  // App info
  electron.ipcMain.handle(ch("app-info"), async () => ({
    name: electron.app.getName(),
    version: electron.app.getVersion(),
    electronVersion: process.versions.electron || "unknown",
    platform: process.platform,
    runtimeDir,
    userRoot,
  }));

  // Window list — preload's app.getWindows() invokes this channel
  electron.ipcMain.handle(ch("windows"), async () =>
    electron.BrowserWindow.getAllWindows()
      .filter((w) => !w.isDestroyed())
      .map((w) => ({
        id: w.id,
        title: w.getTitle(),
        url: w.webContents.getURL(),
        focused: w.isFocused(),
      }))
  );

  // Preload log forwarding (renderer → main log file)
  electron.ipcMain.on(ch("preload-log"), (_e, level: string, msg: string) => {
    log(level, `[preload]`, msg);
  });

  // Synchronous config read — FIXED bootstrap channel (the preload learns the
  // randomized channel prefix, stealth flag, and log level from here before it
  // installs any hooks).
  electron.ipcMain.on("desktop-proxy:config-sync", (e) => {
    e.returnValue = {
      stealth: isStealthEnabled(),
      logLevel: rootLogger.getLevel(),
      channelPrefix: CHANNEL_PREFIX,
      enforcePermissions: readConfig().enforcePermissions === true,
      maxResponseBodyBytes: readConfig().maxResponseBodyBytes,
    };
  });

  // Unified plugin storage — renderer plugins proxy api.storage to the main
  // backend: a synchronous snapshot on init, then write-through set/delete.
  electron.ipcMain.on(ch("storage:snapshot"), (e, id: string) => {
    try {
      e.returnValue = pluginStorage.all(id);
    } catch {
      e.returnValue = {};
    }
  });
  electron.ipcMain.on(ch("storage:set"), (_e, id: string, key: string, value: unknown) => {
    try {
      pluginStorage.set(id, key, value);
    } catch (err) {
      log("warn", "storage:set failed:", String(err));
    }
  });
  electron.ipcMain.on(ch("storage:delete"), (_e, id: string, key: string) => {
    try {
      pluginStorage.delete(id, key);
    } catch (err) {
      log("warn", "storage:delete failed:", String(err));
    }
  });

  // Initialize the message bus hub (registers the ch("bus") IPC channel so
  // renderer leaves can connect for api.events and RPC).
  const bus = getBus();

  // Converged RPC methods — single source of truth on the bus. The legacy IPC
  // handlers below delegate here, and remote clients (CLI/phone over NATS) get
  // the same methods for free.
  bus.handle("config.get", () => ({ ...readConfig(), version: FRAMEWORK_VERSION }));
  bus.handle("config.set", (p) => {
    const cfg = { ...readConfig(), ...((p as Record<string, unknown>) ?? {}) } as Config;
    writeConfig(cfg);
    return { ok: true };
  });
  bus.handle("plugin.list", () => {
    discoverPlugins();
    return discoveredPlugins.map((pl) => ({
      manifest: pl.manifest,
      entry: pl.entry,
      dir: pl.dir,
      enabled: isPluginEnabled(pl.manifest.id),
      compatible: satisfiesMinVersion(FRAMEWORK_VERSION, pl.manifest.minDesktopProxyVersion),
    }));
  });
  bus.handle("plugin.toggle", (p) => {
    const { id, enabled } = (p as { id: string; enabled: boolean }) ?? {};
    const prev = readConfig();
    const cfg: Config = { ...prev, plugins: { ...prev.plugins, [id]: { ...prev.plugins?.[id], enabled } } };
    writeConfig(cfg);
    return { id, enabled };
  });
  bus.handle("traffic.list", (p) => {
    const rec = getTrafficRecorder();
    const entries = rec.list(p as string | undefined);
    let bytes = 0;
    let errors = 0;
    let aiCalls = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let costUsd = 0;
    let hasCost = false;
    for (const e of entries) {
      if (e.bodyBytes) bytes += e.bodyBytes;
      if (e.status != null && e.status >= 400) errors++;
      if (e.category === "ai") {
        aiCalls++;
        if (e.usage) {
          promptTokens += e.usage.promptTokens ?? 0;
          completionTokens += e.usage.completionTokens ?? 0;
          if (e.usage.costUsd != null) {
            costUsd += e.usage.costUsd;
            hasCost = true;
          }
        }
      }
    }
    return {
      enabled: rec.isEnabled(),
      count: rec.count(),
      entries,
      stats: { bytes, errors, ai: { calls: aiCalls, promptTokens, completionTokens, costUsd: hasCost ? costUsd : null } },
    };
  });
  bus.handle("traffic.detail", (p) => getTrafficRecorder().detail(p as string));
  bus.handle("traffic.clear", () => {
    getTrafficRecorder().clear();
    return { ok: true };
  });
  bus.handle("traffic.replay", async (p) => {
    const { id, overrides } = (p as { id: string; overrides?: { url?: string; method?: string; headers?: Record<string, string>; body?: string } }) ?? {};
    if (typeof fetch !== "function") return { ok: false, error: "fetch is unavailable in this runtime" };
    const d = getTrafficRecorder().detail(id);
    if (!d) return { ok: false, error: "request not found" };
    const url = overrides?.url ?? d.url;
    const method = (overrides?.method ?? d.method ?? "GET").toUpperCase();
    const base = overrides?.headers ?? d.reqHeaders;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(base)) {
      if (!/^(host|content-length|connection|accept-encoding)$/i.test(k)) headers[k] = v;
    }
    const body = overrides?.body ?? (method === "GET" || method === "HEAD" ? undefined : d.reqBody ?? undefined);
    try {
      const res = await fetch(url, { method, headers, body });
      log("info", `traffic: replayed ${method} ${url} → ${res.status}`);
      return { ok: true, status: res.status };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });
  bus.handle("traffic.export", (p) => {
    const har = getTrafficRecorder().toHar(p as string | undefined);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outPath = path.join(userRoot, `traffic-${stamp}.har`);
    fs.writeFileSync(outPath, JSON.stringify(har, null, 2));
    log("info", `traffic: exported HAR to ${outPath}`);
    return { path: outPath, count: har.log.entries.length };
  });

  // Sandboxed filesystem — the plugin id scopes each call to its confined data
  // dir. Converged onto the bus (in-app only: NOT in REMOTE_METHODS, so a remote
  // phone/CLI cannot reach the desktop filesystem).
  type FileEncoding = import("@desktop-proxy/plugin-sdk").FileEncoding;
  const fsRoot = (id: string) => pluginDataDir(userRoot, id);
  const fsArgs = (p: unknown) => (p ?? {}) as { id: string; path: string; data?: string; encoding?: FileEncoding };
  bus.handle("fs.read", (p) => { const a = fsArgs(p); return fsRead(fsRoot(a.id), a.path, a.encoding); });
  bus.handle("fs.write", (p) => { const a = fsArgs(p); return fsWrite(fsRoot(a.id), a.path, a.data ?? "", a.encoding); });
  bus.handle("fs.exists", (p) => { const a = fsArgs(p); return fsExists(fsRoot(a.id), a.path); });
  bus.handle("fs.list", (p) => { const a = fsArgs(p); return fsList(fsRoot(a.id), a.path); });
  bus.handle("fs.delete", (p) => { const a = fsArgs(p); return fsDelete(fsRoot(a.id), a.path); });
  bus.handle("fs.mkdir", (p) => { const a = fsArgs(p); return fsMkdir(fsRoot(a.id), a.path); });
  bus.handle("fs.stat", (p) => { const a = fsArgs(p); return fsStat(fsRoot(a.id), a.path); });
  // Legacy IPC channels delegate to the bus (kept for any direct ipc callers).
  electron.ipcMain.handle(ch("fs:read"), async (_e, id: string, p: string, encoding?: FileEncoding) => getBus().request("fs.read", { id, path: p, encoding }));
  electron.ipcMain.handle(ch("fs:write"), async (_e, id: string, p: string, data: string, encoding?: FileEncoding) => getBus().request("fs.write", { id, path: p, data, encoding }));
  electron.ipcMain.handle(ch("fs:exists"), async (_e, id: string, p: string) => getBus().request("fs.exists", { id, path: p }));
  electron.ipcMain.handle(ch("fs:list"), async (_e, id: string, p?: string) => getBus().request("fs.list", { id, path: p }));
  electron.ipcMain.handle(ch("fs:delete"), async (_e, id: string, p: string) => getBus().request("fs.delete", { id, path: p }));
  electron.ipcMain.handle(ch("fs:mkdir"), async (_e, id: string, p: string) => getBus().request("fs.mkdir", { id, path: p }));
  electron.ipcMain.handle(ch("fs:stat"), async (_e, id: string, p: string) => getBus().request("fs.stat", { id, path: p }));

  // Chrome DevTools Protocol — attached to the calling renderer's webContents.
  // Permission gating happens preload-side; events flow back via ch("cdp:event").
  const cdpForwarded = new Set<number>();
  electron.ipcMain.handle(ch("cdp:attach"), async (e) => {
    const wc = e.sender;
    await getMainCDP().attach(wc);
    if (!cdpForwarded.has(wc.id)) {
      cdpForwarded.add(wc.id);
      const off = getMainCDP().onEvent(wc, (method, params) => {
        if (!wc.isDestroyed()) wc.send(ch("cdp:event"), { method, params });
      });
      wc.once("destroyed", () => {
        off();
        cdpForwarded.delete(wc.id);
      });
    }
  });
  electron.ipcMain.handle(ch("cdp:detach"), async (e) => {
    getMainCDP().detach(e.sender);
  });
  electron.ipcMain.handle(ch("cdp:isAttached"), async (e) =>
    getMainCDP().isAttached(e.sender),
  );
  electron.ipcMain.handle(
    ch("cdp:send"),
    async (e, method: string, params?: Record<string, unknown>) =>
      getMainCDP().send(e.sender, method, params),
  );
}

// ── Watchers (Hot Reload + live config) ──────────────────────────────────────

function broadcastToRenderers(channel: string, ...args: unknown[]): void {
  getElectron()
    .BrowserWindow.getAllWindows()
    .filter((w) => !w.isDestroyed())
    .forEach((w) => w.webContents.send(channel, ...args));
}

function startFSWatcher(): void {
  try {
    // Use Node.js fs.watch to monitor the plugins directory.
    fs.watch(PLUGINS_DIR, { recursive: true }, () => {
      // Debounce: wait 500ms before broadcasting reload.
      setTimeout(() => {
        log("info", "Plugin files changed; broadcasting reload");
        broadcastToRenderers(ch("plugins-changed"));
      }, 500);
    });
    log("info", "FS watcher started on:", PLUGINS_DIR);
  } catch (e) {
    log("warn", "FS watcher failed to start:", String(e));
  }
}

// Watch config.json so changes from the CLI (or the in-app management page)
// apply live: log level updates immediately; plugin enable/disable and
// safe-mode changes trigger a renderer plugin reload.
function startConfigWatcher(): void {
  let lastPlugins = JSON.stringify(readConfig().plugins ?? {});
  let lastSafeMode = readConfig().safeMode === true;
  let timer: NodeJS.Timeout | null = null;

  try {
    fs.watch(userRoot, (_event, filename) => {
      if (filename !== "config.json") return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        invalidateConfigCache();
        const cfg = readConfig();

        const level = parseLevel(process.env.DESKTOP_PROXY_LOG_LEVEL ?? cfg.logLevel, "info");
        if (level !== rootLogger.getLevel()) {
          rootLogger.setLevel(level);
          log("info", `config: logLevel → ${level}`);
        }
        broadcastToRenderers(ch("config-changed"), { logLevel: rootLogger.getLevel() });
        emitEvent("config:changed", { logLevel: rootLogger.getLevel() });

        // Start/stop the traffic recorder to match captureTraffic.
        syncTrafficCapture();
        // Start/stop the model-traffic relay to match config.relay.
        void syncRelay();
        // Connect/disconnect the remote (NATS) bus to match config.
        void syncRemote();

        const plugins = JSON.stringify(cfg.plugins ?? {});
        const safeMode = cfg.safeMode === true;
        if (plugins !== lastPlugins || safeMode !== lastSafeMode) {
          lastPlugins = plugins;
          lastSafeMode = safeMode;
          log("info", "config: plugins/safeMode changed; broadcasting reload");
          broadcastToRenderers(ch("plugins-changed"));
          emitEvent("plugins:changed", null);
        }
      }, 250);
    });
    log("info", "config watcher started on:", CONFIG_FILE);
  } catch (e) {
    log("warn", "config watcher failed to start:", String(e));
  }
}

// ── Startup ──────────────────────────────────────────────────────────────────

log("info", "desktop-proxy runtime initializing");
log("info", `userRoot: ${userRoot}`);
log("info", `runtimeDir: ${runtimeDir}`);
log("info", `preloadPath: ${PRELOAD_PATH}`);
// Both sides must resolve the same prefix; compare this against the preload's
// "preload entry" log line when diagnosing IPC issues in stealth mode.
log("info", `channelPrefix: ${CHANNEL_PREFIX} (stealth=${isStealthEnabled()})`);

// Hook Electron's session system to inject our preload
const electron = getElectron();

electron.app.whenReady().then(() => {
  log("info", "app ready");

  if (isSafeModeEnabled()) {
    log("warn", "Safe mode enabled — preload will not be registered");
    return;
  }

  registerPreload(electron.session.defaultSession, "defaultSession");
});

electron.app.on("session-created", (session) => {
  if (isSafeModeEnabled()) return;
  registerPreload(session, "session-created");
});

// Diagnostic: log webContents creation
electron.app.on("web-contents-created", (_e, wc) => {
  try {
    const wp = (wc as { getLastWebPreferences?: () => Electron.WebPreferences | null }).getLastWebPreferences?.();
    log("info", "web-contents-created", {
      id: wc.id,
      type: wc.getType(),
      sessionIsDefault: wc.session === electron.session.defaultSession,
      sandbox: wp?.sandbox,
      contextIsolation: wp?.contextIsolation,
    });
    wc.on("preload-error", (_ev, p, err) => {
      log("error", `wc ${wc.id} preload-error path=${p}`, String((err as Error)?.stack ?? err));
    });
    wc.once("destroyed", () => getRendererInterceptRouter().cleanupWc(wc.id));

    // Renderer network observation/interception via CDP (opt-in).
    if (!isSafeModeEnabled()) {
      const type = wc.getType();
      const isPage = type === "window" || type === "webview" || type === "browserView";
      const cfg = readConfig();
      if (isPage && (cfg.cdpNetwork === true || cfg.cdpIntercept === true)) {
        void getCdpNetworkObserver().observe(wc);
      }
      if (isPage && (cfg.cdpStreamTransform === true || cfg.cdpWsTransform === true || cfg.cdpRaceRequest === true)) {
        void getMainWorldHost().attach(wc);
      }
    }
  } catch (e) {
    log("error", "web-contents-created handler failed:", String(e));
  }
});

// Set up IPC bridge
setupIPCBridge();

// Load main-process plugins
if (!isSafeModeEnabled()) {
  loadMainProcessPlugins();
}

// Begin recording traffic if captureTraffic is already enabled.
syncTrafficCapture();

// Start the model-traffic relay if it's already enabled in config.
void syncRelay();

// Connect the remote (NATS) bus if it's already enabled in config.
void syncRemote();

// Diagnose: warn if plugins registered network features whose config gate is off
// (otherwise they silently never fire). Deferred so async plugin start() can run.
function warnConfigGates(): void {
  const net = peekMainNetwork();
  if (!net) return; // no plugin touched api.network
  const cfg = readConfig();
  if ((net.hasInterceptors() || net.hasResponseInterceptors()) && cfg.cdpIntercept !== true) {
    log("warn", "plugin registered intercept/interceptResponse but cdpIntercept is OFF — enable: desktop-proxy config set cdpIntercept true");
  }
  if (net.transformRegistrations().length > 0 && cfg.cdpStreamTransform !== true) {
    log("warn", "plugin registered transformStream but cdpStreamTransform is OFF — enable: desktop-proxy config set cdpStreamTransform true");
  }
  if (net.wsTransformRegistrations().length > 0 && cfg.cdpWsTransform !== true) {
    log("warn", "plugin registered transformWebSocket but cdpWsTransform is OFF — enable: desktop-proxy config set cdpWsTransform true");
  }
}
setTimeout(warnConfigGates, 3000).unref?.();

// Start watchers: plugin files (hot reload) + config.json (live settings)
startFSWatcher();
startConfigWatcher();

// Cleanup on quit
electron.app.on("will-quit", () => {
  log("info", "desktop-proxy runtime shutting down");
});

log("info", "runtime evaluated; app.isReady=" + electron.app.isReady());
