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

import type { NetworkRequest, NetworkResponse, WebSocketEvent } from "@desktop-proxy/plugin-sdk";

import type { MainCDP } from "../cdp";
import { toHeaderEntries, fromHeaderEntries, type NetDecision, type NetResponseDecision } from "./intercept";

type Logger = (level: string, ...args: unknown[]) => void;

export interface CdpNetworkDeps {
  observeRequest: (req: NetworkRequest) => void;
  observeResponse: (res: NetworkResponse) => void;
  maxBodyBytes: () => number;
  log: Logger;
  /** When true, also enable the Fetch domain to allow modify/block/mock. */
  interceptEnabled: () => boolean;
  /** Resolve a paused request's decision (first intercept handler to act wins). */
  dispatchIntercept: (req: NetworkRequest, wc: WebContents) => Promise<NetDecision>;
  /** True if any response-rewrite handler is registered (main or this renderer). */
  hasResponseInterceptors: (wc: WebContents) => boolean;
  /** True if a response-rewrite handler targets this url (worth buffering). */
  responseInterceptMatches: (url: string, wc: WebContents) => boolean;
  /** Resolve a real response's rewrite decision. */
  dispatchInterceptResponse: (res: NetworkResponse, url: string, wc: WebContents) => Promise<NetResponseDecision>;
  /** Feed an observed WebSocket lifecycle/frame event. */
  observeWebSocket: (evt: WebSocketEvent) => void;
  /** True if any plugin is observing WebSockets (skip building events otherwise). */
  hasWebSocketHandlers: () => boolean;
}

const FETCH_DECISION_TIMEOUT_MS = 3000;

const VALID_ERROR_REASONS = new Set([
  "Failed", "Aborted", "TimedOut", "AccessDenied", "ConnectionClosed",
  "ConnectionReset", "ConnectionRefused", "ConnectionAborted", "ConnectionFailed",
  "NameNotResolved", "InternetDisconnected", "AddressUnreachable",
  "BlockedByClient", "BlockedByResponse",
]);

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

  function emitWsFrame(type: "sent" | "received", p: Record<string, unknown>): void {
    const r = p.response as { opcode?: number; payloadData?: string } | undefined;
    const opcode = r?.opcode;
    deps.observeWebSocket({
      id: String(p.requestId),
      type,
      data: typeof r?.payloadData === "string" ? r.payloadData : undefined,
      opcode,
      binary: typeof opcode === "number" ? opcode !== 1 : undefined,
      source: "renderer-cdp",
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
        } else if (method === "Fetch.requestPaused") {
          void handleFetchPaused(wc, p);
        } else if (deps.hasWebSocketHandlers() && method.startsWith("Network.webSocket")) {
          if (method === "Network.webSocketCreated") {
            deps.observeWebSocket({
              id: String(p.requestId),
              type: "open",
              url: String(p.url ?? ""),
              source: "renderer-cdp",
              timestamp: Date.now(),
            });
          } else if (method === "Network.webSocketFrameSent") {
            emitWsFrame("sent", p);
          } else if (method === "Network.webSocketFrameReceived") {
            emitWsFrame("received", p);
          } else if (method === "Network.webSocketClosed") {
            deps.observeWebSocket({ id: String(p.requestId), type: "close", source: "renderer-cdp", timestamp: Date.now() });
          } else if (method === "Network.webSocketFrameError") {
            deps.observeWebSocket({
              id: String(p.requestId),
              type: "error",
              error: String(p.errorMessage ?? ""),
              source: "renderer-cdp",
              timestamp: Date.now(),
            });
          }
        }
      } catch (e) {
        deps.log("warn", "cdp-network: event handling error:", String(e));
      }
    });

    void hub.send(wc, "Network.enable").catch((e) =>
      deps.log("warn", `cdp-network: Network.enable failed for wc ${wc.id}:`, String(e)),
    );
    if (deps.interceptEnabled()) {
      // Both stages: Request for modify/block/mock; Response so matched URLs can
      // be rewritten. Unmatched responses are continued immediately (no buffer).
      void hub
        .send(wc, "Fetch.enable", {
          patterns: [
            { urlPattern: "*", requestStage: "Request" },
            { urlPattern: "*", requestStage: "Response" },
          ],
        })
        .catch((e) => deps.log("warn", `cdp-network: Fetch.enable failed for wc ${wc.id}:`, String(e)));
    }
    wc.once("destroyed", () => observed.delete(wc.id));
    deps.log("info", `cdp-network: observing webContents ${wc.id}`);
  }

  async function handleFetchPaused(wc: WebContents, p: Record<string, unknown>): Promise<void> {
    const requestId = String(p.requestId);
    const request = p.request as { url: string; method: string; headers?: Record<string, unknown>; postData?: string };

    // Response stage: only buffer+rewrite when a handler targets this URL;
    // otherwise continue immediately so the body keeps streaming.
    if (p.responseStatusCode !== undefined || p.responseErrorReason !== undefined) {
      await handleResponseStage(wc, requestId, request.url, p);
      return;
    }

    const req: NetworkRequest = {
      id: requestId,
      source: "renderer-cdp",
      _type: mapResourceType(String(p.resourceType ?? "")),
      method: request.method,
      url: request.url,
      headers: toRecord(request.headers),
      body: typeof request.postData === "string" ? request.postData : null,
      timestamp: Date.now(),
    };

    let decision: NetDecision = { action: "continue" };
    try {
      decision = await withTimeout(deps.dispatchIntercept(req, wc), FETCH_DECISION_TIMEOUT_MS, { action: "continue" });
    } catch (e) {
      deps.log("error", "cdp-network: intercept dispatch failed:", String(e));
    }

    try {
      if (decision.action === "fulfill") {
        await hub.send(wc, "Fetch.fulfillRequest", {
          requestId,
          responseCode: decision.response.status,
          responseHeaders: toHeaderEntries(decision.response.headers ?? {}),
          body: encodeBody(decision.response.body, decision.response.bodyEncoding),
        });
      } else if (decision.action === "fail") {
        await hub.send(wc, "Fetch.failRequest", { requestId, errorReason: mapErrorReason(decision.reason) });
      } else {
        const params: Record<string, unknown> = { requestId };
        const mods = decision.mods;
        if (mods?.url) params.url = mods.url;
        if (mods?.method) params.method = mods.method;
        if (mods?.headers) params.headers = toHeaderEntries(mods.headers);
        if (mods?.body != null) params.postData = encodeBody(mods.body, mods.bodyEncoding);
        await hub.send(wc, "Fetch.continueRequest", params);
      }
    } catch (e) {
      deps.log("warn", "cdp-network: applying Fetch decision failed:", String(e));
      await hub.send(wc, "Fetch.continueRequest", { requestId }).catch(() => undefined);
    }
  }

  async function handleResponseStage(
    wc: WebContents,
    requestId: string,
    url: string,
    p: Record<string, unknown>,
  ): Promise<void> {
    // Fast path: nobody wants to rewrite this URL — keep streaming.
    if (!deps.hasResponseInterceptors(wc) || !deps.responseInterceptMatches(url, wc)) {
      await hub.send(wc, "Fetch.continueResponse", { requestId }).catch(() => undefined);
      return;
    }

    const status = Number(p.responseStatusCode ?? 0);
    const headers = fromHeaderEntries(p.responseHeaders as Array<{ name: string; value: string }> | undefined);

    // Buffer the real body (the cost of rewriting — only for matched URLs).
    let originalBase64 = "";
    let handlerBody: string | null = null;
    let handlerEncoding: "utf8" | "base64" = "utf8";
    let truncated = false;
    try {
      const res = (await hub.send(wc, "Fetch.getResponseBody", { requestId })) as {
        body: string;
        base64Encoded: boolean;
      };
      originalBase64 = res.base64Encoded ? res.body : Buffer.from(res.body, "utf8").toString("base64");
      let raw = Buffer.from(res.body, res.base64Encoded ? "base64" : "utf8");
      const cap = deps.maxBodyBytes();
      if (cap > 0 && raw.length > cap) {
        raw = raw.subarray(0, cap);
        truncated = true;
      }
      handlerBody = res.base64Encoded ? raw.toString("base64") : raw.toString("utf8");
      handlerEncoding = res.base64Encoded ? "base64" : "utf8";
    } catch {
      // body unavailable; handler still sees headers/status
    }

    const networkResponse: NetworkResponse = {
      id: `resp-${requestId}`,
      requestId,
      source: "renderer-cdp",
      status,
      statusText: "",
      headers,
      body: handlerBody,
      bodyEncoding: handlerEncoding,
      truncated,
      timestamp: Date.now(),
    };

    let decision: NetResponseDecision = { action: "continue" };
    try {
      decision = await withTimeout(
        deps.dispatchInterceptResponse(networkResponse, url, wc),
        FETCH_DECISION_TIMEOUT_MS,
        { action: "continue" },
      );
    } catch (e) {
      deps.log("error", "cdp-network: response intercept dispatch failed:", String(e));
    }

    try {
      if (decision.action === "fulfill") {
        const r = decision.response;
        const body = r.body != null ? encodeBody(r.body, r.bodyEncoding) : originalBase64;
        await hub.send(wc, "Fetch.fulfillRequest", {
          requestId,
          responseCode: r.status ?? status,
          responseHeaders: toHeaderEntries(r.headers ?? headers),
          body,
        });
      } else {
        await hub.send(wc, "Fetch.continueResponse", { requestId });
      }
    } catch (e) {
      deps.log("warn", "cdp-network: applying response decision failed:", String(e));
      await hub.send(wc, "Fetch.continueResponse", { requestId }).catch(() => undefined);
    }
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

function encodeBody(body: string | undefined, encoding: "utf8" | "base64" | undefined): string | undefined {
  if (body == null) return undefined;
  return Buffer.from(body, encoding === "base64" ? "base64" : "utf8").toString("base64");
}

function mapErrorReason(reason: string | undefined): string {
  return reason && VALID_ERROR_REASONS.has(reason) ? reason : "BlockedByClient";
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(fallback);
      }
    }, ms);
    void promise
      .then((value) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }
      })
      .catch(() => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(fallback);
        }
      });
  });
}
