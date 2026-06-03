import { describe, it, expect } from "vitest";

import { postInject } from "../src/os/post-inject.js";
import type { CodexInstall } from "../src/platform.js";

function install(platform: string): CodexInstall {
  return {
    platform,
    appName: "X",
    appRoot: "/x",
    executable: "/x",
    resourcesDir: "/x",
    asarPath: "/x/app.asar",
    metaPath: null,
    electronBinary: "/x/e",
    channel: "stable",
    bundleId: null,
  } as CodexInstall;
}

const ctx = { userRoot: "/tmp", entitlements: [] as string[], sudo: false, log: () => {} };

describe("postInject", () => {
  it("is a no-op on Windows and Linux (no signature wall)", () => {
    expect(postInject(install("win32"), ctx).resigned).toBe(false);
    expect(postInject(install("linux"), ctx).resigned).toBe(false);
  });

  it("skips when noResign is set, even on macOS", () => {
    expect(postInject(install("darwin"), { ...ctx, noResign: true }).resigned).toBe(false);
  });
});
