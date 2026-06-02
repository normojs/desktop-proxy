import { describe, it, expect } from "vitest";

import { compareVersions, satisfiesMinVersion } from "../src/index";

describe("compareVersions", () => {
  it("orders versions numerically (not lexically)", () => {
    expect(compareVersions("0.2.0", "0.10.0")).toBe(-1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("2.0.0", "1.9.9")).toBe(1);
  });

  it("normalizes leading v and pre-release/build metadata", () => {
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.3-beta", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.3+build.5", "1.2.3")).toBe(0);
  });

  it("handles differing segment counts", () => {
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1.2.1", "1.2")).toBe(1);
  });
});

describe("satisfiesMinVersion", () => {
  it("passes when no minimum is set", () => {
    expect(satisfiesMinVersion("0.1.0", undefined)).toBe(true);
  });

  it("passes when version >= min", () => {
    expect(satisfiesMinVersion("0.1.0", "0.1.0")).toBe(true);
    expect(satisfiesMinVersion("1.0.0", "0.9.0")).toBe(true);
  });

  it("fails when version < min", () => {
    expect(satisfiesMinVersion("0.1.0", "0.2.0")).toBe(false);
    expect(satisfiesMinVersion("0.9.0", "1.0.0")).toBe(false);
  });
});
