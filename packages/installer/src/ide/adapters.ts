/**
 * IDE adapters — per-IDE specifics (where it lives, how it's injected, how to
 * reach its model traffic), as data. Adding an OS or IDE is a table entry, not
 * surgery. See docs/cross-platform-plan.md.
 *
 * This is the single source of truth for known apps; `platform.ts` builds its
 * discovery list from here.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export type Platform = "darwin" | "win32" | "linux" | string;

/** How a given IDE's *model* traffic can be observed/redirected. */
export type ModelControl =
  /** A native core reads a config file we rewrite to point at the relay (Codex). */
  | { kind: "config-redirect"; tool: string; configFile: string; authFile?: string; wireApi: "responses" | "chat" }
  /** The model call runs inside the Electron app — our injection intercepts it (Cursor). */
  | { kind: "in-process"; payload: "json" | "protobuf"; redirectable: "yes" | "limited" }
  /** A proprietary native language-server makes the call (Windsurf/Codeium). */
  | { kind: "language-server"; redirectable: boolean };

export interface IdeAdapter {
  id: string;
  displayName: string;
  /** macOS bundle id (used for discovery / `osascript quit`). */
  bundleId?: string;
  /** Candidate install locations across macOS/Windows/Linux. */
  searchPaths(): string[];
  /** Injection strategy (all current targets are Electron → "asar"). */
  injection: "asar" | "none";
  /** How to reach the model traffic. */
  modelControl: ModelControl;
  /** The IDE's user config directory (cross-platform via the home dir). */
  configDir(): string;
}

const HOME = process.env.HOME || process.env.USERPROFILE || homedir();
const LOCALAPPDATA = process.env.LOCALAPPDATA || "";
const PROGRAMFILES = process.env.PROGRAMFILES || "";

/** Best-effort install search paths for an app across macOS/Windows/Linux. */
export function searchPathsFor(appName: string): string[] {
  const lower = appName.toLowerCase();
  return [
    // macOS
    `/Applications/${appName}.app`,
    join(HOME, "Applications", `${appName}.app`),
    // Windows (per-user install preferred; then Program Files)
    join(LOCALAPPDATA, "Programs", lower),
    join(LOCALAPPDATA, "Programs", appName),
    join(PROGRAMFILES, appName),
    // Linux (.deb/tar; AppImage is read-only and unsupported)
    `/opt/${appName}`,
    `/opt/${lower}`,
    `/usr/share/${lower}`,
    `/usr/lib/${lower}`,
    join(HOME, ".local", "share", lower),
  ];
}

const codexDir = join(HOME, ".codex");

export const ADAPTERS: Record<string, IdeAdapter> = {
  codex: {
    id: "codex",
    displayName: "Codex",
    bundleId: "com.openai.codex",
    searchPaths: () => searchPathsFor("Codex"),
    injection: "asar",
    modelControl: {
      kind: "config-redirect",
      tool: "codex",
      configFile: join(codexDir, "config.toml"),
      authFile: join(codexDir, "auth.json"),
      wireApi: "responses",
    },
    configDir: () => codexDir,
  },
  cursor: {
    id: "cursor",
    displayName: "Cursor",
    bundleId: "com.cursor.app",
    searchPaths: () => searchPathsFor("Cursor"),
    injection: "asar",
    // Cursor calls its backend in-process over HTTP/2 protobuf; transport-level
    // race/retry works, semantic rewrite needs protobuf decoding (later).
    modelControl: { kind: "in-process", payload: "protobuf", redirectable: "limited" },
    configDir: () => join(HOME, ".cursor"),
  },
  windsurf: {
    id: "windsurf",
    displayName: "Windsurf",
    bundleId: "com.codeium.windsurf",
    searchPaths: () => searchPathsFor("Windsurf"),
    injection: "asar",
    // Codeium's native language_server talks to a proprietary backend; likely not
    // redirectable to arbitrary models (observe via proxy/CA). Needs investigation.
    modelControl: { kind: "language-server", redirectable: false },
    configDir: () => join(HOME, ".codeium"),
  },
};

export function getIdeAdapter(id: string): IdeAdapter | null {
  return ADAPTERS[id.toLowerCase()] ?? null;
}

export function listIdeAdapters(): IdeAdapter[] {
  return Object.values(ADAPTERS);
}
