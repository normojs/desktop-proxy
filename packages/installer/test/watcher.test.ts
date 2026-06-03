import { describe, it, expect } from "vitest";
import { join } from "node:path";

import {
  shellJoin,
  buildLaunchdPlist,
  buildSystemdService,
  buildSystemdPath,
  buildWindowsTaskCreateArgs,
  launchdPlistPath,
  systemdUnitPaths,
  MAC_LABEL,
  UNIT_NAME,
  type WatcherSpec,
} from "../src/watcher";

const spec: WatcherSpec = {
  repairArgs: ["/usr/bin/node", "/opt/dp/cli.js", "repair", "--if-needed", "--app", "/Applications/My App.app", "--quiet"],
  asarPath: "/Applications/My App.app/Contents/Resources/app.asar",
  watchDir: "/Applications/My App.app/Contents/Resources",
  logFile: "/home/me/.desktop-proxy/log/watcher.log",
};

describe("shellJoin", () => {
  it("quotes args with whitespace only", () => {
    expect(shellJoin(["a", "b c", "d"])).toBe('a "b c" d');
  });
});

describe("buildLaunchdPlist", () => {
  const xml = buildLaunchdPlist(spec);
  it("has the label, args, watch path and RunAtLoad", () => {
    expect(xml).toContain(`<string>${MAC_LABEL}</string>`);
    expect(xml).toContain("<key>ProgramArguments</key>");
    expect(xml).toContain("<string>repair</string>");
    expect(xml).toContain("<string>/Applications/My App.app/Contents/Resources</string>");
    expect(xml).toContain("<key>RunAtLoad</key><true/>");
  });
});

describe("buildSystemdService / Path", () => {
  it("service is a oneshot running repair", () => {
    const s = buildSystemdService(spec);
    expect(s).toContain("Type=oneshot");
    expect(s).toContain('ExecStart=/usr/bin/node /opt/dp/cli.js repair --if-needed --app "/Applications/My App.app" --quiet');
  });
  it("path watches the asar and triggers the service", () => {
    const p = buildSystemdPath(spec);
    expect(p).toContain("PathModified=/Applications/My App.app/Contents/Resources/app.asar");
    expect(p).toContain(`Unit=${UNIT_NAME}.service`);
    expect(p).toContain("WantedBy=default.target");
  });
});

describe("buildWindowsTaskCreateArgs", () => {
  it("creates a logon-triggered task", () => {
    const args = buildWindowsTaskCreateArgs(spec);
    expect(args).toEqual([
      "/Create",
      "/TN",
      UNIT_NAME,
      "/TR",
      '/usr/bin/node /opt/dp/cli.js repair --if-needed --app "/Applications/My App.app" --quiet',
      "/SC",
      "ONLOGON",
      "/F",
    ]);
  });
});

describe("on-disk locations", () => {
  it("resolves launchd + systemd paths under a given home", () => {
    expect(launchdPlistPath("/home/me")).toBe(join("/home/me", "Library", "LaunchAgents", `${MAC_LABEL}.plist`));
    const units = systemdUnitPaths("/home/me");
    expect(units.service).toBe(join("/home/me", ".config", "systemd", "user", `${UNIT_NAME}.service`));
    expect(units.path).toBe(join("/home/me", ".config", "systemd", "user", `${UNIT_NAME}.path`));
  });
});
