/**
 * Remote bus for the standalone relay daemon.
 *
 * Lets a phone/CLI reach the daemon's relay state over NATS (relay.summary,
 * config.get) WITHOUT injecting any app — the correct path for config-redirect
 * IDEs (Codex), where the relay lives in the daemon rather than an injected core.
 *
 * Mirrors the hub bus in index.ts but scoped to the daemon: same decentralized-JWT
 * connect, same remote allowlist gating, summary built from the daemon's own relay
 * config + persisted budget. Off unless `config.remote.enabled` + `url` are set.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { createBusRouter } from "@desktop-proxy/plugin-sdk";

import { buildRelaySummary } from "./net/relay-summary.js";
import { redactConfigForRemote } from "./net/redact.js";
import { isRemoteMethodAllowed } from "./net/remote-subjects.js";
import type { BudgetState } from "./net/budget.js";
import type { UiEntry } from "./net/relay-ui.js";
import { reconstructSessions } from "./net/chat-reconstruct.js";

type Logger = (level: string, ...args: unknown[]) => void;

const USER_ROOT = join(homedir(), ".desktop-proxy");
const CONFIG_FILE = join(USER_ROOT, "config.json");
const LOG_DIR = join(USER_ROOT, "log");

interface RemoteCfg {
  enabled?: boolean;
  url?: string;
  wsUrl?: string;
  caFile?: string;
  accountSeed?: string;
  accountId?: string;
  user?: string;
  pass?: string;
}

type RelayCfgLike = Parameters<typeof buildRelaySummary>[0];

function readConfig(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// The phone's pairing instanceId must match the bus instanceId. The injected
// runtime sets this on first launch; when running daemon-only we set it here.
function ensureInstanceId(): string {
  const cfg = readConfig();
  if (typeof cfg.instanceId === "string" && cfg.instanceId.length > 0) return cfg.instanceId;
  const id = randomUUID();
  try {
    writeFileSync(CONFIG_FILE, JSON.stringify({ ...cfg, instanceId: id }, null, 2));
  } catch {
    /* read-only config — still usable in-memory for this run */
  }
  return id;
}

export interface DaemonBus {
  instanceId: string;
  close(): Promise<void>;
}

/**
 * Connect the daemon to the remote bus. Returns null (and logs why) when remote
 * is not configured, so the daemon keeps running as a pure local relay.
 */
export async function startDaemonRemoteBus(opts: { relayPort: number; recent: UiEntry[]; reload: () => Promise<void>; log: Logger }): Promise<DaemonBus | null> {
  const cfg = readConfig();
  const r = (cfg.remote ?? {}) as RemoteCfg;
  if (r.enabled !== true || !r.url) {
    opts.log("info", "remote bus off (set config.remote.enabled + url to let a phone/CLI connect).");
    return null;
  }

  const instanceId = ensureInstanceId();
  const { connect, jwtAuthenticator } = await import("nats");
  const name = `dprox-daemon:${instanceId}`;
  const tls = r.caFile ? { tls: { caFile: r.caFile } } : {};

  let nc: Awaited<ReturnType<typeof connect>>;
  if (r.accountSeed && r.accountId) {
    const { mintHubCreds } = await import("./net/remote-jwt.js");
    const creds = await mintHubCreds(r.accountSeed, r.accountId, instanceId);
    nc = await connect({ servers: r.url, authenticator: jwtAuthenticator(creds.jwt, new TextEncoder().encode(creds.seed)), name, ...tls });
  } else {
    nc = await connect({ servers: r.url, user: r.user, pass: r.pass, name, ...tls });
  }

  const bus = createBusRouter({
    bridge: true,
    canReceive: (env, source) => {
      if (source !== "nats") return true;
      if (env.kind === "req") return isRemoteMethodAllowed(env.method);
      return true;
    },
  });

  const { createNatsHubTransport } = await import("./net/nats-transport.js");
  bus.addTransport("nats", createNatsHubTransport(nc, instanceId, opts.log));

  bus.handle("relay.summary", () => {
    const c = readConfig();
    const relay = c.relay as RelayCfgLike;
    const port = (relay as { port?: number } | undefined)?.port ?? opts.relayPort;
    let budgetState: BudgetState | undefined;
    try {
      budgetState = JSON.parse(readFileSync(join(LOG_DIR, `relay-${port}-budget.json`), "utf8")) as BudgetState;
    } catch {
      /* no spend yet */
    }
    return buildRelaySummary(relay, budgetState);
  });

  bus.handle("config.get", (_p, ctx) => {
    const c = { ...readConfig(), version: "daemon" };
    return ctx.source === "nats" ? redactConfigForRemote(c) : c;
  });

  // Remote control: merge a partial config, persist, then hot-reload the relay so
  // model-map / upstream / budget changes from the phone take effect immediately.
  bus.handle("config.set", async (p, ctx) => {
    const patch = (p ?? {}) as Record<string, unknown>;
    // A remote caller must not overwrite a real secret with the masked placeholder
    // it received from config.get; drop masked credential fields.
    if (ctx.source === "nats") {
      const relay = patch.relay as Record<string, unknown> | undefined;
      if (relay && typeof relay.apiKey === "string" && relay.apiKey.includes("***")) delete relay.apiKey;
    }
    const cfg = readConfig();
    const merged: Record<string, unknown> = { ...cfg };
    for (const k of Object.keys(patch)) {
      const v = patch[k];
      const cur = cfg[k];
      if (k === "relay" && v != null && typeof v === "object" && cur != null && typeof cur === "object") {
        merged.relay = { ...(cur as Record<string, unknown>), ...(v as Record<string, unknown>) };
      } else {
        merged[k] = v;
      }
    }
    writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2));
    try {
      await opts.reload();
    } catch (e) {
      opts.log("warn", "reload after config.set failed:", String(e));
    }
    return { ok: true };
  });

  // Recent relay calls from the in-memory ring buffer (newest first), wrapped in
  // { items } so phone clients can read it via UTSJSONObject.getArray.
  bus.handle("traffic.list", () => {
    const list = opts.recent;
    const n = list.length;
    const start = n > 200 ? n - 200 : 0;
    const items: Array<Record<string, unknown>> = [];
    for (let i = n - 1; i >= start; i--) {
      const e = list[i];
      items.push({
        i,
        t: e.startedDateTime ?? "",
        method: e.method ?? "",
        service: e.service ?? "",
        model: e.model ?? "",
        status: e.status ?? 0,
        costUsd: e.usage?.costUsd ?? null,
        totalTokens: e.usage?.totalTokens ?? null,
      });
    }
    return { items };
  });

  bus.handle("traffic.detail", (p) => {
    const i = typeof p === "number" ? p : -1;
    const e = i >= 0 && i < opts.recent.length ? opts.recent[i] : null;
    if (!e) return null;
    return {
      t: e.startedDateTime ?? "",
      method: e.method ?? "",
      url: e.url ?? "",
      status: e.status ?? 0,
      service: e.service ?? "",
      model: e.model ?? "",
      usage: e.usage ?? null,
      reqBody: e.reqBody ?? null,
      resBody: e.resBody ?? null,
    };
  });

  // Reconstructed conversations from captured relay traffic (the IDE's chat).
  bus.handle("chat.sessions", () => {
    const sessions = reconstructSessions(opts.recent);
    return {
      sessions: sessions.map((s) => ({
        key: s.key,
        title: s.title,
        model: s.model ?? "",
        turnCount: s.turnCount,
        requestCount: s.requestCount,
        totalTokens: s.totalTokens,
        totalCostUsd: s.totalCostUsd,
        lastActivity: s.lastActivity ?? "",
      })),
    };
  });

  bus.handle("chat.session", (p) => {
    const key = typeof p === "string" ? p : "";
    const s = reconstructSessions(opts.recent).find((x) => x.key === key);
    if (!s) return null;
    return {
      title: s.title,
      model: s.model ?? "",
      turns: s.turns.map((t) => ({
        role: t.role,
        text: t.text,
        tools: (t.toolCalls ?? []).map((c) => c.name).join(", "),
      })),
    };
  });

  opts.log("info", `remote bus connected: ${r.url} (instance ${instanceId})`);

  return {
    instanceId,
    close: async () => {
      bus.removeTransport("nats");
      try {
        await nc.close();
      } catch {
        /* ignore */
      }
    },
  };
}
