/**
 * Renderer preload entry point.
 *
 * Runs in an isolated world before the app's page JavaScript loads.
 * Responsibilities:
 *   1. Install React DevTools global hook (before React bundle loads)
 *   2. Install network interceptor (fetch/XHR hooks)
 *   3. After DOMContentLoaded, start plugin host
 *   4. Listen for hot-reload events from main process
 */

import type { IpcRenderer } from "electron";

import { installReactHook } from "./react-hook";
import { installNetworkInterceptor } from "./network-interceptor";
import { startPluginHost, teardownPluginHost } from "./plugin-host";

// ── Electron IPC ─────────────────────────────────────────────────────────────
// In a sandboxed preload context, we can still require("electron") to get ipcRenderer.

let _ipcRenderer: IpcRenderer | null = null;

function getIpcRenderer(): IpcRenderer {
  if (!_ipcRenderer) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    _ipcRenderer = require("electron").ipcRenderer;
  }
  return _ipcRenderer!;
}

function fileLog(stage: string, extra?: unknown): void {
  const msg = `[desktop-proxy preload] ${stage}${extra !== undefined ? " " + JSON.stringify(extra) : ""}`;
  try {
    getIpcRenderer().send("desktop-proxy:preload-log", "info", msg);
  } catch {
    // best effort
  }
}

// ── Boot ─────────────────────────────────────────────────────────────────────

fileLog("preload entry", { url: window.location.href });

// Step 1: Install React hook BEFORE the app's JS bundle runs.
// This must happen synchronously in the preload script.
try {
  installReactHook();
  fileLog("react hook installed");
} catch (e) {
  fileLog("react hook install FAILED", String(e));
}

// Step 2: Install network interceptor to hook fetch/XHR.
try {
  installNetworkInterceptor();
  fileLog("network interceptor installed");
} catch (e) {
  fileLog("network interceptor install FAILED", String(e));
}

// Step 3: After DOMContentLoaded, start plugin host.
function boot(): void {
  fileLog("boot start", { readyState: document.readyState });
  startPluginHost()
    .then(() => fileLog("plugin host started"))
    .catch((e) => fileLog("plugin host start FAILED", String(e)));
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}

// Step 4: Hot reload support — listen for plugin changes from main process.
let reloading: Promise<void> | null = null;

getIpcRenderer().on("desktop-proxy:plugins-changed", () => {
  if (reloading) return;
  reloading = (async () => {
    try {
      fileLog("hot-reloading plugins");
      await teardownPluginHost();
      await startPluginHost();
      fileLog("hot-reload complete");
    } catch (e) {
      fileLog("hot-reload FAILED", String(e));
    } finally {
      reloading = null;
    }
  })();
});

fileLog("preload evaluated");
