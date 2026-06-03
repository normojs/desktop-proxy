/**
 * Injection backend abstraction.
 *
 * A backend is the *only* part that differs between injection strategies: how we
 * get the desktop-proxy runtime to load inside the target's main process. Every
 * other install step (staging runtime/plugins, re-signing, clearing quarantine,
 * state, uninstall, doctor, the auto-repair watcher) is backend-agnostic and
 * lives in the shared install pipeline.
 *
 * Today the only backend is `asar` (patch app.asar's entry → loader). The
 * abstraction leaves a clean slot for a future `dyld`/V8-hook fallback (see
 * docs/macos-injection-plan.md §8.3, §10) without forcing it to be built now.
 */

import type { CodexInstall } from "../platform.js";

export type BackendName = "asar" | "dyld";

export interface BackendContext {
  install: CodexInstall;
  userRoot: string;
  runtimeDir: string;
  backupDir: string;
  log: (msg: string) => void;
  /** Skip flipping the asar-integrity fuse (asar backend honors this). */
  noFuse?: boolean;
}

export interface ApplyResult {
  /**
   * Entitlements the shared re-sign step must grant (macOS). Empty for `asar`
   * (it doesn't load foreign native code); the `dyld` backend would return the
   * library-validation/exec-memory entitlements here.
   */
  entitlements: string[];
  /** Backend-specific fields to persist in state.json (merged by the pipeline). */
  state: Record<string, unknown>;
}

export interface SupportResult {
  ok: boolean;
  reason?: string;
}

export interface InjectionBackend {
  readonly name: BackendName;
  /** Whether this backend can be used for the given app on this platform. */
  supported(install: CodexInstall): SupportResult;
  /**
   * Mutate the app so its main process loads our runtime (back up originals,
   * patch/inject). Does NOT re-sign — the shared pipeline re-signs afterwards
   * using the returned entitlements, so there is one re-sign implementation.
   */
  apply(ctx: BackendContext): Promise<ApplyResult>;
  /** True if the app is currently injected by this backend. */
  isApplied(install: CodexInstall): boolean;
  /** Restore the app to its pre-injection state (uninstall). No re-sign here. */
  revert(ctx: BackendContext): void;
}
