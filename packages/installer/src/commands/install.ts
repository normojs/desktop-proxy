/**
 * Install command — backend-agnostic flow for injecting the desktop-proxy
 * runtime into an Electron app.
 *
 * The pipeline is shared across injection backends: stage the runtime/plugins,
 * let the selected backend mutate the app (asar patch today; a dyld/V8-hook
 * fallback could be added later), then re-sign (macOS) with whatever entitlements
 * the backend needs, clear quarantine, and record state. See
 * docs/macos-injection-plan.md.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import { locateApp } from "../platform.js";
import {
  signAppBundle,
  signAppBundleWithEntitlements,
  clearQuarantine,
  DEFAULT_SIGNING_IDENTITY,
} from "../codesign.js";
import { buildEntitlementsPlist } from "../macos-inject.js";
import { permissions } from "./permissions.js";
import { getBackend, DEFAULT_BACKEND, type BackendName, type BackendContext } from "../backends/index.js";

export interface InstallOptions {
  app?: string;
  noFuse?: boolean;
  noResign?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  /** Injection backend to use (default "asar"). */
  backend?: BackendName;
}

const here = dirname(fileURLToPath(import.meta.url));

export async function install(opts: InstallOptions = {}): Promise<void> {
  const log = opts.quiet ? () => {} : (msg: string) => console.log(`  ${msg}`);

  const codex = locateApp(opts.app);
  const backend = getBackend(opts.backend ?? DEFAULT_BACKEND);

  console.log(`\ndesktop-proxy install`);
  console.log(`  App: ${codex.appRoot} (${codex.channel})`);
  console.log(`  Backend: ${backend.name}`);

  const support = backend.supported(codex);
  if (!support.ok) {
    throw new Error(`backend "${backend.name}" cannot be used here: ${support.reason}`);
  }

  // Resolve user paths
  const userRoot = join(homedir(), ".desktop-proxy");
  const runtimeDir = join(userRoot, "runtime");
  const pluginsDir = join(userRoot, "plugins");
  const backupDir = join(userRoot, "backup");
  const logDir = join(userRoot, "log");

  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(pluginsDir, { recursive: true });
  mkdirSync(backupDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });

  log(`User dir: ${userRoot}`);

  // ── Stage runtime files (shared) ──────────────────────────────────────────
  const assetsSource = resolve(here, "..", "..", "assets");
  const runtimeSource = existsSync(join(assetsSource, "runtime"))
    ? join(assetsSource, "runtime")
    : resolve(here, "..", "..", "..", "runtime", "dist");

  if (existsSync(runtimeSource)) {
    cpSync(runtimeSource, runtimeDir, { recursive: true });
    log("Runtime staged");
  } else {
    console.warn(`  Warning: runtime source not found at ${runtimeSource}`);
    console.warn(`  Build the runtime package first: pnpm build:runtime && pnpm build:preload`);
  }

  // The loader loads runtime/main.js and registers runtime/preload.js. The
  // runtime bundle (main.js) ships in runtimeSource; ensure the preload bundle
  // is staged alongside it (in dev it lives in the preload package's dist).
  if (!existsSync(join(runtimeDir, "main.js"))) {
    console.warn(`  Warning: runtime bundle main.js missing in ${runtimeDir} — run "pnpm build" (esbuild produces it)`);
  }
  if (!existsSync(join(runtimeDir, "preload.js"))) {
    const preloadSrc = existsSync(join(assetsSource, "runtime", "preload.js"))
      ? join(assetsSource, "runtime", "preload.js")
      : resolve(here, "..", "..", "..", "preload", "dist", "preload.js");
    if (existsSync(preloadSrc)) {
      cpSync(preloadSrc, join(runtimeDir, "preload.js"));
      log("Preload staged");
    } else {
      console.warn(`  Warning: preload bundle not found at ${preloadSrc} — renderer plugins won't load`);
    }
  }

  // ── Backend-specific injection (backup + patch/inject) ────────────────────
  const ctx: BackendContext = { install: codex, userRoot, runtimeDir, backupDir, log, noFuse: opts.noFuse };
  const result = await backend.apply(ctx);

  // ── Re-sign on macOS (shared; entitlements from the backend) ──────────────
  let resigned = false;
  if (opts.noResign !== true && codex.platform === "darwin") {
    clearQuarantine(codex.appRoot);
    if (result.entitlements.length > 0) {
      const entitlementsPath = join(userRoot, "inject.entitlements");
      writeFileSync(entitlementsPath, buildEntitlementsPlist(result.entitlements));
      signAppBundleWithEntitlements(codex.appRoot, entitlementsPath, { identityName: DEFAULT_SIGNING_IDENTITY });
    } else {
      signAppBundle(codex.appRoot, { identityName: DEFAULT_SIGNING_IDENTITY });
    }
    resigned = true;
    log("Re-signed app bundle with local identity");
  }

  // ── Deploy default request-interceptor plugin (shared) ────────────────────
  deployRequestInterceptorPlugin(pluginsDir, log);

  // ── Write state ───────────────────────────────────────────────────────────
  const statePath = join(userRoot, "state.json");
  writeFileSync(
    statePath,
    JSON.stringify(
      {
        version: "0.1.0",
        installedAt: new Date().toISOString(),
        backend: backend.name,
        appRoot: codex.appRoot,
        codexVersion: null,
        codexChannel: codex.channel,
        codexBundleId: codex.bundleId,
        resigned,
        ...result.state,
      },
      null,
      2,
    ),
  );

  console.log(`\n  ✓ desktop-proxy installed.`);
  console.log(`  Plugins:  ${pluginsDir}`);
  console.log(`  Logs:     ${logDir}`);
  console.log(`\n  Launch the app normally; plugins will load automatically.`);
  console.log();

  // Re-signing reset the app's macOS TCC permissions; guide a one-time re-grant
  // and open System Settings. (No-op on Windows/Linux, which don't reset perms.)
  if (resigned && codex.platform === "darwin") {
    console.log(`  Re-signing reset macOS permissions for this app (one-time). Re-grant:`);
    permissions({ openRoot: true });
  }
}

function deployRequestInterceptorPlugin(pluginsDir: string, log: (msg: string) => void): void {
  const destDir = join(pluginsDir, "com.desktop-proxy.request-interceptor");
  mkdirSync(destDir, { recursive: true });

  const pluginSources = [
    resolve(here, "..", "..", "assets", "plugins", "request-interceptor"),
    resolve(here, "..", "..", "..", "plugins", "request-interceptor"),
  ];

  for (const src of pluginSources) {
    if (existsSync(src)) {
      const manifestPath = join(src, "manifest.json");
      const indexPath = join(src, "index.js");
      if (existsSync(manifestPath) && existsSync(indexPath)) {
        cpSync(manifestPath, join(destDir, "manifest.json"));
        cpSync(indexPath, join(destDir, "index.js"));
        log("Deployed request-interceptor plugin");
        return;
      }
    }
  }

  log("Warning: request-interceptor plugin not found");
}
