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
  UnsubscribeFn,
} from "@desktop-proxy/plugin-sdk";

type Logger = (level: string, ...args: unknown[]) => void;

export interface MainNetwork {
  onRequest(handler: NetworkRequestHandler): UnsubscribeFn;
  onResponse(handler: NetworkResponseHandler): UnsubscribeFn;
}

const URL_FILTER = { urls: ["*://*/*"] };

export function createMainNetwork(
  getSession: () => Session,
  whenReady: () => Promise<void>,
  log: Logger,
): MainNetwork {
  const requestHandlers = new Set<NetworkRequestHandler>();
  const responseHandlers = new Set<NetworkResponseHandler>();

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

  function attachRequest(): void {
    if (requestAttached) return;
    getSession().webRequest.onBeforeSendHeaders(
      URL_FILTER,
      (details: OnBeforeSendHeadersListenerDetails, callback: (response: BeforeSendResponse) => void) => {
        const request: NetworkRequest = {
          id: String(details.id),
          method: details.method,
          url: details.url,
          headers: { ...((details.requestHeaders as Record<string, string>) ?? {}) },
          body: null,
          timestamp: Date.now(),
          _type: "fetch",
        };

        void runRequestHandlers(request)
          .then((modified) => callback({ requestHeaders: modified.headers }))
          .catch((e) => {
            log("error", "main network onRequest handlers failed:", String(e));
            callback({ requestHeaders: details.requestHeaders });
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
      const response: NetworkResponse = {
        id: `resp-${details.id}`,
        requestId: String(details.id),
        status: details.statusCode,
        statusText: details.statusLine?.split(" ").slice(1).join(" ") || "",
        headers: (details.responseHeaders as unknown as Record<string, string>) ?? {},
        body: null,
        timestamp: Date.now(),
      };
      for (const handler of responseHandlers) {
        try {
          handler(response);
        } catch {
          // swallow handler errors
        }
      }
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
  };
}
