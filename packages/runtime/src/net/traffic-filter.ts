/**
 * Traffic filter DSL (pure) — DevTools-style query language for the inspector.
 *
 *   status:>=400 method:POST domain:openai.com larger-than:1k is:stream
 *   body:"insufficient_quota" -domain:telemetry has:authorization model:gpt-4o
 *
 * `parseQuery(text)` → predicates; `matchEntry(entry, predicates)` → boolean
 * (AND of all predicates; `-` negates; bare words match url/service/label).
 * No I/O — fully unit-testable.
 */

export interface Predicate {
  key: string; // "" = free text
  value: string;
  negate: boolean;
}

export interface FilterEntry {
  method: string;
  url: string;
  host: string;
  path: string;
  status: number | null;
  kind: string;
  category: string;
  service: string;
  source: string;
  contentType: string;
  reqHeaders: Record<string, string>;
  resHeaders: Record<string, string>;
  reqBody: string | null;
  resBody: string | null;
  reqSize: number;
  resSize: number;
  timeMs: number | null;
  model?: string;
  tags: string[];
  startMs: number;
  label: string;
}

/** Tokenize respecting "quoted phrases"; split each into {key,value,negate}. */
export function parseQuery(text: string): Predicate[] {
  const out: Predicate[] = [];
  const tokens = text.match(/-?(?:[^\s:"]+:)?(?:"[^"]*"|\/[^/]*\/|[^\s"]+)|"[^"]*"/g) ?? [];
  for (let raw of tokens) {
    let negate = false;
    if (raw.startsWith("-")) {
      negate = true;
      raw = raw.slice(1);
    }
    const colon = raw.indexOf(":");
    let key = "";
    let value = raw;
    if (colon > 0 && !raw.slice(0, colon).includes('"')) {
      key = raw.slice(0, colon).toLowerCase();
      value = raw.slice(colon + 1);
    }
    value = stripQuotes(value);
    if (value === "" && key === "") continue;
    out.push({ key, value, negate });
  }
  return out;
}

export function matchEntry(e: FilterEntry, predicates: Predicate[]): boolean {
  for (const p of predicates) {
    const ok = evalPredicate(e, p);
    if (p.negate ? ok : !ok) return false;
  }
  return true;
}

function evalPredicate(e: FilterEntry, p: Predicate): boolean {
  const v = p.value;
  switch (p.key) {
    case "":
      return (
        ci(e.url).includes(ci(v)) ||
        ci(e.service).includes(ci(v)) ||
        ci(e.label).includes(ci(v)) ||
        ci(e.host).includes(ci(v))
      );
    case "status":
      return statusMatch(e.status, v);
    case "method":
      return ci(e.method) === ci(v);
    case "kind":
      return ci(e.kind) === ci(v);
    case "category":
    case "cat":
      return ci(e.category) === ci(v);
    case "service":
      return ci(e.service).includes(ci(v));
    case "source":
      return ci(e.source).includes(ci(v));
    case "domain":
    case "host":
      return ci(e.host).includes(ci(v));
    case "path":
      return ci(e.path).includes(ci(v));
    case "type":
    case "content-type":
    case "mime":
      return ci(e.contentType).includes(ci(v));
    case "model":
      return !!e.model && ci(e.model).includes(ci(v));
    case "size":
      return cmp(e.reqSize + e.resSize, v, parseSize);
    case "req-size":
      return cmp(e.reqSize, v, parseSize);
    case "res-size":
      return cmp(e.resSize, v, parseSize);
    case "larger-than":
      return e.reqSize + e.resSize > parseSize(v);
    case "smaller-than":
      return e.reqSize + e.resSize < parseSize(v);
    case "time":
      return cmp(e.timeMs, v, parseDuration);
    case "slower-than":
      return e.timeMs != null && e.timeMs > parseDuration(v);
    case "faster-than":
      return e.timeMs != null && e.timeMs < parseDuration(v);
    case "has":
      return hasHeader(e, v);
    case "header":
      return headerMatch(e, v);
    case "body":
      return bodyMatch(e.reqBody, v) || bodyMatch(e.resBody, v);
    case "req-body":
      return bodyMatch(e.reqBody, v);
    case "res-body":
      return bodyMatch(e.resBody, v);
    case "is":
      return isFlag(e, ci(v));
    case "since":
      return e.startMs >= Date.now() - parseDuration(v);
    default:
      // Unknown key → treat the whole token as free text.
      return ci(e.url).includes(ci(`${p.key}:${v}`));
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function ci(s: string): string {
  return s.toLowerCase();
}

function stripQuotes(s: string): string {
  return s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
}

function statusMatch(status: number | null, expr: string): boolean {
  if (status == null) return /^pending$/i.test(expr);
  const e = expr.trim().toLowerCase();
  if (e === "ok") return status < 400;
  if (e === "error") return status >= 400;
  const cls = /^([1-5])xx$/.exec(e);
  if (cls) return Math.floor(status / 100) === Number(cls[1]);
  return cmp(status, expr, (s) => Number(s));
}

function cmp(actual: number | null, expr: string, parse: (s: string) => number): boolean {
  if (actual == null) return false;
  const m = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(expr.trim());
  if (!m) return false;
  const n = parse(m[2]);
  if (Number.isNaN(n)) return false;
  switch (m[1] || "=") {
    case ">=":
      return actual >= n;
    case "<=":
      return actual <= n;
    case ">":
      return actual > n;
    case "<":
      return actual < n;
    default:
      return actual === n;
  }
}

export function parseSize(s: string): number {
  const m = /^([\d.]+)\s*(b|kb|k|mb|m|gb|g)?$/i.exec(s.trim());
  if (!m) return NaN;
  const n = parseFloat(m[1]);
  const unit = (m[2] || "b").toLowerCase();
  const mult = unit.startsWith("g") ? 1e9 : unit.startsWith("m") ? 1e6 : unit.startsWith("k") ? 1e3 : 1;
  return n * mult;
}

export function parseDuration(s: string): number {
  const m = /^([\d.]+)\s*(ms|s|m|h)?$/i.exec(s.trim());
  if (!m) return NaN;
  const n = parseFloat(m[1]);
  const unit = (m[2] || "ms").toLowerCase();
  return unit === "h" ? n * 3.6e6 : unit === "m" ? n * 60000 : unit === "s" ? n * 1000 : n;
}

function hasHeader(e: FilterEntry, name: string): boolean {
  const k = ci(name);
  return Object.keys(e.reqHeaders).some((h) => ci(h) === k) || Object.keys(e.resHeaders).some((h) => ci(h) === k);
}

function headerMatch(e: FilterEntry, expr: string): boolean {
  const eq = expr.indexOf("=");
  if (eq < 0) return hasHeader(e, expr);
  const name = ci(expr.slice(0, eq));
  const want = ci(expr.slice(eq + 1));
  const find = (h: Record<string, string>) =>
    Object.entries(h).some(([k, val]) => ci(k) === name && ci(String(val)).includes(want));
  return find(e.reqHeaders) || find(e.resHeaders);
}

function bodyMatch(body: string | null, expr: string): boolean {
  if (!body) return false;
  const re = /^\/(.+)\/([a-z]*)$/.exec(expr);
  if (re) {
    try {
      return new RegExp(re[1], re[2] || "i").test(body);
    } catch {
      return false;
    }
  }
  return ci(body).includes(ci(expr));
}

function isFlag(e: FilterEntry, flag: string): boolean {
  switch (flag) {
    case "ws":
      return e.kind === "ws";
    case "sse":
      return e.kind === "sse";
    case "stream":
      return e.tags.includes("stream") || e.kind === "sse";
    case "error":
      return (e.status != null && e.status >= 400) || e.tags.includes("error");
    case "ok":
      return e.status != null && e.status < 400;
    case "pending":
      return e.status == null;
    default:
      return e.tags.includes(flag);
  }
}
