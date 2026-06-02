/**
 * Plugin host — manages plugin lifecycle in the renderer process.
 *
 * Since the renderer runs with sandbox: true, we cannot require() arbitrary
 * plugin files from disk. Instead we fetch the plugin source via IPC from
 * the main process and evaluate it with new Function() inside the preload
 * context.
 */

import type {
  PluginAPI,
  PluginManifest,
  PluginModule,
  PluginLogger,
  PluginStorage,
  PluginSettings,
  ReactAPI,
  PluginIPC,
  PluginNetwork,
  PluginFS,
  PluginCDPCore,
  PluginUI,
  PluginApp,
  UnsubscribeFn,
  LogLevel,
} from "@desktop-proxy/plugin-sdk";
import { isLevelEnabled, createCDP } from "@desktop-proxy/plugin-sdk";

import type { IpcRenderer, IpcRendererEvent } from "electron";

import { ch } from "./channels";
import { fiberForNode } from "./react-hook";
import { onRequest, onResponse, clearNetworkHandlers } from "./network-interceptor";
import { createUiApi } from "./ui";

// ── IPC Renderer utilities (preload has access to ipcRenderer via require("electron")) ──

let _ipcRenderer: IpcRenderer | null = null;

function getIpcRenderer(): IpcRenderer {
  if (!_ipcRenderer) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    _ipcRenderer = require("electron").ipcRenderer;
  }
  return _ipcRenderer!;
}

// ── Plugin State ─────────────────────────────────────────────────────────────

interface LoadedPlugin {
  manifest: PluginManifest;
  stop?: () => void | Promise<void>;
  dispose: () => void;
}

const loaded = new Map<string, LoadedPlugin>();

// Renderer-side log threshold, mirrored from the main process so we can avoid
// sending suppressed log lines over IPC. Set by index.ts at boot.
let currentLogLevel = "info";

export function setLogLevel(level: string): void {
  currentLogLevel = level || "info";
}

// When enforcement is on, plugins must declare fs/network permissions to use
// those APIs; otherwise undeclared use is allowed with a one-time warning.
let enforcePermissions = false;
const warnedPermissions = new Set<string>();

export function setEnforcePermissions(value: boolean): void {
  enforcePermissions = value;
}

/** Returns true if the plugin may use `perm`. Throws (enforce) or warns once. */
function allowPermission(manifest: PluginManifest, perm: string): boolean {
  if (manifest.permissions?.includes(perm)) return true;
  if (enforcePermissions) return false;
  const key = `${manifest.id}:${perm}`;
  if (!warnedPermissions.has(key)) {
    warnedPermissions.add(key);
    try {
      getIpcRenderer().send(
        ch("preload-log"),
        "warn",
        `Plugin ${manifest.id} uses api.${perm} without declaring "${perm}" in manifest.permissions`,
      );
    } catch {
      // best effort
    }
  }
  return true;
}

// Registers from settings-injector (set by caller)
let registerSectionFn: ((section: { id: string; title: string; render: (root: HTMLElement) => void | (() => void) }) => { unregister(): void }) | null = null;
let registerPageFn: ((tweakId: string, manifest: PluginManifest, page: { id: string; title: string; iconSvg?: string; description?: string; render: (root: HTMLElement) => void | (() => void) }) => { unregister(): void }) | null = null;

export function setSettingsCallbacks(
  registerSection: typeof registerSectionFn,
  registerPage: typeof registerPageFn,
): void {
  registerSectionFn = registerSection;
  registerPageFn = registerPage;
}

// ── Plugin API Factory ───────────────────────────────────────────────────────

function createPluginAPI(manifest: PluginManifest): { api: PluginAPI; dispose: () => void } {
  const ipc = getIpcRenderer();
  const id = manifest.id;

  // Per-plugin disposal scope: every subscription handed to the plugin is
  // remembered here and revoked on teardown, even if the plugin's stop() omits it.
  const disposers: Array<() => void> = [];
  const remember = (off: UnsubscribeFn): UnsubscribeFn => {
    disposers.push(off);
    return off;
  };

  const emitLog = (level: LogLevel, args: unknown[]): void => {
    if (!isLevelEnabled(level, currentLogLevel)) return;
    try {
      ipc.send(ch("preload-log"), level, `[${id}] ${args.map(String).join(" ")}`);
    } catch {
      // best effort
    }
  };

  const log: PluginLogger = {
    debug: (...args: unknown[]) => emitLog("debug", args),
    info: (...args: unknown[]) => emitLog("info", args),
    warn: (...args: unknown[]) => emitLog("warn", args),
    error: (...args: unknown[]) => emitLog("error", args),
    isEnabled: (level) => isLevelEnabled(level, currentLogLevel),
  };

  const storage: PluginStorage = {
    get: <T>(key: string, defaultValue?: T): T => {
      try {
        const data = JSON.parse(localStorage.getItem(`desktop-proxy:storage:${id}`) ?? "{}");
        return key in data ? data[key] : (defaultValue as T);
      } catch {
        return defaultValue as T;
      }
    },
    set: (key: string, value: unknown) => {
      try {
        const data = JSON.parse(localStorage.getItem(`desktop-proxy:storage:${id}`) ?? "{}");
        data[key] = value;
        localStorage.setItem(`desktop-proxy:storage:${id}`, JSON.stringify(data));
      } catch {}
    },
    delete: (key: string) => {
      try {
        const data = JSON.parse(localStorage.getItem(`desktop-proxy:storage:${id}`) ?? "{}");
        delete data[key];
        localStorage.setItem(`desktop-proxy:storage:${id}`, JSON.stringify(data));
      } catch {}
    },
    all: () => {
      try { return JSON.parse(localStorage.getItem(`desktop-proxy:storage:${id}`) ?? "{}"); } catch { return {}; }
    },
  };

  const settings: PluginSettings = {
    registerSection: (section) => {
      const handle = registerSectionFn
        ? registerSectionFn(section)
        : (log.warn("registerSection called but settings-injector is not active"), { unregister: () => {} });
      disposers.push(() => handle.unregister());
      return handle;
    },
    registerPage: (page) => {
      const handle = registerPageFn
        ? registerPageFn(id, manifest, page)
        : (log.warn("registerPage called but settings-injector is not active"), { unregister: () => {} });
      disposers.push(() => handle.unregister());
      return handle;
    },
  };

  const react: ReactAPI = {
    getFiber: (node: Node) => fiberForNode(node),
    findOwnerByName: (node: Node, name: string) => {
      let fiber: any = fiberForNode(node);
      while (fiber) {
        const type = fiber.type;
        if (type && (type.displayName === name || type.name === name)) return fiber;
        fiber = fiber.return;
      }
      return null;
    },
    waitForElement: (selector: string, timeoutMs = 5000): Promise<Element> => {
      return new Promise((resolve, reject) => {
        const existing = document.querySelector(selector);
        if (existing) return resolve(existing);

        const deadline = Date.now() + timeoutMs;
        const observer = new MutationObserver(() => {
          const el = document.querySelector(selector);
          if (el) {
            observer.disconnect();
            resolve(el);
          } else if (Date.now() > deadline) {
            observer.disconnect();
            reject(new Error(`timeout waiting for ${selector}`));
          }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
      });
    },
  };

  const ipcBridge: PluginIPC = {
    on: (channel: string, handler: (...args: unknown[]) => void): UnsubscribeFn => {
      const fullChannel = ch(`${id}:${channel}`);
      const wrapped = (_e: IpcRendererEvent, ...args: unknown[]) => handler(...args);
      ipc.on(fullChannel, wrapped);
      return remember(() => { ipc.removeListener(fullChannel, wrapped); });
    },
    send: (channel: string, ...args: unknown[]) => {
      ipc.send(ch(`${id}:${channel}`), ...args);
    },
    invoke: async <T>(channel: string, ...args: unknown[]): Promise<T> => {
      return ipc.invoke(ch(`${id}:${channel}`), ...args) as Promise<T>;
    },
  };

  const network: PluginNetwork = allowPermission(manifest, "network")
    ? {
        onRequest: (handler) => remember(onRequest(handler)),
        onResponse: (handler) => remember(onResponse(handler)),
      }
    : {
        onRequest: () => {
          throw new Error(`Plugin ${id} lacks the "network" permission`);
        },
        onResponse: () => {
          throw new Error(`Plugin ${id} lacks the "network" permission`);
        },
      };

  const denyFs = () => Promise.reject(new Error(`Plugin ${id} lacks the "fs" permission`));
  const fsApi: PluginFS = allowPermission(manifest, "fs")
    ? {
        read: (p, encoding) => ipc.invoke(ch("fs:read"), id, p, encoding),
        write: (p, data, encoding) => ipc.invoke(ch("fs:write"), id, p, data, encoding),
        exists: (p) => ipc.invoke(ch("fs:exists"), id, p),
        list: (p) => ipc.invoke(ch("fs:list"), id, p),
        delete: (p) => ipc.invoke(ch("fs:delete"), id, p),
        mkdir: (p) => ipc.invoke(ch("fs:mkdir"), id, p),
        stat: (p) => ipc.invoke(ch("fs:stat"), id, p),
      }
    : {
        read: denyFs,
        write: denyFs,
        exists: denyFs,
        list: denyFs,
        delete: denyFs,
        mkdir: denyFs,
        stat: denyFs,
      };

  const cdpCore = createRendererCDPCore(id, manifest, ipc);
  const cdp = createCDP({
    ...cdpCore,
    on: (event, handler) => remember(cdpCore.on(event, handler)),
  });

  const rawUi = createUiApi();
  const ui: PluginUI = {
    ...rawUi,
    injectCSS: (css) => remember(rawUi.injectCSS(css)),
  };

  const app: PluginApp = {
    getInfo: async () => ipc.invoke(ch("app-info")),
    getWindows: async () => ipc.invoke(ch("windows")),
  };

  const api: PluginAPI = {
    manifest,
    process: "renderer",
    log,
    storage,
    settings,
    react,
    ipc: ipcBridge,
    network,
    fs: fsApi,
    cdp,
    ui,
    app,
  };

  const dispose = (): void => {
    for (const off of disposers.splice(0)) {
      try {
        off();
      } catch {
        // best effort
      }
    }
  };

  return { api, dispose };
}

// ── CDP core (renderer) ──────────────────────────────────────────────────────
// Targets the plugin's own webContents over IPC. The shared createCDP() layers
// evaluate()/onResponse()/onRequestPaused() on top of this core.

// Shared CDP event routing: a SINGLE ipc listener (installed once for the
// renderer's lifetime) dispatches to handlers keyed by CDP event method. Using
// module scope avoids leaking a new ipc listener per plugin on every hot reload.
const cdpHandlers = new Map<string, Set<(params: unknown) => void>>();
let cdpListening = false;

function ensureCdpListening(): void {
  if (cdpListening) return;
  cdpListening = true;
  getIpcRenderer().on(ch("cdp:event"), (_e: IpcRendererEvent, payload: { method: string; params: unknown }) => {
    const set = cdpHandlers.get(payload.method);
    if (set) for (const h of set) { try { h(payload.params); } catch { /* ignore */ } }
  });
}

function clearCdpHandlers(): void {
  cdpHandlers.clear();
}

function createRendererCDPCore(
  id: string,
  manifest: PluginManifest,
  ipc: IpcRenderer,
): PluginCDPCore {
  const granted = Array.isArray(manifest.permissions) && manifest.permissions.includes("cdp");

  function requireGrant(): void {
    if (!granted) {
      throw new Error(`Plugin ${id} lacks the "cdp" permission (add "permissions": ["cdp"] to manifest.json)`);
    }
  }

  return {
    attach: async () => {
      requireGrant();
      ensureCdpListening();
      return ipc.invoke(ch("cdp:attach"));
    },
    detach: async () => {
      requireGrant();
      return ipc.invoke(ch("cdp:detach"));
    },
    isAttached: async () => {
      requireGrant();
      return ipc.invoke(ch("cdp:isAttached"));
    },
    send: async <T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> => {
      requireGrant();
      return ipc.invoke(ch("cdp:send"), method, params) as Promise<T>;
    },
    on: (event: string, handler: (params: unknown) => void): UnsubscribeFn => {
      requireGrant();
      ensureCdpListening();
      let set = cdpHandlers.get(event);
      if (!set) cdpHandlers.set(event, (set = new Set()));
      set.add(handler);
      return () => { cdpHandlers.get(event)?.delete(handler); };
    },
  };
}

// ── Plugin Loading ───────────────────────────────────────────────────────────

export async function startPluginHost(): Promise<void> {
  const ipc = getIpcRenderer();

  // Fetch plugin list from main process
  const plugins: Array<{
    manifest: PluginManifest;
    entry: string;
    dir: string;
    enabled: boolean;
    compatible?: boolean;
  }> = await ipc.invoke(ch("list-plugins"));

  for (const plugin of plugins) {
    if (plugin.manifest.scope === "main") continue; // main-only, skip
    if (!plugin.enabled) continue;
    if (plugin.compatible === false) {
      ipc.send(ch("preload-log"), "warn", `Plugin ${plugin.manifest.id} requires a newer desktop-proxy; skipping`);
      continue;
    }

    try {
      const source: string = await ipc.invoke(ch("read-plugin-source"), plugin.entry);

      // Evaluate as CommonJS-shaped module
      const module = { exports: {} as PluginModule };
      const exports = module.exports;
      // eslint-disable-next-line no-new-func
      const fn = new Function("module", "exports", "console", `${source}\n//# sourceURL=desktop-proxy-plugin://${encodeURIComponent(plugin.manifest.id)}/index.js`);
      fn(module, exports, console);

      const mod = module.exports as unknown as Record<string, unknown>;
      const tweak = (mod.default ?? mod) as PluginModule;

      if (typeof tweak?.start !== "function") {
        throw new Error(`Plugin ${plugin.manifest.id} has no start() function`);
      }

      const { api, dispose } = createPluginAPI(plugin.manifest);
      await tweak.start(api);
      loaded.set(plugin.manifest.id, {
        manifest: plugin.manifest,
        stop: tweak.stop?.bind(tweak),
        dispose,
      });

      ipc.send(ch("preload-log"), "info", `Loaded plugin: ${plugin.manifest.id}`);
    } catch (e) {
      ipc.send(ch("preload-log"), "error", `Plugin load failed: ${plugin.manifest.id}: ${String(e)}`);
    }
  }
}

/** Stop all loaded renderer plugins */
export async function teardownPluginHost(): Promise<void> {
  for (const [, plugin] of loaded) {
    try {
      await plugin.stop?.();
    } catch {
      // best effort
    }
    // Revoke every subscription the plugin acquired, regardless of its stop().
    plugin.dispose();
  }
  loaded.clear();
  // Belt-and-suspenders: also clear the shared framework-owned registries.
  clearNetworkHandlers();
  clearCdpHandlers();
}
