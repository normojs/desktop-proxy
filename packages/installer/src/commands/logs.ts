/**
 * Logs command — view the framework's runtime log (`~/.desktop-proxy/log/main.log`).
 */

import {
  existsSync,
  readFileSync,
  statSync,
  watch,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface LogsOptions {
  follow?: boolean;
  lines?: number;
}

export function logs(opts: LogsOptions = {}): void {
  const file = join(homedir(), ".desktop-proxy", "log", "main.log");

  if (!existsSync(file)) {
    console.log(`\n  No log file yet at ${file}`);
    console.log(`  Launch a patched app to generate logs.\n`);
    return;
  }

  const tailLines = opts.lines ?? 200;
  const content = readFileSync(file, "utf8");
  const split = content.split("\n");
  process.stdout.write(split.slice(-tailLines).join("\n"));
  if (!content.endsWith("\n")) process.stdout.write("\n");

  if (!opts.follow) return;

  // Follow mode: stream appended bytes as the file grows.
  let offset = statSync(file).size;
  console.error(`\n[following ${file} — Ctrl+C to stop]\n`);
  watch(file, () => {
    try {
      const size = statSync(file).size;
      if (size < offset) offset = 0; // truncated or rotated
      if (size > offset) {
        const fd = openSync(file, "r");
        const buf = Buffer.alloc(size - offset);
        readSync(fd, buf, 0, size - offset, offset);
        closeSync(fd);
        process.stdout.write(buf.toString("utf8"));
        offset = size;
      }
    } catch {
      // ignore transient read errors
    }
  });
  // Keep the process alive while following.
  setInterval(() => {}, 1 << 30);
}
