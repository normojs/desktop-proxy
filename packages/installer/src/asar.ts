/**
 * ASAR (Atom Shell Archive) operations.
 *
 * Extracts, patches, and repacks Electron app.asar archives while preserving
 * the unpacked file set. The integrity hash Electron checks is the SHA-256 of
 * the asar header JSON, not the entire file.
 */

import * as asar from "@electron/asar";
import { createHash } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
  cpSync,
  existsSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface AsarHeaderInfo {
  /** SHA-256 hex of the header JSON bytes */
  headerHash: string;
  /** The decoded header object */
  header: unknown;
}

export function readHeaderHash(asarPath: string): AsarHeaderInfo {
  const raw = (asar as unknown as {
    getRawHeader: (p: string) => {
      header: unknown;
      headerString: string;
      headerSize: number;
    };
  }).getRawHeader(asarPath);
  const hash = createHash("sha256").update(raw.headerString).digest("hex");
  return { headerHash: hash, header: raw.header };
}

/**
 * Extract → mutate → repack an asar archive.
 * Preserves the original unpacked file set exactly.
 */
export async function patchAsar(
  asarPath: string,
  mutate: (extractedDir: string) => Promise<void> | void,
): Promise<AsarHeaderInfo> {
  const work = mkdtempSync(join(tmpdir(), "dp-asar-"));
  const extractDir = join(work, "src");
  const outAsar = join(work, "app.asar");

  const originalUnpackOptions = collectUnpackOptions(asarPath);

  try {
    asar.extractAll(asarPath, extractDir);
    await mutate(extractDir);

    await asar.createPackageWithOptions(extractDir, outAsar, {
      globOptions: { dot: true },
      ...originalUnpackOptions,
    });

    // Atomic-ish replace: write to staging file next to target, then rename.
    const stagingPath = `${asarPath}.dp-new`;
    try {
      cpSync(outAsar, stagingPath);
    } catch (e) {
      throw annotatePermError(e, asarPath);
    }
    try {
      renameSync(stagingPath, asarPath);
    } catch (e) {
      try { unlinkSync(stagingPath); } catch { /* best effort */ }
      throw annotatePermError(e, asarPath);
    }
    return readHeaderHash(asarPath);
  } finally {
    try {
      rmSync(work, { recursive: true, force: true });
    } catch { /* best effort */ }
  }
}

/**
 * Walk the existing asar header and produce compact glob options that
 * preserve exactly what was unpacked.
 */
export function collectUnpackOptions(
  asarPath: string,
): { unpack?: string; unpackDir?: string } {
  const sibling = `${asarPath}.unpacked`;
  if (!existsSync(sibling)) return {};

  const raw = (asar as unknown as {
    getRawHeader: (p: string) => {
      header: { files?: Record<string, unknown> };
    };
  }).getRawHeader(asarPath);

  const covers = unpackCovers(raw.header as Record<string, unknown>, "").covers;
  const dirs = covers
    .filter((c) => c.type === "dir")
    .map((c) => stripLeadingSlash(c.path));
  const files = covers
    .filter((c) => c.type === "file")
    .map((c) => `**/${stripLeadingSlash(c.path)}`);

  return {
    ...(files.length > 0 ? { unpack: bracePattern(files) } : {}),
    ...(dirs.length > 0 ? { unpackDir: bracePattern(dirs) } : {}),
  };
}

interface UnpackCover {
  type: "dir" | "file";
  path: string;
}

function unpackCovers(
  node: Record<string, unknown>,
  prefix: string,
): { total: number; unpacked: number; covers: UnpackCover[] } {
  const files = (node as { files?: Record<string, Record<string, unknown>> })
    .files;
  if (!files) return { total: 0, unpacked: 0, covers: [] };

  let total = 0;
  let unpacked = 0;
  const covers: UnpackCover[] = [];

  for (const [name, val] of Object.entries(files)) {
    const p = `${prefix}/${name}`;
    const isDir = !!(val as { files?: unknown }).files;
    if (isDir) {
      const child = unpackCovers(val, p);
      total += child.total;
      unpacked += child.unpacked;
      covers.push(...child.covers);
      continue;
    }

    total += 1;
    if ((val as { unpacked?: boolean }).unpacked) {
      unpacked += 1;
      covers.push({ type: "file", path: p });
    }
  }

  // If ALL files in this directory are unpacked, collapse to dir-level unpack
  if (prefix && total > 0 && total === unpacked) {
    return {
      total,
      unpacked,
      covers: [{ type: "dir", path: prefix }],
    };
  }
  return { total, unpacked, covers };
}

function stripLeadingSlash(p: string): string {
  return p.replace(/^\/+/, "");
}

function bracePattern(patterns: string[]): string {
  return patterns.length === 1 ? patterns[0] : `{${patterns.join(",")}}`;
}

/** Backup: copy `from` to `to` if `to` doesn't already exist. */
export function backupOnce(from: string, to: string): void {
  if (!existsSync(to)) cpSync(from, to, { recursive: true });
}

/** Read a file inside the asar without extracting the whole thing. */
export function readFileInAsar(asarPath: string, relPath: string): Buffer {
  return asar.extractFile(asarPath, relPath) as Buffer;
}

function annotatePermError(e: unknown, target: string): Error {
  const err = e as NodeJS.ErrnoException;
  if (
    err &&
    (err.code === "EPERM" || err.code === "EACCES") &&
    /\/Applications\//.test(target)
  ) {
    const msg =
      `Permission denied writing to ${target}.\n\n` +
      `macOS App Management is blocking modification of the app bundle.\n` +
      `Run this command with sudo, or grant Terminal Full Disk Access in System Settings.\n\n` +
      `Original error: ${err.message}`;
    const wrapped = new Error(msg);
    (wrapped as NodeJS.ErrnoException).code = err.code;
    return wrapped;
  }
  return err instanceof Error ? err : new Error(String(err));
}
