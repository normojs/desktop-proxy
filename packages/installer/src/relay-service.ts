/**
 * Run the standalone relay daemon as a managed background service (pure generators).
 *
 * Unlike the auto-repair watcher (event-triggered oneshot), this is a long-running
 * process that should auto-start and stay up:
 *   - macOS:   launchd LaunchAgent, RunAtLoad + KeepAlive.
 *   - Linux:   systemd user .service, Restart=always.
 *   - Windows: Task Scheduler logon task (starts the daemon at logon).
 *
 * Only the file/argument generation lives here (unit tested); the launchctl /
 * systemctl / schtasks calls live in commands/relay.ts.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** macOS launchd label. */
export const RELAY_MAC_LABEL = "com.desktop-proxy.relay";
/** Linux systemd unit base name + Windows task name. */
export const RELAY_UNIT_NAME = "desktop-proxy-relay";

export interface RelayServiceSpec {
  /** Full argv to launch the daemon (e.g. [node, relay-daemon.js]). */
  daemonArgs: string[];
  /** Log file for the daemon's stdout/stderr. */
  logFile: string;
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Join argv into a shell command line, quoting args that contain whitespace. */
export function shellJoin(args: readonly string[]): string {
  return args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
}

export function buildRelayLaunchdPlist(spec: RelayServiceSpec): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${RELAY_MAC_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${spec.daemonArgs.map((a) => `    <string>${xmlEscape(a)}</string>`).join("\n")}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>${xmlEscape(spec.logFile)}</string>
  <key>StandardOutPath</key><string>${xmlEscape(spec.logFile)}</string>
</dict>
</plist>
`;
}

export function buildRelaySystemdService(spec: RelayServiceSpec): string {
  return `[Unit]
Description=desktop-proxy model-traffic relay daemon
After=network-online.target

[Service]
Type=simple
ExecStart=${shellJoin(spec.daemonArgs)}
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`;
}

/** `schtasks /Create` args for a logon-triggered relay daemon (Windows). */
export function buildRelayWindowsTaskCreateArgs(spec: RelayServiceSpec): string[] {
  return ["/Create", "/TN", RELAY_UNIT_NAME, "/TR", shellJoin(spec.daemonArgs), "/SC", "ONLOGON", "/F"];
}

// ── on-disk locations ─────────────────────────────────────────────────────────

export function relayLaunchdPlistPath(home = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${RELAY_MAC_LABEL}.plist`);
}

export function relaySystemdServicePath(home = homedir()): string {
  return join(home, ".config", "systemd", "user", `${RELAY_UNIT_NAME}.service`);
}
