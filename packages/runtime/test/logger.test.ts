import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLogger, parseLevel } from "../src/logger";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dp-log-"));
  file = join(dir, "main.log");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("parseLevel", () => {
  it("parses known levels (case-insensitive)", () => {
    expect(parseLevel("debug", "info")).toBe("debug");
    expect(parseLevel("WARN", "info")).toBe("warn");
    expect(parseLevel("silent", "info")).toBe("silent");
  });

  it("falls back for missing or unknown input", () => {
    expect(parseLevel(undefined, "info")).toBe("info");
    expect(parseLevel("bogus", "warn")).toBe("warn");
  });
});

describe("createLogger", () => {
  it("filters messages below the threshold", () => {
    const log = createLogger({ file, level: "warn" });
    log.debug("d-msg");
    log.info("i-msg");
    log.warn("w-msg");
    log.error("e-msg");

    const out = readFileSync(file, "utf8");
    expect(out).not.toContain("[debug]");
    expect(out).not.toContain("[info]");
    expect(out).toContain("w-msg");
    expect(out).toContain("e-msg");
  });

  it("isEnabled reflects the threshold", () => {
    const log = createLogger({ file, level: "info" });
    expect(log.isEnabled("debug")).toBe(false);
    expect(log.isEnabled("info")).toBe(true);
    expect(log.isEnabled("error")).toBe(true);
  });

  it("setLevel changes filtering at runtime", () => {
    const log = createLogger({ file, level: "error" });
    log.info("suppressed");
    log.setLevel("debug");
    log.info("emitted");

    const out = readFileSync(file, "utf8");
    expect(out).not.toContain("suppressed");
    expect(out).toContain("emitted");
  });

  it("child loggers add a namespace tag and share the level", () => {
    const log = createLogger({ file, level: "debug" });
    const child = log.child("network");
    child.info("hello");
    expect(readFileSync(file, "utf8")).toContain("[network]");

    log.setLevel("silent");
    child.warn("after-silent");
    expect(readFileSync(file, "utf8")).not.toContain("after-silent");
  });

  it("serializes non-string args as JSON", () => {
    const log = createLogger({ file, level: "debug" });
    log.info("obj", { a: 1 });
    expect(readFileSync(file, "utf8")).toContain('{"a":1}');
  });

  it("caps the log file size", () => {
    const log = createLogger({ file, level: "debug", capBytes: 256 });
    for (let i = 0; i < 200; i++) log.info("x".repeat(60));
    const size = readFileSync(file).byteLength;
    expect(size).toBeLessThanOrEqual(256);
  });
});
