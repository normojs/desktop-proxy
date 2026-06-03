/**
 * NATS nkeys — base32 + crc16 + seed decode (pure, portable).
 *
 * For JWT auth the phone must sign the server nonce with the device's ed25519
 * private key. The key is distributed as an nkey *seed* string (e.g. "SU...").
 * This module decodes that seed string to the raw 32-byte ed25519 seed; the
 * actual ed25519 signature is done by the platform (native UTS plugin / tweetnacl
 * on JS targets). Decoding + checksum is pure and unit-testable here.
 *
 * Seed layout (base32 of): [ b1, b2, <32 ed25519 seed bytes>, crc16(LE) ]
 *   b1 = PREFIX_SEED | (typePrefix >> 5);  b2 = (typePrefix & 31) << 3
 */

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const B32_REV = new Map<string, number>();
for (let i = 0; i < B32.length; i++) B32_REV.set(B32[i], i);

export const PREFIX_SEED = 18 << 3; // 144
export const PREFIX_OPERATOR = 14 << 3;
export const PREFIX_ACCOUNT = 0;
export const PREFIX_USER = 20 << 3; // 160

export function encodeBase32(data: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of data) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function decodeBase32(str: string): Uint8Array {
  const s = str.toUpperCase().replace(/=+$/, "");
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of s) {
    const idx = B32_REV.get(ch);
    if (idx === undefined) throw new Error(`invalid base32 char: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** CRC-16/XMODEM (poly 0x1021, init 0x0000) — the variant nkeys uses. */
export function crc16(data: Uint8Array): number {
  let crc = 0;
  for (const b of data) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x8000) !== 0 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc & 0xffff;
}

export interface DecodedSeed {
  /** Key type the seed is for (PREFIX_USER, PREFIX_ACCOUNT, …). */
  typePrefix: number;
  /** The raw 32-byte ed25519 seed. */
  seed: Uint8Array;
}

export function decodeSeed(encoded: string): DecodedSeed {
  const raw = decodeBase32(encoded);
  if (raw.length < 4) throw new Error("nkey seed too short");
  const body = raw.slice(0, raw.length - 2);
  const crcStored = raw[raw.length - 2] | (raw[raw.length - 1] << 8); // little-endian
  if (crc16(body) !== crcStored) throw new Error("invalid nkey checksum");
  const b1 = body[0];
  if ((b1 & 0xf8) !== PREFIX_SEED) throw new Error("not an nkey seed");
  const typePrefix = ((b1 & 7) << 5) | (body[1] >> 3);
  const seed = body.slice(2);
  if (seed.length !== 32) throw new Error(`unexpected ed25519 seed length: ${seed.length}`);
  return { typePrefix, seed };
}

export function encodeSeed(seed: Uint8Array, typePrefix: number): string {
  if (seed.length !== 32) throw new Error("ed25519 seed must be 32 bytes");
  const body = new Uint8Array(2 + 32);
  body[0] = PREFIX_SEED | (typePrefix >> 5);
  body[1] = (typePrefix & 31) << 3;
  body.set(seed, 2);
  const crc = crc16(body);
  const full = new Uint8Array(body.length + 2);
  full.set(body);
  full[body.length] = crc & 0xff;
  full[body.length + 1] = (crc >> 8) & 0xff;
  return encodeBase32(full);
}

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Base64url (no padding), implemented from scratch so it ports to UTS. */
export function base64UrlFromBytes(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64URL[b0 >> 2];
    out += B64URL[((b0 & 3) << 4) | (b1 >> 4)];
    if (i + 1 < bytes.length) out += B64URL[((b1 & 15) << 2) | (b2 >> 6)];
    if (i + 2 < bytes.length) out += B64URL[b2 & 63];
  }
  return out;
}
