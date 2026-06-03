import { describe, it, expect } from "vitest";

import { runRace, RaceAllFailedError, type RaceFetch, type RaceInit, type RaceResponseLike } from "../src/net/race";
import type { RaceRequestContext, RaceVariant } from "@desktop-proxy/plugin-sdk";

interface Behavior {
  status?: number;
  delay?: number;
  throw?: boolean;
}

interface Harness {
  fetchImpl: RaceFetch;
  calls: string[];
  inits: Record<string, RaceInit>;
  cancelled: Set<string>;
  aborted: Set<string>;
  maxConcurrent: number;
}

function makeFetch(behaviors: Record<string, Behavior>): Harness {
  const h: Harness = {
    calls: [],
    inits: {},
    cancelled: new Set(),
    aborted: new Set(),
    maxConcurrent: 0,
    fetchImpl: (() => {
      throw new Error("unset");
    }) as RaceFetch,
  };
  let active = 0;
  h.fetchImpl = (url, init) => {
    h.calls.push(url);
    h.inits[url] = init;
    active++;
    h.maxConcurrent = Math.max(h.maxConcurrent, active);
    const b = behaviors[url] ?? { status: 200, delay: 1 };
    return new Promise<RaceResponseLike>((resolve, reject) => {
      const timer = setTimeout(() => {
        active--;
        if (b.throw) reject(new Error("network error"));
        else resolve({ status: b.status ?? 200, headers: {}, body: { cancel: () => h.cancelled.add(url) } });
      }, b.delay ?? 1);
      init.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        active--;
        h.aborted.add(url);
        reject(new Error("aborted"));
      });
    });
  };
  return h;
}

const REQ: RaceRequestContext = {
  method: "POST",
  url: "https://api/x",
  headers: { authorization: "orig", "content-type": "application/json" },
  body: "orig-body",
};

const vs = (...urls: string[]): RaceVariant[] => urls.map((url) => ({ url }));

describe("runRace — race mode", () => {
  it("returns the first ACCEPTED response (skipping a faster rejected one)", async () => {
    const h = makeFetch({ v0: { status: 500, delay: 5 }, v1: { status: 200, delay: 30 }, v2: { status: 200, delay: 15 } });
    const { response, result } = await runRace(REQ, vs("v0", "v1", "v2"), {}, h.fetchImpl);
    expect(response.status).toBe(200);
    expect(result.winnerIndex).toBe(2); // v2 is the first 2xx to arrive
    expect(h.aborted.has("v1")).toBe(true); // slower loser aborted
    expect(h.cancelled.has("v2")).toBe(false); // winner stream kept intact
  });

  it("honors the concurrency cap", async () => {
    const h = makeFetch({
      v0: { status: 500, delay: 10 },
      v1: { status: 500, delay: 10 },
      v2: { status: 500, delay: 10 },
      v3: { status: 200, delay: 10 },
    });
    const { result } = await runRace(REQ, vs("v0", "v1", "v2", "v3"), { concurrency: 2 }, h.fetchImpl);
    expect(h.maxConcurrent).toBeLessThanOrEqual(2);
    expect(result.winnerIndex).toBe(3);
  });

  it("returns the last real response when none are accepted", async () => {
    const h = makeFetch({ v0: { status: 500, delay: 5 }, v1: { status: 429, delay: 8 } });
    const { response, result } = await runRace(REQ, vs("v0", "v1"), {}, h.fetchImpl);
    expect(result.winnerIndex).toBeNull();
    expect([500, 429]).toContain(response.status);
  });

  it("throws RaceAllFailedError when every variant errors", async () => {
    const h = makeFetch({ v0: { throw: true, delay: 2 }, v1: { throw: true, delay: 2 } });
    await expect(runRace(REQ, vs("v0", "v1"), {}, h.fetchImpl)).rejects.toBeInstanceOf(RaceAllFailedError);
  });

  it("merges headers/body per variant and defaults to the original", async () => {
    const h = makeFetch({ v0: { status: 200, delay: 1 } });
    await runRace(
      REQ,
      [{ url: "v0", headers: { authorization: "key-1" }, body: "b1" }],
      {},
      h.fetchImpl,
    );
    expect(h.inits["v0"].headers).toMatchObject({ authorization: "key-1", "content-type": "application/json" });
    expect(h.inits["v0"].body).toBe("b1");
  });
});

describe("runRace — fallback mode", () => {
  it("tries sequentially and stops at the first accepted (later variants untouched)", async () => {
    const h = makeFetch({ v0: { status: 500, delay: 3 }, v1: { status: 200, delay: 3 }, v2: { status: 200, delay: 3 } });
    const { result } = await runRace(REQ, vs("v0", "v1", "v2"), { mode: "fallback" }, h.fetchImpl);
    expect(result.winnerIndex).toBe(1);
    expect(h.calls).toEqual(["v0", "v1"]); // v2 never attempted
  });

  it("aborts a hung variant via perRequestTimeout and falls through", async () => {
    const h = makeFetch({ v0: { status: 200, delay: 1000 }, v1: { status: 200, delay: 3 } });
    const { result } = await runRace(
      REQ,
      vs("v0", "v1"),
      { mode: "fallback", perRequestTimeoutMs: 20 },
      h.fetchImpl,
    );
    expect(h.aborted.has("v0")).toBe(true);
    expect(result.winnerIndex).toBe(1);
  });
});

describe("runRace — timeouts & abort propagation", () => {
  it("totalTimeout aborts everything and reports timedOut", async () => {
    const h = makeFetch({ v0: { status: 200, delay: 1000 }, v1: { status: 200, delay: 1000 } });
    await expect(
      runRace(REQ, vs("v0", "v1"), { totalTimeoutMs: 15 }, h.fetchImpl),
    ).rejects.toMatchObject({ result: { timedOut: true } });
    expect(h.aborted.size).toBe(2);
  });

  it("propagates a parent abort to all variants", async () => {
    const h = makeFetch({ v0: { status: 200, delay: 1000 }, v1: { status: 200, delay: 1000 } });
    const parent = new AbortController();
    setTimeout(() => parent.abort(), 10);
    await expect(runRace(REQ, vs("v0", "v1"), {}, h.fetchImpl, parent.signal)).rejects.toBeInstanceOf(RaceAllFailedError);
    expect(h.aborted.size).toBe(2);
  });
});
