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
  const writer = createTrafficWriter(join(LOG_DIR, "relay-daemon.ndjson"));
  const log = (level: string, ...args: unknown[]) => console.log(`[${ts()}] [${level}] relay:`, ...args);

  const pending = new Map<string, { method: string; url: string; headers: Record<string, string>; body: string | null }>();

  const opts: RelayOptions = {
    port: r.port ?? 8788,
    upstream: r.upstream,
    proxy: r.proxy,
    apiKey: r.apiKey,
    modelMap: r.modelMap,
    fallbackModels: r.fallbackModels,
    upstreamApi: r.upstreamApi,
    transforms: r.transforms,
    maxBodyBytes,
  };

  const handle = await startRelay(opts, {
    log,
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
      writer.write(redact ? redactEntry(record) : record);
    },
  });

  log("info", `daemon listening on http://127.0.0.1:${handle.port} → ${r.upstream}${r.upstreamApi === "chat" ? " (Responses↔chat)" : ""}`);
  log("info", `recording to ${join(LOG_DIR, "relay-daemon.ndjson")} — Ctrl-C to stop.`);

  const shutdown = () => {
    log("info", "shutting down");
    void handle.close().finally(() => {
      writer.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main().catch((e) => {
  console.error("relay daemon failed:", e);
  process.exit(1);
});
