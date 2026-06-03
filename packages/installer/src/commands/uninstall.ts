/**
 * Uninstall command — restores the app via the backend recorded in state.json.
 */

import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { locateApp } from "../platform.js";
import { signAppBundle, clearQuarantine } from "../codesign.js";
import { uninstallWatcher } from "./watch.js";
import { getBackend, DEFAULT_BACKEND, isBackendName, type BackendContext, type BackendName } from "../backends/index.js";

function readBackendName(userRoot: string): BackendName {
  try {
    const state = JSON.parse(readFileSync(join(userRoot, "state.json"), "utf8"));
    if (typeof state.backend === "string" && isBackendName(state.backend)) return state.backend;
  } catch {
    // no/invalid state → assume the historical default
  }
  return DEFAULT_BACKEND;
}

export function uninstall(quiet = false): void {
  const log = quiet ? () => {} : (msg: string) => console.log(`  ${msg}`);

  try {
    const codex = locateApp();
    const userRoot = join(homedir(), ".desktop-proxy");
    const backupDir = join(userRoot, "backup");
    const backend = getBackend(readBackendName(userRoot));

    // Remove the auto-repair watcher first, so it can't re-apply mid-uninstall.
    try {
      uninstallWatcher({ quiet: true });
    } catch {
      // best-effort
    }

    const ctx: BackendContext = {
      install: codex,
      userRoot,
      runtimeDir: join(userRoot, "runtime"),
      backupDir,
      log,
    };
    backend.revert(ctx);

    // Re-sign on macOS (shared) after restoring files.
    if (codex.platform === "darwin") {
      clearQuarantine(codex.appRoot);
      try {
        signAppBundle(codex.appRoot);
        log("Re-signed app bundle");
      } catch {
        // best-effort
      }
    }

    // Remove install state so status/doctor no longer report "installed".
    try {
      rmSync(join(userRoot, "state.json"), { force: true });
    } catch {
      // best-effort
    }

    console.log(`\n  ✓ desktop-proxy uninstalled from ${codex.appName} (backend: ${backend.name}).`);
    console.log(`\n  User data is preserved at ${userRoot}.`);
    console.log(`  To remove it: rm -rf ${userRoot}`);
  } catch (e) {
    console.error("  Error:", (e as Error).message);
    process.exit(1);
  }
}
