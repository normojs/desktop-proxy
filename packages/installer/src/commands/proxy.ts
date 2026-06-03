/**
 * `proxy` command — point a VS Code-derived app (Cursor/Windsurf/VS Code) at a
 * local proxy + CA via settings.json/argv.json, with NO injection/re-sign.
 *
 * This is a renderer/extension-host supplement only. An AI IDE's own LLM calls
 * come from the main/Node process and are NOT captured here — use injection
 * (`desktop-proxy install`) + the in-process interceptors for those. See
 * docs/macos-injection-plan.md §9.6.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { locateApp } from "../platform.js";
import {
  buildVscodeSettingsPatch,
  buildArgvJsonPatch,
  mergeJson,
  removeKeys,
  parseJsonc,
  resolveForkPaths,
  nodeCaEnvHint,
  PROXY_SETTING_KEYS,
  ARGV_PROXY_KEYS,
  type ProxyConfigOptions,
} from "../proxy-config.js";

export interface ProxyOptions {
  app?: string;
  server?: string;
  bypass?: string;
  ca?: string;
  strictSSL?: boolean;
}

export type ProxySubcommand = "on" | "off" | "status";

function readText(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  } catch {
    return "";
  }
}

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

export function proxy(sub: ProxySubcommand, opts: ProxyOptions = {}): void {
  const codex = locateApp(opts.app);
  const paths = resolveForkPaths(codex.bundleId);

  console.log(`\ndesktop-proxy proxy ${sub}`);
  console.log(`  App: ${codex.appName} (${codex.bundleId ?? "unknown"})`);

  if (!paths) {
    console.error(`\n  ${codex.appName} is not a VS Code-derived app — the argv.json/proxy path`);
    console.error(`  only applies to Cursor / Windsurf / VS Code.`);
    console.error(`  For its main-process (AI) traffic, use injection: desktop-proxy install\n`);
    process.exit(1);
    return;
  }

  if (sub === "status") {
    const settings = parseJsonc(readText(paths.settingsJson));
    const argv = parseJsonc(readText(paths.argvJson));
    console.log(`\n  settings.json (${paths.settingsJson}):`);
    for (const k of PROXY_SETTING_KEYS) console.log(`    ${k} = ${JSON.stringify(settings[k] ?? null)}`);
    console.log(`\n  argv.json (${paths.argvJson}):`);
    for (const k of ARGV_PROXY_KEYS) console.log(`    ${k} = ${JSON.stringify(argv[k] ?? null)}`);
    console.log();
    return;
  }

  if (sub === "off") {
    writeText(paths.settingsJson, removeKeys(readText(paths.settingsJson) || "{}", PROXY_SETTING_KEYS));
    writeText(paths.argvJson, removeKeys(readText(paths.argvJson) || "{}", ARGV_PROXY_KEYS));
    console.log(`\n  ✓ Proxy config removed. Restart ${codex.appName} to apply.\n`);
    return;
  }

  // on
  if (!opts.server) {
    console.error("\n  --server <host:port> is required (e.g. --server 127.0.0.1:8888)\n");
    process.exit(1);
    return;
  }
  const cfg: ProxyConfigOptions = { proxyServer: opts.server, bypass: opts.bypass, strictSSL: opts.strictSSL };
  writeText(paths.settingsJson, mergeJson(readText(paths.settingsJson) || "{}", buildVscodeSettingsPatch(cfg)));
  writeText(paths.argvJson, mergeJson(readText(paths.argvJson) || "{}", buildArgvJsonPatch(cfg)));

  console.log(`\n  ✓ Proxy configured (renderer + extension host).`);
  console.log(`    settings.json: ${paths.settingsJson}`);
  console.log(`    argv.json:     ${paths.argvJson}`);
  if (opts.ca) {
    console.log(`\n  To also trust your CA in the app's Node requests, launch it with:`);
    console.log(`    ${nodeCaEnvHint(opts.ca)}`);
  }
  console.log(`\n  Note: this covers renderer/extension-host traffic only. The app's own`);
  console.log(`  main-process (AI/LLM) requests need injection: desktop-proxy install`);
  console.log(`  Restart ${codex.appName} to apply.\n`);
}
