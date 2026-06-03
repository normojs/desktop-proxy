/**
 * OS-specific post-injection step.
 *
 * After the backend mutates the app bundle, each OS may need a different finishing
 * step. macOS MUST re-sign (the patched bundle's original signature is now invalid
 * and Gatekeeper would refuse it). Windows and Linux need nothing — there is no
 * signature enforcement that blocks running a modified asar. Keeping this here
 * (instead of inline `if (platform === "darwin")` blocks) means new per-OS steps
 * (e.g. Windows elevation helpers) slot in without touching the install pipeline.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { CodexInstall } from "../platform.js";
import {
  signAppBundle,
  signAppBundleWithEntitlements,
  clearQuarantine,
  DEFAULT_SIGNING_IDENTITY,
} from "../codesign.js";
import { buildEntitlementsPlist } from "../macos-inject.js";

export interface PostInjectContext {
  userRoot: string;
  /** Entitlements the backend needs (asar: none; dyld/V8-hook: a set). */
  entitlements: string[];
  /** True when running under sudo (login keychain unreachable → ad-hoc sign). */
  sudo: boolean;
  noResign?: boolean;
  log: (msg: string) => void;
}

export interface PostInjectResult {
  resigned: boolean;
}

/** Run the OS-appropriate finishing step. Returns whether the bundle was re-signed. */
export function postInject(install: CodexInstall, ctx: PostInjectContext): PostInjectResult {
  if (install.platform !== "darwin" || ctx.noResign === true) {
    // Windows/Linux: nothing to do (no signature wall). Future per-OS steps go here.
    return { resigned: false };
  }

  clearQuarantine(install.appRoot);
  // Under sudo the invoking user's login keychain isn't reachable (root's is
  // used), so a local signing identity is unreliable — sign ad-hoc. The app still
  // launches locally; TCC perms reset on each re-sign (re-grant via `dprox permissions`).
  const useLocalIdentity = !ctx.sudo;
  if (ctx.entitlements.length > 0) {
    const entitlementsPath = join(ctx.userRoot, "inject.entitlements");
    writeFileSync(entitlementsPath, buildEntitlementsPlist(ctx.entitlements));
    signAppBundleWithEntitlements(install.appRoot, entitlementsPath, {
      identityName: DEFAULT_SIGNING_IDENTITY,
      useLocalIdentity,
    });
  } else {
    signAppBundle(install.appRoot, { identityName: DEFAULT_SIGNING_IDENTITY, useLocalIdentity });
  }
  ctx.log(useLocalIdentity ? "Re-signed app bundle with local identity" : "Re-signed app bundle (ad-hoc)");
  return { resigned: true };
}
