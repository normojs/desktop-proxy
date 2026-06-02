/**
 * Universal settings overlay.
 *
 * Codex++ injects its menu into the host app's own settings sidebar by matching
 * Codex-specific DOM. That is fragile and app-specific. Since desktop-proxy
 * targets *any* Electron app, we instead render a framework-owned panel inside a
 * Shadow DOM so it is fully isolated from the host app's markup and CSS, and is
 * reachable on every app via a floating launcher button and a hotkey
 * (Cmd/Ctrl+Shift+\).
 *
 * The plugin host calls setSettingsCallbacks() with the registerSection /
 * registerPage functions returned by installSettingsOverlay(), wiring
 * api.settings.* through to this panel.
 */

import type { PluginManifest } from "@desktop-proxy/plugin-sdk";

type RenderFn = (root: HTMLElement) => void | (() => void);

interface OverlaySection {
  id: string;
  title: string;
  render: RenderFn;
}

interface OverlayPage {
  id: string;
  title: string;
  iconSvg?: string;
  description?: string;
  render: RenderFn;
}

interface RegisteredSection {
  key: string;
  section: OverlaySection;
}

interface RegisteredPage {
  key: string;
  tweakId: string;
  manifest: PluginManifest;
  page: OverlayPage;
}

export interface SettingsOverlayHandle {
  registerSection(section: OverlaySection): { unregister(): void };
  registerPage(
    tweakId: string,
    manifest: PluginManifest,
    page: OverlayPage,
  ): { unregister(): void };
  clearAll(): void;
  open(): void;
  close(): void;
  toggle(): void;
}

const STYLE = `
:host { all: initial; }
* { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }

.dp-launcher {
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
  width: 40px; height: 40px; border-radius: 999px; border: none;
  background: #0a84ff; color: #fff; cursor: pointer; font-size: 16px; font-weight: 700;
  box-shadow: 0 4px 14px rgba(0,0,0,.25); opacity: .85; transition: opacity .15s, transform .15s;
}
.dp-launcher:hover { opacity: 1; transform: translateY(-1px); }

.dp-backdrop {
  position: fixed; inset: 0; z-index: 2147483647;
  background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center;
}
.dp-backdrop[hidden] { display: none; }

.dp-panel {
  width: min(880px, 92vw); height: min(620px, 86vh);
  background: #fff; color: #111; border-radius: 12px; overflow: hidden;
  display: flex; flex-direction: column; box-shadow: 0 20px 60px rgba(0,0,0,.35);
}

.dp-header {
  display: flex; align-items: center; gap: 8px;
  padding: 12px 16px; border-bottom: 1px solid #e6e8eb; flex: 0 0 auto;
}
.dp-header .dp-dot { width: 10px; height: 10px; border-radius: 999px; background: #0a84ff; }
.dp-title { font-size: 14px; font-weight: 600; }
.dp-spacer { flex: 1 1 auto; }
.dp-close {
  border: none; background: transparent; cursor: pointer; font-size: 16px; color: #6b7280;
  width: 28px; height: 28px; border-radius: 6px;
}
.dp-close:hover { background: #f1f3f5; color: #111; }

.dp-body { flex: 1 1 auto; display: flex; min-height: 0; }

.dp-sidebar {
  width: 220px; flex: 0 0 auto; border-right: 1px solid #e6e8eb;
  overflow-y: auto; padding: 8px; background: #fafbfc;
}
.dp-navitem {
  display: flex; align-items: center; gap: 8px; width: 100%; text-align: left;
  padding: 8px 10px; border: none; background: transparent; border-radius: 8px;
  cursor: pointer; font-size: 13px; color: #374151;
}
.dp-navitem:hover { background: #eef1f4; }
.dp-navitem.active { background: #e7f0ff; color: #0a5cd6; font-weight: 600; }
.dp-navitem .dp-ico { width: 16px; height: 16px; display: inline-flex; }
.dp-navitem .dp-ico svg { width: 16px; height: 16px; }

.dp-content { flex: 1 1 auto; overflow-y: auto; padding: 4px; min-width: 0; }
.dp-empty { color: #9aa3ad; font-size: 13px; text-align: center; padding: 48px 16px; }

.dp-section-card {
  border: 1px solid #e6e8eb; border-radius: 10px; margin: 12px; overflow: hidden;
}
.dp-section-card > h4 {
  margin: 0; padding: 10px 12px; font-size: 12px; font-weight: 600;
  text-transform: uppercase; letter-spacing: .04em; color: #6b7280;
  background: #fafbfc; border-bottom: 1px solid #eef1f4;
}
.dp-section-body { padding: 4px; }
`;

let installedHandle: SettingsOverlayHandle | null = null;

export function installSettingsOverlay(opts: { stealth?: boolean } = {}): SettingsOverlayHandle {
  if (installedHandle) return installedHandle;
  const stealth = opts.stealth === true;

  const sections: RegisteredSection[] = [];
  const pages: RegisteredPage[] = [];
  let activeKey: string | null = null;
  let cleanupActive: (() => void) | null = null;

  // ── Shadow host ────────────────────────────────────────────────────────────
  const host = document.createElement("div");
  if (!stealth) host.setAttribute("data-desktop-proxy", "settings-overlay");
  // A closed shadow root hides our UI from `host.shadowRoot` inspection.
  const shadow = host.attachShadow({ mode: stealth ? "closed" : "open" });

  const style = document.createElement("style");
  style.textContent = STYLE;
  shadow.appendChild(style);

  const launcher = document.createElement("button");
  launcher.className = "dp-launcher";
  launcher.textContent = "DP";
  launcher.title = "desktop-proxy settings (Cmd/Ctrl+Shift+\\)";
  // In stealth mode the panel is reachable only via the hotkey.
  if (stealth) launcher.style.display = "none";

  const backdrop = document.createElement("div");
  backdrop.className = "dp-backdrop";
  backdrop.hidden = true;
  backdrop.innerHTML = `
    <div class="dp-panel" role="dialog" aria-label="desktop-proxy settings">
      <div class="dp-header">
        <span class="dp-dot"></span>
        <span class="dp-title">desktop-proxy</span>
        <span class="dp-spacer"></span>
        <button class="dp-close" aria-label="Close">✕</button>
      </div>
      <div class="dp-body">
        <nav class="dp-sidebar"></nav>
        <main class="dp-content"></main>
      </div>
    </div>
  `;

  shadow.appendChild(launcher);
  shadow.appendChild(backdrop);

  const panel = backdrop.querySelector(".dp-panel") as HTMLElement;
  const sidebar = backdrop.querySelector(".dp-sidebar") as HTMLElement;
  const content = backdrop.querySelector(".dp-content") as HTMLElement;
  const closeBtn = backdrop.querySelector(".dp-close") as HTMLElement;

  function appendHost(): void {
    const parent = document.body || document.documentElement;
    if (parent && host.parentNode !== parent) parent.appendChild(host);
  }
  appendHost();

  // ── Rendering ────────────────────────────────────────────────────────────────
  const SECTIONS_KEY = "__sections__";

  function navEntries(): Array<{ key: string; title: string; iconSvg?: string }> {
    const entries: Array<{ key: string; title: string; iconSvg?: string }> = [];
    if (sections.length > 0) entries.push({ key: SECTIONS_KEY, title: "General" });
    for (const p of pages) entries.push({ key: p.key, title: p.page.title, iconSvg: p.page.iconSvg });
    return entries;
  }

  function runCleanup(): void {
    if (cleanupActive) {
      try {
        cleanupActive();
      } catch {
        // ignore plugin cleanup errors
      }
      cleanupActive = null;
    }
  }

  function renderContent(): void {
    runCleanup();
    content.innerHTML = "";

    const entries = navEntries();
    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "dp-empty";
      empty.textContent = "No plugin settings registered yet.";
      content.appendChild(empty);
      return;
    }

    if (!activeKey || !entries.some((e) => e.key === activeKey)) {
      activeKey = entries[0].key;
    }

    if (activeKey === SECTIONS_KEY) {
      for (const { section } of sections) {
        const card = document.createElement("div");
        card.className = "dp-section-card";
        const h4 = document.createElement("h4");
        h4.textContent = section.title;
        const body = document.createElement("div");
        body.className = "dp-section-body";
        card.appendChild(h4);
        card.appendChild(body);
        content.appendChild(card);
        safeRender(section.render, body);
      }
      return;
    }

    const page = pages.find((p) => p.key === activeKey);
    if (page) {
      const root = document.createElement("div");
      content.appendChild(root);
      const cleanup = safeRender(page.page.render, root);
      cleanupActive = cleanup;
    }
  }

  function safeRender(render: RenderFn, root: HTMLElement): (() => void) | null {
    try {
      const result = render(root);
      return typeof result === "function" ? result : null;
    } catch (e) {
      const err = document.createElement("div");
      err.className = "dp-empty";
      err.textContent = `Failed to render: ${String(e)}`;
      root.appendChild(err);
      return null;
    }
  }

  function renderSidebar(): void {
    sidebar.innerHTML = "";
    for (const entry of navEntries()) {
      const item = document.createElement("button");
      item.className = "dp-navitem" + (entry.key === activeKey ? " active" : "");
      if (entry.iconSvg) {
        const ico = document.createElement("span");
        ico.className = "dp-ico";
        ico.innerHTML = entry.iconSvg;
        item.appendChild(ico);
      }
      const label = document.createElement("span");
      label.textContent = entry.title;
      item.appendChild(label);
      item.addEventListener("click", () => {
        activeKey = entry.key;
        renderSidebar();
        renderContent();
      });
      sidebar.appendChild(item);
    }
  }

  function refresh(): void {
    renderSidebar();
    renderContent();
  }

  // ── Open / close ─────────────────────────────────────────────────────────────
  function open(): void {
    appendHost();
    backdrop.hidden = false;
    refresh();
  }
  function close(): void {
    backdrop.hidden = true;
    runCleanup();
  }
  function toggle(): void {
    if (backdrop.hidden) open();
    else close();
  }

  launcher.addEventListener("click", toggle);
  closeBtn.addEventListener("click", close);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  panel.addEventListener("click", (e) => e.stopPropagation());

  window.addEventListener(
    "keydown",
    (e) => {
      // Cmd/Ctrl+Shift+\ toggles; Escape closes when open.
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "\\" || e.code === "Backslash")) {
        e.preventDefault();
        e.stopPropagation();
        toggle();
      } else if (e.key === "Escape" && !backdrop.hidden) {
        close();
      }
    },
    true,
  );

  // ── Registration API ─────────────────────────────────────────────────────────
  function registerSection(section: OverlaySection): { unregister(): void } {
    const key = `section:${section.id}`;
    const idx = sections.findIndex((s) => s.key === key);
    const entry: RegisteredSection = { key, section };
    if (idx >= 0) sections[idx] = entry;
    else sections.push(entry);
    if (!backdrop.hidden) refresh();
    return {
      unregister() {
        const i = sections.findIndex((s) => s.key === key);
        if (i >= 0) sections.splice(i, 1);
        if (!backdrop.hidden) refresh();
      },
    };
  }

  function registerPage(
    tweakId: string,
    manifest: PluginManifest,
    page: OverlayPage,
  ): { unregister(): void } {
    const key = `page:${tweakId}:${page.id}`;
    const idx = pages.findIndex((p) => p.key === key);
    const entry: RegisteredPage = { key, tweakId, manifest, page };
    if (idx >= 0) pages[idx] = entry;
    else pages.push(entry);
    if (!backdrop.hidden) refresh();
    return {
      unregister() {
        const i = pages.findIndex((p) => p.key === key);
        if (i >= 0) pages.splice(i, 1);
        if (activeKey === key) activeKey = null;
        if (!backdrop.hidden) refresh();
      },
    };
  }

  function clearAll(): void {
    runCleanup();
    sections.length = 0;
    pages.length = 0;
    // Keep activeKey: if the same page is re-registered (e.g. on hot reload),
    // the panel stays on it instead of jumping back to the first entry.
    // renderContent() falls back to the first entry only if it no longer exists.
    if (!backdrop.hidden) refresh();
  }

  const handle: SettingsOverlayHandle = {
    registerSection,
    registerPage,
    clearAll,
    open,
    close,
    toggle,
  };

  installedHandle = handle;
  if (!stealth) {
    (window as unknown as { __desktop_proxy_overlay__?: SettingsOverlayHandle }).__desktop_proxy_overlay__ =
      handle;
  }

  return handle;
}
