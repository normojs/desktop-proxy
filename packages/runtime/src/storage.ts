/**
 * Unified plugin key-value storage (main process).
 *
 * One JSON file per plugin under the user root, with an in-memory cache and
 * atomic writes. This is the single backend for `api.storage` in BOTH scopes:
 * main-scope plugins use it directly; renderer-scope plugins proxy to it over
 * IPC (sync snapshot on init + write-through). That keeps storage durable,
 * consistent across windows, and shared for `scope: "both"` plugins.
 */

import fs from "node:fs";
import path from "node:path";

export interface PluginStorageStore {
  get<T = unknown>(id: string, key: string, defaultValue?: T): T;
  set(id: string, key: string, value: unknown): void;
  delete(id: string, key: string): void;
  all(id: string): Record<string, unknown>;
}

function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function createPluginStorage(rootDir: string): PluginStorageStore {
  const cache = new Map<string, Record<string, unknown>>();
  const fileOf = (id: string): string => path.join(rootDir, `plugin-${safeId(id)}.json`);

  function load(id: string): Record<string, unknown> {
    const cached = cache.get(id);
    if (cached) return cached;
    let data: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(fileOf(id), "utf8"));
      if (parsed && typeof parsed === "object") data = parsed as Record<string, unknown>;
    } catch {
      /* missing/invalid → empty */
    }
    cache.set(id, data);
    return data;
  }

  function persist(id: string, data: Record<string, unknown>): void {
    const file = fileOf(id);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  }

  return {
    get: <T>(id: string, key: string, defaultValue?: T): T => {
      const d = load(id);
      return (key in d ? d[key] : defaultValue) as T;
    },
    set: (id: string, key: string, value: unknown): void => {
      const d = load(id);
      d[key] = value;
      persist(id, d);
    },
    delete: (id: string, key: string): void => {
      const d = load(id);
      if (key in d) {
        delete d[key];
        persist(id, d);
      }
    },
    all: (id: string): Record<string, unknown> => ({ ...load(id) }),
  };
}
