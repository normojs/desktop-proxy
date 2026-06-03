import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { getBackend, DEFAULT_BACKEND, isBackendName } from "../src/backends/index";
import type { BackendContext } from "../src/backends/index";
import type { CodexInstall } from "../src/platform";

function fakeInstall(asarPath: string): CodexInstall {
  return {
    platform: "darwin",
    appName: "X",
    appRoot: "/Applications/X.app",
    asarPath,
    metaPath: null,
    electronBinary: "",
    channel: "stable",
    bundleId: null,
  } as unknown as CodexInstall;
}

describe("backend registry", () => {
  it("defaults to asar", () => {
    expect(DEFAULT_BACKEND).toBe("asar");
    expect(getBackend().name).toBe("asar");
  });

  it("returns the named backends", () => {
    expect(getBackend("asar").name).toBe("asar");
    expect(getBackend("dyld").name).toBe("dyld");
  });

  it("throws on an unknown backend", () => {
    expect(() => getBackend("nope" as never)).toThrow(/unknown injection backend/);
  });

  it("validates backend names", () => {
    expect(isBackendName("asar")).toBe(true);
    expect(isBackendName("dyld")).toBe(true);
    expect(isBackendName("proxy")).toBe(false);
  });
});

describe("asar backend", () => {
  it("is supported when app.asar exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "dp-be-"));
    const asar = join(dir, "app.asar");
    writeFileSync(asar, "x");
    try {
      expect(getBackend("asar").supported(fakeInstall(asar))).toEqual({ ok: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is unsupported when app.asar is missing", () => {
    const r = getBackend("asar").supported(fakeInstall("/no/such/app.asar"));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("not found");
  });

  it("isApplied is false when the asar can't be read", () => {
    expect(getBackend("asar").isApplied(fakeInstall("/no/such/app.asar"))).toBe(false);
  });
});

describe("dyld backend (placeholder)", () => {
  it("reports itself unimplemented via supported()", () => {
    const r = getBackend("dyld").supported(fakeInstall("/x"));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not implemented/i);
  });

  it("apply rejects and revert throws", async () => {
    await expect(getBackend("dyld").apply({} as unknown as BackendContext)).rejects.toThrow();
    expect(() => getBackend("dyld").revert({} as unknown as BackendContext)).toThrow();
  });
});
