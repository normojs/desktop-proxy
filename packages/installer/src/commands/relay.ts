/**
 * `relay` command — manage the local model-traffic relay.
 *
 * The relay itself runs inside the injected runtime (config-gated by
 * `config.relay`); this command just configures it and, for Codex, points the
 * native core at it via `~/.codex/config.toml` (backed up first, fully
 * reversible). Forwarding to the previous upstream is preserved, so it chains
 * non-destructively in front of an existing relay (e.g. CodexPlusPlus's 57321).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import {
  applyCodexRelay,
  removeCodexRelay,
  currentProvider,
  hasDproxRelay,
} from "../codex-config.js";

const USER_ROOT = join(homedir(), ".desktop-proxy");
const CONFIG_FILE = join(USER_ROOT, "config.json");
const CODEX_DIR = join(homedir(), ".codex");
const CODEX_CONFIG = join(CODEX_DIR, "config.toml");
const CODEX_AUTH = join(CODEX_DIR, "auth.json");
const DEFAULT_PORT = 8788;

interface RelayCfg {
  enabled?: boolean;
  port?: number;
  upstream?: string;
  proxy?: string;
  apiKey?: string;
  modelMap?: Record<string, string>;
  fallbackModels?: string[];
}
interface Config {
  relay?: RelayCfg;
  [k: string]: unknown;
}

function readConfig(): Config {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as Config;
  } catch {
    return {};
  }
}

function writeConfig(c: Config): void {
  mkdirSync(USER_ROOT, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2));
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export type RelaySubcommand = "on" | "off" | "status";

export interface RelayOptions {
  upstream?: string;
  key?: string;
  port?: number;
  proxy?: string;
  codex?: boolean;
  json?: boolean;
  /** Skip writing ~/.codex/auth.json (keep the real ChatGPT login). */
  noAuth?: boolean;
  /** model rewrite map (exact or `prefix*`). */
  modelMap?: Record<string, string>;
  /** ordered fallback models if the request errors. */
  fallbackModels?: string[];
}

export function relay(sub: RelaySubcommand, opts: RelayOptions = {}): void {
  if (sub === "status") return relayStatus(opts);
  if (sub === "off") return relayOff(opts);
  return relayOn(opts);
}

function relayOn(opts: RelayOptions): void {
  const cfg = readConfig();
  const port = opts.port ?? cfg.relay?.port ?? DEFAULT_PORT;

  let upstream = opts.upstream ?? cfg.relay?.upstream;
  let token = opts.key;

  // Codex auto-wire: chain through the current provider unless an upstream/key
  // is explicitly given, so we sit in front of an existing relay without breaking it.
  let codexToml = "";
  if (opts.codex) {
    if (!existsSync(CODEX_CONFIG)) {
      console.error(`\n  Error: ${CODEX_CONFIG} not found — is Codex installed/configured?\n`);
      process.exit(1);
    }
    codexToml = readFileSync(CODEX_CONFIG, "utf8");
    const prov = currentProvider(codexToml);
    if (!upstream && prov?.baseUrl) upstream = prov.baseUrl;
    if (!token && prov?.token) token = prov.token;
  }

  if (!upstream) {
    console.error(`\n  Error: an upstream is required. Pass --upstream <url> (or --codex with an existing provider).\n`);
    process.exit(1);
  }

  const localBase = `http://127.0.0.1:${port}/v1`;
  // Guard against pointing the relay at itself (e.g. re-running --codex when the
  // active provider is already ours): that would be an infinite loop.
  if (upstream.replace(/\/+$/, "") === localBase.replace(/\/+$/, "")) {
    console.error(`\n  Error: upstream "${upstream}" is the relay itself (self-loop). Pass --upstream <real upstream>.\n`);
    process.exit(1);
  }

  cfg.relay = {
    enabled: true,
    port,
    upstream,
    proxy: opts.proxy ?? cfg.relay?.proxy,
    apiKey: opts.key ?? cfg.relay?.apiKey,
    modelMap: opts.modelMap ?? cfg.relay?.modelMap,
    fallbackModels: opts.fallbackModels ?? cfg.relay?.fallbackModels,
  };
  writeConfig(cfg);

  if (opts.codex) {
    const providerToken = token ?? "dprox-local";
    const bak = `${CODEX_CONFIG}.dprox-bak-${stamp()}`;
    copyFileSync(CODEX_CONFIG, bak);
    writeFileSync(CODEX_CONFIG, applyCodexRelay(codexToml, { baseUrl: localBase, token: providerToken }));
    console.log(`\n  ✓ Codex core pointed at the relay (${localBase}).`);
    console.log(`    Backup:  ${bak}`);

    // Login bypass (the CodexPlusPlus trick): Codex authenticates via API key when
    // ~/.codex/auth.json has OPENAI_API_KEY, skipping the ChatGPT OAuth screen.
    if (opts.noAuth !== true) {
      if (existsSync(CODEX_AUTH)) copyFileSync(CODEX_AUTH, `${CODEX_AUTH}.dprox-bak-${stamp()}`);
      writeFileSync(CODEX_AUTH, JSON.stringify({ OPENAI_API_KEY: providerToken }, null, 2));
      console.log(`    ✓ Wrote ~/.codex/auth.json (OPENAI_API_KEY) — Codex skips ChatGPT login.`);
    }
    console.log(`    Revert:  dprox relay off --codex`);
  }

  console.log(`\n  ✓ relay enabled`);
  console.log(`    Listen:   ${localBase}`);
  console.log(`    Upstream: ${upstream}`);
  if (cfg.relay.proxy) console.log(`    Proxy:    ${cfg.relay.proxy}`);
  if (cfg.relay.modelMap && Object.keys(cfg.relay.modelMap).length) {
    console.log(`    Model map: ${Object.entries(cfg.relay.modelMap).map(([k, v]) => `${k}→${v}`).join(", ")}`);
  }
  if (cfg.relay.fallbackModels?.length) console.log(`    Fallback:  ${cfg.relay.fallbackModels.join(", ")}`);
  console.log(`\n  The relay runs inside the injected app (applied live via the config watcher).`);
  console.log(`  Restart the target app so its core re-reads config and dials the relay.`);
  if (opts.codex) console.log(`  For Codex, relaunch via Codex++ so its downstream relay is up too.`);
  console.log();
}

function relayOff(opts: RelayOptions): void {
  const cfg = readConfig();
  if (cfg.relay) {
    cfg.relay.enabled = false;
    writeConfig(cfg);
  }

  if (opts.codex && existsSync(CODEX_CONFIG)) {
    const toml = readFileSync(CODEX_CONFIG, "utf8");
    if (hasDproxRelay(toml)) {
      const bak = `${CODEX_CONFIG}.dprox-bak-${stamp()}`;
      copyFileSync(CODEX_CONFIG, bak);
      writeFileSync(CODEX_CONFIG, removeCodexRelay(toml));
      console.log(`\n  ✓ Codex config restored to its previous provider (backup: ${bak}).`);
    }
    // Undo the login bypass: restore the most recent auth.json backup, else
    // remove the one we wrote (so Codex asks for real login again).
    if (existsSync(CODEX_AUTH)) {
      const baks = readdirSync(CODEX_DIR)
        .filter((f) => f.startsWith("auth.json.dprox-bak-"))
        .sort();
      const latest = baks[baks.length - 1];
      if (latest) {
        copyFileSync(join(CODEX_DIR, latest), CODEX_AUTH);
        console.log(`  ✓ Restored ~/.codex/auth.json from ${latest}.`);
      } else {
        rmSync(CODEX_AUTH, { force: true });
        console.log(`  ✓ Removed ~/.codex/auth.json (login required again).`);
      }
    }
  }

  console.log(`\n  ✓ relay disabled. Restart the target app to apply.\n`);
}

function relayStatus(opts: RelayOptions): void {
  const cfg = readConfig();
  const r = cfg.relay ?? {};
  const codexExists = existsSync(CODEX_CONFIG);
  const prov = codexExists ? currentProvider(readFileSync(CODEX_CONFIG, "utf8")) : null;
  const codexWired = codexExists ? hasDproxRelay(readFileSync(CODEX_CONFIG, "utf8")) : false;

  if (opts.json) {
    console.log(JSON.stringify({ relay: r, codexWired, codexProvider: prov }, null, 2));
    return;
  }

  console.log(`\ndprox relay\n`);
  console.log(`  Enabled:  ${r.enabled ? "yes" : "no"}`);
  console.log(`  Listen:   http://127.0.0.1:${r.port ?? DEFAULT_PORT}/v1`);
  console.log(`  Upstream: ${r.upstream ?? "(unset)"}`);
  console.log(`  Proxy:    ${r.proxy ?? "(none)"}`);
  if (r.modelMap && Object.keys(r.modelMap).length) {
    console.log(`  Model map: ${Object.entries(r.modelMap).map(([k, v]) => `${k}→${v}`).join(", ")}`);
  }
  if (r.fallbackModels?.length) console.log(`  Fallback:  ${r.fallbackModels.join(", ")}`);
  if (codexExists) {
    console.log(`\n  Codex config.toml:`);
    console.log(`    Active provider: ${prov?.name ?? "(none)"} → ${prov?.baseUrl ?? "(no base_url)"}`);
    console.log(`    dprox-wired:     ${codexWired ? "yes" : "no"}`);
  }
  let loginBypass = false;
  try {
    loginBypass = typeof (JSON.parse(readFileSync(CODEX_AUTH, "utf8")) as { OPENAI_API_KEY?: unknown }).OPENAI_API_KEY === "string";
  } catch {
    /* no auth.json */
  }
  console.log(`    login bypass:    ${loginBypass ? "on (auth.json OPENAI_API_KEY)" : "off (ChatGPT login)"}`);
  console.log();
}
