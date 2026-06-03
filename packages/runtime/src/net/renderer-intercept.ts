/**
 * Renderer-scope interception router (main side).
 *
 * Request/response pauses happen in the main process (CDP Fetch on a
 * webContents), but renderer-scope plugins register their `intercept` /
 * `interceptResponse` handlers in their own renderer. This router bridges the
 * two: when a pause occurs on a webContents that has registered renderer
 * interceptors, it forwards the request/response to that renderer, awaits a
 * decision (with a timeout fallback to "continue"), and returns it so the CDP
 * layer can apply it.
 *
 * Main-scope handlers are consulted first (in index.ts); the renderer is only
 * asked when no main-scope handler acted, so this never duplicates work.
 */

import type { WebContents } from "electron";

import type { NetworkRequest, NetworkResponse } from "@desktop-proxy/plugin-sdk";

import type { NetDecision, NetResponseDecision } from "./intercept";

type Logger = (level: string, ...args: unknown[]) => void;

export interface RendererRegistration {
  /** Whether the renderer has any request interceptors. */
  request: boolean;
  /** URL substrings the renderer wants to rewrite responses for ("" = all). */
  responseUrls: string[];
}

export interface RendererInterceptDeps {
  sendReqPaused: (wc: WebContents, pauseId: string, req: NetworkRequest) => void;
  sendResPaused: (wc: WebContents, pauseId: string, res: NetworkResponse, url: string) => void;
  /** Max wait for a renderer decision before falling back to "continue". */
  timeoutMs?: number;
  log: Logger;
}

export interface RendererInterceptRouter {
  setRegistration(wcId: number, reg: RendererRegistration | null): void;
  wantsRequest(wcId: number): boolean;
  wantsResponse(wcId: number): boolean;
  responseUrlsMatch(wcId: number, url: string): boolean;
  dispatchRequest(wc: WebContents, req: NetworkRequest): Promise<NetDecision>;
  dispatchResponse(wc: WebContents, res: NetworkResponse, url: string): Promise<NetResponseDecision>;
  resolve(pauseId: string, decision: NetDecision | NetResponseDecision): void;
  cleanupWc(wcId: number): void;
}

interface PendingEntry {
  resolve: (d: unknown) => void;
  wcId: number;
  timer: ReturnType<typeof setTimeout>;
}

export function createRendererInterceptRouter(deps: RendererInterceptDeps): RendererInterceptRouter {
  const timeoutMs = deps.timeoutMs ?? 2500;
  const regs = new Map<number, RendererRegistration>();
  const pending = new Map<string, PendingEntry>();
  let counter = 0;

  function wantsRequest(wcId: number): boolean {
    return regs.get(wcId)?.request === true;
  }
  function wantsResponse(wcId: number): boolean {
    return (regs.get(wcId)?.responseUrls.length ?? 0) > 0;
  }
  function responseUrlsMatch(wcId: number, url: string): boolean {
    const urls = regs.get(wcId)?.responseUrls;
    if (!urls || urls.length === 0) return false;
    return urls.some((u) => url.includes(u));
  }

  function roundTrip<T>(wc: WebContents, fallback: T, send: (pauseId: string) => void): Promise<T> {
    const pauseId = `ri${++counter}`;
    return new Promise<T>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(pauseId);
        resolve(fallback);
      }, timeoutMs);
      pending.set(pauseId, {
        resolve: (d) => {
          clearTimeout(timer);
          resolve(d as T);
        },
        wcId: wc.id,
        timer,
      });
      try {
        send(pauseId);
      } catch (e) {
        clearTimeout(timer);
        pending.delete(pauseId);
        deps.log("warn", "renderer-intercept: send failed:", String(e));
        resolve(fallback);
      }
    });
  }

  return {
    setRegistration(wcId, reg) {
      if (reg && (reg.request || reg.responseUrls.length > 0)) regs.set(wcId, reg);
      else regs.delete(wcId);
    },
    wantsRequest,
    wantsResponse,
    responseUrlsMatch,
    dispatchRequest(wc, req) {
      if (!wantsRequest(wc.id)) return Promise.resolve<NetDecision>({ action: "continue" });
      return roundTrip<NetDecision>(wc, { action: "continue" }, (pauseId) => deps.sendReqPaused(wc, pauseId, req));
    },
    dispatchResponse(wc, res, url) {
      if (!responseUrlsMatch(wc.id, url)) return Promise.resolve<NetResponseDecision>({ action: "continue" });
      return roundTrip<NetResponseDecision>(wc, { action: "continue" }, (pauseId) =>
        deps.sendResPaused(wc, pauseId, res, url),
      );
    },
    resolve(pauseId, decision) {
      pending.get(pauseId)?.resolve(decision);
      pending.delete(pauseId);
    },
    cleanupWc(wcId) {
      regs.delete(wcId);
      for (const [pauseId, p] of pending) {
        if (p.wcId === wcId) {
          clearTimeout(p.timer);
          p.resolve({ action: "continue" });
          pending.delete(pauseId);
        }
      }
    },
  };
}
