import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readFuses, writeFuse, FuseV1 } from "../src/fuses";

// Mirrors the sentinel in src/fuses.ts (not exported).
const SENTINEL = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX", "ascii");

/** Build a synthetic Electron binary with the fuse wire format. */
function makeBinary(fuseChars: string): Buffer {
  const count = fuseChars.length;
  return Buffer.concat([
    Buffer.from("....some preceding bytes...."),
    SENTINEL,
    Buffer.from([0x01, count]), // schema v1, fuse count
    Buffer.from(fuseChars, "ascii"), // each char is '0'..'3'
    Buffer.from("....trailing bytes...."),
  ]);
}

let dir: string;
let bin: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dp-fuse-"));
  bin = join(dir, "Electron Framework");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readFuses", () => {
  it("decodes schema, count, and fuse states", () => {
    writeFileSync(bin, makeBinary("011010010"));
    const snap = readFuses(bin);
    expect(snap.schemaVersion).toBe(1);
    expect(snap.count).toBe(9);
    expect(snap.fuses[0]).toBe("off"); // '0'
    expect(snap.fuses[1]).toBe("on"); // '1'
  });

  it("throws when the sentinel is missing", () => {
    writeFileSync(bin, Buffer.from("no sentinel in here at all"));
    expect(() => readFuses(bin)).toThrow();
  });

  it("throws on an unsupported schema version", () => {
    const buf = Buffer.concat([SENTINEL, Buffer.from([0x02, 1, 0x30])]);
    writeFileSync(bin, buf);
    expect(() => readFuses(bin)).toThrow();
  });
});

describe("writeFuse", () => {
  it("flips a fuse byte and reads it back", () => {
    writeFileSync(bin, makeBinary("011111111"));
    const idx = FuseV1.EnableEmbeddedAsarIntegrityValidation;
    expect(readFuses(bin).fuses[idx]).toBe("on");

    const result = writeFuse(bin, "EnableEmbeddedAsarIntegrityValidation", "off");
    expect(result.from).toBe("on");
    expect(result.to).toBe("off");
    expect(readFuses(bin).fuses[idx]).toBe("off");
  });

  it("is a no-op when already at the requested value", () => {
    writeFileSync(bin, makeBinary("000000000"));
    const result = writeFuse(bin, "RunAsNode", "off");
    expect(result.from).toBe("off");
    expect(result.to).toBe("off");
  });

  it("throws when the fuse index exceeds the count", () => {
    writeFileSync(bin, makeBinary("011")); // only 3 fuses
    expect(() => writeFuse(bin, "GrantFileProtocolExtraPrivileges", "on")).toThrow();
  });
});
