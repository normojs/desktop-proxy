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

import { createMainNetwork, type MainNetwork } from "./network";
import { createMainCDP, type MainCDP } from "./cdp";
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

function log(level: string, ...args: unknown[]): void {
  const line = `[${new Date().toISOString()}] [${level}] ${args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ")}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    // best effort
  }
  if (level === "error") {
    process.stderr.write(`[desktop-proxy] ${args.join(" ")}\n`);
  }
}

// ── Config ───────────────────────────────────────────────────────────────────

interface Config {
  autoUpdate?: boolean;
  safeMode?: boolean;
  /** When true, minimize the framework's detectable footprint in renderers. */
  stealth?: boolean;
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

// ── Preload Registration ─────────────────────────────────────────────────────

function registerPreload(session: Electron.Session, label: string): void {
  try {
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
        const fullChannel = `desktop-proxy:${manifest.id}:${channel}`;
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
    // CDP is renderer-scoped in v1 (no main-process target). Surface clear errors.
    cdp: {
      attach: async () => { throw new Error("cdp is not available to main-process plugins"); },
      detach: async () => {},
      isAttached: async () => false,
      send: async () => { throw new Error("cdp is not available to main-process plugins"); },
      on: () => () => {},
      evaluate: async () => { throw new Error("cdp is not available to main-process plugins"); },
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
  electron.ipcMain.handle("desktop-proxy:read-plugin-source", async (_e, entryPath: string) => {
    try {
      return fs.readFileSync(entryPath, "utf8");
    } catch (e) {
      log("error", "read-plugin-source failed:", entryPath, String(e));
      throw e;
    }
  });

  // Plugin listing — preload asks main for the plugin list
  electron.ipcMain.handle("desktop-proxy:list-plugins", async () => {
    discoverPlugins();
    return discoveredPlugins.map((p) => ({
      manifest: p.manifest,
      entry: p.entry,
      dir: p.dir,
      enabled: isPluginEnabled(p.manifest.id),
    }));
  });

  // User paths — preload needs to know the user root
  electron.ipcMain.handle("desktop-proxy:user-paths", async () => ({
    userRoot,
    runtimeDir,
    pluginsDir: PLUGINS_DIR,
  }));

  // Config read
  electron.ipcMain.handle("desktop-proxy:get-config", async () => ({
    ...readConfig(),
    version: "0.1.0",
  }));

  // Toggle plugin enabled state
  electron.ipcMain.handle("desktop-proxy:toggle-plugin", async (_e, id: string, enabled: boolean) => {
    const cfg = readConfig();
    cfg.plugins ??= {};
    cfg.plugins[id] = { ...cfg.plugins[id], enabled };
    writeConfig(cfg);
    return { id, enabled };
  });

  // Toggle safe mode
  electron.ipcMain.handle("desktop-proxy:toggle-safe-mode", async (_e, enabled: boolean) => {
    if (enabled) {
      fs.writeFileSync(SAFE_MODE_FILE, "");
    } else {
      try { fs.unlinkSync(SAFE_MODE_FILE); } catch {}
    }
    return { safeMode: enabled };
  });

  // App info
  electron.ipcMain.handle("desktop-proxy:app-info", async () => ({
    name: electron.app.getName(),
    version: electron.app.getVersion(),
    electronVersion: process.versions.electron || "unknown",
    platform: process.platform,
    runtimeDir,
    userRoot,
  }));

  // Window list — preload's app.getWindows() invokes this channel
  electron.ipcMain.handle("desktop-proxy:windows", async () =>
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
  electron.ipcMain.on("desktop-proxy:preload-log", (_e, level: string, msg: string) => {
    log(level, `[preload]`, msg);
  });

  // Synchronous config read — the preload needs the stealth flag *before* it
  // installs any hooks (which happens synchronously at preload evaluation).
  electron.ipcMain.on("desktop-proxy:config-sync", (e) => {
    e.returnValue = { stealth: isStealthEnabled() };
  });

  // Sandboxed filesystem — renderer plugins reach disk through these handlers.
  // The plugin id scopes each call to its own confined data directory.
  type FileEncoding = import("@desktop-proxy/plugin-sdk").FileEncoding;
  const fsRoot = (id: string) => pluginDataDir(userRoot, id);

  electron.ipcMain.handle("desktop-proxy:fs:read", async (_e, id: string, p: string, encoding?: FileEncoding) =>
    fsRead(fsRoot(id), p, encoding),
  );
  electron.ipcMain.handle("desktop-proxy:fs:write", async (_e, id: string, p: string, data: string, encoding?: FileEncoding) =>
    fsWrite(fsRoot(id), p, data, encoding),
  );
  electron.ipcMain.handle("desktop-proxy:fs:exists", async (_e, id: string, p: string) =>
    fsExists(fsRoot(id), p),
  );
  electron.ipcMain.handle("desktop-proxy:fs:list", async (_e, id: string, p?: string) =>
    fsList(fsRoot(id), p),
  );
  electron.ipcMain.handle("desktop-proxy:fs:delete", async (_e, id: string, p: string) =>
    fsDelete(fsRoot(id), p),
  );
  electron.ipcMain.handle("desktop-proxy:fs:mkdir", async (_e, id: string, p: string) =>
    fsMkdir(fsRoot(id), p),
  );
  electron.ipcMain.handle("desktop-proxy:fs:stat", async (_e, id: string, p: string) =>
    fsStat(fsRoot(id), p),
  );

  // Chrome DevTools Protocol — attached to the calling renderer's webContents.
  // Permission gating happens preload-side; events flow back via desktop-proxy:cdp:event.
  electron.ipcMain.handle("desktop-proxy:cdp:attach", async (e) => {
    await getMainCDP().attach(e.sender);
  });
  electron.ipcMain.handle("desktop-proxy:cdp:detach", async (e) => {
    getMainCDP().detach(e.sender);
  });
  electron.ipcMain.handle("desktop-proxy:cdp:isAttached", async (e) =>
    getMainCDP().isAttached(e.sender),
  );
  electron.ipcMain.handle(
    "desktop-proxy:cdp:send",
    async (e, method: string, params?: Record<string, unknown>) =>
      getMainCDP().send(e.sender, method, params),
  );
}

// ── FS Watcher (Hot Reload) ──────────────────────────────────────────────────

function startFSWatcher(): void {
  try {
    const electron = getElectron();
    // Use Node.js fs.watch to monitor plugins directory
    fs.watch(PLUGINS_DIR, { recursive: true }, (_eventType, _filename) => {
      // Debounce: wait 500ms before broadcasting reload
      setTimeout(() => {
        log("info", "Plugin files changed; broadcasting reload");
        electron.BrowserWindow.getAllWindows()
          .filter((w) => !w.isDestroyed())
          .forEach((w) => {
            w.webContents.send("desktop-proxy:plugins-changed");
          });
      }, 500);
    });
    log("info", "FS watcher started on:", PLUGINS_DIR);
  } catch (e) {
    log("warn", "FS watcher failed to start:", String(e));
  }
}

// ── Startup ──────────────────────────────────────────────────────────────────

log("info", "desktop-proxy runtime initializing");
log("info", `userRoot: ${userRoot}`);
log("info", `runtimeDir: ${runtimeDir}`);
log("info", `preloadPath: ${PRELOAD_PATH}`);

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

// Start file system watcher for hot reload
startFSWatcher();

// Cleanup on quit
electron.app.on("will-quit", () => {
  log("info", "desktop-proxy runtime shutting down");
});

log("info", "runtime evaluated; app.isReady=" + electron.app.isReady());
