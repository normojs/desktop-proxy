/**
 * Uninstall command — restores the original app.asar from backup.
 */

import { existsSync, cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { locateApp } from "../platform.js";
import { signAppBundle, clearQuarantine } from "../codesign.js";

export function uninstall(quiet = false): void {
  const log = quiet ? () => {} : (msg: string) => console.log(`  ${msg}`);

  try {
    const codex = locateApp();
    const userRoot = join(homedir(), ".desktop-proxy");
    const backupDir = join(userRoot, "backup");

    // Restore app.asar from backup
    const backupAsar = join(backupDir, "app.asar");
    if (existsSync(backupAsar)) {
      cpSync(backupAsar, codex.asarPath);
      log("Restored original app.asar");
    } else {
      console.warn("  Warning: No backup found for app.asar");
    }

    // Restore app.asar.unpacked
    const backupUnpacked = join(backupDir, "app.asar.unpacked");
    if (existsSync(backupUnpacked)) {
      const unpackedDest = `${codex.asarPath}.unpacked`;
      rmSync(unpackedDest, { recursive: true, force: true });
      cpSync(backupUnpacked, unpackedDest, { recursive: true });
      log("Restored app.asar.unpacked");
    }

    // Restore Electron Framework from backup
    const backupFramework = join(backupDir, "Electron Framework");
    if (existsSync(backupFramework) && existsSync(codex.electronBinary)) {
      cpSync(backupFramework, codex.electronBinary);
      log("Restored Electron Framework");
    }

    // Re-sign on macOS
    if (codex.platform === "darwin") {
      clearQuarantine(codex.appRoot);
      try {
        signAppBundle(codex.appRoot);
        log("Re-signed app bundle");
      } catch {
        // ad-hoc sign
      }
    }

    console.log(`\n  ✓ desktop-proxy uninstalled from ${codex.appName}.`);

    // Optionally clean up user data
    console.log(`\n  User data is preserved at ${userRoot}.`);
    console.log(`  To remove it: rm -rf ${userRoot}`);
  } catch (e) {
    console.error("  Error:", (e as Error).message);
    process.exit(1);
  }
}
