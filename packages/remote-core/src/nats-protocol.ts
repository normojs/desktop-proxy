/**
 * Minimal NATS wire protocol codec for the phone client (over a WebSocket).
 *
 * Parser is byte-accurate (MSG payload length is in bytes; control lines are
 * ASCII). It buffers partial frames and yields complete messages. Serializers
 * build CONNECT/SUB/PUB/PONG. Headers (HMSG) aren't used by us.
 */

import { utf8Encode, concatBytes } from "./util.js";

export type NatsMsg =
  | { kind: "INFO"; info: Record<string, unknown> }
  | { kind: "MSG"; subject: string; sid: string; reply?: string; payload: Uint8Array }
  | { kind: "PING" }
  | { kind: "PONG" }
  | { kind: "OK" }
  | { kind: "ERR"; message: string };

const CR = 13;
const LF = 10;

function asciiLine(buf: Uint8Array, start: number, end: number): string {
  let s = "";
  for (let i = start; i < end; i++) s += String.fromCharCode(buf[i]);
  return s;
}

function indexOfCRLF(buf: Uint8Array, from: number): number {
  for (let i = from; i + 1 < buf.length; i++) {
    if (buf[i] === CR && buf[i + 1] === LF) return i;
  }
  return -1;
}

/** Streaming NATS frame parser. Feed bytes from the socket; get complete messages. */
export class NatsParser {
  private buf: Uint8Array = new Uint8Array(0);

  push(chunk: Uint8Array): NatsMsg[] {
    this.buf = this.buf.length === 0 ? chunk : concatBytes(this.buf, chunk);
    const out: NatsMsg[] = [];
    let consumed = 0;

    for (;;) {
      const crlf = indexOfCRLF(this.buf, consumed);
      if (crlf < 0) break;
      const line = asciiLine(this.buf, consumed, crlf);
      const upper = line.slice(0, 4).toUpperCase();

      if (upper.startsWith("MSG ") || upper.startsWith("MSG\t")) {
        const parts = line.slice(4).trim().split(/\s+/);
        // MSG <subject> <sid> [reply] <#bytes>
        const nBytes = Number(parts[parts.length - 1]);
        const subject = parts[0];
        const sid = parts[1];
        const reply = parts.length === 4 ? parts[2] : undefined;
        const payloadStart = crlf + 2;
        const payloadEnd = payloadStart + nBytes;
        if (payloadEnd + 2 > this.buf.length) break; // wait for the full payload + trailing CRLF
        const payload = this.buf.slice(payloadStart, payloadEnd);
        out.push({ kind: "MSG", subject, sid, reply, payload });
        consumed = payloadEnd + 2;
        continue;
      }

      consumed = crlf + 2;
      if (upper.startsWith("INFO")) {
        try {
          out.push({ kind: "INFO", info: JSON.parse(line.slice(5)) as Record<string, unknown> });
        } catch {
          /* ignore malformed INFO */
        }
      } else if (upper.startsWith("PING")) {
        out.push({ kind: "PING" });
      } else if (upper.startsWith("PONG")) {
        out.push({ kind: "PONG" });
      } else if (line.startsWith("+OK")) {
        out.push({ kind: "OK" });
      } else if (line.startsWith("-ERR")) {
        out.push({ kind: "ERR", message: line.slice(4).trim().replace(/^'|'$/g, "") });
      }
    }

    this.buf = consumed === 0 ? this.buf : this.buf.slice(consumed);
    return out;
  }
}

export interface ConnectOpts {
  jwt?: string;
  sig?: string;
  user?: string;
  pass?: string;
  name?: string;
  lang?: string;
  version?: string;
}

export function buildConnect(opts: ConnectOpts): string {
  const o: Record<string, unknown> = {
    verbose: false,
    pedantic: false,
    protocol: 1,
    lang: opts.lang ?? "uts",
    version: opts.version ?? "0.1.0",
    name: opts.name ?? "dprox-app",
  };
  if (opts.jwt) o.jwt = opts.jwt;
  if (opts.sig) o.sig = opts.sig;
  if (opts.user) o.user = opts.user;
  if (opts.pass) o.pass = opts.pass;
  return `CONNECT ${JSON.stringify(o)}\r\n`;
}

export function buildSub(subject: string, sid: string): string {
  return `SUB ${subject} ${sid}\r\n`;
}

export function buildUnsub(sid: string): string {
  return `UNSUB ${sid}\r\n`;
}

export const PONG = "PONG\r\n";
export const PING = "PING\r\n";

/** PUB with a UTF-8 payload → bytes (header is ASCII, length is the byte count). */
export function buildPub(subject: string, reply: string | undefined, payload: string): Uint8Array {
  const body = utf8Encode(payload);
  const header = reply
    ? `PUB ${subject} ${reply} ${body.length}\r\n`
    : `PUB ${subject} ${body.length}\r\n`;
  return concatBytes(concatBytes(utf8Encode(header), body), utf8Encode("\r\n"));
}
