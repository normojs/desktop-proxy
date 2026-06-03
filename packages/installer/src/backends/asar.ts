/**
 * asar backend — the default (and currently only) injection backend.
 *
 * Patches app.asar's `package.json#main` to our loader stub, updates the
 * Electron asar-integrity hash, and flips the integrity fuse. Works on all three
 * platforms; only macOS additionally needs the shared re-sign step afterwards
 * (the pipeline handles that). This wraps the existing asar/fuses/platform
 * helpers behind the InjectionBackend interface — no behavior change.
 */

import { existsSync, readFileSync, writeFileSync, cpSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { CodexInstall } from "../platform.js";
import { writeIntegrity } from "../platform.js";
import { patchAsar, backupOnce, readHeaderHash, readFileInAsar } from "../asar.js";
import { writeFuse } from "../fuses.js";

import type { ApplyResult, BackendContext, InjectionBackend, SupportResult } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));

const LOADER_NAME = "desktop-proxy-loader.cjs";

function loaderSources(): string[] {
  return [
    resolve(here, "..", "..", "assets", "loader.cjs"),
    resolve(here, "..", "..", "..", "loader", "dist", "loader.cjs"),
    resolve(here, "..", "..", "..", "loader", "src", "loader.cjs"),
  ];
}

export class AsarBackend implements InjectionBackend {
  readonly name = "asar" as const;

  supported(install: CodexInstall): SupportResult {
    if (!existsSync(install.asarPath)) {
      return { ok: false, reason: `app.asar not found at ${install.asarPath}` };
    }
    return { ok: true };
  }

  async apply(ctx: BackendContext): Promise<ApplyResult> {
    const { install, userRoot, backupDir, log } = ctx;

    // ── Back up originals ──────────────────────────────────────────────────
    backupOnce(install.asarPath, join(backupDir, "app.asar"));
    if (existsSync(`${install.asarPath}.unpacked`)) {
      backupOnce(`${install.asarPath}.unpacked`, join(backupDir, "app.asar.unpacked"));
    }
    if (install.electronBinary && existsSync(install.electronBinary)) {
      backupOnce(install.electronBinary, join(backupDir, "Electron Framework"));
    }
    log("Backup ready");

    // ── Patch app.asar (package.json#main → loader) ────────────────────────
    const originalHash = readHeaderHash(install.asarPath).headerHash;
    let originalMain = "";

    await patchAsar(install.asarPath, (extractDir) => {
      const pkgPath = join(extractDir, "package.json");
      if (!existsSync(pkgPath)) {
        throw new Error("app.asar has no package.json — is this an Electron app?");
      }
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      originalMain = String(pkg.main ?? "");
      if (!originalMain) throw new Error("app.asar package.json has no `main` field");
      if (pkg.__desktop_proxy) {
        originalMain = String(pkg.__desktop_proxy.originalMain);
      }

      pkg.__desktop_proxy = { originalMain, userRoot, loader: LOADER_NAME };
      pkg.main = LOADER_NAME;
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

      let loaderCopied = false;
      for (const src of loaderSources()) {
        if (existsSync(src)) {
          cpSync(src, join(extractDir, LOADER_NAME));
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

    const patchedHash = readHeaderHash(install.asarPath).headerHash;
    log(`Patched app.asar (entry was ${originalMain})`);

    // ── Update ElectronAsarIntegrity ───────────────────────────────────────
    if (install.metaPath) {
      writeIntegrity(install, patchedHash);
      log(`Updated ElectronAsarIntegrity → ${patchedHash.slice(0, 12)}...`);
    }

    // ── Flip the integrity fuse ────────────────────────────────────────────
    let fuseFlipped = false;
    if (ctx.noFuse !== true && existsSync(install.electronBinary)) {
      try {
        const result = writeFuse(install.electronBinary, "EnableEmbeddedAsarIntegrityValidation", "off");
        log(`Fuse EnableEmbeddedAsarIntegrityValidation: ${result.from} → ${result.to}`);
        fuseFlipped = true;
      } catch (e) {
        console.warn(`  Warning: Fuse flip failed: ${(e as Error).message}`);
      }
    }

    return {
      entitlements: [], // asar doesn't load foreign native code
      state: {
        originalAsarHash: originalHash,
        patchedAsarHash: patchedHash,
        originalEntryPoint: originalMain,
        fuseFlipped,
      },
    };
  }

  isApplied(install: CodexInstall): boolean {
    try {
      const pkg = JSON.parse(readFileInAsar(install.asarPath, "package.json").toString("utf8"));
      return Boolean(pkg.__desktop_proxy);
    } catch {
      return false;
    }
  }

  revert(ctx: BackendContext): void {
    const { install, backupDir, log } = ctx;

    const backupAsar = join(backupDir, "app.asar");
    if (existsSync(backupAsar)) {
      cpSync(backupAsar, install.asarPath);
      log("Restored original app.asar");
    } else {
      console.warn("  Warning: No backup found for app.asar");
    }

    const backupUnpacked = join(backupDir, "app.asar.unpacked");
    if (existsSync(backupUnpacked)) {
      const unpackedDest = `${install.asarPath}.unpacked`;
      rmSync(unpackedDest, { recursive: true, force: true });
      cpSync(backupUnpacked, unpackedDest, { recursive: true });
      log("Restored app.asar.unpacked");
    }

    const backupFramework = join(backupDir, "Electron Framework");
    if (existsSync(backupFramework) && existsSync(install.electronBinary)) {
      cpSync(backupFramework, install.electronBinary);
      log("Restored Electron Framework");
    }
  }
}
