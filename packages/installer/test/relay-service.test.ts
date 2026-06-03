import { describe, it, expect } from "vitest";

import {
  buildRelayLaunchdPlist,
  buildRelaySystemdService,
  buildRelayWindowsTaskCreateArgs,
  relayLaunchdPlistPath,
  relaySystemdServicePath,
  shellJoin,
  RELAY_MAC_LABEL,
  RELAY_UNIT_NAME,
  type RelayServiceSpec,
} from "../src/relay-service.js";

const spec: RelayServiceSpec = {
  daemonArgs: ["/usr/bin/node", "/home/me/.desktop-proxy/runtime/relay-daemon.js"],
  logFile: "/home/me/.desktop-proxy/log/relay-daemon.out",
};

describe("relay-service generators", () => {
  it("launchd plist keeps the daemon alive at load", () => {
    const plist = buildRelayLaunchdPlist(spec);
    expect(plist).toContain(`<string>${RELAY_MAC_LABEL}</string>`);
    expect(plist).toContain("<key>RunAtLoad</key><true/>");
    expect(plist).toContain("<key>KeepAlive</key><true/>");
    expect(plist).toContain("relay-daemon.js");
  });

  it("systemd service restarts always", () => {
    const unit = buildRelaySystemdService(spec);
    expect(unit).toContain("Type=simple");
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("ExecStart=/usr/bin/node /home/me/.desktop-proxy/runtime/relay-daemon.js");
    expect(unit).toContain("WantedBy=default.target");
  });

  it("windows task runs at logon", () => {
    const args = buildRelayWindowsTaskCreateArgs(spec);
    expect(args).toContain("/Create");
    expect(args).toContain(RELAY_UNIT_NAME);
    expect(args).toContain("ONLOGON");
  });

  it("shellJoin quotes whitespace args", () => {
    expect(shellJoin(["a", "b c", "d"])).toBe('a "b c" d');
  });

  it("resolves on-disk unit locations under the home dir", () => {
    expect(relayLaunchdPlistPath("/home/me")).toBe(`/home/me/Library/LaunchAgents/${RELAY_MAC_LABEL}.plist`);
    expect(relaySystemdServicePath("/home/me")).toBe(`/home/me/.config/systemd/user/${RELAY_UNIT_NAME}.service`);
  });
});
