/**
 * Renderer network observer via CDP Network domain (passive, streaming-safe).
 *
 * Unlike the renderer fetch/XHR hooks (which run in the preload's isolated world
 * and may not reach the page's main world under contextIsolation), this observes
 * at the network layer for a webContents, so it captures *all* page requests
 * (document, subresources, fetch, XHR) regardless of isolation.
 *
 * It is **passive**: requests come from `Network.requestWillBeSent`, responses
 * from `Network.responseReceived` + `Network.loadingFinished` followed by
 * `Network.getResponseBody`. We never use the Fetch domain's response stage,
 * which would pause and buffer the body and break streaming/SSE. Modification /
 * block / mock arrive with the Fetch-based `intercept` control API (later phase).
 */

import type { WebContents } from "electron";

import type { NetworkRequest, NetworkResponse } from "@desktop-proxy/plugin-sdk";

import type { MainCDP } from "../cdp";

type Logger = (level: string, ...args: unknown[]) => void;

export interface CdpNetworkDeps {
  observeRequest: (req: NetworkRequest) => void;
  observeResponse: (res: NetworkResponse) => void;
  maxBodyBytes: () => number;
  log: Logger;
}

interface PendingResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  mimeType: string;
}

const TEXT_CONTENT_TYPE = /(json|text|xml|javascript|event-stream|x-www-form-urlencoded)/i;

export interface CdpNetworkObserver {
  observe(wc: WebContents): Promise<void>;
}

export function createCdpNetworkObserver(hub: MainCDP, deps: CdpNetworkDeps): CdpNetworkObserver {
  const observed = new Set<number>();

  async function finishResponse(wc: WebContents, requestId: string, meta: PendingResponse): Promise<void> {
    let body: string | null = null;
    let bodyEncoding: "utf8" | "base64" = "utf8";
    let truncated = false;

    const isText = meta.mimeType === "" || TEXT_CONTENT_TYPE.test(meta.mimeType);
    if (isText) {
      try {
        const res = (await hub.send(wc, "Network.getResponseBody", { requestId })) as {
          body: string;
          base64Encoded: boolean;
        };
        let raw = Buffer.from(res.body, res.base64Encoded ? "base64" : "utf8");
        const cap = deps.maxBodyBytes();
        if (cap > 0 && raw.length > cap) {
          raw = raw.subarray(0, cap);
          truncated = true;
        }
        body = res.base64Encoded ? raw.toString("base64") : raw.toString("utf8");
        bodyEncoding = res.base64Encoded ? "base64" : "utf8";
      } catch {
        // body not available (e.g. no-content, already evicted)
      }
    }

    deps.observeResponse({
      id: `resp-${requestId}`,
      requestId,
      source: "renderer-cdp",
      status: meta.status,
      statusText: meta.statusText,
      headers: meta.headers,
      body,
      bodyEncoding,
      truncated,
      timestamp: Date.now(),
    });
  }

  async function observe(wc: WebContents): Promise<void> {
    if (observed.has(wc.id)) return;
    observed.add(wc.id);

    try {
      await hub.attach(wc);
    } catch (e) {
      observed.delete(wc.id);
      deps.log("warn", `cdp-network: attach failed for wc ${wc.id}:`, String(e));
      return;
    }

    const pending = new Map<string, PendingResponse>();

    hub.onEvent(wc, (method, params) => {
      try {
        const p = params as Record<string, unknown>;
        if (method === "Network.requestWillBeSent") {
          const request = p.request as {
            url: string;
            method: string;
            headers?: Record<string, unknown>;
            postData?: string;
          };
          deps.observeRequest({
            id: String(p.requestId),
            source: "renderer-cdp",
            _type: mapResourceType(String(p.type ?? "")),
            method: request.method,
            url: request.url,
            headers: toRecord(request.headers),
            body: typeof request.postData === "string" ? request.postData : null,
            timestamp: Date.now(),
          });
        } else if (method === "Network.responseReceived") {
          const response = p.response as {
            status: number;
            statusText?: string;
            headers?: Record<string, unknown>;
            mimeType?: string;
          };
          pending.set(String(p.requestId), {
            status: response.status,
            statusText: response.statusText ?? "",
            headers: toRecord(response.headers),
            mimeType: response.mimeType ?? "",
          });
        } else if (method === "Network.loadingFinished") {
          const requestId = String(p.requestId);
          const meta = pending.get(requestId);
          if (meta) {
            pending.delete(requestId);
            void finishResponse(wc, requestId, meta);
          }
        } else if (method === "Network.loadingFailed") {
          pending.delete(String(p.requestId));
        }
      } catch (e) {
        deps.log("warn", "cdp-network: event handling error:", String(e));
      }
    });

    void hub.send(wc, "Network.enable").catch((e) =>
      deps.log("warn", `cdp-network: Network.enable failed for wc ${wc.id}:`, String(e)),
    );
    wc.once("destroyed", () => observed.delete(wc.id));
    deps.log("info", `cdp-network: observing webContents ${wc.id}`);
  }

  return { observe };
}

function toRecord(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers && typeof headers === "object") {
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
      if (value != null) out[key] = String(value);
    }
  }
  return out;
}

function mapResourceType(type: string): NetworkRequest["_type"] {
  if (type === "WebSocket") return "websocket";
  if (type === "XHR" || type === "Fetch") return "xhr";
  return "fetch";
}
