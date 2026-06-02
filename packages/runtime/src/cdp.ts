/**
 * Main-process Chrome DevTools Protocol (CDP) hub.
 *
 * Rather than opening a remote-debugging port (a network-visible, unauthenticated
 * surface), we use Electron's in-process `webContents.debugger`. The hub attaches
 * the debugger to a target webContents and fans CDP events out to registered
 * listeners (`onEvent`). The runtime forwards those events to the owning renderer
 * over IPC, and main-process plugins subscribe in-process via the same `onEvent`.
 *
 * This is universal (no launch flags, no fuse changes), keeps the protocol off
 * the network, and targets exactly the webContents that asked for it.
 */

import type { WebContents } from "electron";

type Logger = (level: string, ...args: unknown[]) => void;

export interface MainCDP {
  attach(wc: WebContents): Promise<void>;
  detach(wc: WebContents): void;
  isAttached(wc: WebContents): boolean;
  send(wc: WebContents, method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** Subscribe to all CDP events for a webContents. Returns an unsubscribe fn. */
  onEvent(wc: WebContents, handler: (method: string, params: unknown) => void): () => void;
}

const PROTOCOL_VERSION = "1.3";

export function createMainCDP(log: Logger): MainCDP {
  const attached = new Set<number>();
  const dispatchers = new Map<number, Set<(method: string, params: unknown) => void>>();

  function dispatch(id: number, method: string, params: unknown): void {
    const set = dispatchers.get(id);
    if (set) {
      for (const handler of set) {
        try {
          handler(method, params);
        } catch {
          // a listener error must not break event delivery
        }
      }
    }
  }

  function cleanup(id: number): void {
    attached.delete(id);
    dispatchers.delete(id);
  }

  return {
    async attach(wc: WebContents): Promise<void> {
      if (attached.has(wc.id)) return;
      if (wc.debugger.isAttached()) {
        throw new Error(
          "CDP attach failed: another debugger is already attached (is DevTools open?)",
        );
      }

      wc.debugger.attach(PROTOCOL_VERSION); // throws on failure → rejects
      attached.add(wc.id);

      wc.debugger.on("message", (_event, method, params) => dispatch(wc.id, method, params));
      wc.debugger.once("detach", () => cleanup(wc.id));
      wc.once("destroyed", () => cleanup(wc.id));

      log("info", `CDP: attached to webContents ${wc.id}`);
    },

    detach(wc: WebContents): void {
      if (attached.has(wc.id) && wc.debugger.isAttached()) {
        try {
          wc.debugger.detach();
        } catch (e) {
          log("warn", `CDP: detach failed for wc ${wc.id}:`, String(e));
        }
      }
      cleanup(wc.id);
    },

    isAttached(wc: WebContents): boolean {
      return attached.has(wc.id);
    },

    async send(wc: WebContents, method: string, params?: Record<string, unknown>): Promise<unknown> {
      return wc.debugger.sendCommand(method, params ?? {});
    },

    onEvent(wc: WebContents, handler: (method: string, params: unknown) => void): () => void {
      let set = dispatchers.get(wc.id);
      if (!set) dispatchers.set(wc.id, (set = new Set()));
      set.add(handler);
      return () => {
        set?.delete(handler);
      };
    },
  };
}
