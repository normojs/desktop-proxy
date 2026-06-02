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

import { isLevelEnabled } from "@desktop-proxy/plugin-sdk";

import { ch, setChannelPrefix } from "./channels";
import { installReactHook } from "./react-hook";
import { installNetworkInterceptor } from "./network-interceptor";
import { startPluginHost, teardownPluginHost, setSettingsCallbacks, setLogLevel } from "./plugin-host";
import { installSettingsOverlay, type SettingsOverlayHandle } from "./settings-overlay";

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

// Mirrored from the main process; framework diagnostics log at "info".
let activeLogLevel = "info";

function fileLog(stage: string, extra?: unknown): void {
  if (!isLevelEnabled("info", activeLogLevel)) return;
  const msg = `[desktop-proxy preload] ${stage}${extra !== undefined ? " " + JSON.stringify(extra) : ""}`;
  try {
    getIpcRenderer().send(ch("preload-log"), "info", msg);
  } catch {
    // best effort
  }
}

/**
 * Read framework config synchronously. The hooks below run before any page code,
 * so we cannot wait on an async IPC round-trip here.
 */
function readConfigSync(): { stealth: boolean; logLevel: string; channelPrefix: string } {
  try {
    const cfg = getIpcRenderer().sendSync("desktop-proxy:config-sync") as
      | { stealth?: boolean; logLevel?: string; channelPrefix?: string }
      | undefined;
    return {
      stealth: cfg?.stealth === true,
      logLevel: cfg?.logLevel ?? "info",
      channelPrefix: cfg?.channelPrefix ?? "desktop-proxy",
    };
  } catch {
    return { stealth: false, logLevel: "info", channelPrefix: "desktop-proxy" };
  }
}

// ── Boot ─────────────────────────────────────────────────────────────────────

const { stealth, logLevel, channelPrefix } = readConfigSync();
setChannelPrefix(channelPrefix);
activeLogLevel = logLevel;
setLogLevel(logLevel);
fileLog("preload entry", { url: window.location.href, stealth, logLevel, channelPrefix });

// Step 1: Install React hook BEFORE the app's JS bundle runs.
// This must happen synchronously in the preload script.
try {
  installReactHook(stealth);
  fileLog("react hook installed");
} catch (e) {
  fileLog("react hook install FAILED", String(e));
}

// Step 2: Install network interceptor to hook fetch/XHR.
try {
  installNetworkInterceptor(stealth);
  fileLog("network interceptor installed");
} catch (e) {
  fileLog("network interceptor install FAILED", String(e));
}

// Step 3: After DOMContentLoaded, install the settings overlay and start the
// plugin host. The overlay must be wired before plugins run so that
// api.settings.* registrations made during start() land in the panel.
let overlay: SettingsOverlayHandle | null = null;

function boot(): void {
  fileLog("boot start", { readyState: document.readyState });
  try {
    if (!overlay) {
      overlay = installSettingsOverlay({ stealth });
      setSettingsCallbacks(overlay.registerSection, overlay.registerPage);
      fileLog("settings overlay installed");
    }
  } catch (e) {
    fileLog("settings overlay install FAILED", String(e));
  }
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

getIpcRenderer().on(ch("plugins-changed"), () => {
  if (reloading) return;
  reloading = (async () => {
    try {
      fileLog("hot-reloading plugins");
      await teardownPluginHost();
      overlay?.clearAll();
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
