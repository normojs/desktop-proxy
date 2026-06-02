/**
 * Renderer UI helpers (api.ui): inject stylesheets and show toasts.
 *
 * Toasts render inside a closed Shadow DOM so they are isolated from (and do not
 * clash with) the host app's markup and CSS.
 */

import type { PluginUI, ToastOptions, UnsubscribeFn } from "@desktop-proxy/plugin-sdk";

let toastShadow: ShadowRoot | null = null;

function ensureToastContainer(): HTMLElement {
  if (toastShadow) return toastShadow.querySelector(".dp-toasts") as HTMLElement;

  const host = document.createElement("div");
  const shadow = host.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    .dp-toasts {
      position: fixed; top: 16px; right: 16px; z-index: 2147483647;
      display: flex; flex-direction: column; gap: 8px; pointer-events: none;
    }
    .dp-toast {
      font: 13px system-ui, -apple-system, sans-serif; color: #fff; background: #111827;
      padding: 10px 14px; border-radius: 8px; box-shadow: 0 4px 14px rgba(0,0,0,.25);
      max-width: 320px; word-break: break-word;
      opacity: 0; transform: translateY(-6px); transition: opacity .15s, transform .15s;
    }
    .dp-toast.show { opacity: .96; transform: none; }
    .dp-toast.success { background: #067647; }
    .dp-toast.error { background: #b42318; }
  `;

  const container = document.createElement("div");
  container.className = "dp-toasts";
  shadow.appendChild(style);
  shadow.appendChild(container);
  (document.body || document.documentElement).appendChild(host);

  toastShadow = shadow;
  return container;
}

export function createUiApi(): PluginUI {
  return {
    injectCSS(css: string): UnsubscribeFn {
      const style = document.createElement("style");
      style.textContent = css;
      (document.head || document.documentElement).appendChild(style);
      return () => style.remove();
    },

    toast(message: string, options?: ToastOptions): void {
      try {
        const container = ensureToastContainer();
        const el = document.createElement("div");
        el.className = `dp-toast ${options?.type ?? "info"}`;
        el.textContent = message;
        container.appendChild(el);
        requestAnimationFrame(() => el.classList.add("show"));
        const duration = options?.durationMs ?? 3000;
        setTimeout(() => {
          el.classList.remove("show");
          setTimeout(() => el.remove(), 220);
        }, duration);
      } catch {
        // best effort — never throw from a UI helper
      }
    },
  };
}
