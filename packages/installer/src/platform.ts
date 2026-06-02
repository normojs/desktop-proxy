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

const KNOWN_APPS: Record<string, {
  name: string;
  bundleId: string;
  searchPaths: string[];
}> = {
  codex: {
    name: "Codex",
    bundleId: "com.openai.codex",
    searchPaths: [
      "/Applications/Codex.app",
      join(process.env.HOME || "~", "Applications/Codex.app"),
    ],
  },
  cursor: {
    name: "Cursor",
    bundleId: "com.cursor.app",
    searchPaths: [
      "/Applications/Cursor.app",
      join(process.env.HOME || "~", "Applications/Cursor.app"),
    ],
  },
  windsurf: {
    name: "Windsurf",
    bundleId: "com.codeium.windsurf",
    searchPaths: [
      "/Applications/Windsurf.app",
      join(process.env.HOME || "~", "Applications/Windsurf.app"),
    ],
  },
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
  const contentsDir = isMac ? join(appRoot, "Contents") : appRoot;
  const resourcesDir = join(contentsDir, "Resources");
  const macosDir = join(contentsDir, "MacOS");
  const asarPath = join(resourcesDir, "app.asar");
  const metaPath = isMac ? join(contentsDir, "Info.plist") : null;

  // Find the Electron Framework or executable
  let electronBinary = "";
  if (isMac) {
    // Try Electron Framework first
    const frameworkPath = join(
      contentsDir,
      "Frameworks",
      "Electron Framework.framework",
      "Versions",
      "A",
      "Electron Framework",
    );
    if (existsSync(frameworkPath)) {
      electronBinary = frameworkPath;
    } else {
      // Fallback: try the main executable
      try {
        const entries = readdirSync(macosDir);
        const execFile = entries.find((e: string) => !e.endsWith(".plist") && !e.startsWith("."));
        if (execFile) electronBinary = join(macosDir, execFile);
      } catch {
        electronBinary = join(macosDir, "Electron");
      }
    }
  } else {
    electronBinary = join(appRoot, `${name || "app"}.exe`);
  }

  if (!existsSync(asarPath)) {
    throw new Error(`app.asar not found at ${asarPath}. Is this an Electron app?`);
  }

  // Detect app name from the .app directory or use provided
  const appName = name || appRoot.split("/").pop()?.replace(/\.app$/, "") || "Unknown";

  // Detect channel (stable, canary, etc.) from bundle name
  const channel = appRoot.toLowerCase().includes("canary")
    ? "canary"
    : appRoot.toLowerCase().includes("beta")
      ? "beta"
      : appRoot.toLowerCase().includes("insiders")
        ? "insiders"
        : "stable";

  return {
    platform: isMac ? "darwin" : platform(),
    appName,
    appRoot,
    executable: macosDir,
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

/**
 * Read the ElectronAsarIntegrity entry from Info.plist (macOS).
 */
export function readIntegrity(install: CodexInstall): string | null {
  if (!install.metaPath || !existsSync(install.metaPath)) return null;
  try {
    const out = execFileSync(
      "plutil",
      ["-extract", "ElectronAsarIntegrity.Resources/app.asar.hash", "raw", install.metaPath],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return out.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Update the ElectronAsarIntegrity hash in Info.plist.
 */
export function writeIntegrity(install: CodexInstall, hash: string): void {
  if (!install.metaPath) return;
  try {
    execFileSync(
      "plutil",
      [
        "-replace",
        "ElectronAsarIntegrity.Resources/app.asar",
        "-json",
        JSON.stringify({ algorithm: "SHA256", hash }),
        install.metaPath,
      ],
      { stdio: "ignore" },
    );
  } catch (e) {
    throw new Error(`Failed to update ElectronAsarIntegrity in Info.plist: ${String(e)}`);
  }
}
