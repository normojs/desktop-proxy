import { describe, it, expect } from "vitest";

import { normalizeHttpArgs, flattenHeaders, decodeBody, headersToRecord, fetchRequestInfo, http2Url } from "../src/net/node-intercept";

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

describe("headersToRecord", () => {
  it("reads a Headers instance (lowercased keys)", () => {
    expect(headersToRecord(new Headers({ "Content-Type": "application/json", "X-A": "1" }))).toEqual({
      "content-type": "application/json",
      "x-a": "1",
    });
  });

  it("reads an array of pairs", () => {
    expect(headersToRecord([["A", "b"], ["c", "d"]])).toEqual({ a: "b", c: "d" });
  });

  it("reads a plain record (joins arrays)", () => {
    expect(headersToRecord({ A: "b", c: ["1", "2"], n: null })).toEqual({ a: "b", c: "1, 2" });
  });

  it("returns empty for nullish", () => {
    expect(headersToRecord(null)).toEqual({});
  });
});

describe("fetchRequestInfo", () => {
  it("parses a url string + init", () => {
    const r = fetchRequestInfo("https://api.x.com/v1/chat", { method: "post", headers: { a: "b" }, body: "hi" });
    expect(r).toEqual({ method: "POST", url: "https://api.x.com/v1/chat", headers: { a: "b" }, body: "hi" });
  });

  it("parses a URL object", () => {
    expect(fetchRequestInfo(new URL("https://h/p?q=1"), undefined).url).toBe("https://h/p?q=1");
  });

  it("parses a Request-like object (method/headers from it)", () => {
    const r = fetchRequestInfo({ url: "https://x/z", method: "PUT", headers: new Headers({ c: "d" }) }, undefined);
    expect(r.method).toBe("PUT");
    expect(r.url).toBe("https://x/z");
    expect(r.headers).toEqual({ c: "d" });
  });

  it("init overrides Request method; serializes URLSearchParams body", () => {
    const r = fetchRequestInfo({ url: "https://x/z", method: "GET" }, { method: "delete", body: new URLSearchParams({ a: "1", b: "2" }) });
    expect(r.method).toBe("DELETE");
    expect(r.body).toBe("a=1&b=2");
  });

  it("defaults to GET with no body", () => {
    expect(fetchRequestInfo("https://x/", undefined)).toEqual({ method: "GET", url: "https://x/", headers: {}, body: null });
  });
});

describe("http2Url", () => {
  it("joins a bare authority (defaults to https)", () => {
    expect(http2Url("api.x.com", "/v1/foo")).toBe("https://api.x.com/v1/foo");
  });

  it("respects an authority with scheme + port and query", () => {
    expect(http2Url("https://h:8443", "/p?q=1")).toBe("https://h:8443/p?q=1");
  });

  it("defaults the path to /", () => {
    expect(http2Url("api.x.com", "")).toBe("https://api.x.com/");
  });
});
