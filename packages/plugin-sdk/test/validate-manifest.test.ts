import { describe, it, expect } from "vitest";

import { validateManifest } from "../src/index";

const base = {
  id: "com.example.plugin",
  name: "Example",
  version: "1.0.0",
  main: "index.js",
  scope: "renderer",
};

describe("validateManifest", () => {
  it("accepts a minimal valid manifest", () => {
    const result = validateManifest(base);
    expect(result.valid).toBe(true);
  });

  it("rejects non-objects", () => {
    expect(validateManifest(null).valid).toBe(false);
    expect(validateManifest("nope").valid).toBe(false);
    expect(validateManifest(42).valid).toBe(false);
  });

  it("reports each missing required field", () => {
    const result = validateManifest({});
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.length).toBeGreaterThanOrEqual(4);
    }
  });

  it("rejects an invalid scope", () => {
    const result = validateManifest({ ...base, scope: "everywhere" });
    expect(result.valid).toBe(false);
  });

  it("accepts each valid scope", () => {
    for (const scope of ["main", "renderer", "both"]) {
      expect(validateManifest({ ...base, scope }).valid).toBe(true);
    }
  });

  it("validates permissions as a string array when present", () => {
    expect(validateManifest({ ...base, permissions: ["cdp"] }).valid).toBe(true);
    expect(validateManifest({ ...base, permissions: [] }).valid).toBe(true);
    expect(validateManifest({ ...base, permissions: "cdp" }).valid).toBe(false);
    expect(validateManifest({ ...base, permissions: [1, 2] }).valid).toBe(false);
  });
});
