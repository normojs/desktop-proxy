/**
 * Electron app on-disk layout, per platform (pure helpers).
 *
 * macOS:  <App>.app/Contents/{Resources/app.asar, Info.plist, Frameworks/Electron Framework.framework/...}
 * Windows: <appRoot>/{resources/app.asar, <App>.exe}
 * Linux:   <appRoot>/{resources/app.asar, <binary>}
 *
 * The earlier implementation assumed the macOS layout everywhere (Contents/ +
 * "Resources" capitalized + ".exe"), which broke Windows/Linux. These pure
 * functions encode the real per-platform layout so they can be unit tested.
 */

import { join } from "node:path";

export type Plat = "darwin" | "win32" | "linux" | string;

function isMac(plat: Plat): boolean {
  return plat === "darwin";
}

/** Directory that holds `app.asar` (Contents/Resources on mac, resources elsewhere). */
export function appResourcesDir(appRoot: string, plat: Plat): string {
  return isMac(plat) ? join(appRoot, "Contents", "Resources") : join(appRoot, "resources");
}

export function appAsarPath(appRoot: string, plat: Plat): string {
  return join(appResourcesDir(appRoot, plat), "app.asar");
}

/** Info.plist path (macOS only; null elsewhere). */
export function appMetaPath(appRoot: string, plat: Plat): string | null {
  return isMac(plat) ? join(appRoot, "Contents", "Info.plist") : null;
}

// Frameworks that are NOT the Electron/Chromium framework (so we don't read
// their fuses by mistake).
const NON_ELECTRON_FRAMEWORK = /^(Sparkle|Squirrel|Mantle|ReactiveObjC|ReactiveCocoa|Crashpad)/i;

/**
 * Ordered candidate paths for the Electron binary whose fuses we read/flip.
 * The caller picks the first that exists (falling back to the first candidate).
 *
 * On macOS the framework is often RENAMED to "<Product> Framework" (e.g. Codex
 * ships "Codex Framework.framework") and versioned under Versions/Current (a
 * Chromium-version dir), not Versions/A. Pass the actual `.framework` dir names
 * (from reading Contents/Frameworks) so we target the right one via its
 * top-level symlink, which resolves regardless of the Versions/ layout.
 */
export function electronBinaryCandidates(
  appRoot: string,
  plat: Plat,
  name: string,
  frameworks: string[] = [],
): string[] {
  if (isMac(plat)) {
    const contents = join(appRoot, "Contents");
    const fwRoot = join(contents, "Frameworks");
    const fws = frameworks
      .filter((f) => f.endsWith("Framework.framework") && !NON_ELECTRON_FRAMEWORK.test(f))
      .sort((a, b) => frameworkRank(a, name) - frameworkRank(b, name));

    const out: string[] = [];
    for (const f of fws) {
      const bin = f.replace(/\.framework$/, "");
      out.push(join(fwRoot, f, bin)); // top-level symlink (works for Versions/A or /Current)
      out.push(join(fwRoot, f, "Versions", "Current", bin));
      out.push(join(fwRoot, f, "Versions", "A", bin));
    }
    // Hardcoded fallbacks if the Frameworks dir couldn't be read.
    out.push(join(fwRoot, "Electron Framework.framework", "Electron Framework"));
    out.push(join(fwRoot, "Electron Framework.framework", "Versions", "A", "Electron Framework"));
    out.push(join(contents, "MacOS", name));
    out.push(join(contents, "MacOS", "Electron"));
    return out;
  }
  if (plat === "win32") {
    return [join(appRoot, `${name}.exe`), join(appRoot, "Electron.exe")];
  }
  // linux: the launcher binary sits in the app root, usually lowercased.
  return [join(appRoot, name.toLowerCase()), join(appRoot, name), join(appRoot, "electron")];
}

/** Prefer "<name> Framework", then "Electron Framework", then any other. */
function frameworkRank(fw: string, name: string): number {
  if (fw === `${name} Framework.framework`) return 0;
  if (fw === "Electron Framework.framework") return 1;
  return 2;
}

/**
 * OS-appropriate guidance when modifying an app bundle is blocked (EPERM/EACCES).
 * macOS hits App Management; Windows needs elevation for Program Files; Linux
 * needs ownership/root for /opt.
 */
export function permissionHint(plat: Plat, target: string): string {
  if (isMac(plat)) {
    return (
      `macOS App Management is blocking modification of ${target}.\n` +
      `Run this command with sudo, or grant your terminal Full Disk Access in System Settings.`
    );
  }
  if (plat === "win32") {
    return (
      `Windows blocked modification of ${target} (apps under Program Files need elevation).\n` +
      `Run the terminal as Administrator, or use a per-user install (e.g. under %LOCALAPPDATA%).`
    );
  }
  return (
    `Permission denied modifying ${target}.\n` +
    `Run with sudo, or ensure you own the install dir (apps under /opt require root).`
  );
}

/** Linux AppImages (single-file, read-only) can't be patched in place. */
export function isAppImage(p: string): boolean {
  return /\.appimage$/i.test(p);
}
