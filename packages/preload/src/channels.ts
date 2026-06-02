/**
 * IPC channel naming for the renderer side.
 *
 * The main process picks the prefix (randomized per session in stealth mode,
 * otherwise the stable "desktop-proxy"). The preload learns it synchronously via
 * the fixed `desktop-proxy:config-sync` bootstrap channel and calls
 * setChannelPrefix() before any other IPC, so both sides agree.
 */

let prefix = "desktop-proxy";

export function setChannelPrefix(value: string): void {
  if (value) prefix = value;
}

export function ch(name: string): string {
  return `${prefix}:${name}`;
}
