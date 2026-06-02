import { describe, it, expect } from "vitest";

import { isLevelEnabled } from "../src/index";

describe("isLevelEnabled", () => {
  it("emits a level at or above the threshold", () => {
    expect(isLevelEnabled("info", "info")).toBe(true);
    expect(isLevelEnabled("warn", "info")).toBe(true);
    expect(isLevelEnabled("error", "warn")).toBe(true);
  });

  it("suppresses a level below the threshold", () => {
    expect(isLevelEnabled("debug", "info")).toBe(false);
    expect(isLevelEnabled("info", "warn")).toBe(false);
    expect(isLevelEnabled("warn", "error")).toBe(false);
  });

  it("suppresses everything when the threshold is silent", () => {
    expect(isLevelEnabled("error", "silent")).toBe(false);
    expect(isLevelEnabled("debug", "silent")).toBe(false);
  });

  it("falls back to info for an unknown threshold", () => {
    expect(isLevelEnabled("debug", "bogus")).toBe(false);
    expect(isLevelEnabled("info", "bogus")).toBe(true);
  });
});
