/**
 * Code signing on macOS.
 *
 * After modifying app.asar or the Electron Framework binary, the original
 * signature is invalid. We re-sign the bundle with a local self-signed
 * identity so the patched app keeps working.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { platform, tmpdir } from "node:os";

export const DEFAULT_SIGNING_IDENTITY = "Desktop Proxy Local Signing";

export type SigningMode = "local-identity" | "adhoc";

export interface CodeSigningOptions {
  useLocalIdentity?: boolean;
  identityName?: string;
}

const MACHO_MAGICS = new Set([
  0xfeedface, // 32-bit
  0xcafebabe, // fat
  0xfeedfacf, // 64-bit
  0xcffaedfe, // 64-bit LE
  0xcefaedfe, // 32-bit LE
]);

export function signAppBundle(
  appRoot: string,
  opts: CodeSigningOptions = {},
): string | null {
  if (platform() !== "darwin") return null;

  const useLocalIdentity = opts.useLocalIdentity !== false;
  const signingIdentity = useLocalIdentity
    ? ensureLocalIdentity(opts.identityName ?? DEFAULT_SIGNING_IDENTITY)
    : "-";

  // Step 1: Pre-sign all Mach-O files in app.asar.unpacked
  const resources = join(appRoot, "Contents", "Resources");
  const unpackedDir = join(resources, "app.asar.unpacked");
  if (existsSync(unpackedDir)) {
    walkAndSign(unpackedDir, signingIdentity);
  }

  // Step 2: Sign the bundle itself with --deep
  execFileSync(
    "codesign",
    ["--force", "--deep", "--sign", signingIdentity, appRoot],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  return signingIdentity;
}

export function adHocSign(appRoot: string): void {
  signAppBundle(appRoot, { useLocalIdentity: false });
}

function walkAndSign(root: string, signingIdentity: string): void {
  const failures: string[] = [];
  walkAndSignInto(root, root, signingIdentity, failures);
  if (failures.length > 0) {
    throw new Error(
      `Failed to sign ${failures.length} Mach-O file(s) under ${root}:\n${failures.join("\n")}`,
    );
  }
}

function walkAndSignInto(
  root: string,
  current: string,
  signingIdentity: string,
  failures: string[],
): void {
  let entries: string[];
  try {
    entries = readdirSync(current);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(current, name);
    const rel = relative(resolve(root), resolve(full));
    if (rel.startsWith("..") || isAbsolute(rel)) continue;

    try {
      const st = lstatSync(full);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        walkAndSignInto(root, full, signingIdentity, failures);
        continue;
      }
      if (!st.isFile()) continue;
      if (!isMachO(full)) continue;

      try {
        execFileSync(
          "codesign",
          [
            "--force",
            "--sign",
            signingIdentity,
            "--preserve-metadata=entitlements,flags",
            full,
          ],
          { stdio: ["ignore", "ignore", "pipe"] },
        );
      } catch (e) {
        failures.push(`${full}: ${signingErrorMessage(e)}`);
      }
    } catch {
      continue;
    }
  }
}

function signingErrorMessage(e: unknown): string {
  const err = e as { stderr?: Buffer | string; message?: string };
  return String(err.stderr ?? err.message ?? e).trim() || "codesign failed";
}

function ensureLocalIdentity(identityName: string): string {
  requireExecutable("codesign", "macOS codesign is required to re-sign apps after patching.");

  const existing = findSigningIdentity(identityName);
  if (existing) return existing.hash;

  requireExecutable("openssl", "macOS openssl is required to create a local signing identity.");
  requireExecutable("security", "macOS security is required to manage signing identities.");

  const created = createLocalIdentity(identityName);
  return created.hash;
}

function findSigningIdentity(
  identityName: string,
): { hash: string; name: string } | null {
  const result = spawnSync(
    "security",
    ["find-identity", "-v", "-p", "codesigning"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return parseIdentities(output).find((i) => i.name === identityName) ?? null;
}

function createLocalIdentity(
  identityName: string,
): { hash: string; name: string } {
  const dir = mkdtempSync(join(tmpdir(), "dp-signing-"));
  try {
    const configPath = join(dir, "openssl.cnf");
    const keyPath = join(dir, "identity.key");
    const certPath = join(dir, "identity.crt");
    const p12Path = join(dir, "identity.p12");
    const p12Password = randomBytes(24).toString("base64url");
    const keychain = defaultUserKeychain();

    writeFileSync(
      configPath,
      [
        "[req]",
        "distinguished_name=req_distinguished_name",
        "x509_extensions=v3_req",
        "prompt=no",
        "",
        "[req_distinguished_name]",
        `CN=${identityName}`,
        "",
        "[v3_req]",
        "basicConstraints=critical,CA:FALSE",
        "keyUsage=critical,digitalSignature",
        "extendedKeyUsage=codeSigning",
      ].join("\n"),
    );

    execFileSync("openssl", [
      "req", "-new", "-newkey", "rsa:2048", "-x509", "-sha256",
      "-days", "3650", "-nodes",
      "-config", configPath,
      "-keyout", keyPath,
      "-out", certPath,
    ], { stdio: "ignore" });

    execFileSync("openssl", [
      "pkcs12", "-export",
      "-inkey", keyPath,
      "-in", certPath,
      "-name", identityName,
      "-out", p12Path,
      "-keypbe", "PBE-SHA1-3DES",
      "-certpbe", "PBE-SHA1-3DES",
      "-macalg", "sha1",
      "-passout", `pass:${p12Password}`,
    ], { stdio: "ignore" });

    execFileSync("security", [
      "import", p12Path,
      "-k", keychain,
      "-P", p12Password,
      "-T", "/usr/bin/codesign",
    ], { stdio: "ignore" });

    execFileSync("security", [
      "add-trusted-cert",
      "-r", "trustRoot",
      "-p", "codeSign",
      "-k", keychain,
      certPath,
    ], { stdio: "ignore" });

    const created = findSigningIdentity(identityName);
    if (!created) {
      throw new Error("created certificate was not found as a valid signing identity");
    }
    return created;
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

function parseIdentities(output: string): Array<{ hash: string; name: string }> {
  const identities: Array<{ hash: string; name: string }> = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*\d+\)\s+([0-9A-Fa-f]{40})\s+"([^"]+)"/.exec(line);
    if (!match) continue;
    identities.push({ hash: match[1], name: match[2] });
  }
  return identities;
}

function defaultUserKeychain(): string {
  const result = spawnSync("security", ["default-keychain", "-d", "user"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.status !== 0 || !output) {
    throw new Error("could not determine the user default keychain");
  }
  return output.replace(/^"|"$/g, "");
}

function requireExecutable(command: string, message: string): void {
  const result = spawnSync("/bin/sh", ["-c", `command -v ${command}`], {
    stdio: "ignore",
  });
  if (result.status !== 0) {
    throw new Error(
      `[!] ${command} not installed\n\n${message}\nPlease install ${command} and try again.`,
    );
  }
}

function isMachO(path: string): boolean {
  try {
    const fd = readFileSync(path, { flag: "r" }).subarray(0, 4);
    if (fd.length < 4) return false;
    const magic = fd.readUInt32BE(0);
    return MACHO_MAGICS.has(magic);
  } catch {
    return false;
  }
}

export function clearQuarantine(appRoot: string): void {
  if (platform() !== "darwin") return;
  try {
    execFileSync("xattr", ["-dr", "com.apple.quarantine", appRoot], {
      stdio: "ignore",
    });
  } catch {
    // no-op if not set
  }
}
