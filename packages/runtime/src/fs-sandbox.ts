/**
 * Sandboxed filesystem helpers for plugins.
 *
 * Renderer plugins run with `sandbox: true` and cannot use Node's `fs`, while
 * eval'd plugin code must never reach arbitrary host files. These helpers confine
 * every operation to a per-plugin data directory
 * (`<userRoot>/plugin-data/<id>/`) and reject any path that escapes it.
 *
 * The strong guarantee is host-path confinement (no traversal out of the plugin
 * data tree). Inter-plugin isolation is best-effort: renderer plugins share one
 * JS context, so it is the framework-supplied plugin id (captured when the API is
 * built) — not a hard boundary — that scopes each plugin to its own directory.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { PluginFileStat, FileEncoding } from "@desktop-proxy/plugin-sdk";

/** Resolve the sandbox root directory for a plugin id. */
export function pluginDataDir(userRoot: string, pluginId: string): string {
  // Collapse the id into a single safe path segment.
  const safeId = pluginId.replace(/[^a-zA-Z0-9._-]/g, "_") || "_";
  return path.join(userRoot, "plugin-data", safeId);
}

/** Resolve `rel` against `root`, throwing if it escapes the sandbox. */
export function resolveWithin(root: string, rel: string): string {
  const normalizedRoot = path.resolve(root);
  const resolved = path.resolve(normalizedRoot, rel ?? "");
  if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + path.sep)) {
    throw new Error(`path escapes plugin sandbox: ${rel}`);
  }
  return resolved;
}

function bufferEncoding(encoding: FileEncoding | undefined): BufferEncoding {
  return encoding === "base64" ? "base64" : "utf8";
}

export function fsRead(root: string, rel: string, encoding?: FileEncoding): string {
  const target = resolveWithin(root, rel);
  return fs.readFileSync(target).toString(bufferEncoding(encoding));
}

export function fsWrite(root: string, rel: string, data: string, encoding?: FileEncoding): void {
  const target = resolveWithin(root, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, Buffer.from(data, bufferEncoding(encoding)));
}

export function fsExists(root: string, rel: string): boolean {
  try {
    return fs.existsSync(resolveWithin(root, rel));
  } catch {
    return false;
  }
}

export function fsList(root: string, rel?: string): string[] {
  const target = resolveWithin(root, rel ?? ".");
  try {
    return fs.readdirSync(target);
  } catch {
    return [];
  }
}

export function fsDelete(root: string, rel: string): void {
  const target = resolveWithin(root, rel);
  // Never allow deleting the sandbox root itself.
  if (target === path.resolve(root)) {
    throw new Error("refusing to delete the plugin sandbox root");
  }
  fs.rmSync(target, { recursive: true, force: true });
}

export function fsMkdir(root: string, rel: string): void {
  const target = resolveWithin(root, rel);
  fs.mkdirSync(target, { recursive: true });
}

export function fsStat(root: string, rel: string): PluginFileStat {
  const target = resolveWithin(root, rel);
  const s = fs.statSync(target);
  return {
    size: s.size,
    isFile: s.isFile(),
    isDirectory: s.isDirectory(),
    mtimeMs: s.mtimeMs,
  };
}
