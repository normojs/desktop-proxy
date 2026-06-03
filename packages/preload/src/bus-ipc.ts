/**
 * Electron-IPC transport for the message bus (renderer/leaf side).
 *
 * A leaf has a single peer — the main process hub — so `send` always targets
 * main and `target` is ignored. The whole bus protocol is multiplexed over one
 * IPC channel.
 */

import type { IpcRenderer } from "electron";
import type { BusTransport, Envelope } from "@desktop-proxy/plugin-sdk";

export function createRendererIpcTransport(ipcRenderer: IpcRenderer, channel: string): BusTransport {
  let receiver: ((env: Envelope, source: string) => void) | undefined;

  ipcRenderer.on(channel, (_e, env: Envelope) => {
    try {
      receiver?.(env, "");
    } catch {
      /* handler error */
    }
  });

  return {
    send: (env) => {
      try {
        ipcRenderer.send(channel, env);
      } catch {
        /* main unavailable */
      }
    },
    setReceiver: (fn) => {
      receiver = fn;
    },
  };
}
