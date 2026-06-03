import { describe, it, expect } from "vitest";

import {
  encodeBase32,
  decodeBase32,
  crc16,
  decodeSeed,
  encodeSeed,
  base64UrlFromBytes,
  PREFIX_USER,
  PREFIX_ACCOUNT,
} from "../src/nkey";

const enc = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));

describe("base32", () => {
  it("round-trips arbitrary bytes", () => {
    for (const sample of [[0], [255], [1, 2, 3, 4, 5], [0, 0, 0], [200, 100, 50, 25, 12, 6, 3]]) {
      const bytes = new Uint8Array(sample);
      expect(Array.from(decodeBase32(encodeBase32(bytes)))).toEqual(sample);
    }
  });
  it("rejects invalid characters", () => {
    expect(() => decodeBase32("018")).toThrow(); // 0, 1, 8 are not in the alphabet
  });
});

describe("crc16 (XMODEM)", () => {
  it("matches the standard test vector", () => {
    expect(crc16(enc("123456789"))).toBe(0x31c3);
  });
});

describe("base64url", () => {
  it("encodes without padding, url-safe", () => {
    expect(base64UrlFromBytes(enc("foobar"))).toBe("Zm9vYmFy");
    expect(base64UrlFromBytes(enc("fo"))).toBe("Zm8");
    expect(base64UrlFromBytes(new Uint8Array([255, 255, 255]))).toBe("____");
  });
});

describe("nkey seed", () => {
  it("round-trips a 32-byte ed25519 seed (user)", () => {
    const seed = new Uint8Array(32);
    for (let i = 0; i < 32; i++) seed[i] = (i * 7 + 3) & 0xff;
    const encoded = encodeSeed(seed, PREFIX_USER);
    expect(encoded.startsWith("SU")).toBe(true); // user seed prefix
    const decoded = decodeSeed(encoded);
    expect(decoded.typePrefix).toBe(PREFIX_USER);
    expect(Array.from(decoded.seed)).toEqual(Array.from(seed));
  });

  it("encodes an account seed as SA…", () => {
    const seed = new Uint8Array(32).fill(9);
    expect(encodeSeed(seed, PREFIX_ACCOUNT).startsWith("SA")).toBe(true);
  });

  it("rejects a tampered checksum", () => {
    const seed = new Uint8Array(32).fill(1);
    const encoded = encodeSeed(seed, PREFIX_USER);
    const broken = encoded.slice(0, -1) + (encoded.endsWith("A") ? "B" : "A");
    expect(() => decodeSeed(broken)).toThrow(/checksum|seed/);
  });

  it("rejects a non-seed string", () => {
    // A valid base32 blob that isn't a seed prefix.
    const body = new Uint8Array([0, 0, 1, 2, 3]);
    expect(() => decodeSeed(encodeBase32(body))).toThrow();
  });
});
