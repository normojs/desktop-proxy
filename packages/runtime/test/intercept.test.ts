import { describe, it, expect } from "vitest";

import { runInterceptors, makeControl, matchesFilter, toHeaderEntries } from "../src/net/intercept";
import type { NetworkRequest } from "@desktop-proxy/plugin-sdk";

const req = (url = "https://api.x.com/v1"): NetworkRequest => ({
  id: "1",
  method: "GET",
  url,
  headers: {},
  body: null,
  timestamp: 0,
  _type: "fetch",
});

describe("makeControl", () => {
  it("records only the first decision", () => {
    const { control, getDecision } = makeControl();
    control.fail("blocked");
    control.continue();
    expect(getDecision()).toEqual({ action: "fail", reason: "blocked" });
  });

  it("returns null when no action taken", () => {
    expect(makeControl().getDecision()).toBeNull();
  });
});

describe("matchesFilter", () => {
  it("matches when no filter", () => {
    expect(matchesFilter("https://x/y")).toBe(true);
    expect(matchesFilter("https://x/y", {})).toBe(true);
  });
  it("matches by substring", () => {
    expect(matchesFilter("https://api.openai.com/v1", { urls: ["openai.com"] })).toBe(true);
    expect(matchesFilter("https://api.x.com", { urls: ["openai.com"] })).toBe(false);
  });
});

describe("runInterceptors", () => {
  it("continues when no handlers", async () => {
    expect(await runInterceptors([], req())).toEqual({ action: "continue" });
  });

  it("first deciding handler wins", async () => {
    const d = await runInterceptors(
      [
        { handler: () => {} }, // observes, no decision
        { handler: (_r, c) => c.fail("nope") },
        { handler: (_r, c) => c.continue() },
      ],
      req(),
    );
    expect(d).toEqual({ action: "fail", reason: "nope" });
  });

  it("awaits async handlers", async () => {
    const d = await runInterceptors(
      [{ handler: async (_r, c) => { await Promise.resolve(); c.fulfill({ status: 204 }); } }],
      req(),
    );
    expect(d).toEqual({ action: "fulfill", response: { status: 204 } });
  });

  it("respects the filter", async () => {
    const d = await runInterceptors(
      [{ handler: (_r, c) => c.fail(), filter: { urls: ["other.com"] } }],
      req("https://api.x.com/v1"),
    );
    expect(d).toEqual({ action: "continue" });
  });

  it("skips a throwing handler", async () => {
    const d = await runInterceptors(
      [
        { handler: () => { throw new Error("boom"); } },
        { handler: (_r, c) => c.continue({ method: "POST" }) },
      ],
      req(),
    );
    expect(d).toEqual({ action: "continue", mods: { method: "POST" } });
  });
});

describe("toHeaderEntries", () => {
  it("converts a record to name/value pairs", () => {
    expect(toHeaderEntries({ a: "b", c: "d" })).toEqual([
      { name: "a", value: "b" },
      { name: "c", value: "d" },
    ]);
  });
});
