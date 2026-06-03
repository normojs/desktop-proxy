/**
 * Secret redaction for persisted/exported traffic.
 *
 * Capture now records full headers and bodies everywhere (relay daemon + in-app
 * recorder), so anything written to disk must scrub credentials by default:
 * Authorization/api-key headers, and common secret shapes inside bodies
 * (sk-… keys, Bearer tokens, JSON api_key/token/password fields). A short prefix
 * is kept so you can still tell *which* key it was while debugging.
 *
 * Live in-memory inspection is left untouched; this only affects what hits disk.
 */

const SENSITIVE_HEADER =
  /^(authorization|proxy-authorization|x-api-key|api-key|openai-api-key|x-goog-api-key|cookie|set-cookie|x-auth-token)$/i;
const ANTHROPIC_KEY_HEADER = /anthropic.*key/i;

function maskToken(value: string): string {
  const v = value.trim();
  const m = /^(Bearer\s+)?(\S{0,6})\S+$/.exec(v);
  if (!m) return "***redacted***";
  const prefix = m[1] ?? "";
  return m[2] ? `${prefix}${m[2]}***` : "***redacted***";
}

export function redactHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
  if (!headers) return headers;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE_HEADER.test(k) || ANTHROPIC_KEY_HEADER.test(k) ? maskToken(String(v)) : v;
  }
  return out;
}

export function redactSecretsInText(text: string | null | undefined): string | null | undefined {
  if (text == null || text === "") return text;
  return text
    // OpenAI / DeepSeek style keys: keep "sk-" + 4 chars
    .replace(/\bsk-[A-Za-z0-9]{2}[A-Za-z0-9_-]{6,}/g, (m) => `${m.slice(0, 6)}***`)
    // Bearer tokens in text
    .replace(/\b(Bearer\s+)[A-Za-z0-9._-]{8,}/g, "$1***")
    // JSON credential fields
    .replace(
      /("(?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|token|password|secret|client[_-]?secret)"\s*:\s*")[^"]+(")/gi,
      "$1***$2",
    );
}

/**
 * Return a shallow copy of a finalized traffic entry with credentials scrubbed
 * from headers and bodies. Unknown shapes pass through untouched.
 */
export function redactEntry<T extends object>(entry: T): T {
  const e: Record<string, unknown> = { ...(entry as Record<string, unknown>) };
  for (const hk of ["reqHeaders", "resHeaders", "requestHeaders", "responseHeaders", "headers"]) {
    const h = e[hk];
    if (h && typeof h === "object" && !Array.isArray(h)) {
      e[hk] = redactHeaders(h as Record<string, string>);
    }
  }
  for (const bk of ["reqBody", "resBody", "postData", "body", "requestBody", "responseBody"]) {
    if (typeof e[bk] === "string") e[bk] = redactSecretsInText(e[bk] as string);
  }
  return e as T;
}
