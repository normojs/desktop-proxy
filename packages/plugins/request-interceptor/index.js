/**
 * Request Interceptor Plugin
 *
 * Captures network requests and responses, with special handling for
 * AI service API tokens (OpenAI, Anthropic, Google, etc.).
 *
 * Logs intercepted data to the plugin's storage for later retrieval.
 *
 * NOTE: This file ships as plain JavaScript (loaded as CommonJS by the plugin
 * host) — keep it free of TypeScript syntax.
 */

// ── AI Service patterns ──────────────────────────────────────────────────────

const AI_SERVICES = [
  {
    name: "OpenAI",
    hostPattern: /api\.openai\.com/,
    tokenHeader: "authorization",
    tokenPrefix: "Bearer ",
    bodyPaths: ["messages", "model", "temperature", "max_tokens", "stream"],
  },
  {
    name: "Anthropic",
    hostPattern: /api\.anthropic\.com/,
    tokenHeader: "x-api-key",
    tokenPrefix: "",
    bodyPaths: ["messages", "model", "max_tokens", "temperature", "stream"],
  },
  {
    name: "Google AI",
    hostPattern: /generativelanguage\.googleapis\.com/,
    tokenHeader: "x-goog-api-key",
    tokenPrefix: "",
    bodyPaths: ["contents", "generationConfig"],
  },
  {
    name: "Codex",
    hostPattern: /api\.openai\.com\/v1\/codex/,
    tokenHeader: "authorization",
    tokenPrefix: "Bearer ",
    bodyPaths: ["prompt", "messages", "model"],
  },
  {
    name: "DeepSeek",
    hostPattern: /api\.deepseek\.com/,
    tokenHeader: "authorization",
    tokenPrefix: "Bearer ",
    bodyPaths: ["messages", "model", "stream"],
  },
];

// ── Redact token for safe logging ────────────────────────────────────────────

function redactToken(token) {
  if (token.length <= 8) return "***";
  return token.slice(0, 4) + "..." + token.slice(-4);
}

function detectService(url) {
  const lowerUrl = url.toLowerCase();
  for (const service of AI_SERVICES) {
    if (service.hostPattern.test(lowerUrl)) return service;
  }
  return null;
}

function parseJSONSafe(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ── Storage ──────────────────────────────────────────────────────────────────

const STORAGE_KEY = "desktop-proxy:intercepted";
const MAX_ENTRIES = 1000;

function getStore() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{"requests":[],"responses":[]}');
  } catch {
    return { requests: [], responses: [] };
  }
}

function saveStore(store) {
  if (store.requests.length > MAX_ENTRIES) {
    store.requests = store.requests.slice(-MAX_ENTRIES);
  }
  if (store.responses.length > MAX_ENTRIES) {
    store.responses = store.responses.slice(-MAX_ENTRIES);
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

function addRequest(req) {
  const store = getStore();
  store.requests.push(req);
  saveStore(store);
}

function addResponse(resp) {
  const store = getStore();
  store.responses.push(resp);
  saveStore(store);
}

// ── Plugin Entry ─────────────────────────────────────────────────────────────

module.exports = {
  start(api) {
    api.log.info("Request Interceptor plugin started");

    // Track pending requests for matching responses
    const pending = new Map();

    // Intercept outgoing requests
    api.network.onRequest((req) => {
      const service = detectService(req.url);
      if (!service) return;

      const tokenHeader = Object.keys(req.headers).find(
        (k) => k.toLowerCase() === service.tokenHeader
      );

      let token = null;
      if (tokenHeader) {
        const rawToken = req.headers[tokenHeader];
        token = rawToken.startsWith(service.tokenPrefix)
          ? rawToken.slice(service.tokenPrefix.length)
          : rawToken;
      }

      const body = parseJSONSafe(req.body);

      const entry = {
        id: req.id,
        service: service.name,
        method: req.method,
        url: req.url,
        token,
        body,
        timestamp: req.timestamp,
      };

      pending.set(req.id, entry);
      addRequest(entry);

      if (token) {
        api.log.info(`[${service.name}] Request captured, token: ${redactToken(token)}`);
      } else {
        api.log.info(`[${service.name}] Request captured: ${req.method} ${req.url}`);
      }
    });

    // Intercept responses
    api.network.onResponse((resp) => {
      const requestEntry = pending.get(resp.requestId);
      if (!requestEntry) return;

      pending.delete(resp.requestId);

      const body = parseJSONSafe(resp.body);

      const entry = {
        id: resp.id,
        requestId: resp.requestId,
        service: requestEntry.service,
        status: resp.status,
        body,
        timestamp: Date.now(),
      };

      addResponse(entry);

      api.log.info(
        `[${requestEntry.service}] Response: ${resp.status} (${resp.requestId})`
      );
    });

    // Register a settings page to view intercepted data
    api.settings.registerPage({
      id: "intercepted",
      title: "Intercepted Requests",
      description: "View captured API requests and responses from AI services.",
      render(root) {
        renderInterceptedPage(root);
      },
    });
  },

  stop() {
    // Cleanup handled by framework
  },
};

// ── Rendering helpers ────────────────────────────────────────────────────────

function renderInterceptedPage(root) {
  const store = getStore();

  root.innerHTML = `
    <div style="font-family: system-ui, -apple-system, sans-serif; padding: 16px;">
      <h3 style="margin: 0 0 8px; font-size: 16px; font-weight: 600;">Intercepted Requests</h3>
      <p style="margin: 0 0 16px; color: #666; font-size: 13px;">
        ${store.requests.length} requests, ${store.responses.length} responses captured.
      </p>

      <div style="display: flex; gap: 8px; margin-bottom: 16px;">
        <button id="dp-refresh-intercepted" style="
          padding: 6px 12px;
          border: 1px solid #d0d5dd;
          border-radius: 6px;
          background: #fff;
          cursor: pointer;
          font-size: 13px;
        ">Refresh</button>
        <button id="dp-clear-intercepted" style="
          padding: 6px 12px;
          border: 1px solid #fecdca;
          border-radius: 6px;
          background: #fff;
          color: #b42318;
          cursor: pointer;
          font-size: 13px;
        ">Clear All</button>
      </div>

      <div id="dp-intercepted-list" style="display: flex; flex-direction: column; gap: 8px;">
        ${renderEntries(store)}
      </div>
    </div>
  `;

  root.querySelector("#dp-refresh-intercepted")?.addEventListener("click", () => {
    renderInterceptedPage(root);
  });
  root.querySelector("#dp-clear-intercepted")?.addEventListener("click", () => {
    localStorage.setItem(STORAGE_KEY, '{"requests":[],"responses":[]}');
    renderInterceptedPage(root);
  });
}

function renderEntries(store) {
  const entries = [...store.requests].reverse().slice(0, 50);
  if (entries.length === 0) {
    return `<div style="color: #999; font-size: 13px; text-align: center; padding: 24px;">No intercepted requests yet. Interact with the AI service to capture.</div>`;
  }

  return entries
    .map((req) => {
      const resp = store.responses.find((r) => r.requestId === req.id);
      return renderEntry(req, resp);
    })
    .join("");
}

function renderEntry(req, resp) {
  const statusColor = resp ? (resp.status < 400 ? "#039855" : "#b42318") : "#999";
  const statusText = resp ? `${resp.status}` : "pending";

  return `
    <div style="
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      padding: 12px;
      background: #fff;
      font-size: 13px;
    ">
      <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 6px;">
        <span style="
          background: #eff8ff;
          color: #175cd3;
          padding: 1px 6px;
          border-radius: 4px;
          font-size: 11px;
          font-weight: 600;
        ">${escapeHtml(req.service)}</span>
        <span style="color: #666;">${escapeHtml(req.method)}</span>
        <span style="
          color: ${statusColor};
          font-weight: 600;
          margin-left: auto;
        ">${statusText}</span>
      </div>
      <div style="color: #999; font-size: 11px; margin-bottom: 4px; word-break: break-all;">
        ${escapeHtml(req.url)}
      </div>
      ${req.token ? `
        <div style="color: #666; font-size: 11px;">
          Token: <code style="background: #f2f4f7; padding: 1px 4px; border-radius: 3px;">${escapeHtml(redactToken(req.token))}</code>
        </div>
      ` : ""}
    </div>
  `;
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
