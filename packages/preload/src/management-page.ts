/**
 * Built-in framework management page (the GUI half of the "both" approach).
 *
 * Registered into the settings overlay by the framework itself (not a plugin),
 * it surfaces the controls that were previously only reachable via orphaned IPC:
 * plugin enable/disable, safe mode, log level, and stealth. All writes go through
 * IPC; the main-process config watcher applies them live.
 */

import type { IpcRenderer } from "electron";
import type { PluginManifest } from "@desktop-proxy/plugin-sdk";

import { getRendererBus } from "./bus";
import { ch } from "./channels";
import type { SettingsOverlayHandle } from "./settings-overlay";

interface PluginListItem {
  manifest: PluginManifest;
  enabled: boolean;
}

interface AppInfo {
  name: string;
  version: string;
  electronVersion: string;
  platform: string;
}

const MANAGE_MANIFEST: PluginManifest = {
  id: "com.desktop-proxy.manage",
  name: "desktop-proxy",
  version: "0.0.0",
  description: "Framework management",
  main: "",
  scope: "renderer",
};

export function registerManagementPage(overlay: SettingsOverlayHandle, ipc: IpcRenderer): void {
  overlay.registerPage(MANAGE_MANIFEST.id, MANAGE_MANIFEST, {
    id: "manage",
    title: "desktop-proxy",
    description: "Framework settings and plugins",
    render(root) {
      void renderManagement(root, ipc);
    },
  });
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function renderManagement(root: HTMLElement, ipc: IpcRenderer): Promise<void> {
  root.textContent = "Loading…";
  const bus = getRendererBus();

  let info: AppInfo | null = null;
  let plugins: PluginListItem[] = [];
  let config: Record<string, unknown> = {};
  try {
    [info, plugins, config] = await Promise.all([
      // app-info stays on IPC (in-app only; not part of the converged bus surface).
      ipc.invoke(ch("app-info")).catch(() => null),
      bus.request<PluginListItem[]>("plugin.list").catch(() => []),
      bus.request<Record<string, unknown>>("config.get").catch(() => ({})),
    ]);
  } catch {
    // fall through with defaults
  }

  const logLevel = (config.logLevel as string) || "info";
  const safeMode = config.safeMode === true;
  const stealth = config.stealth === true;
  const levels = ["debug", "info", "warn", "error", "silent"];

  root.innerHTML = `
    <div style="font:13px system-ui,-apple-system,sans-serif;padding:12px;color:#111;">
      <h3 style="margin:0 0 4px;font-size:15px;font-weight:600;">desktop-proxy</h3>
      <div style="margin-bottom:14px;color:#6b7280;font-size:12px;">
        ${info ? `${esc(info.name)} v${esc(info.version)} · Electron ${esc(info.electronVersion)} · ${esc(info.platform)}` : "app info unavailable"}
      </div>

      <fieldset style="border:1px solid #e5e7eb;border-radius:8px;padding:8px 12px;margin:0 0 14px;">
        <legend style="padding:0 6px;color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:.04em;">Framework</legend>
        <label style="display:flex;align-items:center;gap:8px;margin:8px 0;">
          <input type="checkbox" id="dpm-safe" ${safeMode ? "checked" : ""}/> Safe mode (disable all plugins)
        </label>
        <label style="display:flex;align-items:center;gap:8px;margin:8px 0;">
          <span style="min-width:72px;">Log level</span>
          <select id="dpm-log">
            ${levels.map((l) => `<option value="${l}" ${l === logLevel ? "selected" : ""}>${l}</option>`).join("")}
          </select>
        </label>
        <label style="display:flex;align-items:center;gap:8px;margin:8px 0;">
          <input type="checkbox" id="dpm-stealth" ${stealth ? "checked" : ""}/> Stealth mode
          <span style="color:#9aa3ad;">(restart to apply)</span>
        </label>
      </fieldset>

      <fieldset style="border:1px solid #e5e7eb;border-radius:8px;padding:8px 12px;">
        <legend style="padding:0 6px;color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:.04em;">Plugins (${plugins.length})</legend>
        ${
          plugins.length === 0
            ? `<div style="color:#9aa3ad;padding:8px 0;">No plugins installed.</div>`
            : plugins
                .map(
                  (p) => `
          <label style="display:flex;align-items:center;gap:8px;margin:8px 0;">
            <input type="checkbox" data-plugin="${esc(p.manifest.id)}" ${p.enabled ? "checked" : ""}/>
            <span>${esc(p.manifest.name)}
              <span style="color:#9aa3ad;">${esc(p.manifest.id)} · ${esc(p.manifest.scope)}</span>
            </span>
          </label>`,
                )
                .join("")
        }
      </fieldset>

      <div id="dpm-status" style="margin-top:10px;height:16px;color:#039855;font-size:12px;"></div>
    </div>
  `;

  const statusEl = root.querySelector("#dpm-status") as HTMLElement | null;
  const flash = (msg: string) => {
    if (!statusEl) return;
    statusEl.textContent = msg;
    setTimeout(() => {
      if (statusEl.textContent === msg) statusEl.textContent = "";
    }, 1600);
  };

  root.querySelector("#dpm-safe")?.addEventListener("change", (e) => {
    const checked = (e.target as HTMLInputElement).checked;
    void bus.request("config.set", { safeMode: checked }).then(() => flash(checked ? "Safe mode on" : "Safe mode off"));
  });
  root.querySelector("#dpm-log")?.addEventListener("change", (e) => {
    const value = (e.target as HTMLSelectElement).value;
    void bus.request("config.set", { logLevel: value }).then(() => flash(`Log level: ${value}`));
  });
  root.querySelector("#dpm-stealth")?.addEventListener("change", (e) => {
    const checked = (e.target as HTMLInputElement).checked;
    void bus.request("config.set", { stealth: checked }).then(() => flash("Stealth saved — restart to apply"));
  });
  root.querySelectorAll<HTMLInputElement>("[data-plugin]").forEach((el) => {
    el.addEventListener("change", () => {
      const id = el.getAttribute("data-plugin");
      if (!id) return;
      void bus.request("plugin.toggle", { id, enabled: el.checked }).then(() => flash(`${id} ${el.checked ? "enabled" : "disabled"}`));
    });
  });
}
