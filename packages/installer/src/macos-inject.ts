/**
 * macOS "DYLD + V8-hook" injection backend — pure, testable helpers.
 *
 * This backend loads a native V8-compile-hook dylib into the Electron main
 * process (instead of patching app.asar). The dylib, on compiling the app's
 * entry script, prepends a small bootstrap that sets the DESKTOP_PROXY_* env and
 * requires the runtime. Loading a dylib into a hardened app requires re-signing
 * it with specific entitlements (see docs/macos-injection-plan.md).
 *
 * Only the *pure* pieces live here (entitlements/plist, the V8-hook TOML config,
 * the bootstrap source, and the injection plan as data) so they can be unit
 * tested without a device. The executor (Mach-O edit / shim, re-sign, launch)
 * consumes the plan and is intentionally separate.
 */

import { basename } from "node:path";

/** Entitlements the target must be re-signed with for dylib injection to work. */
export const MACOS_INJECT_ENTITLEMENTS: readonly string[] = [
  // Load our dylib though it isn't signed by the app's Team ID.
  "com.apple.security.cs.disable-library-validation",
  // Honor DYLD_INSERT_LIBRARIES (only needed for the dyld-shim vector, harmless otherwise).
  "com.apple.security.cs.allow-dyld-environment-variables",
  // Let Frida patch code pages under hardened runtime.
  "com.apple.security.cs.allow-unsigned-executable-memory",
  // Belt-and-suspenders for inline hooks vs. executable page protection.
  "com.apple.security.cs.disable-executable-page-protection",
];

/** Build the entitlements plist (XML) granting the keys above (all boolean true). */
export function buildEntitlementsPlist(keys: readonly string[] = MACOS_INJECT_ENTITLEMENTS): string {
  const body = keys.map((k) => `\t<key>${escapeXml(k)}</key>\n\t<true/>`).join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    body,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

export interface BootstrapOptions {
  userRoot: string;
  runtimeDir: string;
  /** Absolute path to the runtime entry (index.js) that the bootstrap requires. */
  runtimeEntry: string;
}

/**
 * The JS prepended to the app's entry script by the V8 hook. It must set the
 * env BEFORE requiring the runtime (the runtime reads requireEnv() at load), run
 * only in the main (browser) process, and guard against double-boot.
 */
export function buildBootstrap(opts: BootstrapOptions): string {
  const userRoot = jsString(opts.userRoot);
  const runtimeDir = jsString(opts.runtimeDir);
  const runtimeEntry = jsString(opts.runtimeEntry);
  return [
    "(function(){",
    "  try {",
    '    if (typeof process !== "undefined" && process.type && process.type !== "browser") return;',
    "    if (globalThis.__desktopProxyBooted) return; globalThis.__desktopProxyBooted = true;",
    `    process.env.DESKTOP_PROXY_USER_ROOT = process.env.DESKTOP_PROXY_USER_ROOT || ${userRoot};`,
    `    process.env.DESKTOP_PROXY_RUNTIME = process.env.DESKTOP_PROXY_RUNTIME || ${runtimeDir};`,
    `    require(${runtimeEntry});`,
    "  } catch (e) {",
    '    try { console.error("[desktop-proxy] bootstrap failed:", e); } catch (_e) {}',
    "  }",
    "})();",
  ].join("\n");
}

export interface V8HookConfigOptions {
  /** Substring of the entry script's V8 resource name to match (e.g. "main.js"). */
  entryKeyword: string;
  /** The bootstrap JS to insert before the matched script. */
  bootstrap: string;
  /** Rule name (TOML table key). */
  ruleName?: string;
}

/**
 * Build the v8_killer TOML config: match the entry script by resource-name
 * keyword and insert the bootstrap before it. Uses a literal (single-quoted)
 * multiline string so the JS body needs no escaping.
 */
export function buildV8HookConfig(opts: V8HookConfigOptions): string {
  if (opts.bootstrap.includes("'''")) {
    throw new Error("bootstrap must not contain ''' (breaks the TOML literal string)");
  }
  const rule = (opts.ruleName ?? "desktop_proxy_bootstrap").replace(/[^A-Za-z0-9_]/g, "_");
  return [
    `[rules.${rule}]`,
    `matcher = { type = "resource-name-keyword", keyword = ${tomlBasicString(opts.entryKeyword)} }`,
    "processors = [",
    "    { type = \"insert-before\", content = '''",
    opts.bootstrap,
    "''' },",
    "]",
    "",
  ].join("\n");
}

export type InjectionVector = "lc-load-dylib" | "dyld-shim";

export interface InjectionPlanInput {
  appRoot: string;
  /** The Mach-O that loads the dylib (Electron Framework binary or app exe). */
  electronBinary: string;
  /** Info.plist path (for backup/restore), if any. */
  metaPath: string | null;
  platform: string;
  vector: InjectionVector;
  dylibPath: string;
  configPath: string;
  bootstrapPath: string;
  entitlementsPath: string;
}

export interface InjectionStep {
  op:
    | "precondition"
    | "backup"
    | "stage-dylib"
    | "write-config"
    | "write-bootstrap"
    | "write-entitlements"
    | "inject-load-command"
    | "install-shim"
    | "resign-entitlements"
    | "clear-quarantine"
    | "write-state";
  detail: string;
  /** Primary path the step acts on, when applicable. */
  path?: string;
}

/**
 * Produce the ordered injection plan as data (so it can be asserted in tests and
 * reviewed before any destructive action). The executor runs these steps.
 */
export function planMacosInjection(input: InjectionPlanInput): InjectionStep[] {
  if (input.platform !== "darwin") {
    return [{ op: "precondition", detail: `unsupported platform: ${input.platform} (darwin only)` }];
  }

  const steps: InjectionStep[] = [
    { op: "backup", detail: "back up app bundle (and binary) before mutation", path: input.appRoot },
    { op: "stage-dylib", detail: "stage universal V8-hook dylib", path: input.dylibPath },
    { op: "write-bootstrap", detail: "write bootstrap JS", path: input.bootstrapPath },
    { op: "write-config", detail: "write v8_killer TOML config", path: input.configPath },
    { op: "write-entitlements", detail: "write injection entitlements plist", path: input.entitlementsPath },
  ];

  if (input.vector === "lc-load-dylib") {
    steps.push({
      op: "inject-load-command",
      detail: `insert LC_LOAD_DYLIB → ${basename(input.dylibPath)} into Mach-O (per slice)`,
      path: input.electronBinary,
    });
  } else {
    steps.push({
      op: "install-shim",
      detail: "install DYLD_INSERT_LIBRARIES shim as the bundle executable",
      path: input.appRoot,
    });
  }

  steps.push(
    {
      op: "resign-entitlements",
      detail: "deep re-sign bundle + framework + helpers with injection entitlements",
      path: input.appRoot,
    },
    { op: "clear-quarantine", detail: "xattr -dr com.apple.quarantine", path: input.appRoot },
    { op: "write-state", detail: "record backend=dyld, vector, backups, entitlements" },
  );

  return steps;
}

// ── escaping helpers ─────────────────────────────────────────────────────────

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function jsString(value: string): string {
  return JSON.stringify(value);
}

function tomlBasicString(value: string): string {
  return JSON.stringify(value); // TOML basic strings share JSON's escaping for our inputs
}
