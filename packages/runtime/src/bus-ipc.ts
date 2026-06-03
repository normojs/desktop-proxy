/**
 * Electron-IPC transport for the message bus (main side).
 *
 * Multiplexes the whole bus protocol over a single IPC channel. It is the hub's
 * transport: each renderer is a peer identified by its webContents id. Inbound
 * messages are tagged with `env.src = <wcId>` so the router/hub can target
 * replies and exclude the origin on event fan-out.
 */

import type { BusTransport, Envelope } from "@desktop-proxy/plugin-sdk";

type Logger = (level: string, ...args: unknown[]) => void;

export function createMainIpcTransport(
  electron: typeof import("electron"),
  channel: string,
  log: Logger,
): BusTransport {
  let receiver: ((env: Envelope, source: string) => void) | undefined;

  electron.ipcMain.on(channel, (e, env: Envelope) => {
    try {
      receiver?.({ ...env, src: String(e.sender.id) }, "");
    } catch (err) {
      log("warn", "bus ipc: receive failed:", String(err));
    }
  });

  return {
    send: (env, target) => {
      if (target != null) {
        const wc = electron.webContents.fromId(Number(target));
        if (wc && !wc.isDestroyed()) wc.send(channel, env);
        return;
      }
      // Broadcast to all window renderers, excluding the origin peer (env.src).
      for (const w of electron.BrowserWindow.getAllWindows()) {
        const wc = w.webContents;
        if (wc.isDestroyed()) continue;
        if (env.src != null && String(wc.id) === String(env.src)) continue;
        wc.send(channel, env);
      }
    },
    setReceiver: (fn) => {
      receiver = fn;
    },
  };
}
