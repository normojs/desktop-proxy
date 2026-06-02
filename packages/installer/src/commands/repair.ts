/**
 * Repair command — re-applies patches after an app update.
 */

import { join } from "node:path";
import { homedir } from "node:os";

import { install } from "./install.js";

export async function repair(opts: { app?: string; quiet?: boolean } = {}): Promise<void> {
  console.log("\ndesktop-proxy repair\n");
  console.log("  Re-applying patches...\n");

  await install({
    app: opts.app,
    quiet: opts.quiet,
  });
}
