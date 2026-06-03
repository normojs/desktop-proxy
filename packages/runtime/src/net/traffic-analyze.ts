/**
 * Traffic analysis (pure) — classify a captured request for the inspector.
 *
 * Produces a category (ai/auth/telemetry/update/websocket/asset/doc/api/other),
 * the originating service, a human label, the kind (http/https/ws/sse), an
 * optional model (parsed from an AI request body), and tags. No I/O — fully
 * unit-testable.
 */

export type Category = "ai" | "auth" | "telemetry" | "update" | "websocket" | "asset" | "doc" | "api" | "other";
export type Kind = "http" | "https" | "ws" | "sse";

export interface AnalyzeInput {
  method: string;
  url: string;
  reqHeaders?: Record<string, string>;
  resHeaders?: Record<string, string>;
  postData?: string | null;
  status?: number | null;
  /** "websocket"/"document"/... from the capture source. */
  resourceType?: string;
  source?: string;
}

export interface Analysis {
  category: Category;
  service: string;
  label: string;
  kind: Kind;
  model?: string;
  tags: string[];
}

interface ServiceDef {
  name: string;
  host: RegExp;
}

// Known AI services (host → display name). Ordered; first match wins.
const AI_SERVICES: ServiceDef[] = [
  { name: "OpenAI", host: /(^|\.)openai\.com$|(^|\.)oaiusercontent\.com$/i },
  { name: "Azure OpenAI", host: /openai\.azure\.com$/i },
  { name: "Anthropic", host: /(^|\.)anthropic\.com$/i },
  { name: "Google AI", host: /generativelanguage\.googleapis\.com$|aiplatform\.googleapis\.com$/i },
  { name: "DeepSeek", host: /(^|\.)deepseek\.com$/i },
  { name: "xAI", host: /(^|\.)x\.ai$/i },
  { name: "Mistral", host: /(^|\.)mistral\.ai$/i },
  { name: "Groq", host: /(^|\.)groq\.com$/i },
  { name: "Cohere", host: /(^|\.)cohere\.(com|ai)$/i },
  { name: "OpenRouter", host: /(^|\.)openrouter\.ai$/i },
  { name: "GitHub Copilot", host: /githubcopilot\.com$|copilot-proxy\./i },
];

const AI_PATH = /\/(chat\/completions|completions|responses|messages|embeddings|generatecontent|generate_content|v1\/(chat|messages|responses|embeddings))/i;
const AUTH_HOST = /(^|\.)(auth|oauth|login|account|accounts|clerk|workos|okta|auth0)\./i;
const AUTH_PATH = /\/(oauth|token|login|signin|sign-in|auth|session|userinfo|\.well-known)/i;
const TELEMETRY_HOST = /(telemetry|analytics|sentry|segment|amplitude|posthog|datadog|bugsnag|mixpanel|statsig|rudderstack|heap|honeycomb)/i;
const TELEMETRY_PATH = /\/(events?|track|collect|telemetry|ingest|metrics|beacon|t\/)/i;
const UPDATE_HOST = /(update|releases?|dl\.|download)/i;
const UPDATE_PATH = /(latest(-mac)?\.yml|appcast|RELEASES|\.dmg|\.AppImage|\.nupkg|update)/i;
const ASSET_PATH = /\.(svg|png|jpe?g|gif|webp|ico|css|js|mjs|woff2?|ttf|otf|map|wasm)(\?|$)/i;
const ASSET_TYPE = /(image\/|font\/|text\/css|application\/javascript|text\/javascript|application\/wasm)/i;
const DOC_TYPE = /text\/html/i;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    const m = /^[a-z]+:\/\/([^/?#]+)/i.exec(url);
    return m ? m[1] : "";
  }
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url.replace(/^[a-z]+:\/\/[^/]*/i, "") || url;
  }
}

function parseJson(text: string | null | undefined): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function detectKind(url: string, resourceType: string | undefined, contentType: string): Kind {
  if (resourceType === "websocket" || /^wss?:/i.test(url)) return "ws";
  if (/text\/event-stream/i.test(contentType)) return "sse";
  return /^https:/i.test(url) ? "https" : "http";
}

function aiService(host: string): string | null {
  for (const s of AI_SERVICES) if (s.host.test(host)) return s.name;
  return null;
}

export function analyzeEntry(e: AnalyzeInput): Analysis {
  const host = hostOf(e.url);
  const path = pathOf(e.url);
  const contentType = (e.resHeaders?.["content-type"] ?? e.resHeaders?.["Content-Type"] ?? "").toString();
  const kind = detectKind(e.url, e.resourceType, contentType);
  const tags: string[] = [];

  const reqJson = parseJson(e.postData);
  const model = typeof reqJson?.model === "string" ? (reqJson.model as string) : undefined;
  const streaming = reqJson?.stream === true || kind === "sse";
  if (streaming) tags.push("stream");
  if (typeof e.status === "number" && e.status >= 400) tags.push("error");
  if (e.reqHeaders && (e.reqHeaders.authorization || e.reqHeaders.Authorization || e.reqHeaders["x-api-key"])) {
    tags.push("auth");
  }

  // Category — order matters (AI before generic API).
  const ai = aiService(host);
  let category: Category;
  let service: string;

  if (ai || AI_PATH.test(path)) {
    category = "ai";
    service = ai ?? host;
  } else if (kind === "ws") {
    category = "websocket";
    service = host;
  } else if (AUTH_HOST.test(host) || AUTH_PATH.test(path)) {
    category = "auth";
    service = host;
  } else if (TELEMETRY_HOST.test(host) || TELEMETRY_PATH.test(path)) {
    category = "telemetry";
    service = host;
  } else if (UPDATE_HOST.test(host) || UPDATE_PATH.test(path)) {
    category = "update";
    service = host;
  } else if (ASSET_TYPE.test(contentType) || ASSET_PATH.test(path)) {
    category = "asset";
    service = host;
  } else if (DOC_TYPE.test(contentType) || e.resourceType === "document") {
    category = "doc";
    service = host;
  } else if (/^api\./i.test(host) || /\/(v\d+|api)\//i.test(path)) {
    category = "api";
    service = host;
  } else {
    category = "other";
    service = host;
  }

  return { category, service, label: makeLabel(category, service, path, model, streaming), kind, model, tags };
}

function makeLabel(category: Category, service: string, path: string, model?: string, streaming?: boolean): string {
  if (category === "ai") {
    const action = /chat\/completions|\/messages|\/responses/i.test(path)
      ? "chat completion"
      : /embeddings/i.test(path)
        ? "embeddings"
        : "request";
    const extra = [model, streaming ? "stream" : null].filter(Boolean).join(", ");
    return `${service} ${action}${extra ? ` (${extra})` : ""}`;
  }
  if (category === "websocket") return `${service} websocket`;
  if (category === "auth") return `${service} auth`;
  if (category === "telemetry") return `${service} telemetry`;
  if (category === "update") return `${service} update`;
  if (category === "asset") return `${service} asset`;
  return service;
}
