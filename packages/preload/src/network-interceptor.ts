/**
 * Network interceptor — hooks window.fetch and XMLHttpRequest to intercept
 * all network requests and responses from the renderer process.
 */

import type {
  NetworkRequest,
  NetworkResponse,
  NetworkRequestHandler,
  NetworkResponseHandler,
  UnsubscribeFn,
} from "@desktop-proxy/plugin-sdk";

let requestIdCounter = 0;
const requestHandlers: Set<NetworkRequestHandler> = new Set();
const responseHandlers: Set<NetworkResponseHandler> = new Set();

const REQUEST_MAP = new Map<string, Request>();

function nextRequestId(): string {
  return `req-${++requestIdCounter}-${Date.now()}`;
}

function requestToSerializable(req: Request, body: string | null, type: "fetch" | "xhr"): NetworkRequest {
  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    headers[key] = value;
  });

  return {
    id: nextRequestId(),
    method: req.method,
    url: req.url,
    headers,
    body,
    timestamp: Date.now(),
    _type: type,
  };
}

async function runRequestHandlers(request: NetworkRequest): Promise<NetworkRequest> {
  let modified = request;
  for (const handler of requestHandlers) {
    try {
      const result = await handler(modified);
      if (result) modified = result;
    } catch {
      // handler errors are swallowed to not break the request
    }
  }
  return modified;
}

function runResponseHandlers(response: NetworkResponse): void {
  for (const handler of responseHandlers) {
    try {
      handler(response);
    } catch {
      // handler errors are swallowed
    }
  }
}

// ── Hook fetch() ─────────────────────────────────────────────────────────────

function hookFetch(): void {
  const originalFetch = window.fetch.bind(window);

  window.fetch = async function (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    const request = new Request(input, init);
    let body: string | null = null;

    if (init?.body) {
      if (typeof init.body === "string") {
        body = init.body;
      } else {
        // Non-string bodies (streams, Blob, FormData, etc.) are not captured
        // here, since reading the stream would consume the request body.
        body = null;
      }
    }

    const netReq = requestToSerializable(request, body, "fetch");
    REQUEST_MAP.set(netReq.id, request);

    // Run request handlers
    const modifiedReq = await runRequestHandlers(netReq);

    // If the URL was modified, recreate the request
    let finalRequest: RequestInfo | URL = input;
    let finalInit: RequestInit | undefined = init;

    if (modifiedReq.url !== netReq.url || modifiedReq.method !== netReq.method) {
      finalRequest = new Request(modifiedReq.url, {
        method: modifiedReq.method,
        headers: modifiedReq.headers,
        body: init?.body,
      });
      finalInit = undefined;
    }

    // Execute the original fetch
    const response = await originalFetch(finalRequest, finalInit);

    // Read response body as text for interception
    const clonedResponse = response.clone();
    let responseBody: string | null = null;
    try {
      responseBody = await clonedResponse.text();
    } catch {
      // can't read response body
    }

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    const netResp: NetworkResponse = {
      id: `resp-${netReq.id}`,
      requestId: netReq.id,
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      body: responseBody,
      timestamp: Date.now(),
    };

    runResponseHandlers(netResp);

    return response;
  };
}

// ── Hook XMLHttpRequest ──────────────────────────────────────────────────────

function hookXHR(): void {
  const XHR = window.XMLHttpRequest;
  const originalOpen = XHR.prototype.open;
  const originalSend = XHR.prototype.send;
  const originalSetRequestHeader = XHR.prototype.setRequestHeader;

  // Store request info on the XHR instance
  interface XHRRequestInfo {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: string | null;
    requestId: string;
  }

  const xhrToRequest = new WeakMap<XMLHttpRequest, XHRRequestInfo>();

  XHR.prototype.open = function (
    method: string,
    url: string | URL,
    async: boolean = true,
    username?: string | null,
    password?: string | null
  ): void {
    const urlStr = typeof url === "string" ? url : url.href;
    xhrToRequest.set(this as XMLHttpRequest, {
      method,
      url: urlStr,
      headers: {},
      body: null,
      requestId: nextRequestId(),
    });
    const open = originalOpen as (
      method: string,
      url: string | URL,
      async?: boolean,
      username?: string | null,
      password?: string | null,
    ) => void;
    return open.call(this, method, url, async, username, password);
  };

  XHR.prototype.setRequestHeader = function (
    name: string,
    value: string
  ): void {
    const info = xhrToRequest.get(this as XMLHttpRequest);
    if (info) {
      info.headers[name] = value;
    }
    return originalSetRequestHeader.call(this, name, value);
  };

  XHR.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null): void {
    const info = xhrToRequest.get(this as XMLHttpRequest);
    const xhr = this as XMLHttpRequest;

    if (info) {
      info.body = typeof body === "string" ? body : null;

      const netReq: NetworkRequest = {
        id: info.requestId,
        method: info.method,
        url: info.url,
        headers: info.headers,
        body: info.body,
        timestamp: Date.now(),
        _type: "xhr",
      };

      // Run request handlers asynchronously
      runRequestHandlers(netReq).then((modifiedReq) => {
        if (modifiedReq.url !== info.url) {
          // Can't really redirect XHR, but we could modify the URL before open
          // For now, just track it
        }
      });

      // Hook response
      const originalOnReadyStateChange = xhr.onreadystatechange;
      xhr.onreadystatechange = function (ev: Event) {
        if (xhr.readyState === 4) {
          const responseHeaders: Record<string, string> = {};
          const headerStr = xhr.getAllResponseHeaders();
          headerStr.split("\r\n").forEach((line) => {
            const colonIdx = line.indexOf(":");
            if (colonIdx > 0) {
              responseHeaders[line.slice(0, colonIdx).trim().toLowerCase()] = line.slice(colonIdx + 1).trim();
            }
          });

          const netResp: NetworkResponse = {
            id: `resp-${info.requestId}`,
            requestId: info.requestId,
            status: xhr.status,
            statusText: xhr.statusText,
            headers: responseHeaders,
            body: xhr.responseText ?? null,
            timestamp: Date.now(),
          };

          runResponseHandlers(netResp);
        }
        if (originalOnReadyStateChange) {
          originalOnReadyStateChange.call(xhr, ev);
        }
      };
    }

    return originalSend.call(this, body);
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

export function installNetworkInterceptor(): void {
  hookFetch();
  hookXHR();
}

export function onRequest(handler: NetworkRequestHandler): UnsubscribeFn {
  requestHandlers.add(handler);
  return () => requestHandlers.delete(handler);
}

export function onResponse(handler: NetworkResponseHandler): UnsubscribeFn {
  responseHandlers.add(handler);
  return () => responseHandlers.delete(handler);
}
