/**
 * Main-process Chrome DevTools Protocol (CDP) hub.
 *
 * Rather than opening a remote-debugging port (a network-visible, unauthenticated
 * surface), we use Electron's in-process `webContents.debugger`. The main process
 * attaches the debugger to a target webContents, forwards CDP events back to that
 * renderer over IPC (`desktop-proxy:cdp:event`), and relays `sendCommand` calls.
 *
 * This is universal (no launch flags, no fuse changes), keeps the protocol off
 * the network, and targets exactly the renderer that asked for it.
 */

import type { WebContents } from "electron";

type Logger = (level: string, ...args: unknown[]) => void;

export interface MainCDP {
  attach(wc: WebContents): Promise<void>;
  detach(wc: WebContents): void;
  isAttached(wc: WebContents): boolean;
  send(wc: WebContents, method: string, params?: Record<string, unknown>): Promise<unknown>;
}

const PROTOCOL_VERSION = "1.3";
const EVENT_CHANNEL = "desktop-proxy:cdp:event";

export function createMainCDP(log: Logger): MainCDP {
  // webContents ids we attached ourselves (vs. DevTools).
  const attached = new Set<number>();

  return {
    async attach(wc: WebContents): Promise<void> {
      if (attached.has(wc.id)) return;
      if (wc.debugger.isAttached()) {
        throw new Error(
          "CDP attach failed: another debugger is already attached (is DevTools open?)",
        );
      }

      // Synchronous; throws on failure → rejects this promise.
      wc.debugger.attach(PROTOCOL_VERSION);
      attached.add(wc.id);

      wc.debugger.on("message", (_event, method, params) => {
        if (!wc.isDestroyed()) {
          wc.send(EVENT_CHANNEL, { method, params });
        }
      });
      wc.debugger.once("detach", () => attached.delete(wc.id));
      wc.once("destroyed", () => attached.delete(wc.id));

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
      attached.delete(wc.id);
    },

    isAttached(wc: WebContents): boolean {
      return attached.has(wc.id);
    },

    async send(wc: WebContents, method: string, params?: Record<string, unknown>): Promise<unknown> {
      return wc.debugger.sendCommand(method, params ?? {});
    },
  };
}
