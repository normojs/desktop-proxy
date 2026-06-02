import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import {
  pluginDataDir,
  resolveWithin,
  fsRead,
  fsWrite,
  fsExists,
  fsList,
  fsDelete,
  fsMkdir,
  fsStat,
} from "../src/fs-sandbox";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dp-fs-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("pluginDataDir", () => {
  it("keeps the data dir strictly under plugin-data, even for adversarial ids", () => {
    const base = "/users/data";
    const pdRoot = join(base, "plugin-data");
    for (const id of ["com.x/../../y", "..", ".", "...", "", "../../etc", "a/b"]) {
      const p = pluginDataDir(base, id);
      expect(p.startsWith(pdRoot + sep)).toBe(true);
      expect(p).not.toBe(pdRoot);
    }
  });
});

describe("resolveWithin", () => {
  it("allows paths inside the sandbox", () => {
    expect(() => resolveWithin(root, "a/b.txt")).not.toThrow();
    expect(() => resolveWithin(root, ".")).not.toThrow();
  });

  it("rejects path traversal", () => {
    expect(() => resolveWithin(root, "../escape")).toThrow();
    expect(() => resolveWithin(root, "a/../../escape")).toThrow();
    expect(() => resolveWithin(root, "/etc/passwd")).toThrow();
  });
});

describe("filesystem operations", () => {
  it("writes and reads utf8", () => {
    fsWrite(root, "f.txt", "hi");
    expect(fsExists(root, "f.txt")).toBe(true);
    expect(fsRead(root, "f.txt")).toBe("hi");
  });

  it("writes and reads base64 (binary)", () => {
    const b64 = Buffer.from([0, 1, 2, 255]).toString("base64");
    fsWrite(root, "b.bin", b64, "base64");
    expect(fsRead(root, "b.bin", "base64")).toBe(b64);
  });

  it("creates directories, lists, and stats", () => {
    fsMkdir(root, "sub");
    fsWrite(root, "sub/x.txt", "y");
    expect(fsList(root, "sub")).toContain("x.txt");

    const stat = fsStat(root, "sub/x.txt");
    expect(stat.isFile).toBe(true);
    expect(stat.isDirectory).toBe(false);
    expect(stat.size).toBe(1);
  });

  it("deletes a file but refuses to delete the sandbox root", () => {
    fsWrite(root, "d.txt", "z");
    fsDelete(root, "d.txt");
    expect(fsExists(root, "d.txt")).toBe(false);
    expect(() => fsDelete(root, ".")).toThrow();
  });

  it("blocks traversal across operations", () => {
    expect(fsExists(root, "../outside")).toBe(false); // exists swallows the error
    expect(() => fsList(root, "../")).toThrow(); // list rejects the escape
    expect(() => fsRead(root, "../secret")).toThrow();
  });
});
