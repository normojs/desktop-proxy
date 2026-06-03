/**
 * `relay` command — manage the local model-traffic relay.
 *
 * The relay itself runs inside the injected runtime (config-gated by
 * `config.relay`); this command just configures it and, for Codex, points the
 * native core at it via `~/.codex/config.toml` (backed up first, fully
 * reversible). Forwarding to the previous upstream is preserved, so it chains
 * non-destructively in front of an existing relay (e.g. CodexPlusPlus's 57321).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, platform } from "node:os";

import {
  applyCodexRelay,
  removeCodexRelay,
  currentProvider,
  hasDproxRelay,
} from "../codex-config.js";
import { getIdeAdapter } from "../ide/adapters.js";
import {
  buildRelayLaunchdPlist,
  buildRelaySystemdService,
  buildRelayWindowsTaskCreateArgs,
  relayLaunchdPlistPath,
  relaySystemdServicePath,
  RELAY_MAC_LABEL,
  RELAY_UNIT_NAME,
  type RelayServiceSpec,
} from "../relay-service.js";

const USER_ROOT = join(homedir(), ".desktop-proxy");
const CONFIG_FILE = join(USER_ROOT, "config.json");
const LOG_DIR = join(USER_ROOT, "log");
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
  upstreamApi?: "responses" | "chat";
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

/**
 * Resolve a config-redirect IDE target from --ide/--codex (the adapter decides
 * what's possible). Returns the IDE id, or null if none requested. Exits with
 * honest guidance for IDEs whose model traffic isn't relay-redirectable.
 */
function resolveRedirectIde(opts: RelayOptions): string | null {
  const id = opts.ide ?? (opts.codex ? "codex" : null);
  if (!id) return null;
  const adapter = getIdeAdapter(id);
  if (!adapter) {
    console.error(`\n  Unknown IDE "${id}". Known: codex, cursor, windsurf.\n`);
    process.exit(1);
  }
  const mc = adapter.modelControl;
  if (mc.kind === "in-process") {
    console.error(
      `\n  ${adapter.displayName} calls the model in-process — the relay redirect doesn't apply.\n` +
        `  Use "dprox install --app <${adapter.displayName}>" + the in-app interceptors / raceRequest instead.\n`,
    );
    process.exit(1);
  }
  if (mc.kind === "language-server") {
    console.error(
      `\n  ${adapter.displayName}'s model client is a proprietary language server (not redirectable).\n` +
        `  You can observe its traffic via an HTTPS proxy + MITM CA, but not redirect it to another model.\n`,
    );
    process.exit(1);
  }
  if (mc.tool !== "codex") {
    console.error(`\n  config-redirect for ${adapter.displayName} is not implemented yet.\n`);
    process.exit(1);
  }
  return id;
}

export type RelaySubcommand = "on" | "off" | "status" | "daemon" | "service";

export interface RelayOptions {
  upstream?: string;
  key?: string;
  port?: number;
  proxy?: string;
  codex?: boolean;
  /** Target IDE id (codex/cursor/windsurf). `--codex` is sugar for `--ide codex`. */
  ide?: string;
  json?: boolean;
  /** Skip writing ~/.codex/auth.json (keep the real ChatGPT login). */
  noAuth?: boolean;
  /** Codex provider wire_api: "responses" (default) or "chat". */
  wireApi?: string;
  /** Relay upstream protocol: "chat" translates Responses↔chat for chat-only backends. */
  upstreamApi?: "responses" | "chat";
  /** model rewrite map (exact or `prefix*`). */
  modelMap?: Record<string, string>;
  /** ordered fallback models if the request errors. */
  fallbackModels?: string[];
}

export function relay(sub: RelaySubcommand, opts: RelayOptions = {}): void {
  if (sub === "status") return relayStatus(opts);
  if (sub === "off") return relayOff(opts);
  if (sub === "daemon") return relayDaemon();
  return relayOn(opts);
}

const here = dirname(fileURLToPath(import.meta.url));

/** Resolve the bundled standalone relay daemon (staged install, then dev tree). */
function resolveDaemon(): string | null {
  const candidates = [
    join(USER_ROOT, "runtime", "relay-daemon.js"),
    resolve(here, "..", "..", "..", "runtime", "dist", "relay-daemon.js"),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/**
 * Run the standalone relay daemon (foreground). For config-redirect IDEs (Codex)
 * this needs NO app injection — just `relay on --codex` + this daemon running.
 */
function relayDaemon(): void {
  const cfg = readConfig();
  if (cfg.relay?.enabled !== true || !cfg.relay.upstream) {
    console.error(`\n  Relay is not enabled. Run "dprox relay on ..." first.\n`);
    process.exit(1);
  }
  const daemon = resolveDaemon();
  if (!daemon) {
    console.error(`\n  relay-daemon.js not found. Build the runtime first: pnpm build:runtime\n`);
    process.exit(1);
  }
  console.log(`\n  Starting relay daemon (Ctrl-C to stop) — no app injection needed for config-redirect IDEs.\n`);
  const child = spawn(process.execPath, [daemon], { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
}

export type RelayServiceAction = "install" | "uninstall" | "status";

/** Run the relay daemon as a managed background service (auto-start + restart). */
export function relayService(action: RelayServiceAction): void {
  const plat = platform();
  if (action === "uninstall") return relayServiceUninstall(plat);
  if (action === "status") return relayServiceStatus(plat);

  const cfg = readConfig();
  if (cfg.relay?.enabled !== true || !cfg.relay.upstream) {
    console.error(`\n  Relay is not enabled. Run "dprox relay on ..." first.\n`);
    process.exit(1);
  }
  const daemon = resolveDaemon();
  if (!daemon) {
    console.error(`\n  relay-daemon.js not found. Build the runtime first: pnpm build:runtime\n`);
    process.exit(1);
  }
  mkdirSync(LOG_DIR, { recursive: true });
  const spec: RelayServiceSpec = { daemonArgs: [process.execPath, daemon], logFile: join(LOG_DIR, "relay-daemon.out") };

  if (plat === "darwin") {
    const plist = relayLaunchdPlistPath();
    mkdirSync(dirname(plist), { recursive: true });
    writeFileSync(plist, buildRelayLaunchdPlist(spec));
    spawnSync("launchctl", ["unload", plist], { stdio: "ignore" });
    const loaded = spawnSync("launchctl", ["load", "-w", plist], { encoding: "utf8" });
    if (loaded.status !== 0) {
      console.error(`\n  launchctl load failed: ${(loaded.stderr || loaded.stdout || "").trim()}\n`);
      process.exit(1);
    }
    console.log(`\n  ✓ Relay service installed (launchd, auto-start + keep-alive).`);
    console.log(`    Listen: http://127.0.0.1:${cfg.relay.port ?? DEFAULT_PORT}  Log: ${spec.logFile}\n`);
    return;
  }
  if (plat === "linux") {
    const unit = relaySystemdServicePath();
    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(unit, buildRelaySystemdService(spec));
    spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
    const enabled = spawnSync("systemctl", ["--user", "enable", "--now", `${RELAY_UNIT_NAME}.service`], { encoding: "utf8" });
    if (enabled.status !== 0) {
      console.error(`\n  systemctl enable failed: ${(enabled.stderr || enabled.stdout || "").trim()}`);
      console.error(`  Unit written to ${unit}; enable manually if needed.\n`);
      process.exit(1);
    }
    console.log(`\n  ✓ Relay service installed (systemd user, Restart=always).`);
    console.log(`    Listen: http://127.0.0.1:${cfg.relay.port ?? DEFAULT_PORT}  Log: ${spec.logFile}\n`);
    return;
  }
  if (plat === "win32") {
    const created = spawnSync("schtasks", buildRelayWindowsTaskCreateArgs(spec), { encoding: "utf8" });
    if (created.status !== 0) {
      console.error(`\n  schtasks create failed: ${(created.stderr || created.stdout || "").trim()}\n`);
      process.exit(1);
    }
    console.log(`\n  ✓ Relay service installed (Task Scheduler, starts at logon).\n`);
    return;
  }
  console.error(`\n  Unsupported platform: ${plat}\n`);
  process.exit(1);
}

function relayServiceUninstall(plat: string): void {
  if (plat === "darwin") {
    const plist = relayLaunchdPlistPath();
    spawnSync("launchctl", ["unload", "-w", plist], { stdio: "ignore" });
    try {
      unlinkSync(plist);
    } catch {
      /* gone */
    }
  } else if (plat === "linux") {
    spawnSync("systemctl", ["--user", "disable", "--now", `${RELAY_UNIT_NAME}.service`], { stdio: "ignore" });
    try {
      rmSync(relaySystemdServicePath(), { force: true });
    } catch {
      /* gone */
    }
    spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
  } else if (plat === "win32") {
    spawnSync("schtasks", ["/Delete", "/TN", RELAY_UNIT_NAME, "/F"], { stdio: "ignore" });
  }
  console.log(`\n  Relay service removed.\n`);
}

function relayServiceStatus(plat: string): void {
  let installed = false;
  let active = false;
  let detail = "";
  if (plat === "darwin") {
    const plist = relayLaunchdPlistPath();
    installed = existsSync(plist);
    active = (spawnSync("launchctl", ["list"], { encoding: "utf8" }).stdout ?? "").includes(RELAY_MAC_LABEL);
    detail = plist;
  } else if (plat === "linux") {
    installed = existsSync(relaySystemdServicePath());
    active = (spawnSync("systemctl", ["--user", "is-active", `${RELAY_UNIT_NAME}.service`], { encoding: "utf8" }).stdout ?? "")
      .trim()
      .startsWith("active");
    detail = relaySystemdServicePath();
  } else if (plat === "win32") {
    const q = spawnSync("schtasks", ["/Query", "/TN", RELAY_UNIT_NAME], { encoding: "utf8" });
    installed = q.status === 0;
    active = installed;
    detail = RELAY_UNIT_NAME;
  }
  const state = installed ? (active ? "installed (active)" : "installed (inactive)") : "not installed";
  console.log(`\n  Relay service: ${state}`);
  if (detail) console.log(`  ${detail}\n`);
}

function relayOn(opts: RelayOptions): void {
  const cfg = readConfig();
  const port = opts.port ?? cfg.relay?.port ?? DEFAULT_PORT;

  let upstream = opts.upstream ?? cfg.relay?.upstream;
  let token = opts.key;

  // Codex auto-wire: chain through the current provider unless an upstream/key
  // is explicitly given, so we sit in front of an existing relay without breaking it.
  const redirectIde = resolveRedirectIde(opts);
  let codexToml = "";
  if (redirectIde) {
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
    upstreamApi: opts.upstreamApi ?? cfg.relay?.upstreamApi,
  };
  writeConfig(cfg);

  if (redirectIde) {
    const providerToken = token ?? "dprox-local";
    const bak = `${CODEX_CONFIG}.dprox-bak-${stamp()}`;
    copyFileSync(CODEX_CONFIG, bak);
    writeFileSync(CODEX_CONFIG, applyCodexRelay(codexToml, { baseUrl: localBase, token: providerToken, wireApi: opts.wireApi }));
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
  if (cfg.relay.upstreamApi) console.log(`    Upstream API: ${cfg.relay.upstreamApi}${cfg.relay.upstreamApi === "chat" ? " (Responses↔chat translation)" : ""}`);
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

  const redirectIde = resolveRedirectIde(opts);
  if (redirectIde && existsSync(CODEX_CONFIG)) {
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
  console.log(`  Upstream API: ${r.upstreamApi ?? "responses"}`);
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
