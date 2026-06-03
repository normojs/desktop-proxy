/**
 * Optional traffic persistence — append finalized entries as NDJSON to disk for
 * post-mortem analysis. Size-capped with a single rotated backup (`<file>.1`).
 * Off by default (config `persistTraffic`); enabled only on explicit opt-in
 * since request/response bodies may contain sensitive data.
 */

import fs from "node:fs";

export interface TrafficWriter {
  write(obj: unknown): void;
  close(): void;
}

export function createTrafficWriter(filePath: string, maxBytes = 5_000_000): TrafficWriter {
  let size = 0;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    size = 0;
  }
  let fd: number | null = null;

  function open(): void {
    if (fd == null) fd = fs.openSync(filePath, "a");
  }
  function rotate(): void {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
      fd = null;
    }
    try {
      fs.renameSync(filePath, `${filePath}.1`); // keep one backup (overwrites prior)
    } catch {
      /* nothing to rotate */
    }
    size = 0;
  }

  return {
    write(obj: unknown): void {
      try {
        const line = `${JSON.stringify(obj)}\n`;
        const bytes = Buffer.byteLength(line);
        if (size > 0 && size + bytes > maxBytes) rotate();
        open();
        fs.writeSync(fd as number, line);
        size += bytes;
      } catch {
        /* best effort — never let persistence break capture */
      }
    },
    close(): void {
      if (fd != null) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
        fd = null;
      }
    },
  };
}
