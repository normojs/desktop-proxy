/**
 * Platform detection for target Electron apps.
 *
 * Locates the target app, detects its Electron version, and provides
 * metadata about the installation.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { platform } from "node:os";

import { appResourcesDir, appAsarPath, appMetaPath, electronBinaryCandidates } from "./layout.js";

export interface CodexInstall {
  platform: string;
  appName: string;
  appRoot: string;
  executable: string;
  resourcesDir: string;
  asarPath: string;
  metaPath: string | null;
  electronBinary: string;
  channel: string;
  bundleId: string | null;
}

const HOME = process.env.HOME || process.env.USERPROFILE || "~";
const LOCALAPPDATA = process.env.LOCALAPPDATA || "";
const PROGRAMFILES = process.env.PROGRAMFILES || "";

/** Build best-effort search paths for an app across macOS/Windows/Linux. */
function searchPathsFor(appName: string): string[] {
  const lower = appName.toLowerCase();
  return [
    // macOS
    `/Applications/${appName}.app`,
    join(HOME, "Applications", `${appName}.app`),
    // Windows (app root contains <App>.exe + resources/)
    join(LOCALAPPDATA, "Programs", lower),
    join(LOCALAPPDATA, "Programs", appName),
    join(PROGRAMFILES, appName),
    // Linux (.deb/tar installs; AppImage is read-only and unsupported)
    `/opt/${appName}`,
    `/opt/${lower}`,
    `/usr/share/${lower}`,
    `/usr/lib/${lower}`,
    join(HOME, ".local", "share", lower),
  ];
}

const KNOWN_APPS: Record<string, {
  name: string;
  bundleId: string;
  searchPaths: string[];
}> = {
  codex: { name: "Codex", bundleId: "com.openai.codex", searchPaths: searchPathsFor("Codex") },
  cursor: { name: "Cursor", bundleId: "com.cursor.app", searchPaths: searchPathsFor("Cursor") },
  windsurf: { name: "Windsurf", bundleId: "com.codeium.windsurf", searchPaths: searchPathsFor("Windsurf") },
};

/**
 * Locate a target Electron app. Supports:
 * - Named apps from KNOWN_APPS
 * - Explicit path to an .app bundle
 * - Auto-detection from known search paths
 */
export function locateApp(appHint?: string): CodexInstall {
  const isMac = platform() === "darwin";

  if (appHint && existsSync(appHint)) {
    return parseAppBundle(appHint, isMac);
  }

  // Look for known apps
  for (const [key, info] of Object.entries(KNOWN_APPS)) {
    if (appHint && appHint.toLowerCase() !== key) continue;
    for (const searchPath of info.searchPaths) {
      if (existsSync(searchPath)) {
        return parseAppBundle(searchPath, isMac, info.name, info.bundleId);
      }
    }
  }

  if (appHint) {
    throw new Error(
      `App "${appHint}" not found. Provide an explicit path with --app /path/to/App.app`,
    );
  }

  // Try all known app search paths
  for (const [key, info] of Object.entries(KNOWN_APPS)) {
    for (const searchPath of info.searchPaths) {
      if (existsSync(searchPath)) {
        return parseAppBundle(searchPath, isMac, info.name, info.bundleId);
      }
    }
  }

  throw new Error(
    "No supported Electron app found. Use --app to specify the path to an .app bundle.\n\n" +
    "Supported apps: " + Object.keys(KNOWN_APPS).join(", ") + "\n" +
    "Or pass any Electron app: desktop-proxy install --app /path/to/App.app",
  );
}

function parseAppBundle(
  appRoot: string,
  isMac: boolean,
  name?: string,
  bundleId?: string,
): CodexInstall {
  const plat = isMac ? "darwin" : platform();

  // Detect app name from the directory or use provided.
  const appName = name || appRoot.split(/[\\/]/).pop()?.replace(/\.app$/, "") || "Unknown";

  const resourcesDir = appResourcesDir(appRoot, plat);
  const asarPath = appAsarPath(appRoot, plat);
  const metaPath = appMetaPath(appRoot, plat);
  const executable = isMac ? join(appRoot, "Contents", "MacOS") : appRoot;

  // Pick the first existing Electron binary candidate (fall back to the first).
  // On macOS the framework may be renamed (e.g. "Codex Framework"), so feed the
  // actual .framework dir names in.
  let frameworks: string[] = [];
  if (isMac) {
    try {
      frameworks = readdirSync(join(appRoot, "Contents", "Frameworks"));
    } catch {
      // no Frameworks dir
    }
  }
  const candidates = electronBinaryCandidates(appRoot, plat, appName, frameworks);
  const electronBinary = candidates.find((c) => existsSync(c)) ?? candidates[0];

  if (!existsSync(asarPath)) {
    throw new Error(`app.asar not found at ${asarPath}. Is this an Electron app?`);
  }

  // Detect channel (stable, canary, etc.) from the bundle name.
  const channel = appRoot.toLowerCase().includes("canary")
    ? "canary"
    : appRoot.toLowerCase().includes("beta")
      ? "beta"
      : appRoot.toLowerCase().includes("insiders")
        ? "insiders"
        : "stable";

  return {
    platform: plat,
    appName,
    appRoot,
    executable,
    resourcesDir,
    asarPath,
    metaPath,
    electronBinary,
    channel,
    bundleId: bundleId || null,
  };
}

/**
 * Read the app version from Info.plist or package.json in the asar.
 */
export function readAppVersion(install: CodexInstall): string | null {
  // macOS: try Info.plist first
  if (install.metaPath && existsSync(install.metaPath)) {
    try {
      const out = execFileSync("plutil", ["-extract", "CFBundleShortVersionString", "raw", install.metaPath], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (out.trim()) return out.trim();
    } catch {}
  }

  // Try reading electron version from the framework
  try {
    const packageJsonPath = join(install.resourcesDir, "app.asar");
    // We'd need to crack open the asar, but for now just return null
  } catch {}

  return null;
}

type IntegrityDict = Record<string, { algorithm?: string; hash?: string }>;

/**
 * Pick the asar entry inside an ElectronAsarIntegrity dict. The key is the asar's
 * path *relative to Contents* (e.g. "Resources/app.asar") — note it contains a
 * dot, which is why we operate on the whole dict instead of a plutil keypath.
 */
function pickAsarKey(dict: IntegrityDict): string | null {
  if (!dict || typeof dict !== "object") return null;
  if ("Resources/app.asar" in dict) return "Resources/app.asar";
  const appAsar = Object.keys(dict).find((k) => k.endsWith("app.asar"));
  if (appAsar) return appAsar;
  const all = Object.keys(dict);
  return all.length ? all[0] : null;
}

/** Read the whole ElectronAsarIntegrity dict from Info.plist (macOS), or null. */
function readIntegrityDict(metaPath: string): IntegrityDict | null {
  try {
    const out = execFileSync("plutil", ["-extract", "ElectronAsarIntegrity", "json", "-o", "-", metaPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(out) as IntegrityDict;
  } catch {
    return null; // key absent → the app doesn't use asar integrity
  }
}

/**
 * Read the ElectronAsarIntegrity hash for app.asar from Info.plist (macOS).
 */
export function readIntegrity(install: CodexInstall): string | null {
  if (!install.metaPath || !existsSync(install.metaPath)) return null;
  const dict = readIntegrityDict(install.metaPath);
  if (!dict) return null;
  const key = pickAsarKey(dict);
  return key ? dict[key]?.hash ?? null : null;
}

/**
 * Update the ElectronAsarIntegrity hash in Info.plist. Replaces the *entire*
 * dict (the asar key contains a dot, which plutil keypaths can't address), while
 * preserving any other entries. No-op when the app has no integrity dict.
 */
export function writeIntegrity(install: CodexInstall, hash: string): void {
  if (!install.metaPath) return;
  const dict = readIntegrityDict(install.metaPath);
  if (!dict) return; // app ships no asar integrity — nothing to maintain
  const key = pickAsarKey(dict) ?? "Resources/app.asar";
  dict[key] = { algorithm: "SHA256", hash };
  try {
    execFileSync("plutil", ["-replace", "ElectronAsarIntegrity", "-json", JSON.stringify(dict), install.metaPath], {
      stdio: "ignore",
    });
  } catch (e) {
    throw new Error(`Failed to update ElectronAsarIntegrity in Info.plist: ${String(e)}`);
  }
}
