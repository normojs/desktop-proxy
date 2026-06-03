import { describe, it, expect } from "vitest";

import { createTrafficRecorder } from "../src/net/traffic-recorder";
import type { NetworkRequest, NetworkResponse, WebSocketEvent, UnsubscribeFn } from "@desktop-proxy/plugin-sdk";

function mockNet() {
  let reqH: ((r: NetworkRequest) => void) | null = null;
  let resH: ((r: NetworkResponse) => void) | null = null;
  let wsH: ((e: WebSocketEvent) => void) | null = null;
  const net = {
    onRequest(h: (r: NetworkRequest) => void): UnsubscribeFn {
      reqH = h;
      return () => {
        reqH = null;
      };
    },
    onResponse(h: (r: NetworkResponse) => void): UnsubscribeFn {
      resH = h;
      return () => {
        resH = null;
      };
    },
    onWebSocket(h: (e: WebSocketEvent) => void): UnsubscribeFn {
      wsH = h;
      return () => {
        wsH = null;
      };
    },
  };
  return {
    net,
    subscribed: () => reqH != null,
    fireReq: (r: Partial<NetworkRequest>) => reqH?.({ headers: {}, body: null, timestamp: Date.now(), _type: "fetch", ...r } as NetworkRequest),
    fireRes: (r: Partial<NetworkResponse>) => resH?.({ headers: {}, body: null, timestamp: Date.now(), ...r } as NetworkResponse),
    fireWs: (e: Partial<WebSocketEvent>) => wsH?.({ timestamp: Date.now(), ...e } as WebSocketEvent),
  };
}

describe("traffic recorder", () => {
  it("subscribes only while enabled", () => {
    const m = mockNet();
    const rec = createTrafficRecorder(m.net, () => "1.0.0");
    expect(m.subscribed()).toBe(false);
    rec.setEnabled(true);
    expect(m.subscribed()).toBe(true);
    expect(rec.isEnabled()).toBe(true);
    rec.setEnabled(false);
    expect(m.subscribed()).toBe(false);
    expect(rec.isEnabled()).toBe(false);
  });

  it("correlates request + response into one entry and HAR", () => {
    const m = mockNet();
    const rec = createTrafficRecorder(m.net, () => "9.9.9");
    rec.setEnabled(true);
    m.fireReq({ id: "1", method: "POST", url: "https://a/x", headers: { "content-type": "application/json" }, body: '{"q":1}', source: "web-request" });
    m.fireRes({ id: "resp-1", requestId: "1", status: 200, statusText: "OK", headers: { "content-type": "application/json" }, body: '{"ok":true}', bodyEncoding: "utf8", source: "web-request" });

    const list = rec.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: "1", method: "POST", url: "https://a/x", status: 200, bodyBytes: 11, source: "web-request" });

    const har = rec.toHar();
    expect(har.log.version).toBe("1.2");
    expect(har.log.creator.version).toBe("9.9.9");
    expect(har.log.entries).toHaveLength(1);
    const e = har.log.entries[0] as { request: { method: string; postData?: { text: string } }; response: { status: number; content: { text?: string } } };
    expect(e.request.method).toBe("POST");
    expect(e.request.postData?.text).toBe('{"q":1}');
    expect(e.response.status).toBe(200);
    expect(e.response.content.text).toBe('{"ok":true}');
  });

  it("evicts oldest beyond the cap (newest first)", () => {
    const m = mockNet();
    const rec = createTrafficRecorder(m.net, () => "1.0.0", 3);
    rec.setEnabled(true);
    for (const id of ["1", "2", "3", "4"]) m.fireReq({ id, method: "GET", url: `https://a/${id}` });
    expect(rec.count()).toBe(3);
    expect(rec.list().map((e) => e.id)).toEqual(["4", "3", "2"]);
  });

  it("records WebSocket frames with the Chrome HAR extension", () => {
    const m = mockNet();
    const rec = createTrafficRecorder(m.net, () => "1.0.0");
    rec.setEnabled(true);
    m.fireWs({ id: "ws1", type: "open", url: "wss://a/sock", source: "renderer-cdp" });
    m.fireWs({ id: "ws1", type: "sent", data: "ping", opcode: 1 });
    m.fireWs({ id: "ws1", type: "received", data: "pong", opcode: 1 });
    m.fireWs({ id: "ws1", type: "close" });

    const list = rec.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ resourceType: "websocket", url: "wss://a/sock", wsFrames: 2 });

    const har = rec.toHar();
    const e = har.log.entries[0] as { _resourceType: string; _webSocketMessages: Array<{ type: string; data: string }> };
    expect(e._resourceType).toBe("websocket");
    expect(e._webSocketMessages).toHaveLength(2);
    expect(e._webSocketMessages[0]).toMatchObject({ type: "send", data: "ping" });
    expect(e._webSocketMessages[1]).toMatchObject({ type: "receive", data: "pong" });
  });

  it("clear() empties the ring; disabling stops recording", () => {
    const m = mockNet();
    const rec = createTrafficRecorder(m.net, () => "1.0.0");
    rec.setEnabled(true);
    m.fireReq({ id: "1", method: "GET", url: "https://a/x" });
    expect(rec.count()).toBe(1);
    rec.clear();
    expect(rec.count()).toBe(0);
    rec.setEnabled(false);
    m.fireReq({ id: "2", method: "GET", url: "https://a/y" });
    expect(rec.count()).toBe(0);
  });
});

describe("traffic recorder — analysis, filter & detail", () => {
  function setup() {
    const m = mockNet();
    const rec = createTrafficRecorder(m.net, () => "1.0.0");
    rec.setEnabled(true);
    m.fireReq({ id: "1", method: "POST", url: "https://api.openai.com/v1/chat/completions", headers: { authorization: "Bearer sk-x", "content-type": "application/json" }, body: '{"model":"gpt-4o","stream":true}' });
    m.fireRes({ id: "resp-1", requestId: "1", status: 200, statusText: "OK", headers: { "content-type": "text/event-stream" }, body: "data: hi\n\n", bodyEncoding: "utf8" });
    m.fireReq({ id: "2", method: "GET", url: "https://telemetry.acme.io/events", headers: {}, body: null });
    m.fireRes({ id: "resp-2", requestId: "2", status: 204, headers: {}, body: null });
    return rec;
  }

  it("annotates summaries with category/service/kind/label", () => {
    const ai = setup().list().find((e) => e.id === "1")!;
    expect(ai.category).toBe("ai");
    expect(ai.service).toBe("OpenAI");
    expect(ai.kind).toBe("sse");
    expect(ai.label).toContain("OpenAI");
    expect(ai.tags).toContain("stream");
  });

  it("filters by DSL query", () => {
    const rec = setup();
    expect(rec.list("category:ai").map((e) => e.id)).toEqual(["1"]);
    expect(rec.list("category:telemetry").map((e) => e.id)).toEqual(["2"]);
    expect(rec.list("domain:openai status:2xx").map((e) => e.id)).toEqual(["1"]);
    expect(rec.list("is:stream").map((e) => e.id)).toEqual(["1"]);
    expect(rec.list("-category:ai").map((e) => e.id)).toEqual(["2"]);
  });

  it("returns full detail with headers + bodies", () => {
    const d = setup().detail("1")!;
    expect(d.reqHeaders.authorization).toBe("Bearer sk-x");
    expect(d.reqBody).toContain("gpt-4o");
    expect(d.resBody).toContain("data: hi");
    expect(d.model).toBe("gpt-4o");
    expect(d.statusText).toBe("OK");
  });

  it("computes AI token usage and filters the HAR export by query", () => {
    const m = mockNet();
    const rec = createTrafficRecorder(m.net, () => "1.0.0");
    rec.setEnabled(true);
    m.fireReq({ id: "1", method: "POST", url: "https://api.openai.com/v1/chat/completions", headers: {}, body: '{"model":"gpt-4o"}' });
    m.fireRes({ id: "r1", requestId: "1", status: 200, headers: { "content-type": "application/json" }, body: '{"usage":{"prompt_tokens":100,"completion_tokens":50}}', bodyEncoding: "utf8" });
    m.fireReq({ id: "2", method: "GET", url: "https://cdn.acme.io/a.svg", headers: {}, body: null });
    m.fireRes({ id: "r2", requestId: "2", status: 200, headers: { "content-type": "image/svg+xml" }, body: "<svg/>" });

    const ai = rec.list().find((e) => e.id === "1")!;
    expect(ai.usage?.promptTokens).toBe(100);
    expect(ai.usage?.costUsd).toBeGreaterThan(0);
    expect(rec.toHar("category:ai").log.entries).toHaveLength(1);
    expect(rec.toHar().log.entries).toHaveLength(2);
  });
});
