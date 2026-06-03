/**
 * Renderer-layer proxy/CA configuration (no-injection supplement).
 *
 * VS Code-derived apps (Cursor, Windsurf, VS Code) can be pointed at a local
 * proxy + CA WITHOUT any injection or re-signing, by editing two user files:
 *   - settings.json  → `http.proxy` etc. (extension host + VS Code core net)
 *   - argv.json      → Chromium `proxy-server` switch (renderer / Electron net)
 *
 * IMPORTANT (see docs/macos-injection-plan.md §9.6): this only covers
 * renderer/extension-host traffic. An AI IDE's own LLM calls originate from the
 * privileged main/Node process and are NOT captured this way — those still need
 * injection (asar backend) + the in-process Node/CDP interceptors. Also: Node
 * won't trust your CA without `NODE_EXTRA_CA_CERTS`, and cert-pinned endpoints
 * bypass any proxy. This is a best-effort supplement, not the AI-capture path.
 */

import { homedir, platform as osPlatform } from "node:os";
import { join } from "node:path";

export interface ProxyConfigOptions {
  /** Proxy address as host:port or a full URL. */
  proxyServer: string;
  /** Comma-separated bypass list (e.g. "localhost,127.0.0.1"). */
  bypass?: string;
  /** Whether VS Code should verify TLS (default false so a mitm cert works). */
  strictSSL?: boolean;
}

/** VS Code settings.json keys this feature manages (so `off` can remove them). */
export const PROXY_SETTING_KEYS = ["http.proxy", "http.proxyStrictSSL", "http.proxySupport"] as const;
/** argv.json keys this feature manages. */
export const ARGV_PROXY_KEYS = ["proxy-server", "proxy-bypass-list"] as const;

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Strip a leading scheme → bare host:port (for Chromium --proxy-server). */
export function toHostPort(server: string): string {
  return server.replace(SCHEME_RE, "").replace(/\/+$/, "");
}

/** Ensure a proxy URL has a scheme (for VS Code http.proxy). */
export function toProxyUrl(server: string): string {
  return SCHEME_RE.test(server) ? server : `http://${server}`;
}

export function buildVscodeSettingsPatch(opts: ProxyConfigOptions): Record<string, unknown> {
  return {
    "http.proxy": toProxyUrl(opts.proxyServer),
    "http.proxyStrictSSL": opts.strictSSL ?? false,
    "http.proxySupport": "on",
  };
}

export function buildArgvJsonPatch(opts: ProxyConfigOptions): Record<string, unknown> {
  const patch: Record<string, unknown> = { "proxy-server": toHostPort(opts.proxyServer) };
  if (opts.bypass) patch["proxy-bypass-list"] = opts.bypass;
  return patch;
}

/** Guidance for trusting the CA in Node-origin requests (can't be auto-applied). */
export function nodeCaEnvHint(caCertPath: string): string {
  return `export NODE_EXTRA_CA_CERTS="${caCertPath}"`;
}

// ── JSONC-tolerant read / merge (argv.json + settings.json may have comments) ──

/** Parse JSON that may contain // and /* *\/ comments and trailing commas. */
export function parseJsonc(text: string): Record<string, unknown> {
  if (!text.trim()) return {};
  const noComments = text
    .replace(/\\"|"(?:\\.|[^"\\])*"|(\/\/[^\n\r]*|\/\*[\s\S]*?\*\/)/g, (m, c) => (c ? "" : m))
    .replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(noComments) as Record<string, unknown>;
}

/** Merge `patch` into the (JSONC) `text`, returning pretty JSON (comments dropped). */
export function mergeJson(text: string, patch: Record<string, unknown>): string {
  const obj = parseJsonc(text);
  return JSON.stringify({ ...obj, ...patch }, null, 2) + "\n";
}

/** Remove `keys` from the (JSONC) `text`, returning pretty JSON. */
export function removeKeys(text: string, keys: readonly string[]): string {
  const obj = parseJsonc(text);
  for (const k of keys) delete obj[k];
  return JSON.stringify(obj, null, 2) + "\n";
}

// ── Fork path resolution ──────────────────────────────────────────────────────

export interface ForkPaths {
  /** App data folder name (e.g. "Cursor"). */
  dataDir: string;
  /** Absolute argv.json path. */
  argvJson: string;
  /** Absolute user settings.json path. */
  settingsJson: string;
}

interface ForkDef {
  /** ~/.<argvDir>/argv.json */
  argvDir: string;
  /** User-data app name for settings.json */
  dataDir: string;
}

const FORKS: Record<string, ForkDef> = {
  "com.cursor.app": { argvDir: ".cursor", dataDir: "Cursor" },
  "com.codeium.windsurf": { argvDir: ".windsurf", dataDir: "Windsurf" },
  "com.microsoft.VSCode": { argvDir: ".vscode", dataDir: "Code" },
  // com.openai.codex is NOT a VS Code derivative → returns null below.
};

export function isVscodeFork(bundleId: string | null | undefined): boolean {
  return !!bundleId && bundleId in FORKS;
}

function userDataRoot(plat: string, home: string): string {
  if (plat === "darwin") return join(home, "Library", "Application Support");
  if (plat === "win32") return process.env.APPDATA ?? join(home, "AppData", "Roaming");
  return join(home, ".config"); // linux
}

export function resolveForkPaths(
  bundleId: string | null | undefined,
  env: { platform?: string; home?: string } = {},
): ForkPaths | null {
  if (!bundleId) return null;
  const def = FORKS[bundleId];
  if (!def) return null;
  const home = env.home ?? homedir();
  const plat = env.platform ?? osPlatform();
  return {
    dataDir: def.dataDir,
    argvJson: join(home, def.argvDir, "argv.json"),
    settingsJson: join(userDataRoot(plat, home), def.dataDir, "User", "settings.json"),
  };
}
