/**
 * Shared renderer-side message bus (leaf router over one IPC channel).
 *
 * One router instance for the whole renderer — used by plugin-host (api.events),
 * the built-in pages (traffic/management), and api.fs — so everything speaks the
 * unified protocol (bus.request / publish / subscribe) instead of ad-hoc IPC.
 */

import type { IpcRenderer } from "electron";
import { createBusRouter, type BusRouter, type BusTransport } from "@desktop-proxy/plugin-sdk";

import { ch } from "./channels";
import { createRendererIpcTransport } from "./bus-ipc";

let _ipc: IpcRenderer | null = null;
function ipcr(): IpcRenderer {
  if (!_ipc) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    _ipc = require("electron").ipcRenderer;
  }
  return _ipc!;
}

let _transport: BusTransport | null = null;
let _bus: BusRouter | null = null;

export function getRendererBus(): BusRouter {
  if (!_transport) _transport = createRendererIpcTransport(ipcr(), ch("bus"));
  if (!_bus) {
    _bus = createBusRouter();
    _bus.addTransport("ipc", _transport);
  }
  return _bus;
}

/** Drop the router (clears subscriptions) on teardown; the transport is reused. */
export function resetRendererBus(): void {
  _transport?.setReceiver(() => {});
  _bus = null;
}
