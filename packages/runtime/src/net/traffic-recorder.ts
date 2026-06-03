/**
 * Traffic recorder — a capped, in-memory ring of recent network activity for the
 * built-in "Network" viewer page and HAR export.
 *
 * It subscribes to the main network hub's observe hooks (onRequest / onResponse /
 * onWebSocket), so it captures every source the framework sees: Electron
 * webRequest, Node http/https, and renderer CDP. It is OFF by default and only
 * subscribes while enabled (config `captureTraffic`), so it adds no overhead
 * otherwise.
 *
 * Output is HAR 1.2 (https://w3c.github.io/web-performance/specs/HAR/Overview.html),
 * with WebSocket frames attached as Chrome's `_webSocketMessages` extension.
 */

import type {
  NetworkRequest,
  NetworkResponse,
  WebSocketEvent,
  UnsubscribeFn,
} from "@desktop-proxy/plugin-sdk";

import { analyzeEntry, type Analysis } from "./traffic-analyze.js";
import { parseQuery, matchEntry, type FilterEntry } from "./traffic-filter.js";
import { extractUsage, type Usage } from "./traffic-cost.js";

interface RecorderNet {
  onRequest(handler: (req: NetworkRequest) => void): UnsubscribeFn;
  onResponse(handler: (res: NetworkResponse) => void): UnsubscribeFn;
  onWebSocket(handler: (evt: WebSocketEvent) => void): UnsubscribeFn;
}

interface WsMessage {
  type: "send" | "receive";
  time: number; // epoch seconds (Chrome HAR convention)
  opcode?: number;
  data: string;
}

interface Entry {
  id: string;
  startedDateTime: string;
  startMs: number;
  method: string;
  url: string;
  reqHeaders: Record<string, string>;
  postData: string | null;
  resourceType: string;
  source?: string;
  status?: number;
  statusText?: string;
  resHeaders?: Record<string, string>;
  body?: string | null;
  bodyEncoding?: "utf8" | "base64";
  truncated?: boolean;
  endMs?: number;
  wsMessages?: WsMessage[];
  closed?: boolean;
  error?: string;
  /** Cached analysis (computed lazily). */
  analysis?: Analysis;
  /** Cached AI usage (computed once the response is finalized). */
  usageCached?: Usage | null;
  /** Whether this entry has already been handed to the persistence sink. */
  persisted?: boolean;
}

export interface TrafficSummary {
  id: string;
  method: string;
  url: string;
  status: number | null;
  resourceType: string;
  source: string | null;
  startedDateTime: string;
  time: number | null;
  bodyBytes: number | null;
  wsFrames?: number;
  category: string;
  service: string;
  label: string;
  kind: string;
  tags: string[];
  usage?: Usage;
}

export interface TrafficDetail extends TrafficSummary {
  statusText: string | null;
  reqHeaders: Record<string, string>;
  resHeaders: Record<string, string>;
  reqBody: string | null;
  resBody: string | null;
  bodyEncoding: "utf8" | "base64";
  truncated: boolean;
  model?: string;
  wsMessages?: WsMessage[];
  error?: string;
}

export interface HarLog {
  log: {
    version: "1.2";
    creator: { name: string; version: string };
    entries: unknown[];
  };
}

export interface TrafficRecorder {
  setEnabled(on: boolean): void;
  isEnabled(): boolean;
  /** List recent traffic, newest first, optionally filtered by a DSL query. */
  list(query?: string): TrafficSummary[];
  /** Full detail (headers + bodies + analysis) for one entry. */
  detail(id: string): TrafficDetail | null;
  count(): number;
  clear(): void;
  /** Export HAR 1.2, optionally limited to entries matching a DSL query. */
  toHar(query?: string): HarLog;
  /** Receive each finalized entry (for optional disk persistence). null clears. */
  setSink(sink: ((entry: TrafficDetail) => void) | null): void;
}

const DEFAULT_CAP = 500;

export function createTrafficRecorder(
  net: RecorderNet,
  getVersion: () => string,
  cap: number = DEFAULT_CAP,
): TrafficRecorder {
  const entries = new Map<string, Entry>();
  const order: string[] = [];
  let unsubs: UnsubscribeFn[] | null = null;
  let sink: ((entry: TrafficDetail) => void) | null = null;

  function touch(id: string): Entry {
    let entry = entries.get(id);
    if (!entry) {
      entry = {
        id,
        startedDateTime: new Date().toISOString(),
        startMs: Date.now(),
        method: "",
        url: "",
        reqHeaders: {},
        postData: null,
        resourceType: "other",
      };
      entries.set(id, entry);
      order.push(id);
      while (order.length > cap) {
        const evicted = order.shift();
        if (evicted) entries.delete(evicted);
      }
    }
    return entry;
  }

  function onRequest(req: NetworkRequest): void {
    const entry = touch(req.id);
    entry.method = req.method;
    entry.url = req.url;
    entry.reqHeaders = req.headers ?? {};
    entry.postData = req.body ?? null;
    entry.resourceType = req._type ?? "other";
    entry.source = req.source;
  }

  function onResponse(res: NetworkResponse): void {
    const entry = touch(res.requestId);
    entry.status = res.status;
    entry.statusText = res.statusText;
    entry.resHeaders = res.headers ?? {};
    entry.body = res.body ?? null;
    entry.bodyEncoding = res.bodyEncoding;
    entry.truncated = res.truncated;
    entry.endMs = Date.now();
    if (res.source) entry.source = res.source;
    finalize(entry);
  }

  function onWebSocket(evt: WebSocketEvent): void {
    const entry = touch(evt.id);
    entry.source = evt.source ?? entry.source;
    entry.resourceType = "websocket";
    entry.wsMessages ??= [];
    if (evt.type === "open") {
      entry.method = "GET";
      if (evt.url) entry.url = evt.url;
    } else if (evt.type === "sent" || evt.type === "received") {
      entry.wsMessages.push({
        type: evt.type === "sent" ? "send" : "receive",
        time: evt.timestamp / 1000,
        opcode: evt.opcode,
        data: evt.data ?? "",
      });
    } else if (evt.type === "close") {
      entry.closed = true;
      entry.endMs = Date.now();
      finalize(entry);
    } else if (evt.type === "error") {
      entry.error = evt.error;
      entry.endMs = Date.now();
      finalize(entry);
    }
  }

  function finalize(entry: Entry): void {
    if (!sink || entry.persisted) return;
    entry.persisted = true;
    try {
      sink(buildDetail(entry));
    } catch {
      /* never let persistence break capture */
    }
  }

  function subscribe(): void {
    if (unsubs) return;
    unsubs = [net.onRequest(onRequest), net.onResponse(onResponse), net.onWebSocket(onWebSocket)];
  }

  function unsubscribe(): void {
    unsubs?.forEach((u) => {
      try {
        u();
      } catch {
        /* ignore */
      }
    });
    unsubs = null;
  }

  function bodyBytes(entry: Entry): number | null {
    if (entry.body == null) return null;
    return Buffer.byteLength(entry.body, entry.bodyEncoding === "base64" ? "base64" : "utf8");
  }

  function analysisOf(entry: Entry): Analysis {
    if (!entry.analysis) {
      entry.analysis = analyzeEntry({
        method: entry.method,
        url: entry.url,
        reqHeaders: entry.reqHeaders,
        resHeaders: entry.resHeaders,
        postData: entry.postData,
        status: entry.status ?? null,
        resourceType: entry.resourceType,
        source: entry.source,
      });
    }
    return entry.analysis;
  }

  function usageOf(entry: Entry): Usage | null {
    const a = analysisOf(entry);
    if (a.category !== "ai") return null;
    if (entry.usageCached !== undefined) return entry.usageCached;
    const u = extractUsage(a.model, entry.body);
    if (entry.status != null) entry.usageCached = u; // cache once the response is finalized
    return u;
  }

  function summaryOf(entry: Entry): TrafficSummary {
    const a = analysisOf(entry);
    const usage = usageOf(entry);
    return {
      id: entry.id,
      method: entry.method || (entry.resourceType === "websocket" ? "WS" : ""),
      url: entry.url,
      status: entry.status ?? null,
      resourceType: entry.resourceType,
      source: entry.source ?? null,
      startedDateTime: entry.startedDateTime,
      time: entry.endMs != null ? entry.endMs - entry.startMs : null,
      bodyBytes: bodyBytes(entry),
      wsFrames: entry.wsMessages?.length,
      category: a.category,
      service: a.service,
      label: a.label,
      kind: a.kind,
      tags: a.tags,
      ...(usage ? { usage } : {}),
    };
  }

  function buildDetail(entry: Entry): TrafficDetail {
    const a = analysisOf(entry);
    return {
      ...summaryOf(entry),
      statusText: entry.statusText ?? null,
      reqHeaders: entry.reqHeaders,
      resHeaders: entry.resHeaders ?? {},
      reqBody: entry.postData ?? null,
      resBody: entry.body ?? null,
      bodyEncoding: entry.bodyEncoding ?? "utf8",
      truncated: entry.truncated ?? false,
      model: a.model,
      wsMessages: entry.wsMessages,
      error: entry.error,
    };
  }

  function hostPath(url: string): { host: string; path: string } {
    try {
      const u = new URL(url);
      return { host: u.host, path: u.pathname + u.search };
    } catch {
      return { host: "", path: url };
    }
  }

  function toFilterEntry(entry: Entry): FilterEntry {
    const a = analysisOf(entry);
    const { host, path } = hostPath(entry.url);
    const contentType = entry.resHeaders?.["content-type"] ?? entry.resHeaders?.["Content-Type"] ?? "";
    return {
      method: entry.method,
      url: entry.url,
      host,
      path,
      status: entry.status ?? null,
      kind: a.kind,
      category: a.category,
      service: a.service,
      source: entry.source ?? "",
      contentType,
      reqHeaders: entry.reqHeaders,
      resHeaders: entry.resHeaders ?? {},
      reqBody: entry.postData ?? null,
      resBody: entry.body ?? null,
      reqSize: entry.postData ? Buffer.byteLength(entry.postData) : 0,
      resSize: bodyBytes(entry) ?? 0,
      timeMs: entry.endMs != null ? entry.endMs - entry.startMs : null,
      model: a.model,
      tags: a.tags,
      startMs: entry.startMs,
      label: a.label,
    };
  }

  return {
    setEnabled(on: boolean): void {
      if (on) subscribe();
      else unsubscribe();
    },
    isEnabled: () => unsubs !== null,
    count: () => order.length,
    clear(): void {
      entries.clear();
      order.length = 0;
    },
    list(query?: string): TrafficSummary[] {
      const preds = query && query.trim() ? parseQuery(query) : [];
      const out: TrafficSummary[] = [];
      for (let i = order.length - 1; i >= 0; i--) {
        const entry = entries.get(order[i]);
        if (!entry) continue;
        if (preds.length && !matchEntry(toFilterEntry(entry), preds)) continue;
        out.push(summaryOf(entry));
      }
      return out;
    },
    detail(id: string): TrafficDetail | null {
      const entry = entries.get(id);
      return entry ? buildDetail(entry) : null;
    },
    setSink(fn: ((entry: TrafficDetail) => void) | null): void {
      sink = fn;
    },
    toHar(query?: string): HarLog {
      const preds = query && query.trim() ? parseQuery(query) : [];
      const harEntries = order
        .map((id) => entries.get(id))
        .filter((e): e is Entry => e != null)
        .filter((e) => preds.length === 0 || matchEntry(toFilterEntry(e), preds))
        .map((entry) => {
          const time = entry.endMs != null ? entry.endMs - entry.startMs : 0;
          const mimeType = entry.resHeaders?.["content-type"] ?? entry.resHeaders?.["Content-Type"] ?? "";
          const har: Record<string, unknown> = {
            startedDateTime: entry.startedDateTime,
            time,
            request: {
              method: entry.method || "GET",
              url: entry.url,
              httpVersion: "HTTP/1.1",
              headers: toHarHeaders(entry.reqHeaders),
              queryString: [],
              cookies: [],
              headersSize: -1,
              bodySize: entry.postData ? Buffer.byteLength(entry.postData) : 0,
              ...(entry.postData
                ? { postData: { mimeType: entry.reqHeaders["content-type"] ?? "", text: entry.postData } }
                : {}),
            },
            response: {
              status: entry.status ?? 0,
              statusText: entry.statusText ?? "",
              httpVersion: "HTTP/1.1",
              headers: toHarHeaders(entry.resHeaders ?? {}),
              cookies: [],
              content: {
                size: bodyBytes(entry) ?? 0,
                mimeType,
                ...(entry.body != null ? { text: entry.body } : {}),
                ...(entry.bodyEncoding === "base64" ? { encoding: "base64" } : {}),
              },
              redirectURL: "",
              headersSize: -1,
              bodySize: bodyBytes(entry) ?? -1,
            },
            cache: {},
            timings: { send: 0, wait: time, receive: 0 },
            _source: entry.source,
            _resourceType: entry.resourceType,
            ...(entry.truncated ? { _truncated: true } : {}),
            ...(entry.error ? { _error: entry.error } : {}),
            ...(entry.wsMessages ? { _webSocketMessages: entry.wsMessages } : {}),
          };
          return har;
        });

      return {
        log: {
          version: "1.2",
          creator: { name: "desktop-proxy", version: getVersion() },
          entries: harEntries,
        },
      };
    },
  };
}

function toHarHeaders(headers: Record<string, string>): Array<{ name: string; value: string }> {
  return Object.entries(headers).map(([name, value]) => ({ name, value: String(value) }));
}
