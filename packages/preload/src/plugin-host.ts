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
  PluginApp,
  UnsubscribeFn,
} from "@desktop-proxy/plugin-sdk";

import type { IpcRenderer, IpcRendererEvent } from "electron";

import { fiberForNode } from "./react-hook";
import { onRequest, onResponse } from "./network-interceptor";

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
}

const loaded = new Map<string, LoadedPlugin>();

// Registers from settings-injector (set by caller)
let registerSectionFn: ((section: { id: string; title: string; render: (root: HTMLElement) => void }) => { unregister(): void }) | null = null;
let registerPageFn: ((tweakId: string, manifest: PluginManifest, page: { id: string; title: string; iconSvg?: string; description?: string; render: (root: HTMLElement) => void }) => { unregister(): void }) | null = null;

export function setSettingsCallbacks(
  registerSection: typeof registerSectionFn,
  registerPage: typeof registerPageFn,
): void {
  registerSectionFn = registerSection;
  registerPageFn = registerPage;
}

// ── Plugin API Factory ───────────────────────────────────────────────────────

function createPluginAPI(manifest: PluginManifest): PluginAPI {
  const ipc = getIpcRenderer();
  const id = manifest.id;

  const log: PluginLogger = {
    debug: (...args: unknown[]) => {
      try { ipc.send("desktop-proxy:preload-log", "debug", `[${id}] ${args.map(String).join(" ")}`); } catch {}
    },
    info: (...args: unknown[]) => {
      try { ipc.send("desktop-proxy:preload-log", "info", `[${id}] ${args.map(String).join(" ")}`); } catch {}
    },
    warn: (...args: unknown[]) => {
      try { ipc.send("desktop-proxy:preload-log", "warn", `[${id}] ${args.map(String).join(" ")}`); } catch {}
    },
    error: (...args: unknown[]) => {
      try { ipc.send("desktop-proxy:preload-log", "error", `[${id}] ${args.map(String).join(" ")}`); } catch {}
    },
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
      if (registerSectionFn) return registerSectionFn(section);
      log.warn("registerSection called but settings-injector is not active");
      return { unregister: () => {} };
    },
    registerPage: (page) => {
      if (registerPageFn) return registerPageFn(id, manifest, page);
      log.warn("registerPage called but settings-injector is not active");
      return { unregister: () => {} };
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
      const fullChannel = `desktop-proxy:${id}:${channel}`;
      const wrapped = (_e: IpcRendererEvent, ...args: unknown[]) => handler(...args);
      ipc.on(fullChannel, wrapped);
      return () => { ipc.removeListener(fullChannel, wrapped); };
    },
    send: (channel: string, ...args: unknown[]) => {
      ipc.send(`desktop-proxy:${id}:${channel}`, ...args);
    },
    invoke: async <T>(channel: string, ...args: unknown[]): Promise<T> => {
      return ipc.invoke(`desktop-proxy:${id}:${channel}`, ...args) as Promise<T>;
    },
  };

  const network: PluginNetwork = {
    onRequest: (handler) => onRequest(handler),
    onResponse: (handler) => onResponse(handler),
  };

  const app: PluginApp = {
    getInfo: async () => ipc.invoke("desktop-proxy:app-info"),
    getWindows: async () => ipc.invoke("desktop-proxy:windows"),
  };

  return {
    manifest,
    process: "renderer",
    log,
    storage,
    settings,
    react,
    ipc: ipcBridge,
    network,
    app,
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
  }> = await ipc.invoke("desktop-proxy:list-plugins");

  for (const plugin of plugins) {
    if (plugin.manifest.scope === "main") continue; // main-only, skip
    if (!plugin.enabled) continue;

    try {
      const source: string = await ipc.invoke("desktop-proxy:read-plugin-source", plugin.entry);

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

      const api = createPluginAPI(plugin.manifest);
      await tweak.start(api);
      loaded.set(plugin.manifest.id, {
        manifest: plugin.manifest,
        stop: tweak.stop?.bind(tweak),
      });

      ipc.send("desktop-proxy:preload-log", "info", `Loaded plugin: ${plugin.manifest.id}`);
    } catch (e) {
      ipc.send("desktop-proxy:preload-log", "error", `Plugin load failed: ${plugin.manifest.id}: ${String(e)}`);
    }
  }
}

/** Stop all loaded renderer plugins */
export async function teardownPluginHost(): Promise<void> {
  for (const [id, plugin] of loaded) {
    try {
      await plugin.stop?.();
    } catch (e) {
      // best effort
    }
  }
  loaded.clear();
}
