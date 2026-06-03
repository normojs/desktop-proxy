import { describe, it, expect } from "vitest";

import {
  privacyPanes,
  privacyPaneUrl,
  rootPrivacyUrl,
  permissionsNote,
  openerCommand,
} from "../src/permissions";

describe("privacyPanes", () => {
  it("lists macOS TCC panes", () => {
    const ids = privacyPanes("darwin").map((p) => p.id);
    expect(ids).toContain("screen-recording");
    expect(ids).toContain("full-disk");
    expect(ids).toContain("microphone");
    // mic/camera re-prompt in-app; screen recording is manual
    expect(privacyPanes("darwin").find((p) => p.id === "microphone")?.manual).toBe(false);
    expect(privacyPanes("darwin").find((p) => p.id === "screen-recording")?.manual).toBe(true);
  });

  it("lists a minimal set on Windows and nothing on Linux", () => {
    expect(privacyPanes("win32").map((p) => p.id)).toContain("microphone");
    expect(privacyPanes("linux")).toEqual([]);
  });
});

describe("privacyPaneUrl", () => {
  it("returns the deep link for a known pane", () => {
    expect(privacyPaneUrl("darwin", "screen-recording")).toBe(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    );
    expect(privacyPaneUrl("win32", "camera")).toBe("ms-settings:privacy-webcam");
  });
  it("returns null for unknown panes", () => {
    expect(privacyPaneUrl("darwin", "nope")).toBeNull();
    expect(privacyPaneUrl("linux", "microphone")).toBeNull();
  });
});

describe("rootPrivacyUrl", () => {
  it("points at the privacy root per platform", () => {
    expect(rootPrivacyUrl("darwin")).toBe("x-apple.systempreferences:com.apple.preference.security?Privacy");
    expect(rootPrivacyUrl("win32")).toBe("ms-settings:privacy");
    expect(rootPrivacyUrl("linux")).toBeNull();
  });
});

describe("permissionsNote", () => {
  it("explains the macOS one-time re-grant", () => {
    expect(permissionsNote("darwin")).toMatch(/re-granted ONCE/);
    expect(permissionsNote("darwin")).toMatch(/stable local certificate/);
  });
  it("notes Windows does not reset permissions", () => {
    expect(permissionsNote("win32")).toMatch(/does NOT reset/);
  });
  it("notes Linux has no per-app permissions", () => {
    expect(permissionsNote("linux")).toMatch(/no per-app permission/);
  });
});

describe("openerCommand", () => {
  it("maps each platform to its opener", () => {
    expect(openerCommand("darwin")).toMatchObject({ cmd: "open" });
    expect(openerCommand("darwin")?.args("u")).toEqual(["u"]);
    expect(openerCommand("win32")?.args("u")).toEqual(["/c", "start", "", "u"]);
    expect(openerCommand("linux")).toMatchObject({ cmd: "xdg-open" });
    expect(openerCommand("aix")).toBeNull();
  });
});
