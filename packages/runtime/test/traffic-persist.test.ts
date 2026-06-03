import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createTrafficWriter } from "../src/net/traffic-persist";

describe("createTrafficWriter", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-traffic-"));
    file = path.join(dir, "traffic.ndjson");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("appends one JSON line per entry", () => {
    const w = createTrafficWriter(file);
    w.write({ id: "1", url: "https://a" });
    w.write({ id: "2", url: "https://b" });
    w.close();
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({ id: "1" });
    expect(JSON.parse(lines[1])).toMatchObject({ id: "2" });
  });

  it("rotates to <file>.1 when the size cap is exceeded", () => {
    const w = createTrafficWriter(file, 200); // tiny cap to force rotation
    for (let i = 0; i < 20; i++) w.write({ i, pad: "x".repeat(40) });
    w.close();
    expect(fs.existsSync(`${file}.1`)).toBe(true);
    // Current file holds only the lines written after the last rotation.
    expect(fs.statSync(file).size).toBeLessThanOrEqual(200 + 80);
  });
});
