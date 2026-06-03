import { describe, it, expect } from "vitest";

import { parseQuery, matchEntry, parseSize, parseDuration, type FilterEntry } from "../src/net/traffic-filter";

function entry(over: Partial<FilterEntry> = {}): FilterEntry {
  return {
    method: "POST",
    url: "https://api.openai.com/v1/chat/completions",
    host: "api.openai.com",
    path: "/v1/chat/completions",
    status: 200,
    kind: "sse",
    category: "ai",
    service: "OpenAI",
    source: "node-http",
    contentType: "text/event-stream",
    reqHeaders: { authorization: "Bearer sk-x", "content-type": "application/json" },
    resHeaders: { "content-type": "text/event-stream" },
    reqBody: '{"model":"gpt-4o","messages":[]}',
    resBody: "data: hi\n\n",
    reqSize: 200,
    resSize: 4200,
    timeMs: 1800,
    model: "gpt-4o",
    tags: ["stream", "auth"],
    startMs: Date.now(),
    label: "OpenAI chat completion (gpt-4o, stream)",
    ...over,
  };
}

describe("parseQuery", () => {
  it("parses keys, negation, quotes, and free text", () => {
    const p = parseQuery('status:>=400 -domain:telemetry body:"insufficient quota" hello');
    expect(p).toEqual([
      { key: "status", value: ">=400", negate: false },
      { key: "domain", value: "telemetry", negate: true },
      { key: "body", value: "insufficient quota", negate: false },
      { key: "", value: "hello", negate: false },
    ]);
  });
  it("keeps a regex body value intact", () => {
    expect(parseQuery("res-body:/quota|limit/")).toEqual([{ key: "res-body", value: "/quota|limit/", negate: false }]);
  });
});

describe("size & duration parsing", () => {
  it("parses size units", () => {
    expect(parseSize("1k")).toBe(1000);
    expect(parseSize("2mb")).toBe(2e6);
    expect(parseSize("500")).toBe(500);
  });
  it("parses durations", () => {
    expect(parseDuration("1s")).toBe(1000);
    expect(parseDuration("5m")).toBe(300000);
    expect(parseDuration("250")).toBe(250);
  });
});

describe("matchEntry", () => {
  const m = (q: string, e = entry()) => matchEntry(e, parseQuery(q));

  it("status comparisons and classes", () => {
    expect(m("status:200")).toBe(true);
    expect(m("status:>=400")).toBe(false);
    expect(m("status:2xx")).toBe(true);
    expect(m("status:error", entry({ status: 500 }))).toBe(true);
    expect(m("status:pending", entry({ status: null }))).toBe(true);
  });

  it("method / kind / category / domain / path / model", () => {
    expect(m("method:post")).toBe(true);
    expect(m("method:get")).toBe(false);
    expect(m("kind:sse")).toBe(true);
    expect(m("category:ai")).toBe(true);
    expect(m("domain:openai.com")).toBe(true);
    expect(m("path:/v1/chat")).toBe(true);
    expect(m("model:gpt-4o")).toBe(true);
  });

  it("size and time predicates", () => {
    expect(m("larger-than:1k")).toBe(true); // 200+4200 > 1000
    expect(m("res-size:>4k")).toBe(true);
    expect(m("slower-than:1s")).toBe(true);
    expect(m("faster-than:1s")).toBe(false);
  });

  it("headers and body search (substring + regex)", () => {
    expect(m("has:authorization")).toBe(true);
    expect(m("header:content-type=event-stream")).toBe(true);
    expect(m('req-body:"gpt-4o"')).toBe(true);
    expect(m("res-body:/h.+/")).toBe(true);
    expect(m("body:nomatch")).toBe(false);
  });

  it("is: flags", () => {
    expect(m("is:stream")).toBe(true);
    expect(m("is:ws", entry({ kind: "ws" }))).toBe(true);
    expect(m("is:error", entry({ status: 429 }))).toBe(true);
    expect(m("is:auth")).toBe(true);
  });

  it("negation, free text, and AND of predicates", () => {
    expect(m("-domain:telemetry")).toBe(true);
    expect(m("-domain:openai")).toBe(false);
    expect(m("openai")).toBe(true); // free text matches host/service/label
    expect(m("category:ai method:POST larger-than:1k")).toBe(true);
    expect(m("category:ai method:GET")).toBe(false);
  });

  it("since filters by capture time", () => {
    expect(m("since:1h", entry({ startMs: Date.now() - 5000 }))).toBe(true);
    expect(m("since:1s", entry({ startMs: Date.now() - 60000 }))).toBe(false);
  });
});
