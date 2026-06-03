/**
 * NATS subject scheme + pairing + ACL (pure, testable).
 *
 * Topology: the desktop is the hub; phones/CLI are clients. Directions use
 * distinct subjects so re-publishing never loops:
 *   - client → hub events:  dp.<id>.c2h.event.<topic>   (hub subscribes)
 *   - hub → client events:  dp.<id>.h2c.event.<topic>   (clients subscribe)
 *   - client → hub RPC:     dp.<id>.rpc.<method>        (NATS request/reply)
 *
 * Everything is scoped under `dp.<instanceId>.>` so per-device NATS permissions
 * isolate one paired desktop from another.
 */

const ROOT = "dp";

export function eventSubjectOut(instanceId: string, topic: string): string {
  return `${ROOT}.${instanceId}.h2c.event.${topic}`;
}
export function eventSubjectIn(instanceId: string, topic: string): string {
  return `${ROOT}.${instanceId}.c2h.event.${topic}`;
}
export function rpcSubject(instanceId: string, method: string): string {
  return `${ROOT}.${instanceId}.rpc.${method}`;
}

/** Subjects the hub (desktop) subscribes to. */
export function hubSubscriptions(instanceId: string): { events: string; rpc: string } {
  return { events: `${ROOT}.${instanceId}.c2h.event.>`, rpc: `${ROOT}.${instanceId}.rpc.>` };
}
/** Subjects a client (phone) subscribes to. */
export function clientSubscriptions(instanceId: string): { events: string } {
  return { events: `${ROOT}.${instanceId}.h2c.event.>` };
}

/** Parse the `<topic>` out of an event subject (either direction). */
export function topicFromSubject(subject: string): string | null {
  const m = new RegExp(`^${ROOT}\\.[^.]+\\.(?:c2h|h2c)\\.event\\.(.+)$`).exec(subject);
  return m ? m[1] : null;
}
/** Parse the `<method>` out of an rpc subject. */
export function methodFromSubject(subject: string): string | null {
  const m = new RegExp(`^${ROOT}\\.[^.]+\\.rpc\\.(.+)$`).exec(subject);
  return m ? m[1] : null;
}

// ── Pairing ───────────────────────────────────────────────────────────────────

export interface PairingPayload {
  v: 1;
  instanceId: string;
  /** NATS server URL for native clients (desktop/CLI), e.g. tls://host:4222. */
  url: string;
  /** WebSocket URL for browser/phone clients (nats.ws), e.g. wss://host:8443. */
  wsUrl?: string;
  /** Human label for the paired desktop. */
  name?: string;
  /** Decentralized JWT credentials (recommended): minted user JWT + nkey seed. */
  jwt?: string;
  seed?: string;
  /** Static fallback credentials. */
  user?: string;
  pass?: string;
}

export function buildPairingPayload(p: Omit<PairingPayload, "v">): PairingPayload {
  return { v: 1, ...p };
}

/** Serialize a pairing payload for a QR code / deep link. */
export function pairingToString(p: PairingPayload): string {
  return `desktopproxy://pair?d=${Buffer.from(JSON.stringify(p), "utf8").toString("base64url")}`;
}
export function pairingFromString(s: string): PairingPayload | null {
  const m = /[?&]d=([^&]+)/.exec(s);
  if (!m) return null;
  try {
    const obj = JSON.parse(Buffer.from(m[1], "base64url").toString("utf8"));
    return obj && obj.v === 1 && typeof obj.instanceId === "string" ? (obj as PairingPayload) : null;
  } catch {
    return null;
  }
}

// ── ACL (NATS subject permissions) ────────────────────────────────────────────

export interface SubjectPermissions {
  publish: string[];
  subscribe: string[];
}

/** Permissions for the desktop (hub) NATS user. */
export function hubPermissions(instanceId: string): SubjectPermissions {
  return {
    publish: [`${ROOT}.${instanceId}.h2c.event.>`, "_INBOX.>", `${ROOT}.${instanceId}.dev.>`],
    subscribe: [`${ROOT}.${instanceId}.c2h.event.>`, `${ROOT}.${instanceId}.rpc.>`, "_INBOX.>"],
  };
}

/** Permissions for a paired client (phone) NATS user — scoped to one instance. */
export function devicePermissions(instanceId: string): SubjectPermissions {
  return {
    publish: [`${ROOT}.${instanceId}.c2h.event.>`, `${ROOT}.${instanceId}.rpc.>`, "_INBOX.>"],
    subscribe: [`${ROOT}.${instanceId}.h2c.event.>`, "_INBOX.>"],
  };
}

// ── Remote RPC allowlist ──────────────────────────────────────────────────────

/**
 * Methods a REMOTE client (phone/CLI over NATS) may invoke. In-app (IPC) callers
 * have full access; remote is limited to the inspector + control surface and never
 * reaches `fs.*` / `cdp.*` / anything else on the bus.
 */
export const REMOTE_METHODS: ReadonlySet<string> = new Set([
  "config.get",
  "config.set",
  "plugin.list",
  "plugin.toggle",
  "traffic.list",
  "traffic.detail",
  "traffic.replay",
  "traffic.clear",
  "traffic.export",
  "relay.summary",
]);

export function isRemoteMethodAllowed(method: string): boolean {
  return REMOTE_METHODS.has(method);
}
