/**
 * Management commands — plugin/config/doctor.
 *
 * These are file-based (they read/write `~/.desktop-proxy/`), so they work
 * whether or not the app is running, and are designed to be scriptable by other
 * tools/agents via `--json`. When the app is running, the runtime's config
 * watcher applies most changes live.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { validateManifest, compareVersions } from "@desktop-proxy/plugin-sdk";

import { locateApp } from "../platform.js";
import { readFileInAsar } from "../asar.js";
import { readFuses, FuseV1 } from "../fuses.js";

const USER_ROOT = join(homedir(), ".desktop-proxy");
const CONFIG_FILE = join(USER_ROOT, "config.json");
const PLUGINS_DIR = join(USER_ROOT, "plugins");
const SAFE_MODE_FILE = join(USER_ROOT, "safe-mode");
const STATE_FILE = join(USER_ROOT, "state.json");
const RUNTIME_MAIN = join(USER_ROOT, "runtime", "main.js");

interface Config {
  autoUpdate?: boolean;
  safeMode?: boolean;
  stealth?: boolean;
  logLevel?: string;
  plugins?: Record<string, { enabled: boolean }>;
}

function readConfig(): Config {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeConfig(c: Config): void {
  mkdirSync(USER_ROOT, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2));
}

interface PluginInfo {
  id: string;
  name: string;
  version: string;
  scope: string;
  enabled: boolean;
  dir: string;
  githubRepo?: string;
}

function listPluginInfo(): PluginInfo[] {
  const cfg = readConfig();
  const result: PluginInfo[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(PLUGINS_DIR);
  } catch {
    return result;
  }
  for (const name of entries) {
    const dir = join(PLUGINS_DIR, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
      const manifestPath = join(dir, "manifest.json");
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (!validateManifest(manifest).valid) continue;
      result.push({
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        scope: manifest.scope,
        enabled: cfg.plugins?.[manifest.id]?.enabled !== false,
        dir,
        githubRepo: manifest.githubRepo,
      });
    } catch {
      // skip unreadable plugin
    }
  }
  return result;
}

// ── plugin ───────────────────────────────────────────────────────────────────

export function pluginList(json = false): void {
  const plugins = listPluginInfo();
  if (json) {
    console.log(JSON.stringify(plugins, null, 2));
    return;
  }
  if (plugins.length === 0) {
    console.log("\n  No plugins installed.\n");
    return;
  }
  console.log("");
  for (const p of plugins) {
    const dot = p.enabled ? "●" : "○";
    console.log(`  ${dot} ${p.id}  —  ${p.name} v${p.version} [${p.scope}]${p.enabled ? "" : "  (disabled)"}`);
  }
  console.log("");
}

export function pluginSetEnabled(id: string, enabled: boolean, json = false): void {
  if (!id) {
    fail("plugin id is required", json);
    return;
  }
  const cfg = readConfig();
  cfg.plugins ??= {};
  cfg.plugins[id] = { ...cfg.plugins[id], enabled };
  writeConfig(cfg);
  if (json) {
    console.log(JSON.stringify({ id, enabled }));
  } else {
    console.log(`\n  Plugin ${id} ${enabled ? "enabled" : "disabled"}.`);
    console.log("  Applied live if the app is running; otherwise on next launch.\n");
  }
}

async function latestRelease(repo: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "desktop-proxy" },
      signal: controller.signal,
    });
    if (res.status === 404) return null; // no published releases
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const data = (await res.json()) as { tag_name?: string; name?: string };
    return data.tag_name ?? data.name ?? null;
  } finally {
    clearTimeout(timer);
  }
}

export async function pluginCheckUpdates(json = false): Promise<void> {
  const plugins = listPluginInfo().filter((p) => p.githubRepo);
  if (plugins.length === 0) {
    if (json) console.log("[]");
    else console.log("\n  No plugins declare a githubRepo to check.\n");
    return;
  }

  const results = await Promise.all(
    plugins.map(async (p) => {
      try {
        const latest = await latestRelease(p.githubRepo as string);
        return {
          id: p.id,
          repo: p.githubRepo,
          current: p.version,
          latest,
          updateAvailable: latest ? compareVersions(latest, p.version) > 0 : false,
        };
      } catch (e) {
        return { id: p.id, repo: p.githubRepo, current: p.version, latest: null, updateAvailable: false, error: String(e) };
      }
    }),
  );

  if (json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  console.log("");
  for (const r of results) {
    if ("error" in r && r.error) console.log(`  ? ${r.id}: check failed (${r.error})`);
    else if (r.updateAvailable) console.log(`  ↑ ${r.id}: ${r.current} → ${r.latest}  (${r.repo})`);
    else console.log(`  ✓ ${r.id}: up to date (${r.current})`);
  }
  console.log("");
}

// ── config ───────────────────────────────────────────────────────────────────

const BOOL_KEYS = new Set(["autoUpdate", "safeMode", "stealth", "enforcePermissions"]);
const STRING_KEYS = new Set(["logLevel"]);
const NUMBER_KEYS = new Set(["maxResponseBodyBytes"]);
const SETTABLE = [...BOOL_KEYS, ...STRING_KEYS, ...NUMBER_KEYS];

export function configGet(key: string | undefined, json = false): void {
  const cfg = readConfig() as Record<string, unknown>;
  if (!key) {
    console.log(JSON.stringify(cfg, null, 2));
    return;
  }
  const value = cfg[key];
  if (json) {
    console.log(JSON.stringify(value ?? null));
  } else {
    console.log(value === undefined ? "(unset)" : typeof value === "string" ? value : JSON.stringify(value));
  }
}

export function configSet(key: string, value: string, json = false): void {
  if (!key || value === undefined) {
    fail(`usage: config set <key> <value> (settable: ${SETTABLE.join(", ")})`, json);
    return;
  }
  const cfg = readConfig() as Record<string, unknown>;
  if (BOOL_KEYS.has(key)) {
    cfg[key] = ["true", "1", "on", "yes"].includes(value.toLowerCase());
  } else if (STRING_KEYS.has(key)) {
    cfg[key] = value;
  } else if (NUMBER_KEYS.has(key)) {
    const n = Number(value);
    if (!Number.isFinite(n)) {
      fail(`"${key}" must be a number`, json);
      return;
    }
    cfg[key] = n;
  } else {
    fail(`unknown config key "${key}". Settable: ${SETTABLE.join(", ")}`, json);
    return;
  }
  writeConfig(cfg as Config);
  if (json) {
    console.log(JSON.stringify({ [key]: cfg[key] }));
  } else {
    console.log(`\n  config.${key} = ${JSON.stringify(cfg[key])}\n`);
  }
}

// ── doctor ─────────────────────────────────────────────────────────────────

type CheckStatus = "ok" | "warn" | "fail";
interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

export function doctor(json = false): void {
  const checks: Check[] = [];

  checks.push({
    name: "user-dir",
    status: existsSync(USER_ROOT) ? "ok" : "warn",
    detail: USER_ROOT,
  });

  checks.push({
    name: "runtime",
    status: existsSync(RUNTIME_MAIN) ? "ok" : "fail",
    detail: existsSync(RUNTIME_MAIN) ? RUNTIME_MAIN : `missing (${RUNTIME_MAIN}) — run install`,
  });

  try {
    const state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    checks.push({ name: "state", status: "ok", detail: `installed ${state.installedAt ?? "?"}` });
  } catch {
    checks.push({ name: "state", status: "warn", detail: "not installed (no state.json)" });
  }

  try {
    const app = locateApp();
    checks.push({ name: "app", status: "ok", detail: `${app.appName} @ ${app.appRoot}` });

    try {
      const pkg = JSON.parse(readFileInAsar(app.asarPath, "package.json").toString("utf8"));
      const patched = Boolean(pkg.__desktop_proxy);
      checks.push({
        name: "patched",
        status: patched ? "ok" : "fail",
        detail: patched ? `main=${pkg.main}` : "app.asar is NOT patched — run install/repair",
      });
    } catch (e) {
      checks.push({ name: "patched", status: "warn", detail: `could not read app.asar: ${String(e)}` });
    }

    if (existsSync(app.electronBinary)) {
      try {
        const integrity = readFuses(app.electronBinary).fuses[FuseV1.EnableEmbeddedAsarIntegrityValidation];
        checks.push({
          name: "integrity-fuse",
          status: integrity === "off" ? "ok" : "warn",
          detail: `EnableEmbeddedAsarIntegrityValidation=${integrity}`,
        });
      } catch (e) {
        checks.push({ name: "integrity-fuse", status: "warn", detail: String(e) });
      }
    }
  } catch (e) {
    checks.push({ name: "app", status: "fail", detail: (e as Error).message });
  }

  const plugins = listPluginInfo();
  checks.push({
    name: "plugins",
    status: "ok",
    detail: `${plugins.length} installed, ${plugins.filter((p) => p.enabled).length} enabled`,
  });

  const safeMode = existsSync(SAFE_MODE_FILE) || readConfig().safeMode === true;
  checks.push({ name: "safe-mode", status: safeMode ? "warn" : "ok", detail: safeMode ? "ON (plugins disabled)" : "off" });

  if (json) {
    const ok = checks.every((c) => c.status !== "fail");
    console.log(JSON.stringify({ ok, checks }, null, 2));
    return;
  }

  console.log("\ndesktop-proxy doctor\n");
  for (const c of checks) {
    const icon = c.status === "ok" ? "✓" : c.status === "warn" ? "!" : "✗";
    console.log(`  ${icon} ${c.name}: ${c.detail}`);
  }
  console.log("");
}

function fail(message: string, json: boolean): void {
  if (json) console.log(JSON.stringify({ error: message }));
  else console.error(`\n  Error: ${message}\n`);
  process.exit(1);
}
