/**
 * Auto-repair watcher generators (pure), per platform.
 *
 * Target apps wipe our patch on auto-update; the watcher re-runs
 * `repair --if-needed` when the app's app.asar changes.
 *   - macOS:   launchd LaunchAgent with WatchPaths (real-time).
 *   - Linux:   systemd user .path unit (PathModified) → oneshot .service (real-time).
 *   - Windows: Task Scheduler logon task (re-applies at next logon; Task Scheduler
 *              has no simple file trigger, so this is not real-time).
 *
 * Only the file/argument generation lives here so it can be unit tested; the
 * actual launchctl/systemctl/schtasks calls live in commands/watch.ts.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** macOS launchd label. */
export const MAC_LABEL = "com.desktop-proxy.watcher";
/** Linux systemd unit base name + Windows task name. */
export const UNIT_NAME = "desktop-proxy-repair";

export interface WatcherSpec {
  /** Full argv for the repair invocation. */
  repairArgs: string[];
  /** The app.asar file to watch (Linux PathModified / used for triggers). */
  asarPath: string;
  /** The directory to watch (macOS WatchPaths). */
  watchDir: string;
  /** Log file for watcher output. */
  logFile: string;
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Join argv into a shell command line, quoting args that contain whitespace. */
export function shellJoin(args: readonly string[]): string {
  return args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
}

export function buildLaunchdPlist(spec: WatcherSpec): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${MAC_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${spec.repairArgs.map((a) => `    <string>${xmlEscape(a)}</string>`).join("\n")}
  </array>
  <key>WatchPaths</key>
  <array><string>${xmlEscape(spec.watchDir)}</string></array>
  <key>RunAtLoad</key><true/>
  <key>StandardErrorPath</key><string>${xmlEscape(spec.logFile)}</string>
  <key>StandardOutPath</key><string>${xmlEscape(spec.logFile)}</string>
</dict>
</plist>
`;
}

export function buildSystemdService(spec: WatcherSpec): string {
  return `[Unit]
Description=desktop-proxy auto-repair (oneshot)

[Service]
Type=oneshot
ExecStart=${shellJoin(spec.repairArgs)}
`;
}

export function buildSystemdPath(spec: WatcherSpec): string {
  return `[Unit]
Description=desktop-proxy watch app.asar

[Path]
PathModified=${spec.asarPath}
Unit=${UNIT_NAME}.service

[Install]
WantedBy=default.target
`;
}

/** `schtasks /Create` args for a logon-triggered repair task (Windows). */
export function buildWindowsTaskCreateArgs(spec: WatcherSpec): string[] {
  return ["/Create", "/TN", UNIT_NAME, "/TR", shellJoin(spec.repairArgs), "/SC", "ONLOGON", "/F"];
}

// ── on-disk locations ─────────────────────────────────────────────────────────

export function launchdPlistPath(home = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${MAC_LABEL}.plist`);
}

export function systemdDir(home = homedir()): string {
  return join(home, ".config", "systemd", "user");
}

export function systemdUnitPaths(home = homedir()): { service: string; path: string } {
  const dir = systemdDir(home);
  return { service: join(dir, `${UNIT_NAME}.service`), path: join(dir, `${UNIT_NAME}.path`) };
}
