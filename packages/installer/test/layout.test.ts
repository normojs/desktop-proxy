import { describe, it, expect } from "vitest";
import { join } from "node:path";

import { appResourcesDir, appAsarPath, appMetaPath, electronBinaryCandidates, permissionHint, isAppImage } from "../src/layout";

describe("appResourcesDir", () => {
  it("uses Contents/Resources on macOS", () => {
    expect(appResourcesDir("/Applications/X.app", "darwin")).toBe(join("/Applications/X.app", "Contents", "Resources"));
  });
  it("uses lowercase resources on Windows/Linux", () => {
    expect(appResourcesDir("/opt/X", "linux")).toBe(join("/opt/X", "resources"));
    expect(appResourcesDir("C:/X", "win32")).toBe(join("C:/X", "resources"));
  });
});

describe("appAsarPath", () => {
  it("locates app.asar per platform", () => {
    expect(appAsarPath("/Applications/X.app", "darwin")).toBe(join("/Applications/X.app", "Contents", "Resources", "app.asar"));
    expect(appAsarPath("/opt/X", "linux")).toBe(join("/opt/X", "resources", "app.asar"));
  });
});

describe("appMetaPath", () => {
  it("is Info.plist on macOS, null elsewhere", () => {
    expect(appMetaPath("/Applications/X.app", "darwin")).toBe(join("/Applications/X.app", "Contents", "Info.plist"));
    expect(appMetaPath("/opt/X", "linux")).toBeNull();
    expect(appMetaPath("C:/X", "win32")).toBeNull();
  });
});

describe("electronBinaryCandidates", () => {
  it("targets a renamed framework via its top-level symlink (Codex)", () => {
    const c = electronBinaryCandidates("/Applications/Codex.app", "darwin", "Codex", [
      "Codex Framework.framework",
      "Sparkle.framework",
    ]);
    expect(c[0]).toBe(
      join("/Applications/Codex.app", "Contents", "Frameworks", "Codex Framework.framework", "Codex Framework"),
    );
    // excludes non-Electron frameworks like Sparkle
    expect(c.some((p) => p.includes("Sparkle"))).toBe(false);
    // includes the Versions/Current fallback
    expect(c).toContain(
      join("/Applications/Codex.app", "Contents", "Frameworks", "Codex Framework.framework", "Versions", "Current", "Codex Framework"),
    );
  });
  it("prefers '<name> Framework' over a generic Electron Framework", () => {
    const c = electronBinaryCandidates("/A/X.app", "darwin", "Cursor", [
      "Electron Framework.framework",
      "Cursor Framework.framework",
    ]);
    expect(c[0]).toContain(join("Cursor Framework.framework", "Cursor Framework"));
  });
  it("falls back to the hardcoded Electron Framework when none are listed", () => {
    const c = electronBinaryCandidates("/A/X.app", "darwin", "X");
    expect(c[0]).toBe(join("/A/X.app", "Contents", "Frameworks", "Electron Framework.framework", "Electron Framework"));
  });
  it("uses <Name>.exe on Windows", () => {
    expect(electronBinaryCandidates("C:/X", "win32", "Cursor")[0]).toBe(join("C:/X", "Cursor.exe"));
  });
  it("uses the lowercased launcher on Linux", () => {
    expect(electronBinaryCandidates("/opt/X", "linux", "Cursor")[0]).toBe(join("/opt/X", "cursor"));
  });
});

describe("permissionHint", () => {
  it("gives OS-specific guidance", () => {
    expect(permissionHint("darwin", "/Applications/X.app")).toMatch(/App Management|Full Disk Access/);
    expect(permissionHint("win32", "C:/Program Files/X")).toMatch(/Administrator|Program Files/);
    expect(permissionHint("linux", "/opt/X")).toMatch(/sudo|own the install/);
  });
});

describe("isAppImage", () => {
  it("detects .AppImage paths (case-insensitive)", () => {
    expect(isAppImage("/home/u/Cursor.AppImage")).toBe(true);
    expect(isAppImage("/home/u/Cursor.appimage")).toBe(true);
    expect(isAppImage("/opt/Cursor")).toBe(false);
    expect(isAppImage("/Applications/Cursor.app")).toBe(false);
  });
});
