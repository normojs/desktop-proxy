/**
 * Auto-repair watcher — re-applies the patch when the target app updates.
 *
 * Cross-platform: launchd (macOS, real-time), systemd user .path unit (Linux,
 * real-time), Task Scheduler logon task (Windows, applies at next logon). The
 * file/argument generation lives in ../watcher.ts (unit tested); this drives the
 * platform tool (launchctl / systemctl / schtasks).
 */

import { existsSync, mkdirSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir, platform } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { locateApp } from "../platform.js";
import {
  buildLaunchdPlist,
  buildSystemdService,
  buildSystemdPath,
  buildWindowsTaskCreateArgs,
  launchdPlistPath,
  systemdUnitPaths,
  UNIT_NAME,
  MAC_LABEL,
  type WatcherSpec,
} from "../watcher.js";

const here = dirname(fileURLToPath(import.meta.url));

function buildSpec(appRoot: string): WatcherSpec {
  const cliJs = resolve(here, "..", "cli.js");
  const logDir = join(homedir(), ".desktop-proxy", "log");
  mkdirSync(logDir, { recursive: true });
  const codex = locateApp(appRoot);
  return {
    repairArgs: [process.execPath, cliJs, "repair", "--if-needed", "--app", codex.appRoot, "--quiet"],
    asarPath: codex.asarPath,
    watchDir: codex.resourcesDir,
    logFile: join(logDir, "watcher.log"),
  };
}

function out(json: boolean, payload: Record<string, unknown>, human: () => void): void {
  if (json) console.log(JSON.stringify(payload));
  else human();
}

export function installWatcher(opts: { app?: string; json?: boolean } = {}): void {
  const json = opts.json ?? false;
  const plat = platform();

  let spec: WatcherSpec;
  try {
    spec = buildSpec(opts.app ?? "");
  } catch (e) {
    out(json, { error: (e as Error).message }, () => console.error(`\n  ${(e as Error).message}\n`));
    process.exit(1);
    return;
  }

  if (plat === "darwin") {
    const plist = launchdPlistPath();
    mkdirSync(dirname(plist), { recursive: true });
    writeFileSync(plist, buildLaunchdPlist(spec));
    spawnSync("launchctl", ["unload", plist], { stdio: "ignore" });
    const loaded = spawnSync("launchctl", ["load", "-w", plist], { encoding: "utf8" });
    if (loaded.status !== 0) {
      const err = `launchctl load failed: ${(loaded.stderr || loaded.stdout || "").trim()}`;
      out(json, { error: err }, () => console.error(`\n  ${err}\n`));
      process.exit(1);
      return;
    }
    out(json, { ok: true, label: MAC_LABEL, plist, watch: spec.watchDir }, () => {
      console.log(`\n  Auto-repair watcher installed (launchd).`);
      console.log(`  Watches: ${spec.watchDir}\n`);
    });
    return;
  }

  if (plat === "linux") {
    const units = systemdUnitPaths();
    mkdirSync(dirname(units.service), { recursive: true });
    writeFileSync(units.service, buildSystemdService(spec));
    writeFileSync(units.path, buildSystemdPath(spec));
    spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
    const enabled = spawnSync("systemctl", ["--user", "enable", "--now", `${UNIT_NAME}.path`], { encoding: "utf8" });
    if (enabled.status !== 0) {
      const err = `systemctl enable failed: ${(enabled.stderr || enabled.stdout || "").trim()}`;
      out(json, { error: err, units }, () => {
        console.error(`\n  ${err}`);
        console.error(`  Units written to ${units.service} / ${units.path}; enable manually if needed.\n`);
      });
      process.exit(1);
      return;
    }
    out(json, { ok: true, units, watch: spec.asarPath }, () => {
      console.log(`\n  Auto-repair watcher installed (systemd user .path).`);
      console.log(`  Watches: ${spec.asarPath}\n`);
    });
    return;
  }

  if (plat === "win32") {
    const created = spawnSync("schtasks", buildWindowsTaskCreateArgs(spec), { encoding: "utf8" });
    if (created.status !== 0) {
      const err = `schtasks create failed: ${(created.stderr || created.stdout || "").trim()}`;
      out(json, { error: err }, () => console.error(`\n  ${err}\n`));
      process.exit(1);
      return;
    }
    out(json, { ok: true, task: UNIT_NAME }, () => {
      console.log(`\n  Auto-repair task installed (Task Scheduler, on logon).`);
      console.log(`  Note: re-applies at next logon (no real-time file trigger on Windows).\n`);
    });
    return;
  }

  out(json, { error: `unsupported platform: ${plat}` }, () => console.error(`\n  unsupported platform: ${plat}\n`));
  process.exit(1);
}

export function uninstallWatcher(opts: { json?: boolean; quiet?: boolean } = {}): void {
  const json = opts.json ?? false;
  const plat = platform();

  if (plat === "darwin") {
    const plist = launchdPlistPath();
    spawnSync("launchctl", ["unload", "-w", plist], { stdio: "ignore" });
    try { unlinkSync(plist); } catch { /* gone */ }
  } else if (plat === "linux") {
    spawnSync("systemctl", ["--user", "disable", "--now", `${UNIT_NAME}.path`], { stdio: "ignore" });
    const units = systemdUnitPaths();
    try { rmSync(units.service, { force: true }); } catch { /* gone */ }
    try { rmSync(units.path, { force: true }); } catch { /* gone */ }
    spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
  } else if (plat === "win32") {
    spawnSync("schtasks", ["/Delete", "/TN", UNIT_NAME, "/F"], { stdio: "ignore" });
  }

  if (json) console.log(JSON.stringify({ ok: true }));
  else if (!opts.quiet) console.log(`\n  Auto-repair watcher removed.\n`);
}

export function watcherStatus(opts: { json?: boolean } = {}): void {
  const json = opts.json ?? false;
  const plat = platform();
  let installed = false;
  let loaded = false;
  let detail = "";

  if (plat === "darwin") {
    const plist = launchdPlistPath();
    installed = existsSync(plist);
    loaded = (spawnSync("launchctl", ["list"], { encoding: "utf8" }).stdout ?? "").includes(MAC_LABEL);
    detail = plist;
  } else if (plat === "linux") {
    const units = systemdUnitPaths();
    installed = existsSync(units.path);
    loaded = (spawnSync("systemctl", ["--user", "is-active", `${UNIT_NAME}.path`], { encoding: "utf8" }).stdout ?? "")
      .trim()
      .startsWith("active");
    detail = units.path;
  } else if (plat === "win32") {
    const q = spawnSync("schtasks", ["/Query", "/TN", UNIT_NAME], { encoding: "utf8" });
    installed = q.status === 0;
    loaded = installed;
    detail = UNIT_NAME;
  }

  if (json) {
    console.log(JSON.stringify({ installed, loaded, detail, platform: plat }));
    return;
  }
  const state = installed ? (loaded ? "installed (active)" : "installed (inactive)") : "not installed";
  console.log(`\n  Auto-repair watcher: ${state}`);
  console.log(`  ${detail}\n`);
}
