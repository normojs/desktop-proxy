/**
 * Main-process network interception hub.
 *
 * Electron's `session.webRequest.onXxx` events allow only a SINGLE listener
 * each — registering again replaces the previous one, and there is no
 * per-listener removal. So we register one internal listener per event and
 * fan out to a set of plugin handlers, giving every main-process plugin a real,
 * independently-removable subscription.
 *
 * We hook `onBeforeSendHeaders` (not `onBeforeRequest`) for requests because it
 * exposes — and lets us modify — the request headers, which is the primary value
 * for main-process interception (e.g. capturing/altering auth tokens). Responses
 * are observed via `onCompleted`; Electron's webRequest does not expose response
 * bodies, so `body` is null in the main process (use a renderer-scope plugin to
 * capture bodies). Requests and responses share Electron's `details.id`, so a
 * response's `requestId` matches the corresponding request's `id`.
 *
 * Plugins may call onRequest/onResponse before `app` is ready (main-process
 * plugins start during runtime bootstrap). We therefore defer attaching the
 * webRequest listeners until the app is ready and the session is available.
 */

import type {
  BeforeSendResponse,
  OnBeforeSendHeadersListenerDetails,
  OnCompletedListenerDetails,
  Session,
} from "electron";

import type {
  NetworkRequest,
  NetworkRequestHandler,
  NetworkResponse,
  NetworkResponseHandler,
  NetworkInterceptHandler,
  NetworkResponseInterceptHandler,
  NetworkInterceptFilter,
  StreamTransformFn,
  StreamTransformOptions,
  WebSocketEvent,
  WebSocketHandler,
  WsTransformFn,
  WsTransformOptions,
  RaceRequestOptions,
  RaceResult,
  UnsubscribeFn,
} from "@desktop-proxy/plugin-sdk";

import { installNodeIntercept } from "./net/node-intercept";
import {
  runInterceptors,
  runResponseInterceptors,
  anyResponseInterceptMatches,
  type NetDecision,
  type NetResponseDecision,
  type InterceptRegistration,
  type ResponseInterceptRegistration,
} from "./net/intercept";

type Logger = (level: string, ...args: unknown[]) => void;

/** A registered streaming-response transformer (runs in the page main world). */
export interface TransformRegistration {
  id: string;
  urls: string[];
  mode: "chunk" | "sse";
  /** The transform function's source (injected and eval'd in the page). */
  source: string;
  onEmit?: (data: unknown) => void;
}

/** A registered outbound-WebSocket transformer (runs in the page main world). */
export interface WsTransformRegistration {
  id: string;
  urls: string[];
  /** The transform function's source (injected and eval'd in the page). */
  source: string;
  onEmit?: (data: unknown) => void;
}

/** A registered request-racing/failover rule (applied to main-process fetch). */
export interface RaceRegistration {
  id: string;
  urls: string[];
  opts: RaceRequestOptions;
  /** `variants`/`accept` sources, for the renderer (main-world) race wrapper. */
  variantsSource: string;
  acceptSource?: string;
}

export interface MainNetwork {
  onRequest(handler: NetworkRequestHandler): UnsubscribeFn;
  onResponse(handler: NetworkResponseHandler): UnsubscribeFn;
  /** Feed an externally-observed request (e.g. from the CDP network observer). */
  observeRequest(req: NetworkRequest): void;
  /** Feed an externally-observed response. */
  observeResponse(res: NetworkResponse): void;
  /** True if any plugin is listening (lets observers skip work). */
  hasHandlers(): boolean;
  /** Register a full-control intercept handler (continue/fulfill/fail). */
  intercept(handler: NetworkInterceptHandler, filter?: NetworkInterceptFilter): UnsubscribeFn;
  /** Run all intercept handlers for a request; first to act decides. */
  dispatchIntercept(req: NetworkRequest): Promise<NetDecision>;
  /** True if any intercept handler is registered. */
  hasInterceptors(): boolean;
  /** Register a response-rewrite handler. */
  interceptResponse(handler: NetworkResponseInterceptHandler, filter?: NetworkInterceptFilter): UnsubscribeFn;
  /** Run response interceptors matching the url; first to fulfill decides. */
  dispatchInterceptResponse(res: NetworkResponse, url: string): Promise<NetResponseDecision>;
  /** True if any response interceptor's filter matches the url (worth buffering). */
  responseInterceptMatches(url: string): boolean;
  /** True if any response interceptor is registered. */
  hasResponseInterceptors(): boolean;
  /** Register a streaming-response transformer (runs in the page main world). */
  transformStream(filter: NetworkInterceptFilter, transform: StreamTransformFn, opts?: StreamTransformOptions): UnsubscribeFn;
  /** Current transform registrations (for pushing into new/ navigated pages). */
  transformRegistrations(): TransformRegistration[];
  /** Subscribe to new transform registrations (the CDP injector listens). */
  setTransformListener(cb: (reg: TransformRegistration) => void): void;
  /** Route an `emit(...)` from a page transformer/ws-transformer back to its plugin. */
  dispatchTransformEmit(id: string, data: unknown): void;
  /** Observe WebSocket lifecycle/frames (fed by the CDP network observer). */
  onWebSocket(handler: WebSocketHandler): UnsubscribeFn;
  /** Feed an externally-observed WebSocket event. */
  observeWebSocket(evt: WebSocketEvent): void;
  /** True if any plugin is observing WebSockets (lets the observer skip work). */
  hasWebSocketHandlers(): boolean;
  /** Register an outbound-WebSocket transformer (runs in the page main world). */
  transformWebSocket(filter: NetworkInterceptFilter, transform: WsTransformFn, opts?: WsTransformOptions): UnsubscribeFn;
  /** Current ws-transform registrations (for pushing into new/ navigated pages). */
  wsTransformRegistrations(): WsTransformRegistration[];
  /** Subscribe to new ws-transform registrations (the CDP injector listens). */
  setWsTransformListener(cb: (reg: WsTransformRegistration) => void): void;
  /** Register a request-racing/failover rule (applied to main-process fetch). */
  raceRequest(filter: NetworkInterceptFilter, opts: RaceRequestOptions): UnsubscribeFn;
  /** First race rule matching the url (used by the Node fetch interceptor). */
  raceFor(url: string): RaceRegistration | null;
  /** Current race registrations (for pushing into new/navigated pages). */
  raceRegistrations(): RaceRegistration[];
  /** Subscribe to new race registrations (the main-world injector listens). */
  setRaceListener(cb: (reg: RaceRegistration) => void): void;
}

const URL_FILTER = { urls: ["*://*/*"] };

// A request handler that never resolves would otherwise stall the request (the
// webRequest callback must be called). Pass the request through after this.
const HANDLER_TIMEOUT_MS = 3000;

export function createMainNetwork(
  getSession: () => Session,
  whenReady: () => Promise<void>,
  log: Logger,
  maxBodyBytes: () => number = () => 1024 * 1024,
): MainNetwork {
  const requestHandlers = new Set<NetworkRequestHandler>();
  const responseHandlers = new Set<NetworkResponseHandler>();
  const interceptRegs = new Set<InterceptRegistration>();
  const responseInterceptRegs = new Set<ResponseInterceptRegistration>();
  const transformRegs = new Map<string, TransformRegistration>();
  const wsTransformRegs = new Map<string, WsTransformRegistration>();
  const wsHandlers = new Set<WebSocketHandler>();
  const raceRegs = new Map<string, RaceRegistration>();
  let transformCounter = 0;
  let wsTransformCounter = 0;
  let raceCounter = 0;
  let raceListener: ((reg: RaceRegistration) => void) | null = null;

  const firstRace = (url: string): RaceRegistration | null => {
    for (const reg of raceRegs.values()) {
      if (reg.urls.length === 0 || reg.urls.some((u) => url.includes(u))) return reg;
    }
    return null;
  };
  let transformListener: ((reg: TransformRegistration) => void) | null = null;
  let wsTransformListener: ((reg: WsTransformRegistration) => void) | null = null;

  let ready = false;
  let requestAttached = false;
  let responseAttached = false;

  // ── Request hook (onBeforeSendHeaders: headers available + modifiable) ──────
  async function runRequestHandlers(request: NetworkRequest): Promise<NetworkRequest> {
    let modified = request;
    for (const handler of requestHandlers) {
      try {
        const result = await handler(modified);
        if (result) modified = result;
      } catch {
        // a handler error must not break the request
      }
    }
    return modified;
  }

  function dispatchResponse(response: NetworkResponse): void {
    for (const handler of responseHandlers) {
      try {
        handler(response);
      } catch {
        // swallow handler errors
      }
    }
  }

  function attachRequest(): void {
    if (requestAttached) return;
    getSession().webRequest.onBeforeSendHeaders(
      URL_FILTER,
      (details: OnBeforeSendHeadersListenerDetails, callback: (response: BeforeSendResponse) => void) => {
        const request: NetworkRequest = {
          id: String(details.id),
          source: "web-request",
          method: details.method,
          url: details.url,
          headers: { ...((details.requestHeaders as Record<string, string>) ?? {}) },
          body: null,
          timestamp: Date.now(),
          _type: "fetch",
        };

        // The webRequest callback must run exactly once. Guard against a handler
        // that hangs by passing the request through after a timeout.
        let settled = false;
        const finish = (headers: Record<string, string>): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          callback({ requestHeaders: headers });
        };
        const timer = setTimeout(() => {
          log("warn", `main network handlers timed out for ${details.url}; passing through`);
          finish(details.requestHeaders as Record<string, string>);
        }, HANDLER_TIMEOUT_MS);

        void runRequestHandlers(request)
          .then((modified) => finish(modified.headers))
          .catch((e) => {
            log("error", "main network onRequest handlers failed:", String(e));
            finish(details.requestHeaders as Record<string, string>);
          });
      },
    );
    requestAttached = true;
    log("info", "main network: onBeforeSendHeaders hook attached");
  }

  function detachRequest(): void {
    if (!requestAttached) return;
    getSession().webRequest.onBeforeSendHeaders(null);
    requestAttached = false;
    log("info", "main network: onBeforeSendHeaders hook detached");
  }

  // ── Response hook (onCompleted: status + headers, no body) ───────────────────
  function attachResponse(): void {
    if (responseAttached) return;
    getSession().webRequest.onCompleted(URL_FILTER, (details: OnCompletedListenerDetails) => {
      dispatchResponse({
        id: `resp-${details.id}`,
        requestId: String(details.id),
        source: "web-request",
        status: details.statusCode,
        statusText: details.statusLine?.split(" ").slice(1).join(" ") || "",
        headers: (details.responseHeaders as unknown as Record<string, string>) ?? {},
        body: null,
        timestamp: Date.now(),
      });
    });
    responseAttached = true;
    log("info", "main network: onCompleted hook attached");
  }

  function detachResponse(): void {
    if (!responseAttached) return;
    getSession().webRequest.onCompleted(null);
    responseAttached = false;
    log("info", "main network: onCompleted hook detached");
  }

  // Attachment is only valid once the app/session is ready. Re-sync whenever the
  // handler sets change (after ready) so listeners exist iff handlers exist.
  function syncRequest(): void {
    if (!ready) return;
    if (requestHandlers.size > 0) attachRequest();
    else detachRequest();
  }
  function syncResponse(): void {
    if (!ready) return;
    if (responseHandlers.size > 0) attachResponse();
    else detachResponse();
  }

  void whenReady()
    .then(() => {
      ready = true;
      syncRequest();
      syncResponse();
    })
    .catch((e) => log("error", "main network: whenReady failed:", String(e)));

  const hasHandlers = (): boolean => requestHandlers.size > 0 || responseHandlers.size > 0;
  // Observe-only feed (modifications not applied): used by Node + CDP observers.
  const observeRequest = (req: NetworkRequest): void => {
    void runRequestHandlers(req);
  };
  const observeResponse = dispatchResponse;

  // Node http/https traffic isn't visible to webRequest; patch the Node modules
  // and feed observations into the same handler sets (tagged source "node-http").
  installNodeIntercept({ hasHandlers, observeRequest, observeResponse, maxBodyBytes, log, raceFor: firstRace });

  return {
    onRequest(handler: NetworkRequestHandler): UnsubscribeFn {
      requestHandlers.add(handler);
      syncRequest();
      return () => {
        requestHandlers.delete(handler);
        syncRequest();
      };
    },
    onResponse(handler: NetworkResponseHandler): UnsubscribeFn {
      responseHandlers.add(handler);
      syncResponse();
      return () => {
        responseHandlers.delete(handler);
        syncResponse();
      };
    },
    observeRequest,
    observeResponse,
    hasHandlers,
    intercept(handler: NetworkInterceptHandler, filter?: NetworkInterceptFilter): UnsubscribeFn {
      const reg: InterceptRegistration = { handler, filter };
      interceptRegs.add(reg);
      return () => {
        interceptRegs.delete(reg);
      };
    },
    dispatchIntercept: (req: NetworkRequest) => runInterceptors(interceptRegs, req),
    hasInterceptors: () => interceptRegs.size > 0,
    interceptResponse(handler: NetworkResponseInterceptHandler, filter?: NetworkInterceptFilter): UnsubscribeFn {
      const reg: ResponseInterceptRegistration = { handler, filter };
      responseInterceptRegs.add(reg);
      return () => {
        responseInterceptRegs.delete(reg);
      };
    },
    dispatchInterceptResponse: (res: NetworkResponse, url: string) =>
      runResponseInterceptors(responseInterceptRegs, res, url),
    responseInterceptMatches: (url: string) => anyResponseInterceptMatches(responseInterceptRegs, url),
    hasResponseInterceptors: () => responseInterceptRegs.size > 0,
    transformStream(filter: NetworkInterceptFilter, transform: StreamTransformFn, opts?: StreamTransformOptions): UnsubscribeFn {
      const id = `t${++transformCounter}`;
      const reg: TransformRegistration = {
        id,
        urls: filter?.urls ?? [],
        mode: opts?.mode === "sse" ? "sse" : "chunk",
        source: transform.toString(),
        onEmit: opts?.onEmit,
      };
      transformRegs.set(id, reg);
      transformListener?.(reg);
      return () => {
        transformRegs.delete(id);
      };
    },
    transformRegistrations: () => [...transformRegs.values()],
    setTransformListener: (cb) => {
      transformListener = cb;
    },
    dispatchTransformEmit: (id: string, data: unknown) => {
      const t = transformRegs.get(id) ?? wsTransformRegs.get(id);
      if (t) {
        t.onEmit?.(data);
        return;
      }
      raceRegs.get(id)?.opts.onResult?.(data as RaceResult);
    },
    onWebSocket(handler: WebSocketHandler): UnsubscribeFn {
      wsHandlers.add(handler);
      return () => {
        wsHandlers.delete(handler);
      };
    },
    observeWebSocket(evt: WebSocketEvent): void {
      for (const handler of wsHandlers) {
        try {
          handler(evt);
        } catch {
          // swallow handler errors
        }
      }
    },
    hasWebSocketHandlers: () => wsHandlers.size > 0,
    transformWebSocket(filter: NetworkInterceptFilter, transform: WsTransformFn, opts?: WsTransformOptions): UnsubscribeFn {
      const id = `w${++wsTransformCounter}`;
      const reg: WsTransformRegistration = {
        id,
        urls: filter?.urls ?? [],
        source: transform.toString(),
        onEmit: opts?.onEmit,
      };
      wsTransformRegs.set(id, reg);
      wsTransformListener?.(reg);
      return () => {
        wsTransformRegs.delete(id);
      };
    },
    wsTransformRegistrations: () => [...wsTransformRegs.values()],
    setWsTransformListener: (cb) => {
      wsTransformListener = cb;
    },
    raceRequest(filter: NetworkInterceptFilter, opts: RaceRequestOptions): UnsubscribeFn {
      const id = `r${++raceCounter}`;
      const reg: RaceRegistration = {
        id,
        urls: filter?.urls ?? [],
        opts,
        variantsSource: opts.variants.toString(),
        acceptSource: opts.accept ? opts.accept.toString() : undefined,
      };
      raceRegs.set(id, reg);
      raceListener?.(reg);
      return () => {
        raceRegs.delete(id);
      };
    },
    raceFor: (url: string) => firstRace(url),
    raceRegistrations: () => [...raceRegs.values()],
    setRaceListener: (cb) => {
      raceListener = cb;
    },
  };
}
