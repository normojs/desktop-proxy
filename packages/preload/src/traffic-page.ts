/**
 * Built-in "Network" inspector page — a DevTools/mitmproxy-style view of recent
 * traffic captured by the main-process recorder (config `captureTraffic`), with a
 * filter DSL, category/method/kind quick filters, a request detail panel, HAR
 * export, and "Copy as cURL".
 *
 * Rendered into the overlay's closed Shadow DOM, so everything is inline-styled
 * (no Tailwind). Data comes over IPC: `traffic:list(query)` and `traffic:detail`.
 * See docs/ui/network-inspector.html for the visual reference.
 */

import type { IpcRenderer } from "electron";
import type { PluginManifest } from "@desktop-proxy/plugin-sdk";

import { ch } from "./channels";
import type { SettingsOverlayHandle } from "./settings-overlay";

interface Summary {
  id: string;
  method: string;
  url: string;
  status: number | null;
  source: string | null;
  time: number | null;
  bodyBytes: number | null;
  wsFrames?: number;
  category: string;
  service: string;
  label: string;
  kind: string;
  tags: string[];
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number; costUsd?: number };
}

interface Detail extends Summary {
  statusText: string | null;
  reqHeaders: Record<string, string>;
  resHeaders: Record<string, string>;
  reqBody: string | null;
  resBody: string | null;
  model?: string;
  wsMessages?: Array<{ type: string; data: string }>;
}

interface Stats {
  bytes: number;
  errors: number;
  ai: { calls: number; promptTokens: number; completionTokens: number; costUsd: number | null };
}

interface ListResult {
  enabled: boolean;
  count: number;
  entries: Summary[];
  stats?: Stats;
}

const NETWORK_MANIFEST: PluginManifest = {
  id: "com.desktop-proxy.network",
  name: "Network",
  version: "0.0.0",
  description: "Network inspector",
  main: "",
  scope: "renderer",
};

const CAT: Record<string, { dot: string; fg: string; bg: string }> = {
  ai: { dot: "#7c3aed", fg: "#6d28d9", bg: "rgba(124,58,237,.1)" },
  auth: { dot: "#0891b2", fg: "#0e7490", bg: "rgba(8,145,178,.1)" },
  telemetry: { dot: "#b45309", fg: "#b45309", bg: "rgba(180,83,9,.1)" },
  api: { dot: "#0d9488", fg: "#0f766e", bg: "rgba(13,148,136,.1)" },
  asset: { dot: "#475569", fg: "#475569", bg: "rgba(71,85,105,.1)" },
  websocket: { dot: "#c026d3", fg: "#a21caf", bg: "rgba(192,38,211,.1)" },
  update: { dot: "#ca8a04", fg: "#a16207", bg: "rgba(202,138,4,.1)" },
  doc: { dot: "#6b7280", fg: "#374151", bg: "rgba(107,114,128,.1)" },
  other: { dot: "#9aa3ad", fg: "#6b7280", bg: "rgba(154,163,173,.1)" },
};
const QUICK_CATS = ["ai", "auth", "telemetry", "api", "asset", "websocket"];

export function registerTrafficPage(overlay: SettingsOverlayHandle, ipc: IpcRenderer): void {
  overlay.registerPage(NETWORK_MANIFEST.id, NETWORK_MANIFEST, {
    id: "network",
    title: "Network",
    description: "Inspect captured traffic",
    render(root) {
      void renderInspector(root, ipc);
    },
  });
}

function esc(v: unknown): string {
  return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function fmtBytes(n: number | null): string {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}
function fmtTime(ms: number | null): string {
  if (ms == null) return "—";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
}
function fmtTok(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
function loadPresets(): Array<{ name: string; query: string }> {
  try {
    const v = JSON.parse(localStorage.getItem(PRESETS_KEY) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function savePresets(p: Array<{ name: string; query: string }>): void {
  try {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable */
  }
}
function parseHeaderLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) {
      const k = line.slice(0, i).trim();
      if (k) out[k] = line.slice(i + 1).trim();
    }
  }
  return out;
}
function formatHeaderLines(h: Record<string, string>): string {
  return Object.entries(h)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}
function methodOptions(current: string): string {
  const methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
  if (current && !methods.includes(current)) methods.unshift(current);
  return methods.map((x) => `<option ${x === current ? "selected" : ""}>${esc(x)}</option>`).join("");
}
function statusColor(s: number | null): string {
  if (s == null) return "#9aa3ad";
  return s >= 500 ? "#b42318" : s >= 400 ? "#b54708" : s >= 300 ? "#854d0e" : s >= 200 ? "#039855" : "#175cd3";
}

/** Toggle a `key:value` token inside a DSL query string. */
function toggleToken(query: string, token: string): string {
  const parts = query.split(/\s+/).filter(Boolean);
  const i = parts.indexOf(token);
  if (i >= 0) parts.splice(i, 1);
  else parts.push(token);
  return parts.join(" ");
}
function hasToken(query: string, token: string): boolean {
  return query.split(/\s+/).filter(Boolean).includes(token);
}

let followTimer: ReturnType<typeof setInterval> | null = null;
const PRESETS_KEY = "dp-net-presets";

async function renderInspector(root: HTMLElement, ipc: IpcRenderer): Promise<void> {
  if (followTimer) {
    clearInterval(followTimer);
    followTimer = null;
  }
  const state = { query: "", selected: null as string | null, enabled: false, follow: false, group: false };

  root.innerHTML = `
    <div style="display:flex;flex-direction:column;font:13px system-ui,-apple-system,sans-serif;color:#111;height:520px;">
      <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid #e5e7eb;">
        <h3 style="margin:0;font-size:15px;font-weight:600;letter-spacing:-.01em;">Network</h3>
        <input id="dpi-q" placeholder='filter… e.g. category:ai status:>=400 domain:openai body:"quota" is:stream'
          style="flex:1;min-width:0;height:30px;border:1px solid #e5e7eb;border-radius:6px;background:#f9fafb;padding:0 10px;font-size:12px;font-family:ui-monospace,monospace;outline:none;" />
        <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#374151;cursor:pointer;white-space:nowrap;">
          <input id="dpi-cap" type="checkbox" /> Capture
        </label>
        <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#374151;cursor:pointer;white-space:nowrap;" title="Append captured traffic to log/traffic.ndjson">
          <input id="dpi-persist" type="checkbox" /> Persist
        </label>
        <button id="dpi-har" style="${BTN}">HAR</button>
        <button id="dpi-clear" style="${BTN_DANGER}">Clear</button>
      </div>

      <div id="dpi-chips" style="display:flex;align-items:center;gap:6px;padding:6px 12px;border-bottom:1px solid #e5e7eb;overflow-x:auto;"></div>

      <div id="dpi-presets" style="display:flex;align-items:center;gap:6px;padding:4px 12px;border-bottom:1px solid #e5e7eb;overflow-x:auto;font-size:11px;"></div>

      <div id="dpi-stats" style="padding:4px 12px;border-bottom:1px solid #e5e7eb;font-size:11px;color:#9aa3ad;"></div>

      <div style="display:flex;flex:1;min-height:0;">
        <div style="flex:1;min-width:0;overflow:auto;">
          <table style="width:100%;border-collapse:collapse;font-size:12px;">
            <thead><tr style="position:sticky;top:0;background:#f9fafb;text-align:left;color:#6b7280;">
              <th style="${TH}width:54px;">Method</th><th style="${TH}width:48px;">Status</th>
              <th style="${TH}width:96px;">Category</th><th style="${TH}">Request</th>
              <th style="${TH}width:72px;text-align:right;">Size</th><th style="${TH}width:64px;text-align:right;">Time</th>
              <th style="${TH}width:76px;">Source</th>
            </tr></thead>
            <tbody id="dpi-rows"></tbody>
          </table>
        </div>
        <aside id="dpi-detail" style="width:380px;flex-shrink:0;border-left:1px solid #e5e7eb;overflow:auto;display:none;"></aside>
      </div>
    </div>
  `;

  const q = root.querySelector("#dpi-q") as HTMLInputElement;
  const rowsEl = root.querySelector("#dpi-rows") as HTMLElement;
  const statsEl = root.querySelector("#dpi-stats") as HTMLElement;
  const chipsEl = root.querySelector("#dpi-chips") as HTMLElement;
  const presetsEl = root.querySelector("#dpi-presets") as HTMLElement;
  const detailEl = root.querySelector("#dpi-detail") as HTMLElement;
  const capEl = root.querySelector("#dpi-cap") as HTMLInputElement;
  const persistEl = root.querySelector("#dpi-persist") as HTMLInputElement;

  function renderChips(): void {
    const chip = (label: string, token: string, color?: string) => {
      const on = hasToken(state.query, token);
      const dot = color ? `<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${color};margin-right:4px;"></span>` : "";
      return `<button data-token="${esc(token)}" style="display:inline-flex;align-items:center;border-radius:999px;padding:3px 9px;font-size:11px;font-weight:500;cursor:pointer;white-space:nowrap;${
        on ? "background:#eff8ff;border:1px solid #175cd3;color:#175cd3;" : "background:#fff;border:1px solid #e5e7eb;color:#374151;"
      }">${dot}${esc(label)}</button>`;
    };
    chipsEl.innerHTML =
      QUICK_CATS.map((c) => chip(c === "websocket" ? "WS" : c[0].toUpperCase() + c.slice(1), `category:${c}`, CAT[c].dot)).join("") +
      `<span style="width:1px;height:16px;background:#e5e7eb;margin:0 2px;"></span>` +
      ["GET", "POST"].map((m) => chip(m, `method:${m}`)).join("") +
      `<span style="width:1px;height:16px;background:#e5e7eb;margin:0 2px;"></span>` +
      ["https", "ws", "sse"].map((k) => chip(k.toUpperCase(), `kind:${k}`)).join("") +
      chip("Errors", "is:error") +
      `<span style="width:1px;height:16px;background:#e5e7eb;margin:0 2px;"></span>` +
      toggle("Follow", "follow", state.follow) +
      toggle("Group", "group", state.group);
    chipsEl.querySelectorAll<HTMLButtonElement>("[data-token]").forEach((b) =>
      b.addEventListener("click", () => {
        state.query = toggleToken(state.query, b.getAttribute("data-token")!);
        q.value = state.query;
        renderChips();
        void loadList();
      }),
    );
    chipsEl.querySelectorAll<HTMLButtonElement>("[data-act]").forEach((b) =>
      b.addEventListener("click", () => {
        const act = b.getAttribute("data-act") as "follow" | "group";
        if (act === "follow") setFollow(!state.follow);
        else {
          state.group = !state.group;
          renderChips();
          void loadList();
        }
      }),
    );
  }

  function toggle(label: string, act: string, on: boolean): string {
    return `<button data-act="${act}" style="border-radius:6px;padding:3px 9px;font-size:11px;font-weight:500;cursor:pointer;white-space:nowrap;${
      on ? "background:#eff8ff;border:1px solid #175cd3;color:#175cd3;" : "background:#fff;border:1px solid #e5e7eb;color:#374151;"
    }">${esc(label)}</button>`;
  }

  function setFollow(on: boolean): void {
    state.follow = on;
    if (followTimer) {
      clearInterval(followTimer);
      followTimer = null;
    }
    if (on) followTimer = setInterval(() => void loadList(), 1500);
    renderChips();
  }

  function renderPresets(): void {
    const presets = loadPresets();
    presetsEl.innerHTML =
      `<span style="color:#9aa3ad;font-weight:500;">Saved</span>` +
      (presets.length ? "" : `<span style="color:#cbd2da;">—</span>`) +
      presets
        .map(
          (p, i) =>
            `<button data-pi="${i}" title="${esc(p.query)}" style="display:inline-flex;align-items:center;gap:4px;border:1px solid #e5e7eb;border-radius:999px;padding:2px 8px;font-size:11px;color:#374151;cursor:pointer;white-space:nowrap;">${esc(p.name)}<span data-del="${i}" style="opacity:.5;font-weight:600;">×</span></button>`,
        )
        .join("") +
      `<button id="dpi-save" style="border:1px dashed #d0d5dd;border-radius:999px;padding:2px 8px;font-size:11px;color:#6b7280;cursor:pointer;">+ Save</button>`;
    presetsEl.querySelectorAll<HTMLButtonElement>("[data-pi]").forEach((b) =>
      b.addEventListener("click", (ev) => {
        const i = Number(b.getAttribute("data-pi"));
        if ((ev.target as HTMLElement).hasAttribute("data-del")) {
          const next = loadPresets();
          next.splice(i, 1);
          savePresets(next);
          renderPresets();
          return;
        }
        state.query = loadPresets()[i]?.query ?? "";
        q.value = state.query;
        renderChips();
        void loadList();
      }),
    );
    (presetsEl.querySelector("#dpi-save") as HTMLElement).addEventListener("click", () => {
      const name = window.prompt("Save current filter as:", "");
      if (!name) return;
      const next = loadPresets();
      next.push({ name, query: state.query });
      savePresets(next);
      renderPresets();
    });
  }

  async function loadList(): Promise<void> {
    let data: ListResult = { enabled: false, count: 0, entries: [] };
    try {
      data = await ipc.invoke(ch("traffic:list"), state.query);
    } catch {
      /* ignore */
    }
    state.enabled = data.enabled;
    capEl.checked = data.enabled;
    const shown = data.entries.length;
    const s = data.stats;
    let aiText = "";
    if (s && s.ai.calls) {
      const tok = s.ai.promptTokens + s.ai.completionTokens;
      aiText = ` · ${s.ai.calls} AI${tok ? ` · ~${fmtTok(tok)} tok` : ""}${s.ai.costUsd != null ? ` · ~$${s.ai.costUsd.toFixed(3)}` : ""}`;
    }
    statsEl.textContent = data.enabled
      ? `${shown} shown · ${data.count} captured${s ? ` · ${fmtBytes(s.bytes)} · ${s.errors} errors` : ""}${aiText}`
      : "Capture is off — enable it and interact with the app.";
    renderRows(data.entries);
  }

  function renderRows(entries: Summary[]): void {
    if (!entries.length) {
      rowsEl.innerHTML = `<tr><td colspan="7" style="padding:18px;text-align:center;color:#9aa3ad;">No matching requests.</td></tr>`;
      return;
    }
    if (state.group) {
      const groups = new Map<string, Summary[]>();
      for (const e of entries) {
        const h = hostOf(e.url);
        if (!groups.has(h)) groups.set(h, []);
        groups.get(h)!.push(e);
      }
      rowsEl.innerHTML = [...groups.entries()]
        .map(
          ([host, es]) =>
            `<tr><td colspan="7" style="padding:4px 10px;background:#f9fafb;font-weight:600;color:#6b7280;border-top:1px solid #e5e7eb;">${esc(host)} <span style="color:#9aa3ad;font-weight:400;">(${es.length})</span></td></tr>` +
            es.map(renderRow).join(""),
        )
        .join("");
    } else {
      rowsEl.innerHTML = entries.map(renderRow).join("");
    }
    rowsEl.querySelectorAll<HTMLElement>("[data-id]").forEach((tr) =>
      tr.addEventListener("click", () => void selectRow(tr.getAttribute("data-id")!)),
    );
  }

  function renderRow(e: Summary): string {
    const c = CAT[e.category] ?? CAT.other;
    const status = e.kind === "ws" ? `${e.wsFrames ?? 0}f` : e.status != null ? String(e.status) : "—";
    const sel = e.id === state.selected;
    return `<tr data-id="${esc(e.id)}" style="cursor:pointer;border-top:1px solid #f1f3f5;${sel ? "background:#eff8ff;" : ""}">
      <td style="${TD}font-weight:600;color:#374151;">${esc(e.method)}</td>
      <td style="${TD}font-weight:600;color:${statusColor(e.status)};">${esc(status)}</td>
      <td style="${TD}"><span style="display:inline-flex;align-items:center;gap:4px;border-radius:4px;padding:1px 6px;font-size:10px;font-weight:500;color:${c.fg};background:${c.bg};"><span style="width:6px;height:6px;border-radius:50%;background:${c.dot};"></span>${esc(e.category)}</span></td>
      <td style="${TD}max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(e.url)}">${esc(e.label || e.url)}</td>
      <td style="${TD}text-align:right;color:#6b7280;">${esc(fmtBytes(e.bodyBytes))}</td>
      <td style="${TD}text-align:right;color:#6b7280;">${esc(fmtTime(e.time))}</td>
      <td style="${TD}color:#9aa3ad;">${esc(e.source ?? "")}</td>
    </tr>`;
  }

  async function selectRow(id: string): Promise<void> {
    state.selected = id;
    rowsEl.querySelectorAll<HTMLElement>("[data-id]").forEach((tr) => {
      tr.style.background = tr.getAttribute("data-id") === id ? "#eff8ff" : "";
    });
    let d: Detail | null = null;
    try {
      d = await ipc.invoke(ch("traffic:detail"), id);
    } catch {
      /* ignore */
    }
    if (!d) {
      detailEl.style.display = "none";
      return;
    }
    detailEl.style.display = "block";
    renderDetail(d);
  }

  function renderDetail(d: Detail): void {
    const c = CAT[d.category] ?? CAT.other;
    const headerRows = (h: Record<string, string>) =>
      Object.entries(h)
        .map(([k, v]) => `<div style="display:flex;gap:8px;padding:2px 0;"><span style="color:#6b7280;min-width:110px;">${esc(k)}</span><span style="word-break:break-all;font-family:ui-monospace,monospace;font-size:11px;">${esc(v)}</span></div>`)
        .join("") || `<div style="color:#9aa3ad;">none</div>`;
    const sse = d.kind === "sse" || (d.wsMessages && d.wsMessages.length);
    const responseBlock = d.wsMessages?.length
      ? d.wsMessages.map((m) => `<div style="border-left:2px solid ${m.type === "send" ? "#175cd3" : "#7c3aed"};padding-left:8px;">${esc(m.type)}: ${esc(m.data)}</div>`).join("")
      : `<pre style="${PRE}">${esc(d.resBody ?? "(no body captured)")}</pre>`;

    detailEl.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid #e5e7eb;">
        <span style="border-radius:4px;padding:1px 6px;font-size:10px;font-weight:600;text-transform:uppercase;color:${c.fg};background:${c.bg};">${esc(d.category)}</span>
        <span style="font-size:13px;font-weight:600;letter-spacing:-.01em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(d.service)}</span>
        <span style="margin-left:auto;display:flex;gap:6px;flex-shrink:0;">
          <button id="dpi-edit" style="${BTN}">Edit</button>
          <button id="dpi-replay" style="${BTN}">Replay</button>
          <button id="dpi-curl" style="${BTN}">Copy as cURL</button>
        </span>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:1px;background:#e5e7eb;border-bottom:1px solid #e5e7eb;">
        ${summaryCell("Status", d.status != null ? String(d.status) : "—", statusColor(d.status))}
        ${summaryCell("Kind", d.kind.toUpperCase())}
        ${summaryCell("Time", fmtTime(d.time))}
        ${summaryCell("Model", d.model ?? "—")}
        ${summaryCell("Size", fmtBytes(d.bodyBytes))}
        ${summaryCell("Source", d.source ?? "—")}
        ${d.usage ? summaryCell("Tokens", `${d.usage.promptTokens ?? "?"} → ${d.usage.completionTokens ?? "?"}`) : ""}
        ${d.usage?.costUsd != null ? summaryCell("Est. cost", `~$${d.usage.costUsd.toFixed(4)}`) : ""}
      </div>
      <div id="dpi-tabs" style="display:flex;gap:14px;padding:0 12px;border-bottom:1px solid #e5e7eb;font-size:12px;">
        ${["Endpoint", "Headers", "Payload", "Response"].map((t, i) => `<button data-tab="${t}" style="margin-bottom:-1px;border:0;background:none;border-bottom:2px solid ${i === 0 ? "#175cd3" : "transparent"};color:${i === 0 ? "#175cd3" : "#6b7280"};padding:8px 0;font-weight:500;cursor:pointer;">${t}</button>`).join("")}
      </div>
      <div style="padding:12px;font-size:12px;">
        <div data-pane="Endpoint">
          <div style="${LBL}">Endpoint</div>
          <div style="word-break:break-all;border:1px solid #e5e7eb;background:#f9fafb;border-radius:6px;padding:6px 10px;font-family:ui-monospace,monospace;font-size:11px;">${esc(d.method)} ${esc(d.url)}</div>
          ${d.tags?.length ? `<div style="margin-top:8px;display:flex;gap:4px;flex-wrap:wrap;">${d.tags.map((t) => `<span style="border:1px solid #e5e7eb;border-radius:4px;padding:1px 6px;font-size:10px;color:#6b7280;">${esc(t)}</span>`).join("")}</div>` : ""}
        </div>
        <div data-pane="Headers" style="display:none;">
          <div style="${LBL}">Request</div>${headerRows(d.reqHeaders)}
          <div style="${LBL}margin-top:10px;">Response</div>${headerRows(d.resHeaders)}
        </div>
        <div data-pane="Payload" style="display:none;"><pre style="${PRE}">${esc(pretty(d.reqBody) ?? "(no payload)")}</pre></div>
        <div data-pane="Response" style="display:none;">
          ${sse ? `<div style="${LBL}">SSE / frames</div><div style="border:1px solid #e5e7eb;background:#f9fafb;border-radius:6px;padding:8px;font-family:ui-monospace,monospace;font-size:11px;display:flex;flex-direction:column;gap:2px;">${responseBlock}</div>` : responseBlock}
        </div>
      </div>
    `;
    const tabs = detailEl.querySelector("#dpi-tabs") as HTMLElement;
    tabs.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const t = btn.getAttribute("data-tab");
        tabs.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((b) => {
          const on = b === btn;
          b.style.borderBottomColor = on ? "#175cd3" : "transparent";
          b.style.color = on ? "#175cd3" : "#6b7280";
        });
        detailEl.querySelectorAll<HTMLElement>("[data-pane]").forEach((p) => {
          p.style.display = p.getAttribute("data-pane") === t ? "block" : "none";
        });
      }),
    );
    (detailEl.querySelector("#dpi-curl") as HTMLElement).addEventListener("click", () => copyText(toCurl(d)));
    (detailEl.querySelector("#dpi-edit") as HTMLElement).addEventListener("click", () => renderEditor(d));
    (detailEl.querySelector("#dpi-replay") as HTMLElement).addEventListener("click", () => {
      void ipc.invoke(ch("traffic:replay"), d.id).then((r: { ok: boolean; status?: number; error?: string }) => {
        statsEl.textContent = r.ok ? `Replayed → ${r.status}` : `Replay failed: ${esc(r.error)}`;
        setTimeout(() => void loadList(), 500);
      });
    });
  }

  function renderEditor(d: Detail): void {
    detailEl.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid #e5e7eb;">
        <span style="font-size:13px;font-weight:600;letter-spacing:-.01em;">Edit &amp; resend</span>
        <span style="margin-left:auto;display:flex;gap:6px;">
          <button id="dpe-cancel" style="${BTN}">Cancel</button>
          <button id="dpe-send" style="${BTN_PRIMARY}">Send</button>
        </span>
      </div>
      <div style="padding:12px;display:flex;flex-direction:column;gap:10px;font-size:12px;">
        <div style="display:flex;gap:8px;">
          <select id="dpe-method" style="${INPUT}width:96px;">${methodOptions(d.method)}</select>
          <input id="dpe-url" value="${esc(d.url)}" style="${INPUT}flex:1;min-width:0;" />
        </div>
        <div><div style="${LBL}">Headers (one per line: Key: Value)</div><textarea id="dpe-headers" rows="6" style="${TA}">${esc(formatHeaderLines(d.reqHeaders))}</textarea></div>
        <div><div style="${LBL}">Body</div><textarea id="dpe-body" rows="8" style="${TA}">${esc(d.reqBody ?? "")}</textarea></div>
      </div>
    `;
    (detailEl.querySelector("#dpe-cancel") as HTMLElement).addEventListener("click", () => renderDetail(d));
    (detailEl.querySelector("#dpe-send") as HTMLElement).addEventListener("click", () => {
      const method = (detailEl.querySelector("#dpe-method") as HTMLSelectElement).value;
      const url = (detailEl.querySelector("#dpe-url") as HTMLInputElement).value;
      const headers = parseHeaderLines((detailEl.querySelector("#dpe-headers") as HTMLTextAreaElement).value);
      const bodyVal = (detailEl.querySelector("#dpe-body") as HTMLTextAreaElement).value;
      void ipc
        .invoke(ch("traffic:replay"), d.id, { method, url, headers, body: bodyVal === "" ? undefined : bodyVal })
        .then((r: { ok: boolean; status?: number; error?: string }) => {
          statsEl.textContent = r.ok ? `Resent → ${r.status}` : `Resend failed: ${esc(r.error)}`;
          setTimeout(() => void loadList(), 500);
        });
    });
  }

  // ── wiring ────────────────────────────────────────────────────────────────
  let timer: ReturnType<typeof setTimeout> | null = null;
  q.addEventListener("input", () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      state.query = q.value.trim();
      renderChips();
      void loadList();
    }, 200);
  });
  capEl.addEventListener("change", () => {
    void ipc.invoke(ch("set-config"), { captureTraffic: capEl.checked }).then(() => setTimeout(() => void loadList(), 300));
  });
  persistEl.addEventListener("change", () => {
    void ipc.invoke(ch("set-config"), { persistTraffic: persistEl.checked });
  });
  void ipc
    .invoke(ch("get-config"))
    .then((cfg: { persistTraffic?: boolean }) => {
      persistEl.checked = cfg?.persistTraffic === true;
    })
    .catch(() => {});
  (root.querySelector("#dpi-clear") as HTMLElement).addEventListener("click", () => {
    void ipc.invoke(ch("traffic:clear")).then(() => {
      state.selected = null;
      detailEl.style.display = "none";
      void loadList();
    });
  });
  (root.querySelector("#dpi-har") as HTMLElement).addEventListener("click", () => {
    void ipc.invoke(ch("traffic:export"), state.query).then((r: { path: string; count: number }) => {
      statsEl.textContent = `Exported ${r.count} entries → ${r.path}`;
    });
  });

  renderChips();
  renderPresets();
  await loadList();
}

function summaryCell(label: string, value: string, color = "#111"): string {
  return `<div style="background:#fff;padding:6px 10px;"><div style="font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:#9aa3ad;">${esc(label)}</div><div style="font-weight:500;color:${color};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(value)}</div></div>`;
}
function pretty(body: string | null): string | null {
  if (body == null) return null;
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}
function toCurl(d: Detail): string {
  const parts = [`curl -X ${d.method} ${shq(d.url)}`];
  for (const [k, v] of Object.entries(d.reqHeaders)) parts.push(`-H ${shq(`${k}: ${v}`)}`);
  if (d.reqBody) parts.push(`--data ${shq(d.reqBody)}`);
  return parts.join(" \\\n  ");
}
function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
function copyText(text: string): void {
  try {
    void navigator.clipboard?.writeText(text);
  } catch {
    /* clipboard unavailable */
  }
}

const BTN = "height:30px;display:inline-flex;align-items:center;padding:0 10px;border:1px solid #d0d5dd;border-radius:6px;background:#fff;color:#374151;font-size:12px;font-weight:500;cursor:pointer;";
const BTN_PRIMARY = "height:30px;display:inline-flex;align-items:center;padding:0 12px;border:1px solid #175cd3;border-radius:6px;background:#175cd3;color:#fff;font-size:12px;font-weight:500;cursor:pointer;";
const INPUT = "height:30px;border:1px solid #e5e7eb;border-radius:6px;background:#fff;padding:0 8px;font-size:12px;font-family:ui-monospace,monospace;outline:none;box-sizing:border-box;";
const TA = "width:100%;border:1px solid #e5e7eb;border-radius:6px;background:#fff;padding:8px;font-size:11px;font-family:ui-monospace,monospace;outline:none;box-sizing:border-box;resize:vertical;";
const BTN_DANGER = "height:30px;display:inline-flex;align-items:center;padding:0 10px;border:1px solid #fecdca;border-radius:6px;background:#fff;color:#b42318;font-size:12px;font-weight:500;cursor:pointer;";
const TH = "padding:6px 10px;font-weight:500;white-space:nowrap;";
const TD = "padding:5px 10px;white-space:nowrap;";
const LBL = "font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:#9aa3ad;margin-bottom:4px;";
const PRE = "overflow:auto;border:1px solid #e5e7eb;background:#f9fafb;border-radius:6px;padding:8px;font-family:ui-monospace,monospace;font-size:11px;line-height:1.5;color:#374151;white-space:pre-wrap;word-break:break-word;margin:0;";
