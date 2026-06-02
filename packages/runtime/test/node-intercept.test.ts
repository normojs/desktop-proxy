import { describe, it, expect } from "vitest";

import { normalizeHttpArgs, flattenHeaders, decodeBody } from "../src/net/node-intercept";

describe("normalizeHttpArgs", () => {
  it("parses url string + options", () => {
    const r = normalizeHttpArgs("https:", ["https://api.x.com/v1/chat", { method: "post", headers: { a: "b" } }]);
    expect(r.method).toBe("POST");
    expect(r.url).toBe("https://api.x.com/v1/chat");
    expect(r.headers).toEqual({ a: "b" });
  });

  it("parses an options object (hostname + path)", () => {
    const r = normalizeHttpArgs("http:", [{ hostname: "api.x.com", path: "/v1", method: "GET" }]);
    expect(r.url).toBe("http://api.x.com/v1");
  });

  it("preserves an explicit port", () => {
    expect(normalizeHttpArgs("http:", [{ host: "localhost", port: 3000, path: "/" }]).url).toBe(
      "http://localhost:3000/",
    );
  });

  it("extracts a port embedded in host", () => {
    expect(normalizeHttpArgs("http:", [{ host: "localhost:8080", path: "/x" }]).url).toBe(
      "http://localhost:8080/x",
    );
  });

  it("parses a URL object", () => {
    expect(normalizeHttpArgs("http:", [new URL("https://h/p?q=1")]).url).toBe("https://h/p?q=1");
  });

  it("defaults method to GET and path to /", () => {
    const r = normalizeHttpArgs("http:", [{ hostname: "h" }]);
    expect(r.method).toBe("GET");
    expect(r.url).toBe("http://h/");
  });
});

describe("flattenHeaders", () => {
  it("stringifies and joins array values, drops null/undefined", () => {
    expect(flattenHeaders({ a: "b", c: ["1", "2"], n: 5, u: undefined, z: null })).toEqual({
      a: "b",
      c: "1, 2",
      n: "5",
    });
  });

  it("returns empty for non-objects", () => {
    expect(flattenHeaders(undefined)).toEqual({});
    expect(flattenHeaders("x")).toEqual({});
  });
});

describe("decodeBody", () => {
  it("returns null for no chunks", () => {
    expect(decodeBody([], 0)).toEqual({ body: null, bodyEncoding: "utf8", truncated: false });
  });

  it("decodes utf8 text", () => {
    const r = decodeBody([Buffer.from("hello "), Buffer.from("world")], 0);
    expect(r).toEqual({ body: "hello world", bodyEncoding: "utf8", truncated: false });
  });

  it("uses base64 for binary (contains NUL)", () => {
    const buf = Buffer.from([0x00, 0x01, 0x02]);
    const r = decodeBody([buf], 0);
    expect(r.bodyEncoding).toBe("base64");
    expect(r.body).toBe(buf.toString("base64"));
  });

  it("truncates at the cap", () => {
    const r = decodeBody([Buffer.from("abcdefghij")], 4);
    expect(r.body).toBe("abcd");
    expect(r.truncated).toBe(true);
  });
});
