/**
 * Auto-repair watcher (macOS).
 *
 * Target apps usually wipe our patch when they auto-update. We install a launchd
 * LaunchAgent with WatchPaths on the app's Resources directory; whenever
 * `app.asar` changes, launchd runs `desktop-proxy repair --if-needed`, which
 * re-applies the patch only if it is missing (so it does not loop on our own
 * re-patch).
 */

import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir, platform } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { locateApp } from "../platform.js";

const LABEL = "com.desktop-proxy.watcher";
const here = dirname(fileURLToPath(import.meta.url));

function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function requireMac(json: boolean): boolean {
  if (platform() === "darwin") return true;
  const msg = "the auto-repair watcher is macOS-only (uses launchd)";
  if (json) console.log(JSON.stringify({ error: msg }));
  else console.error(`\n  ${msg}\n`);
  return false;
}

export function installWatcher(opts: { app?: string; json?: boolean } = {}): void {
  const json = opts.json ?? false;
  if (!requireMac(json)) return;

  const codex = locateApp(opts.app);
  const cliJs = resolve(here, "..", "cli.js");
  const logDir = join(homedir(), ".desktop-proxy", "log");
  mkdirSync(logDir, { recursive: true });
  const watchDir = join(codex.appRoot, "Contents", "Resources");
  const logFile = join(logDir, "watcher.log");
  const plist = plistPath();
  mkdirSync(dirname(plist), { recursive: true });

  const args = [process.execPath, cliJs, "repair", "--if-needed", "--app", codex.appRoot, "--quiet"];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xmlEscape(a)}</string>`).join("\n")}
  </array>
  <key>WatchPaths</key>
  <array><string>${xmlEscape(watchDir)}</string></array>
  <key>RunAtLoad</key><true/>
  <key>StandardErrorPath</key><string>${xmlEscape(logFile)}</string>
  <key>StandardOutPath</key><string>${xmlEscape(logFile)}</string>
</dict>
</plist>
`;
  writeFileSync(plist, xml);

  spawnSync("launchctl", ["unload", plist], { stdio: "ignore" });
  const loaded = spawnSync("launchctl", ["load", "-w", plist], { encoding: "utf8" });
  if (loaded.status !== 0) {
    const err = `launchctl load failed: ${(loaded.stderr || loaded.stdout || "").trim()}`;
    if (json) console.log(JSON.stringify({ error: err }));
    else console.error(`\n  ${err}\n`);
    process.exit(1);
  }

  if (json) {
    console.log(JSON.stringify({ ok: true, label: LABEL, plist, watch: watchDir }));
  } else {
    console.log(`\n  Auto-repair watcher installed.`);
    console.log(`  Watches: ${watchDir}`);
    console.log(`  Re-applies the patch automatically when ${codex.appName} updates.\n`);
  }
}

export function uninstallWatcher(opts: { json?: boolean } = {}): void {
  const json = opts.json ?? false;
  if (!requireMac(json)) return;
  const plist = plistPath();
  spawnSync("launchctl", ["unload", "-w", plist], { stdio: "ignore" });
  try {
    unlinkSync(plist);
  } catch {
    // already gone
  }
  if (json) console.log(JSON.stringify({ ok: true }));
  else console.log(`\n  Auto-repair watcher removed.\n`);
}

export function watcherStatus(opts: { json?: boolean } = {}): void {
  const json = opts.json ?? false;
  const plist = plistPath();
  const installed = existsSync(plist);
  let loaded = false;
  if (platform() === "darwin") {
    const result = spawnSync("launchctl", ["list"], { encoding: "utf8" });
    loaded = (result.stdout ?? "").includes(LABEL);
  }
  if (json) {
    console.log(JSON.stringify({ installed, loaded, plist }));
    return;
  }
  const state = installed ? (loaded ? "installed (loaded)" : "installed (not loaded)") : "not installed";
  console.log(`\n  Auto-repair watcher: ${state}`);
  console.log(`  Plist: ${plist}\n`);
}
