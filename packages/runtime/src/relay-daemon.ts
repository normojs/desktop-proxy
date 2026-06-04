/**
 * Standalone relay daemon — runs the model-traffic relay WITHOUT injecting any
 * app. For config-redirect IDEs (Codex, and any OpenAI-compatible core), this is
 * all you need: point the core's config at this relay (`dprox relay on --codex`)
 * and run this daemon. No asar patching, no re-signing, no sudo, no TCC.
 *
 * It reads `~/.desktop-proxy/config.json` (the `relay` block), starts the relay,
 * and records each call to `log/relay-daemon.ndjson` (with analysis + AI cost).
 * Bundled to `dist/relay-daemon.js` (pure Node — no Electron).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, mkdirSync } from "node:fs";

import { startRelay, type RelayOptions } from "./net/relay.js";
import { createTrafficWriter } from "./net/traffic-persist.js";
import { analyzeEntry } from "./net/traffic-analyze.js";
import { extractUsage } from "./net/traffic-cost.js";
import { redactEntry } from "./net/redact.js";
import type { RelayTransforms } from "./net/transform.js";
import type { RouteRule } from "./net/route.js";
import type { GuardRule } from "./net/guardrails.js";
import { createBudgetTracker, type BudgetConfig } from "./net/budget.js";
import { startRelayUi, type UiEntry } from "./net/relay-ui.js";
import { startDaemonRemoteBus, type DaemonBus } from "./daemon-bus.js";

const USER_ROOT = join(homedir(), ".desktop-proxy");
const LOG_DIR = join(USER_ROOT, "log");

interface RelayCfg {
  enabled?: boolean;
  port?: number;
  upstream?: string;
  proxy?: string;
  apiKey?: string;
  modelMap?: Record<string, string>;
  fallbackModels?: string[];
  upstreamApi?: "responses" | "chat";
  transforms?: RelayTransforms;
  routes?: RouteRule[];
  guardrails?: GuardRule[];
  budget?: BudgetConfig;
  /** Local dashboard port (default relay port + 1; set 0 to disable). */
  uiPort?: number;
}

function ts(): string {
  return new Date().toISOString();
}

function readRelayConfig(): { relay: RelayCfg; maxBodyBytes: number; redact: boolean } {
  let cfg: { relay?: RelayCfg; maxResponseBodyBytes?: number; redactSecrets?: boolean } = {};
  try {
    cfg = JSON.parse(readFileSync(join(USER_ROOT, "config.json"), "utf8"));
  } catch {
    /* defaults */
  }
  return {
    relay: cfg.relay ?? {},
    maxBodyBytes: cfg.maxResponseBodyBytes ?? 1024 * 1024,
    redact: cfg.redactSecrets !== false,
  };
}

async function main(): Promise<void> {
  const { relay: r, maxBodyBytes, redact } = readRelayConfig();
  if (r.enabled !== true || !r.upstream) {
    console.error(`relay daemon: config.relay is disabled or missing an upstream.\nRun e.g. "dprox relay on --codex --upstream <url> --key <key> --upstream-api chat" first.`);
    process.exit(1);
  }

  mkdirSync(LOG_DIR, { recursive: true });
  const relayPort = r.port ?? 8788;
  // Per-port filenames so a daemon and an injected app (or two relays) on
  // different ports never clobber each other's capture/budget files.
  const writer = createTrafficWriter(join(LOG_DIR, `relay-${relayPort}.ndjson`));
  const log = (level: string, ...args: unknown[]) => console.log(`[${ts()}] [${level}] relay:`, ...args);

  const pending = new Map<string, { method: string; url: string; headers: Record<string, string>; body: string | null }>();
  // In-memory ring buffer powering the local dashboard.
  const recent: UiEntry[] = [];
  const RECENT_MAX = 1000;
  const budget = createBudgetTracker(join(LOG_DIR, `relay-${relayPort}-budget.json`), () => r.budget);

  const opts: RelayOptions = {
    port: r.port ?? 8788,
    upstream: r.upstream,
    proxy: r.proxy,
    apiKey: r.apiKey,
    modelMap: r.modelMap,
    fallbackModels: r.fallbackModels,
    upstreamApi: r.upstreamApi,
    transforms: r.transforms,
    routes: r.routes,
    guardrails: r.guardrails,
    maxBodyBytes,
  };

  const handle = await startRelay(opts, {
    log,
    beforeForward: () => {
      const v = budget.check();
      if (!v.over) return undefined;
      const msg = `relay budget exceeded: ${v.scope} $${v.spent.toFixed(4)} ≥ $${v.limit}`;
      if (r.budget?.action === "block") return { block: true, status: 402, message: msg };
      log("warn", msg);
      return undefined;
    },
    onRequest: (req) => pending.set(req.id, { method: req.method, url: req.url, headers: req.headers, body: req.body }),
    onResponse: (resp) => {
      const req = pending.get(resp.requestId);
      pending.delete(resp.requestId);
      let model: string | undefined;
      try {
        model = JSON.parse(req?.body ?? "{}").model;
      } catch {
        /* not JSON */
      }
      const analysis = analyzeEntry({
        method: req?.method ?? "",
        url: req?.url ?? "",
        source: "relay",
        postData: req?.body,
        resHeaders: resp.headers,
        status: resp.status,
      });
      const usage = extractUsage(model ?? analysis.model, resp.body);
      log(
        resp.status >= 400 ? "warn" : "info",
        `${req?.method ?? "?"} ${resp.status} ${analysis.service} ${model ?? analysis.model ?? ""}` +
          (usage?.costUsd != null ? ` $${usage.costUsd.toFixed(5)}` : ""),
      );
      const record = {
        startedDateTime: ts(),
        method: req?.method,
        url: req?.url,
        status: resp.status,
        category: analysis.category,
        service: analysis.service,
        kind: analysis.kind,
        model: model ?? analysis.model,
        tags: analysis.tags,
        usage,
        reqHeaders: req?.headers,
        reqBody: req?.body,
        resBody: resp.body,
      };
      const persisted = redact ? redactEntry(record) : record;
      writer.write(persisted);
      recent.push(persisted as UiEntry);
      if (recent.length > RECENT_MAX) recent.shift();
      if (usage?.costUsd) budget.record(usage.costUsd);
    },
  });

  log("info", `daemon listening on http://127.0.0.1:${handle.port} → ${r.upstream}${r.upstreamApi === "chat" ? " (Responses↔chat)" : ""}`);
  log("info", `recording to ${join(LOG_DIR, `relay-${relayPort}.ndjson`)} — Ctrl-C to stop.`);

  // Local dashboard (no-injection visibility). uiPort 0 disables it.
  const uiPort = r.uiPort ?? handle.port + 1;
  let uiServer: ReturnType<typeof startRelayUi> | null = null;
  if (uiPort > 0) {
    try {
      uiServer = startRelayUi(uiPort, () => recent, log);
    } catch (e) {
      log("warn", "dashboard failed to start:", String(e));
    }
  }

  // Remote bus (NATS) — lets a phone/CLI reach relay.summary WITHOUT injection.
  // The right path for config-redirect IDEs (Codex). No-op unless config.remote
  // is enabled. Failures are non-fatal: the daemon keeps relaying locally.
  let remoteBus: DaemonBus | null = null;
  try {
    remoteBus = await startDaemonRemoteBus({ relayPort, log });
  } catch (e) {
    log("warn", "remote bus failed:", String(e));
  }

  const shutdown = () => {
    log("info", "shutting down");
    uiServer?.close();
    void remoteBus?.close();
    void handle.close().finally(() => {
      writer.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main().catch((e) => {
  if ((e as NodeJS.ErrnoException)?.code === "EADDRINUSE") {
    console.error(
      `relay daemon: ${String((e as Error).message || e)}\n` +
        `Another relay is already running. Stop it, or set a different config.relay.port.`,
    );
  } else {
    console.error("relay daemon failed:", e);
  }
  process.exit(1);
});
