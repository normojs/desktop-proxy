/**
 * Leveled logger for the main process.
 *
 * Adds what the previous ad-hoc `log()` lacked: level filtering (debug < info <
 * warn < error < silent), a configurable threshold (env or config), namespaced
 * child loggers, an `isEnabled()` guard for expensive log construction, and a
 * size cap so `main.log` cannot grow without bound.
 */

import * as fs from "node:fs";

import type { LogLevel } from "@desktop-proxy/plugin-sdk";

export type LogConfigLevel = LogLevel | "silent";

const ORDER: Record<LogConfigLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

const DEFAULT_CAP_BYTES = 10 * 1024 * 1024;

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  /** Generic entry point used by the legacy `log(level, ...)` call sites. */
  log(level: string, ...args: unknown[]): void;
  isEnabled(level: LogLevel): boolean;
  child(namespace: string): Logger;
  setLevel(level: LogConfigLevel): void;
  getLevel(): LogConfigLevel;
}

export function parseLevel(value: string | undefined, fallback: LogConfigLevel): LogConfigLevel {
  if (!value) return fallback;
  const v = value.toLowerCase();
  return v in ORDER ? (v as LogConfigLevel) : fallback;
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function format(level: string, namespace: string | undefined, args: unknown[]): string {
  const ts = new Date().toISOString();
  const ns = namespace ? ` [${namespace}]` : "";
  const msg = args.map((a) => (typeof a === "string" ? a : safeStringify(a))).join(" ");
  return `[${ts}] [${level}]${ns} ${msg}\n`;
}

function appendCapped(file: string, line: string, capBytes: number): void {
  const incoming = Buffer.from(line);
  try {
    if (incoming.byteLength >= capBytes) {
      fs.writeFileSync(file, incoming.subarray(incoming.byteLength - capBytes));
      return;
    }
    if (fs.existsSync(file)) {
      const size = fs.statSync(file).size;
      const allowedExisting = capBytes - incoming.byteLength;
      if (size > allowedExisting) {
        const existing = fs.readFileSync(file);
        fs.writeFileSync(file, existing.subarray(Math.max(0, existing.byteLength - allowedExisting)));
      }
    }
    fs.appendFileSync(file, incoming);
  } catch {
    // best effort — never throw from logging
  }
}

export function createLogger(opts: {
  file: string;
  level: LogConfigLevel;
  capBytes?: number;
  mirrorErrorsToStderr?: boolean;
}): Logger {
  const state: { level: LogConfigLevel } = { level: opts.level };
  const cap = opts.capBytes ?? DEFAULT_CAP_BYTES;

  function thresholdFor(level: string): boolean {
    const value = ORDER[level as LogConfigLevel];
    if (value === undefined) return true; // unknown levels always pass
    return value >= ORDER[state.level];
  }

  function make(namespace?: string): Logger {
    function emit(level: string, args: unknown[]): void {
      if (!thresholdFor(level)) return;
      appendCapped(opts.file, format(level, namespace, args), cap);
      if (opts.mirrorErrorsToStderr && level === "error") {
        try {
          process.stderr.write(`[desktop-proxy] ${args.join(" ")}\n`);
        } catch {
          // ignore
        }
      }
    }

    return {
      debug: (...a) => emit("debug", a),
      info: (...a) => emit("info", a),
      warn: (...a) => emit("warn", a),
      error: (...a) => emit("error", a),
      log: (level, ...a) => emit(level, a),
      isEnabled: (level: LogLevel) => ORDER[level] >= ORDER[state.level],
      child: (ns: string) => make(namespace ? `${namespace}:${ns}` : ns),
      setLevel: (level: LogConfigLevel) => {
        state.level = level;
      },
      getLevel: () => state.level,
    };
  }

  return make();
}
