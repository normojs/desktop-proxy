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

import { maskAsNative } from "./stealth";

let requestIdCounter = 0;
const requestHandlers: Set<NetworkRequestHandler> = new Set();
const responseHandlers: Set<NetworkResponseHandler> = new Set();

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

// ── Response body capture (capped + content-type filtered) ───────────────────

// Default 1 MiB cap so large downloads / long SSE streams don't buffer in full.
// 0 means unlimited. Set from config at boot.
let maxResponseBodyBytes = 1024 * 1024;

export function setMaxResponseBodyBytes(bytes: number): void {
  if (Number.isFinite(bytes) && bytes >= 0) maxResponseBodyBytes = bytes;
}

const TEXT_CONTENT_TYPE = /(json|text|xml|javascript|event-stream|x-www-form-urlencoded)/i;

function isTextResponse(headers: Record<string, string>): boolean {
  const contentType = headers["content-type"] ?? headers["Content-Type"] ?? "";
  return contentType === "" || TEXT_CONTENT_TYPE.test(contentType);
}

/** Read a response body as text, stopping at `cap` bytes (0 = unlimited). */
async function readCappedText(res: Response, cap: number): Promise<{ body: string; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) {
    try {
      const text = await res.text();
      if (cap > 0 && text.length > cap) return { body: text.slice(0, cap), truncated: true };
      return { body: text, truncated: false };
    } catch {
      return { body: "", truncated: false };
    }
  }

  const decoder = new TextDecoder();
  let out = "";
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (cap > 0 && total > cap) {
        const keep = Math.max(0, value.byteLength - (total - cap));
        out += decoder.decode(value.subarray(0, keep));
        await reader.cancel();
        return { body: out, truncated: true };
      }
      out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
  } catch {
    // stream error — return what we have
  }
  return { body: out, truncated: false };
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

    // Run request handlers (may modify url/method).
    const modifiedReq = await runRequestHandlers(netReq);

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

    const response = await originalFetch(finalRequest, finalInit);

    // Notify response handlers WITHOUT blocking the caller: read a clone of the
    // body in the background so streaming responses (e.g. SSE used by AI APIs)
    // still reach the app immediately instead of being buffered first.
    if (responseHandlers.size > 0) {
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });
      const base = {
        id: `resp-${netReq.id}`,
        requestId: netReq.id,
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        timestamp: Date.now(),
      };

      if (isTextResponse(responseHeaders)) {
        const clone = response.clone();
        void readCappedText(clone, maxResponseBodyBytes)
          .then(({ body, truncated }) => runResponseHandlers({ ...base, body, truncated }))
          .catch(() => {
            // response body unavailable
          });
      } else {
        // Binary response: notify with metadata only, don't buffer the body.
        runResponseHandlers({ ...base, body: null });
      }
    }

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

          let xhrBody: string | null = xhr.responseText ?? null;
          let xhrTruncated = false;
          if (xhrBody && maxResponseBodyBytes > 0 && xhrBody.length > maxResponseBodyBytes) {
            xhrBody = xhrBody.slice(0, maxResponseBodyBytes);
            xhrTruncated = true;
          }

          const netResp: NetworkResponse = {
            id: `resp-${info.requestId}`,
            requestId: info.requestId,
            status: xhr.status,
            statusText: xhr.statusText,
            headers: responseHeaders,
            truncated: xhrTruncated,
            body: xhrBody,
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

export function installNetworkInterceptor(stealth = false): void {
  hookFetch();
  hookXHR();

  if (stealth) {
    // Make the patched built-ins report native source under fn.toString().
    maskAsNative(window.fetch as unknown as (...args: unknown[]) => unknown, "fetch");
    const proto = window.XMLHttpRequest.prototype;
    maskAsNative(proto.open as unknown as (...args: unknown[]) => unknown, "open");
    maskAsNative(proto.send as unknown as (...args: unknown[]) => unknown, "send");
    maskAsNative(proto.setRequestHeader as unknown as (...args: unknown[]) => unknown, "setRequestHeader");
  }
}

export function onRequest(handler: NetworkRequestHandler): UnsubscribeFn {
  requestHandlers.add(handler);
  return () => requestHandlers.delete(handler);
}

export function onResponse(handler: NetworkResponseHandler): UnsubscribeFn {
  responseHandlers.add(handler);
  return () => responseHandlers.delete(handler);
}

/** Remove all handlers — called on hot reload so they don't accumulate. */
export function clearNetworkHandlers(): void {
  requestHandlers.clear();
  responseHandlers.clear();
}
