/**
 * NATS subject scheme + pairing parse (mirrors runtime/net/remote-subjects.ts).
 * The phone is a client: it publishes to `dp.<id>.rpc.<method>` and subscribes to
 * `dp.<id>.h2c.event.>`.
 */

const ROOT = "dp";

export function rpcSubject(instanceId: string, method: string): string {
  return `${ROOT}.${instanceId}.rpc.${method}`;
}

export function clientEventSubscription(instanceId: string): string {
  return `${ROOT}.${instanceId}.h2c.event.>`;
}

/** Parse the `<topic>` from a hub→client event subject, or null. */
export function topicFromSubject(subject: string): string | null {
  const prefix = `${ROOT}.`;
  if (!subject.startsWith(prefix)) return null;
  const marker = ".h2c.event.";
  const at = subject.indexOf(marker);
  if (at < 0) return null;
  return subject.slice(at + marker.length);
}

export interface PairingPayload {
  v: 1;
  instanceId: string;
  url: string;
  wsUrl?: string;
  name?: string;
  jwt?: string;
  seed?: string;
  user?: string;
  pass?: string;
}

function base64UrlDecodeToString(b64url: string): string {
  // Pure base64url → UTF-8 string (no atob/Buffer), for portability.
  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const s = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of s) {
    const idx = B64.indexOf(ch);
    if (idx < 0) continue;
    buffer = (buffer << 6) | idx;
    bits += 6;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  // bytes are UTF-8; decode
  let out = "";
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i++];
    if (b < 0x80) out += String.fromCharCode(b);
    else if (b < 0xe0) out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i++] & 0x3f));
    else if (b < 0xf0) out += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f));
    else {
      const cp = ((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
      const c = cp - 0x10000;
      out += String.fromCharCode(0xd800 + (c >> 10), 0xdc00 + (c & 0x3ff));
    }
  }
  return out;
}

/** Parse a `dprox://pair?d=<base64url(json)>` link. */
export function pairingFromString(s: string): PairingPayload | null {
  const m = /[?&]d=([^&]+)/.exec(s);
  if (!m) return null;
  try {
    const obj = JSON.parse(base64UrlDecodeToString(m[1]));
    return obj && obj.v === 1 && typeof obj.instanceId === "string" ? (obj as PairingPayload) : null;
  } catch {
    return null;
  }
}
