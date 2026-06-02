/**
 * Install command — full flow for patching an Electron app.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import { locateApp, type CodexInstall } from "../platform.js";
import { patchAsar, backupOnce, readHeaderHash, readFileInAsar } from "../asar.js";
import { writeFuse, FuseV1 } from "../fuses.js";
import { signAppBundle, clearQuarantine, DEFAULT_SIGNING_IDENTITY } from "../codesign.js";
import { readIntegrity, writeIntegrity } from "../platform.js";

export interface InstallOptions {
  app?: string;
  noFuse?: boolean;
  noResign?: boolean;
  quiet?: boolean;
  verbose?: boolean;
}

const here = dirname(fileURLToPath(import.meta.url));

export async function install(opts: InstallOptions = {}): Promise<void> {
  const log = opts.quiet ? () => {} : (msg: string) => console.log(`  ${msg}`);

  const codex = locateApp(opts.app);
  console.log(`\ndesktop-proxy install`);
  console.log(`  App: ${codex.appRoot} (${codex.channel})`);

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

  // ── Stage runtime files ──────────────────────────────────────────────────

  const assetsSource = resolve(here, "..", "..", "assets");
  // In production, assets are shipped alongside the installer.
  // In development, we look for them in the build output.
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

  // ── Backup originals ────────────────────────────────────────────────────

  const backupAsar = join(backupDir, "app.asar");
  backupOnce(codex.asarPath, backupAsar);
  if (existsSync(`${codex.asarPath}.unpacked`)) {
    backupOnce(`${codex.asarPath}.unpacked`, join(backupDir, "app.asar.unpacked"));
  }
  if (codex.electronBinary && existsSync(codex.electronBinary)) {
    backupOnce(codex.electronBinary, join(backupDir, "Electron Framework"));
  }
  log("Backup ready");

  // ── Patch app.asar ──────────────────────────────────────────────────────

  const originalHash = readHeaderHash(codex.asarPath).headerHash;
  let originalMain = "";

  await patchAsar(codex.asarPath, (extractDir) => {
    const pkgPath = join(extractDir, "package.json");
    if (!existsSync(pkgPath)) {
      throw new Error("app.asar has no package.json — is this an Electron app?");
    }

    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    originalMain = String(pkg.main ?? "");
    if (!originalMain) throw new Error("app.asar package.json has no `main` field");

    // Check if already patched
    if (pkg.__desktop_proxy) {
      console.log("  Already patched, updating loader...");
      originalMain = String(pkg.__desktop_proxy.originalMain);
    }

    pkg.__desktop_proxy = {
      originalMain,
      userRoot,
      loader: "desktop-proxy-loader.cjs",
    };
    pkg.main = "desktop-proxy-loader.cjs";
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

    // Copy loader stub into asar root
    const loaderSources = [
      resolve(here, "..", "..", "assets", "loader.cjs"),
      resolve(here, "..", "..", "..", "loader", "dist", "loader.cjs"),
      resolve(here, "..", "..", "..", "loader", "src", "loader.cjs"),
    ];
    let loaderCopied = false;
    for (const src of loaderSources) {
      if (existsSync(src)) {
        cpSync(src, join(extractDir, "desktop-proxy-loader.cjs"));
        loaderCopied = true;
        break;
      }
    }
    if (!loaderCopied) {
      throw new Error(
        "loader.cjs not found. Build the loader package first:\n" +
        "  cp packages/loader/src/loader.cjs packages/loader/dist/loader.cjs",
      );
    }
  });

  const patchedHash = readHeaderHash(codex.asarPath).headerHash;
  log(`Patched app.asar (entry was ${originalMain})`);

  // ── Update ElectronAsarIntegrity ────────────────────────────────────────

  if (codex.metaPath) {
    writeIntegrity(codex, patchedHash);
    log(`Updated ElectronAsarIntegrity → ${patchedHash.slice(0, 12)}...`);
  }

  // ── Flip Electron fuse ──────────────────────────────────────────────────

  let fuseFlipped = false;
  if (opts.noFuse !== true && existsSync(codex.electronBinary)) {
    try {
      const result = writeFuse(
        codex.electronBinary,
        "EnableEmbeddedAsarIntegrityValidation",
        "off",
      );
      log(`Fuse EnableEmbeddedAsarIntegrityValidation: ${result.from} → ${result.to}`);
      fuseFlipped = true;
    } catch (e) {
      console.warn(`  Warning: Fuse flip failed: ${(e as Error).message}`);
    }
  }

  // ── Re-sign on macOS ────────────────────────────────────────────────────

  let resigned = false;
  if (opts.noResign !== true && codex.platform === "darwin") {
    clearQuarantine(codex.appRoot);
    signAppBundle(codex.appRoot, { identityName: DEFAULT_SIGNING_IDENTITY });
    resigned = true;
    log("Re-signed app bundle with local identity");
  }

  // ── Deploy default request-interceptor plugin ────────────────────────────

  deployRequestInterceptorPlugin(pluginsDir, log);

  // ── Write state ─────────────────────────────────────────────────────────

  const statePath = join(userRoot, "state.json");
  writeFileSync(
    statePath,
    JSON.stringify(
      {
        version: "0.1.0",
        installedAt: new Date().toISOString(),
        appRoot: codex.appRoot,
        originalAsarHash: originalHash,
        patchedAsarHash: patchedHash,
        codexVersion: null,
        codexChannel: codex.channel,
        codexBundleId: codex.bundleId,
        fuseFlipped,
        resigned,
        originalEntryPoint: originalMain,
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
