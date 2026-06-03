/**
 * Built-in "Model Relay" settings page.
 *
 * Edits `config.relay` over the bus (config.get/set). The injected runtime's
 * config watcher applies changes live (starts/stops/reconfigures the relay), so
 * model rewrites and upstream/fallback tweaks take effect without a restart.
 *
 * Pointing an out-of-process core at the relay (e.g. Codex's ~/.codex/config.toml)
 * is a one-time CLI step: `dprox relay on --codex`.
 */

import type { PluginManifest } from "@desktop-proxy/plugin-sdk";

import { getRendererBus } from "./bus";
import type { SettingsOverlayHandle } from "./settings-overlay";

interface RelayCfg {
  enabled?: boolean;
  port?: number;
  upstream?: string;
  proxy?: string;
  apiKey?: string;
  modelMap?: Record<string, string>;
  fallbackModels?: string[];
}

const RELAY_MANIFEST: PluginManifest = {
  id: "com.desktop-proxy.relay",
  name: "Model Relay",
  version: "0.0.0",
  description: "Model traffic relay",
  main: "",
  scope: "renderer",
};

const DEEPSEEK_PRESET = "gpt-5.4-mini = deepseek-v4-flash\ngpt-5.4 = deepseek-v4-pro\ngpt-5* = deepseek-v4-pro";

export function registerRelayPage(overlay: SettingsOverlayHandle): void {
  overlay.registerPage(RELAY_MANIFEST.id, RELAY_MANIFEST, {
    id: "relay",
    title: "Model Relay",
    description: "Capture & rewrite model traffic",
    render(root) {
      void renderRelay(root);
    },
  });
}

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formatMap(map: Record<string, string> | undefined): string {
  return Object.entries(map ?? {})
    .map(([k, v]) => `${k} = ${v}`)
    .join("\n");
}

function parseMap(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf("=");
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (k && v) out[k] = v;
  }
  return out;
}

const INPUT = "width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid #d0d5dd;border-radius:6px;font:13px ui-monospace,monospace;background:#fff;color:#111;";
const LBL = "display:block;margin:0 0 4px;color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:.04em;";
const ROW = "margin:0 0 12px;";

async function renderRelay(root: HTMLElement): Promise<void> {
  const bus = getRendererBus();
  root.textContent = "Loading…";

  let cfg: { relay?: RelayCfg } = {};
  try {
    cfg = await bus.request<{ relay?: RelayCfg }>("config.get");
  } catch {
    /* defaults */
  }
  const r = cfg.relay ?? {};

  root.innerHTML = `
    <div style="font:13px system-ui,-apple-system,sans-serif;padding:12px;color:#111;max-width:560px;">
      <h3 style="margin:0 0 4px;font-size:15px;font-weight:600;">Model Relay</h3>
      <div style="margin:0 0 14px;color:#6b7280;font-size:12px;">
        Capture an IDE core's model traffic and rewrite/route it. Changes apply live.
      </div>

      <label style="display:flex;align-items:center;gap:8px;${ROW}">
        <input type="checkbox" id="dpr-enabled" ${r.enabled ? "checked" : ""}/> Enabled
      </label>

      <div style="${ROW}"><label style="${LBL}">Upstream base URL</label>
        <input id="dpr-upstream" style="${INPUT}" placeholder="https://api.openai.com/v1 or http://127.0.0.1:57321/v1" value="${esc(r.upstream ?? "")}"/></div>

      <div style="display:flex;gap:10px;${ROW}">
        <div style="flex:1;"><label style="${LBL}">Local port</label>
          <input id="dpr-port" style="${INPUT}" value="${esc(String(r.port ?? 8788))}"/></div>
        <div style="flex:2;"><label style="${LBL}">Outbound proxy (optional)</label>
          <input id="dpr-proxy" style="${INPUT}" placeholder="http://127.0.0.1:7897" value="${esc(r.proxy ?? "")}"/></div>
      </div>

      <div style="${ROW}"><label style="${LBL}">Inject API key (optional, if client sends none)</label>
        <input id="dpr-key" type="password" style="${INPUT}" value="${esc(r.apiKey ?? "")}"/></div>

      <div style="${ROW}">
        <label style="${LBL}">Model rewrite — one <code>from = to</code> per line (<code>prefix*</code> allowed)</label>
        <textarea id="dpr-map" rows="4" style="${INPUT}resize:vertical;" placeholder="gpt-5* = deepseek-v4-pro">${esc(formatMap(r.modelMap))}</textarea>
        <button id="dpr-preset" style="margin-top:6px;padding:4px 10px;border:1px solid #d0d5dd;border-radius:6px;background:#fff;cursor:pointer;font-size:12px;">Preset: DeepSeek backend</button>
      </div>

      <div style="${ROW}"><label style="${LBL}">Fallback models (comma-separated; retried on error)</label>
        <input id="dpr-fallback" style="${INPUT}" placeholder="deepseek-v4-pro, deepseek-v4-flash" value="${esc((r.fallbackModels ?? []).join(", "))}"/></div>

      <div style="display:flex;align-items:center;gap:12px;margin-top:6px;">
        <button id="dpr-save" style="padding:7px 16px;border:1px solid #0a84ff;border-radius:6px;background:#0a84ff;color:#fff;cursor:pointer;font-size:13px;font-weight:500;">Save</button>
        <span id="dpr-status" style="color:#039855;font-size:12px;"></span>
      </div>

      <div style="margin-top:14px;padding:8px 10px;background:#f7f8fa;border:1px solid #eceef1;border-radius:6px;color:#6b7280;font-size:11px;line-height:1.5;">
        To route Codex's core through this relay (one-time): <code style="background:#eceef1;padding:1px 4px;border-radius:3px;">dprox relay on --codex</code><br/>
        It backs up <code>~/.codex/config.toml</code> and chains in front of your existing provider. Revert: <code style="background:#eceef1;padding:1px 4px;border-radius:3px;">dprox relay off --codex</code>.
      </div>
    </div>
  `;

  const statusEl = root.querySelector("#dpr-status") as HTMLElement | null;
  const flash = (msg: string, color = "#039855") => {
    if (!statusEl) return;
    statusEl.style.color = color;
    statusEl.textContent = msg;
    setTimeout(() => {
      if (statusEl.textContent === msg) statusEl.textContent = "";
    }, 2200);
  };

  const mapEl = root.querySelector("#dpr-map") as HTMLTextAreaElement;
  root.querySelector("#dpr-preset")?.addEventListener("click", () => {
    mapEl.value = DEEPSEEK_PRESET;
  });

  root.querySelector("#dpr-save")?.addEventListener("click", () => {
    const relay: RelayCfg = {
      enabled: (root.querySelector("#dpr-enabled") as HTMLInputElement).checked,
      port: Number((root.querySelector("#dpr-port") as HTMLInputElement).value) || 8788,
      upstream: (root.querySelector("#dpr-upstream") as HTMLInputElement).value.trim(),
      proxy: (root.querySelector("#dpr-proxy") as HTMLInputElement).value.trim() || undefined,
      apiKey: (root.querySelector("#dpr-key") as HTMLInputElement).value.trim() || undefined,
      modelMap: parseMap(mapEl.value),
      fallbackModels: (root.querySelector("#dpr-fallback") as HTMLInputElement).value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    };
    if (relay.enabled && !relay.upstream) {
      flash("Upstream is required when enabled", "#b42318");
      return;
    }
    void bus
      .request("config.set", { relay })
      .then(() => flash("Saved — applies live"))
      .catch((e) => flash(`Save failed: ${String(e)}`, "#b42318"));
  });
}
