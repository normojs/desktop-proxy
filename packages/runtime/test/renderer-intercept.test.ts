import { describe, it, expect, vi } from "vitest";
import type { WebContents } from "electron";

import { createRendererInterceptRouter } from "../src/net/renderer-intercept";

const wc = (id: number) => ({ id }) as unknown as WebContents;
const noop = () => {};

describe("renderer intercept router", () => {
  it("returns continue without a round-trip when the wc isn't registered", async () => {
    const send = vi.fn();
    const router = createRendererInterceptRouter({ sendReqPaused: send, sendResPaused: noop, log: noop });
    expect(await router.dispatchRequest(wc(1), { url: "x" } as never)).toEqual({ action: "continue" });
    expect(send).not.toHaveBeenCalled();
  });

  it("round-trips a request decision back to the caller", async () => {
    let pauseId = "";
    const router = createRendererInterceptRouter({
      sendReqPaused: (_wc, id) => {
        pauseId = id;
      },
      sendResPaused: noop,
      log: noop,
    });
    router.setRegistration(1, { request: true, responseUrls: [] });
    const p = router.dispatchRequest(wc(1), { url: "x" } as never);
    expect(pauseId).toBeTruthy();
    router.resolve(pauseId, { action: "fail", reason: "blocked" });
    expect(await p).toEqual({ action: "fail", reason: "blocked" });
  });

  it("falls back to continue on timeout", async () => {
    const router = createRendererInterceptRouter({
      sendReqPaused: noop,
      sendResPaused: noop,
      log: noop,
      timeoutMs: 10,
    });
    router.setRegistration(1, { request: true, responseUrls: [] });
    expect(await router.dispatchRequest(wc(1), { url: "x" } as never)).toEqual({ action: "continue" });
  });

  it("gates responses by registered url substrings", async () => {
    let pauseId = "";
    const router = createRendererInterceptRouter({
      sendReqPaused: noop,
      sendResPaused: (_wc, id) => {
        pauseId = id;
      },
      log: noop,
    });
    router.setRegistration(2, { request: false, responseUrls: ["api/"] });
    expect(router.wantsResponse(2)).toBe(true);
    expect(router.responseUrlsMatch(2, "https://x/api/y")).toBe(true);
    expect(router.responseUrlsMatch(2, "https://x/other")).toBe(false);

    expect(await router.dispatchResponse(wc(2), {} as never, "https://x/other")).toEqual({ action: "continue" });
    const p = router.dispatchResponse(wc(2), {} as never, "https://x/api/y");
    router.resolve(pauseId, { action: "fulfill", response: { status: 201 } });
    expect(await p).toEqual({ action: "fulfill", response: { status: 201 } });
  });

  it("treats an empty url ('') as match-all", () => {
    const router = createRendererInterceptRouter({ sendReqPaused: noop, sendResPaused: noop, log: noop });
    router.setRegistration(5, { request: false, responseUrls: [""] });
    expect(router.responseUrlsMatch(5, "https://anything/at/all")).toBe(true);
  });

  it("cleanupWc resolves pending with continue and drops registration", async () => {
    const router = createRendererInterceptRouter({
      sendReqPaused: noop,
      sendResPaused: noop,
      log: noop,
      timeoutMs: 9999,
    });
    router.setRegistration(3, { request: true, responseUrls: [] });
    const p = router.dispatchRequest(wc(3), { url: "x" } as never);
    router.cleanupWc(3);
    expect(await p).toEqual({ action: "continue" });
    expect(router.wantsRequest(3)).toBe(false);
  });

  it("setRegistration with an empty reg unregisters the wc", () => {
    const router = createRendererInterceptRouter({ sendReqPaused: noop, sendResPaused: noop, log: noop });
    router.setRegistration(1, { request: true, responseUrls: [] });
    expect(router.wantsRequest(1)).toBe(true);
    router.setRegistration(1, { request: false, responseUrls: [] });
    expect(router.wantsRequest(1)).toBe(false);
  });
});
