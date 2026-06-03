import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { STREAM_WRAPPER_SOURCE, WS_WRAPPER_SOURCE, RACE_WRAPPER_SOURCE } from "../src/net/main-world";

// The wrappers are page (main-world) code, but they only use globals that Node
// also provides (web streams, fetch Response, WebSocket), so we can exercise
// them here with a fake `window`.

// ── Streaming-response transform ─────────────────────────────────────────────

interface FetchWindow {
  fetch: (url: string) => Promise<Response>;
  __dpRegisterTransform?: (id: string, urls: string[], mode: string, src: string) => void;
}

function makeFetchWindow(): FetchWindow {
  const enc = new TextEncoder();
  return {
    fetch: async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(enc.encode('data: {"t":"hi"}\n\n'));
            c.enqueue(enc.encode('data: {"t":"yo"}\n\n'));
            c.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
  };
}

async function readAll(res: Response): Promise<{ text: string; chunks: number }> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let text = "";
  let chunks = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks++;
    text += dec.decode(value);
  }
  return { text, chunks };
}

describe("stream transform wrapper", () => {
  let win: FetchWindow;

  beforeEach(() => {
    win = makeFetchWindow();
    (globalThis as unknown as { window: FetchWindow }).window = win;
    (0, eval)(STREAM_WRAPPER_SOURCE);
  });

  afterEach(() => {
    delete (globalThis as unknown as { window?: FetchWindow }).window;
  });

  it("transforms SSE events while preserving streaming", async () => {
    win.__dpRegisterTransform!("t1", ["sse"], "sse", ((c: string) => c.toUpperCase()).toString());
    const { text, chunks } = await readAll(await win.fetch("http://x/sse"));
    expect(chunks).toBe(2); // streamed per event, not buffered into one
    expect(text).toBe('DATA: {"T":"HI"}\n\nDATA: {"T":"YO"}\n\n');
  });

  it("passes through unmatched urls unchanged", async () => {
    win.__dpRegisterTransform!("t1", ["other"], "sse", ((c: string) => c.toUpperCase()).toString());
    const { text } = await readAll(await win.fetch("http://x/sse"));
    expect(text).toBe('data: {"t":"hi"}\n\ndata: {"t":"yo"}\n\n');
  });

  it("drops events when the transform returns null", async () => {
    win.__dpRegisterTransform!("t1", ["sse"], "sse", ((c: string) => (c.includes("hi") ? null : c)).toString());
    const { text } = await readAll(await win.fetch("http://x/sse"));
    expect(text).toBe('data: {"t":"yo"}\n\n');
  });

  it("passes chunk through when transform returns undefined", async () => {
    win.__dpRegisterTransform!("t1", ["sse"], "sse", ((): void => undefined).toString());
    const { text } = await readAll(await win.fetch("http://x/sse"));
    expect(text).toBe('data: {"t":"hi"}\n\ndata: {"t":"yo"}\n\n');
  });
});

// ── Outbound WebSocket transform ─────────────────────────────────────────────

interface WsWindow {
  WebSocket: unknown;
  __dpRegisterWs?: (id: string, urls: string[], src: string) => void;
}

describe("websocket outbound transform", () => {
  let win: WsWindow;
  let FakeWS: new (url: string) => { url: string; sent: unknown[]; send(data: unknown): void };

  beforeEach(() => {
    // Fresh class each test so the wrapper mutates a clean prototype.
    FakeWS = class {
      url: string;
      sent: unknown[] = [];
      constructor(url: string) {
        this.url = url;
      }
      send(data: unknown): void {
        this.sent.push(data);
      }
    };
    win = { WebSocket: FakeWS };
    (globalThis as unknown as { window: WsWindow }).window = win;
    (0, eval)(WS_WRAPPER_SOURCE);
  });

  afterEach(() => {
    delete (globalThis as unknown as { window?: WsWindow }).window;
    delete (globalThis as unknown as { __dpEmit?: unknown }).__dpEmit;
  });

  it("rewrites outbound text frames for matching sockets", () => {
    win.__dpRegisterWs!("w1", ["chat"], ((d: string) => d.toUpperCase()).toString());
    const ws = new FakeWS("wss://x/chat");
    ws.send("hello");
    expect(ws.sent).toEqual(["HELLO"]);
  });

  it("drops a frame when the transform returns null", () => {
    win.__dpRegisterWs!("w1", ["chat"], ((d: string) => (d.includes("secret") ? null : d)).toString());
    const ws = new FakeWS("wss://x/chat");
    ws.send("secret payload");
    ws.send("ok");
    expect(ws.sent).toEqual(["ok"]);
  });

  it("passes the frame through when the transform returns undefined", () => {
    win.__dpRegisterWs!("w1", ["chat"], ((): void => undefined).toString());
    const ws = new FakeWS("wss://x/chat");
    ws.send("hello");
    expect(ws.sent).toEqual(["hello"]);
  });

  it("leaves unmatched sockets untouched", () => {
    win.__dpRegisterWs!("w1", ["other"], ((d: string) => d.toUpperCase()).toString());
    const ws = new FakeWS("wss://x/chat");
    ws.send("hello");
    expect(ws.sent).toEqual(["hello"]);
  });

  it("never transforms binary frames", () => {
    win.__dpRegisterWs!("w1", ["chat"], ((d: string) => d.toUpperCase()).toString());
    const ws = new FakeWS("wss://x/chat");
    const buf = new Uint8Array([1, 2, 3]);
    ws.send(buf);
    expect(ws.sent).toEqual([buf]);
  });

  it("routes ctx.emit observations to __dpEmit", () => {
    const seen: unknown[] = [];
    (globalThis as unknown as { __dpEmit: (json: string) => void }).__dpEmit = (json) => seen.push(JSON.parse(json));
    win.__dpRegisterWs!(
      "w1",
      ["chat"],
      function (d: string, ctx: { emit: (v: unknown) => void }) {
        ctx.emit({ len: d.length });
        return d;
      }.toString(),
    );
    const ws = new FakeWS("wss://x/chat");
    ws.send("hello");
    expect(seen).toEqual([{ id: "w1", data: { len: 5 } }]);
    expect(ws.sent).toEqual(["hello"]);
  });
});

describe("websocket inbound transform", () => {
  interface FakeSocket extends EventTarget {
    url: string;
    sent: unknown[];
    send(data: unknown): void;
    receive(data: string): void;
  }
  let win: WsWindow;
  let FakeWS: new (url: string) => FakeSocket;

  beforeEach(() => {
    // EventTarget-based so addEventListener("message")/dispatchEvent work like a
    // real WebSocket's receiving path.
    FakeWS = class extends EventTarget {
      url: string;
      sent: unknown[] = [];
      constructor(url: string) {
        super();
        this.url = url;
      }
      send(data: unknown): void {
        this.sent.push(data);
      }
      receive(data: string): void {
        this.dispatchEvent(new MessageEvent("message", { data }));
      }
    } as unknown as new (url: string) => FakeSocket;
    win = { WebSocket: FakeWS };
    (globalThis as unknown as { window: WsWindow }).window = win;
    (0, eval)(WS_WRAPPER_SOURCE);
  });

  afterEach(() => {
    delete (globalThis as unknown as { window?: WsWindow }).window;
    delete (globalThis as unknown as { __dpEmit?: unknown }).__dpEmit;
  });

  function collect(ws: FakeSocket): string[] {
    const got: string[] = [];
    ws.addEventListener("message", (ev) => got.push((ev as MessageEvent).data));
    return got;
  }

  it("rewrites inbound text frames (rebuilding the MessageEvent)", () => {
    win.__dpRegisterWs!("w1", ["chat"], ((d: string) => d.toUpperCase()).toString());
    const ws = new FakeWS("wss://x/chat");
    const got = collect(ws);
    ws.receive("hello");
    expect(got).toEqual(["HELLO"]);
  });

  it("drops inbound frames when the transform returns null", () => {
    win.__dpRegisterWs!("w1", ["chat"], ((d: string) => (d.includes("secret") ? null : d)).toString());
    const ws = new FakeWS("wss://x/chat");
    const got = collect(ws);
    ws.receive("secret");
    ws.receive("ok");
    expect(got).toEqual(["ok"]);
  });

  it("passes inbound through on undefined", () => {
    win.__dpRegisterWs!("w1", ["chat"], ((): void => undefined).toString());
    const ws = new FakeWS("wss://x/chat");
    const got = collect(ws);
    ws.receive("hello");
    expect(got).toEqual(["hello"]);
  });

  it("leaves unmatched sockets' inbound frames untouched", () => {
    win.__dpRegisterWs!("w1", ["other"], ((d: string) => d.toUpperCase()).toString());
    const ws = new FakeWS("wss://x/chat");
    const got = collect(ws);
    ws.receive("hello");
    expect(got).toEqual(["hello"]);
  });

  it("exposes ctx.direction ('send' vs 'receive')", () => {
    const seen: unknown[] = [];
    (globalThis as unknown as { __dpEmit: (json: string) => void }).__dpEmit = (json) =>
      seen.push((JSON.parse(json) as { data: unknown }).data);
    win.__dpRegisterWs!(
      "w1",
      ["chat"],
      function (d: string, ctx: { direction: string; emit: (v: unknown) => void }) {
        ctx.emit(ctx.direction);
        return d;
      }.toString(),
    );
    const ws = new FakeWS("wss://x/chat");
    collect(ws);
    ws.send("out");
    ws.receive("in");
    expect(seen).toEqual(["send", "receive"]);
  });
});

describe("request race wrapper", () => {
  interface FakeRes {
    status: number;
    headers: { forEach(cb: (v: string, k: string) => void): void };
    body: { cancel(): void };
  }
  interface RaceWin {
    fetch: (url: string, init?: { method?: string; headers?: unknown; body?: unknown; signal?: AbortSignal }) => Promise<FakeRes>;
    __dpRegisterRace?: (...a: unknown[]) => void;
  }
  let win: RaceWin;
  let calls: string[];

  function fakeRes(status: number): FakeRes {
    return { status, headers: { forEach() {} }, body: { cancel() {} } };
  }

  function makeWin(behaviors: Record<string, { status: number; delay?: number }>): RaceWin {
    return {
      fetch: (url, init) =>
        new Promise<FakeRes>((resolve, reject) => {
          calls.push(url);
          const b = behaviors[url] ?? { status: 200, delay: 1 };
          const timer = setTimeout(() => resolve(fakeRes(b.status)), b.delay ?? 1);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          });
        }),
    };
  }

  const VARIANTS = ((): { url: string }[] => [{ url: "v0" }, { url: "v1" }, { url: "v2" }]).toString();

  beforeEach(() => {
    calls = [];
    // v0 fails; v1 and v2 are 2xx but v2 is faster — so "race" winner is v2 (index 2),
    // while sequential "fallback" winner is v1 (index 1, and v2 is never attempted).
    win = makeWin({ v0: { status: 500, delay: 5 }, v1: { status: 200, delay: 20 }, v2: { status: 200, delay: 8 }, "https://x/other": { status: 201, delay: 1 } });
    (globalThis as unknown as { window: RaceWin }).window = win;
    (0, eval)(RACE_WRAPPER_SOURCE);
  });
  afterEach(() => {
    delete (globalThis as unknown as { window?: RaceWin }).window;
    delete (globalThis as unknown as { __dpEmit?: unknown }).__dpEmit;
  });

  it("races to the first accepted (2xx) variant", async () => {
    win.__dpRegisterRace!("r1", ["chat"], "race", 0, 0, 0, VARIANTS, "");
    const res = await win.fetch("https://x/chat");
    expect(res.status).toBe(200);
  });

  it("fallback mode tries sequentially and skips later variants", async () => {
    win.__dpRegisterRace!("r1", ["chat"], "fallback", 0, 0, 0, VARIANTS, "");
    const res = await win.fetch("https://x/chat");
    expect(res.status).toBe(200);
    expect(calls).toEqual(["v0", "v1"]); // v2 never attempted
  });

  it("passes unmatched requests straight through (no race)", async () => {
    win.__dpRegisterRace!("r1", ["chat"], "race", 0, 0, 0, VARIANTS, "");
    const res = await win.fetch("https://x/other");
    expect(res.status).toBe(201);
    expect(calls).toEqual(["https://x/other"]); // original url, not variants
  });

  it("emits the race result via __dpEmit", async () => {
    const seen: Array<{ id: string; data: { winnerIndex: number | null } }> = [];
    (globalThis as unknown as { __dpEmit: (j: string) => void }).__dpEmit = (j) => seen.push(JSON.parse(j));
    win.__dpRegisterRace!("r1", ["chat"], "race", 0, 0, 0, VARIANTS, "");
    await win.fetch("https://x/chat");
    expect(seen).toHaveLength(1);
    expect(seen[0].id).toBe("r1");
    expect(seen[0].data.winnerIndex).toBe(2);
  });
});
