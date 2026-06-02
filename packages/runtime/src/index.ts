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
  plugins?: Record<string, { enabled: boolean }>;
}

function readConfig(): Config {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeConfig(c: Config): void {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2));
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

function getMainNetwork(): MainNetwork {
  if (!_mainNetwork) {
    const electron = getElectron();
    _mainNetwork = createMainNetwork(
      () => electron.session.defaultSession,
      () => electron.app.whenReady().then(() => undefined),
      log,
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
      get: <T>(key: string, defaultValue?: T): T => {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(userRoot, `plugin-${manifest.id}.json`), "utf8"));
          return key in data ? data[key] : (defaultValue as T);
        } catch {
          return defaultValue as T;
        }
      },
      set: (key: string, value: unknown) => {
        const filePath = path.join(userRoot, `plugin-${manifest.id}.json`);
        let data: Record<string, unknown> = {};
        try { data = JSON.parse(fs.readFileSync(filePath, "utf8")); } catch {}
        data[key] = value;
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
      },
      delete: (key: string) => {
        const filePath = path.join(userRoot, `plugin-${manifest.id}.json`);
        try {
          const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
          delete data[key];
          fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        } catch {}
      },
      all: () => {
        try { return JSON.parse(fs.readFileSync(path.join(userRoot, `plugin-${manifest.id}.json`), "utf8")); } catch { return {}; }
      },
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
  electron.ipcMain.handle(ch("list-plugins"), async () => {
    discoverPlugins();
    return discoveredPlugins.map((p) => ({
      manifest: p.manifest,
      entry: p.entry,
      dir: p.dir,
      enabled: isPluginEnabled(p.manifest.id),
      compatible: satisfiesMinVersion(FRAMEWORK_VERSION, p.manifest.minDesktopProxyVersion),
    }));
  });

  // User paths — preload needs to know the user root
  electron.ipcMain.handle(ch("user-paths"), async () => ({
    userRoot,
    runtimeDir,
    pluginsDir: PLUGINS_DIR,
  }));

  // Config read
  electron.ipcMain.handle(ch("get-config"), async () => ({
    ...readConfig(),
    version: FRAMEWORK_VERSION,
  }));

  // Toggle plugin enabled state
  electron.ipcMain.handle(ch("toggle-plugin"), async (_e, id: string, enabled: boolean) => {
    const cfg = readConfig();
    cfg.plugins ??= {};
    cfg.plugins[id] = { ...cfg.plugins[id], enabled };
    writeConfig(cfg);
    return { id, enabled };
  });

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
  electron.ipcMain.handle(ch("set-config"), async (_e, patch: Record<string, unknown>) => {
    const cfg = readConfig() as Record<string, unknown>;
    for (const [key, value] of Object.entries(patch ?? {})) {
      cfg[key] = value;
    }
    writeConfig(cfg as Config);
    return { ok: true };
  });

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

  // Sandboxed filesystem — renderer plugins reach disk through these handlers.
  // The plugin id scopes each call to its own confined data directory.
  type FileEncoding = import("@desktop-proxy/plugin-sdk").FileEncoding;
  const fsRoot = (id: string) => pluginDataDir(userRoot, id);

  electron.ipcMain.handle(ch("fs:read"), async (_e, id: string, p: string, encoding?: FileEncoding) =>
    fsRead(fsRoot(id), p, encoding),
  );
  electron.ipcMain.handle(ch("fs:write"), async (_e, id: string, p: string, data: string, encoding?: FileEncoding) =>
    fsWrite(fsRoot(id), p, data, encoding),
  );
  electron.ipcMain.handle(ch("fs:exists"), async (_e, id: string, p: string) =>
    fsExists(fsRoot(id), p),
  );
  electron.ipcMain.handle(ch("fs:list"), async (_e, id: string, p?: string) =>
    fsList(fsRoot(id), p),
  );
  electron.ipcMain.handle(ch("fs:delete"), async (_e, id: string, p: string) =>
    fsDelete(fsRoot(id), p),
  );
  electron.ipcMain.handle(ch("fs:mkdir"), async (_e, id: string, p: string) =>
    fsMkdir(fsRoot(id), p),
  );
  electron.ipcMain.handle(ch("fs:stat"), async (_e, id: string, p: string) =>
    fsStat(fsRoot(id), p),
  );

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
        const cfg = readConfig();

        const level = parseLevel(process.env.DESKTOP_PROXY_LOG_LEVEL ?? cfg.logLevel, "info");
        if (level !== rootLogger.getLevel()) {
          rootLogger.setLevel(level);
          log("info", `config: logLevel → ${level}`);
        }
        broadcastToRenderers(ch("config-changed"), { logLevel: rootLogger.getLevel() });

        const plugins = JSON.stringify(cfg.plugins ?? {});
        const safeMode = cfg.safeMode === true;
        if (plugins !== lastPlugins || safeMode !== lastSafeMode) {
          lastPlugins = plugins;
          lastSafeMode = safeMode;
          log("info", "config: plugins/safeMode changed; broadcasting reload");
          broadcastToRenderers(ch("plugins-changed"));
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

// Start watchers: plugin files (hot reload) + config.json (live settings)
startFSWatcher();
startConfigWatcher();

// Cleanup on quit
electron.app.on("will-quit", () => {
  log("info", "desktop-proxy runtime shutting down");
});

log("info", "runtime evaluated; app.isReady=" + electron.app.isReady());
