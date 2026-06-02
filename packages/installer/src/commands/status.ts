/**
 * Status command — shows the current installation state.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { locateApp, type CodexInstall } from "../platform.js";
import { readHeaderHash } from "../asar.js";
import { readFuses } from "../fuses.js";

export function status(): void {
  const userRoot = join(homedir(), ".desktop-proxy");
  const statePath = join(userRoot, "state.json");

  console.log("\ndesktop-proxy status\n");

  // Show state file
  if (existsSync(statePath)) {
    try {
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      console.log(`  Version:      ${state.version || "unknown"}`);
      console.log(`  Installed:    ${state.installedAt || "unknown"}`);
      console.log(`  App:          ${state.appRoot || "unknown"}`);
      console.log(`  Codex Ver:    ${state.codexVersion || "unknown"}`);
      console.log(`  Channel:      ${state.codexChannel || "unknown"}`);
      console.log(`  Fuse Flipped: ${state.fuseFlipped ? "yes" : "no"}`);
      console.log(`  Re-signed:    ${state.resigned ? "yes" : "no"}`);
      console.log();
    } catch {
      console.log("  State file is corrupted.\n");
    }
  } else {
    console.log("  Not installed. Run: desktop-proxy install\n");
    return;
  }

  // Check current state
  try {
    const codex = locateApp();

    // Check if asar is patched
    try {
      const pkg = JSON.parse(
        readFileSync(join(homedir(), ".desktop-proxy", "backup", "app.asar"), "utf8").length + ""
      );
    } catch {}

    const hash = readHeaderHash(codex.asarPath);
    console.log(`  app.asar hash:  ${hash.headerHash.slice(0, 16)}...`);

    // Check fuses
    if (existsSync(codex.electronBinary)) {
      try {
        const fuses = readFuses(codex.electronBinary);
        const integrity = fuses.fuses[4]; // EnableEmbeddedAsarIntegrityValidation
        console.log(`  Integrity fuse: ${integrity}`);
      } catch {
        console.log(`  Integrity fuse: could not read`);
      }
    }

    console.log(`\n  User dir:    ${userRoot}`);
    console.log(`  Plugins:     ${join(userRoot, "plugins")}`);
    console.log(`  Logs:        ${join(userRoot, "log")}`);
    console.log(`  Safe mode:   ${existsSync(join(userRoot, "safe-mode")) ? "ON" : "off"}`);
    console.log();
  } catch (e) {
    console.log(`  Error reading current state: ${(e as Error).message}\n`);
  }
}
