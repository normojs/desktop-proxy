/**
 * Repair command — re-applies patches after an app update.
 *
 * With `--if-needed` it first checks whether the app.asar is still patched and
 * skips the work if so. This makes it safe to run from the auto-repair watcher
 * (launchd fires on every app.asar change, including our own re-patch).
 */

import { install } from "./install.js";
import { locateApp } from "../platform.js";
import { readFileInAsar } from "../asar.js";

export interface RepairOptions {
  app?: string;
  quiet?: boolean;
  ifNeeded?: boolean;
}

function isPatched(appHint?: string): boolean {
  try {
    const codex = locateApp(appHint);
    const pkg = JSON.parse(readFileInAsar(codex.asarPath, "package.json").toString("utf8"));
    return Boolean(pkg.__desktop_proxy);
  } catch {
    return false;
  }
}

export async function repair(opts: RepairOptions = {}): Promise<void> {
  if (opts.ifNeeded && isPatched(opts.app)) {
    if (!opts.quiet) console.log("desktop-proxy: already patched, nothing to do.");
    return;
  }

  console.log("\ndesktop-proxy repair\n");
  console.log("  Re-applying patches...\n");

  await install({
    app: opts.app,
    quiet: opts.quiet,
  });
}
