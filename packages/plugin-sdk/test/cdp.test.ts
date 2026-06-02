import { describe, it, expect, vi } from "vitest";

import { createCDP, type PluginCDPCore } from "../src/index";

function mockCore() {
  const listeners = new Map<string, Array<(p: unknown) => void>>();
  const sent: Array<{ method: string; params?: Record<string, unknown> }> = [];

  const core: PluginCDPCore = {
    attach: vi.fn(async () => {}),
    detach: vi.fn(async () => {}),
    isAttached: vi.fn(async () => true),
    send: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      sent.push({ method, params });
      if (method === "Runtime.evaluate") return { result: { value: 42 } } as unknown;
      if (method === "Network.getResponseBody") return { body: "hello", base64Encoded: false } as unknown;
      return {} as unknown;
    }),
    on: (event, handler) => {
      const arr = listeners.get(event) ?? [];
      arr.push(handler);
      listeners.set(event, arr);
      return () => {
        const next = (listeners.get(event) ?? []).filter((h) => h !== handler);
        listeners.set(event, next);
      };
    },
  };

  const emit = (event: string, params: unknown) =>
    (listeners.get(event) ?? []).forEach((h) => h(params));

  return { core, sent, emit };
}

describe("createCDP", () => {
  it("evaluate wraps Runtime.evaluate and returns the value", async () => {
    const { core, sent } = mockCore();
    const cdp = createCDP(core);
    const value = await cdp.evaluate("1 + 1");
    expect(value).toBe(42);
    expect(sent.some((s) => s.method === "Runtime.evaluate")).toBe(true);
  });

  it("onResponse enables Network, maps the event, and fetches the body lazily", async () => {
    const { core, sent, emit } = mockCore();
    const cdp = createCDP(core);
    const seen: Array<{ url: string; status: number }> = [];

    await cdp.onResponse((res) => seen.push(res));
    expect(sent.some((s) => s.method === "Network.enable")).toBe(true);

    emit("Network.responseReceived", {
      requestId: "1",
      response: { url: "http://x/api", status: 200, mimeType: "application/json", headers: { a: "b" } },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("http://x/api");
    expect(seen[0].status).toBe(200);

    const body = await (seen[0] as unknown as { getBody(): Promise<{ body: string }> }).getBody();
    expect(body.body).toBe("hello");
  });

  it("onRequestPaused enables Fetch and exposes continue/fulfill/fail", async () => {
    const { core, sent, emit } = mockCore();
    const cdp = createCDP(core);
    const seen: Array<{ requestId: string }> = [];

    await cdp.onRequestPaused((req, ctl) => {
      seen.push(req);
      void ctl.continue();
    });
    expect(sent.some((s) => s.method === "Fetch.enable")).toBe(true);

    emit("Fetch.requestPaused", {
      requestId: "r1",
      request: { url: "http://x", method: "GET", headers: {} },
      resourceType: "Document",
    });

    expect(seen[0].requestId).toBe("r1");
    expect(sent.some((s) => s.method === "Fetch.continueRequest")).toBe(true);
  });

  it("delegates core methods", async () => {
    const { core } = mockCore();
    const cdp = createCDP(core);
    await cdp.attach();
    expect(await cdp.isAttached()).toBe(true);
    expect(core.attach).toHaveBeenCalled();
  });
});
