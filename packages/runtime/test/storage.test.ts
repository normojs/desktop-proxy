import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createPluginStorage } from "../src/storage";

describe("createPluginStorage", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-store-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("get/set/delete/all and persists across instances", () => {
    const s = createPluginStorage(dir);
    expect(s.get("p1", "k", "def")).toBe("def");
    s.set("p1", "k", { a: 1 });
    expect(s.get("p1", "k")).toEqual({ a: 1 });
    expect(s.all("p1")).toEqual({ k: { a: 1 } });

    // A fresh instance reads the persisted file.
    expect(createPluginStorage(dir).get("p1", "k")).toEqual({ a: 1 });

    s.delete("p1", "k");
    expect(s.get("p1", "k", "x")).toBe("x");
  });

  it("isolates plugins and sanitizes ids into safe filenames", () => {
    const s = createPluginStorage(dir);
    s.set("a/b", "k", 1);
    s.set("com.foo.bar", "k", 2);
    expect(s.get("a/b", "k")).toBe(1);
    expect(s.get("com.foo.bar", "k")).toBe(2);
    expect(fs.existsSync(path.join(dir, "plugin-a_b.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "plugin-com.foo.bar.json"))).toBe(true);
  });

  it("all() returns a copy (not the live cache)", () => {
    const s = createPluginStorage(dir);
    s.set("p", "k", 1);
    const snap = s.all("p");
    snap.k = 999;
    expect(s.get("p", "k")).toBe(1);
  });
});
