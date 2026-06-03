/**
 * Injection backend registry. The install/uninstall/status pipeline picks a
 * backend by name (default "asar"; recorded in state.json) and drives it through
 * the InjectionBackend interface.
 */

import type { CodexInstall } from "../platform.js";
import type {
  ApplyResult,
  BackendContext,
  BackendName,
  InjectionBackend,
  SupportResult,
} from "./types.js";
import { AsarBackend } from "./asar.js";

export const DEFAULT_BACKEND: BackendName = "asar";

/**
 * Placeholder for the future native dyld/V8-hook fallback. The abstraction is
 * real so the pipeline already dispatches by backend, but it is intentionally
 * not implemented — see docs/macos-injection-plan.md §8/§10 (asar is the single
 * cross-platform mechanism; this is only a future edge-case fallback).
 */
class DyldBackend implements InjectionBackend {
  readonly name = "dyld" as const;
  supported(): SupportResult {
    return {
      ok: false,
      reason: "dyld/V8-hook backend is not implemented yet (see docs/macos-injection-plan.md)",
    };
  }
  apply(): Promise<ApplyResult> {
    return Promise.reject(new Error("dyld backend not implemented"));
  }
  isApplied(): boolean {
    return false;
  }
  revert(): void {
    throw new Error("dyld backend not implemented");
  }
}

const REGISTRY: Record<BackendName, InjectionBackend> = {
  asar: new AsarBackend(),
  dyld: new DyldBackend(),
};

export function getBackend(name: BackendName = DEFAULT_BACKEND): InjectionBackend {
  const backend = REGISTRY[name];
  if (!backend) throw new Error(`unknown injection backend: ${name}`);
  return backend;
}

export function isBackendName(value: string): value is BackendName {
  return value === "asar" || value === "dyld";
}

export type { InjectionBackend, BackendContext, ApplyResult, BackendName, SupportResult } from "./types.js";
export type { CodexInstall };
