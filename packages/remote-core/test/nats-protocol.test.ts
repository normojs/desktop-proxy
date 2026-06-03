import { describe, it, expect } from "vitest";

import { NatsParser, buildConnect, buildSub, buildPub, type NatsMsg } from "../src/nats-protocol";
import { utf8Encode, utf8Decode, concatBytes } from "../src/util";

function msgFrame(subject: string, sid: string, payload: string, reply?: string): Uint8Array {
  const body = utf8Encode(payload);
  const header = reply ? `MSG ${subject} ${sid} ${reply} ${body.length}\r\n` : `MSG ${subject} ${sid} ${body.length}\r\n`;
  return concatBytes(concatBytes(utf8Encode(header), body), utf8Encode("\r\n"));
}

describe("NatsParser", () => {
  it("parses INFO / PING / +OK / -ERR control frames", () => {
    const p = new NatsParser();
    const out = p.push(utf8Encode('INFO {"nonce":"abc","server_id":"x"}\r\nPING\r\n+OK\r\n-ERR \'auth violation\'\r\n'));
    expect(out.map((m) => m.kind)).toEqual(["INFO", "PING", "OK", "ERR"]);
    expect((out[0] as Extract<NatsMsg, { kind: "INFO" }>).info.nonce).toBe("abc");
    expect((out[3] as Extract<NatsMsg, { kind: "ERR" }>).message).toBe("auth violation");
  });

  it("parses a MSG with a byte-accurate UTF-8 payload", () => {
    const p = new NatsParser();
    const out = p.push(msgFrame("dp.i1.h2c.event.traffic", "1", "你好🚀"));
    expect(out).toHaveLength(1);
    const m = out[0] as Extract<NatsMsg, { kind: "MSG" }>;
    expect(m.subject).toBe("dp.i1.h2c.event.traffic");
    expect(utf8Decode(m.payload)).toBe("你好🚀");
  });

  it("captures the reply subject (request/reply)", () => {
    const p = new NatsParser();
    const m = p.push(msgFrame("dp.i1.rpc.config.get", "2", "{}", "_INBOX.r1"))[0] as Extract<NatsMsg, { kind: "MSG" }>;
    expect(m.reply).toBe("_INBOX.r1");
  });

  it("reassembles a frame split across chunks", () => {
    const p = new NatsParser();
    const frame = msgFrame("s", "1", "hello world");
    const a = frame.slice(0, 6);
    const b = frame.slice(6);
    expect(p.push(a)).toHaveLength(0); // incomplete
    const out = p.push(b);
    expect(utf8Decode((out[0] as Extract<NatsMsg, { kind: "MSG" }>).payload)).toBe("hello world");
  });

  it("parses multiple frames in one chunk", () => {
    const p = new NatsParser();
    const out = p.push(concatBytes(msgFrame("a", "1", "x"), msgFrame("b", "2", "yy")));
    expect(out).toHaveLength(2);
    expect(utf8Decode((out[1] as Extract<NatsMsg, { kind: "MSG" }>).payload)).toBe("yy");
  });
});

describe("serializers", () => {
  it("builds CONNECT with jwt + sig", () => {
    const c = buildConnect({ jwt: "ey.j", sig: "s1g", name: "dprox-app" });
    expect(c.startsWith("CONNECT ")).toBe(true);
    expect(c.endsWith("\r\n")).toBe(true);
    const json = JSON.parse(c.slice("CONNECT ".length).trim());
    expect(json).toMatchObject({ jwt: "ey.j", sig: "s1g", protocol: 1, verbose: false });
  });

  it("builds SUB and a byte-accurate PUB", () => {
    expect(buildSub("dp.i1.h2c.event.>", "1")).toBe("SUB dp.i1.h2c.event.> 1\r\n");
    const pub = buildPub("dp.i1.rpc.config.set", "_INBOX.r1", '{"x":"你好"}');
    const text = utf8Decode(pub);
    // header length must be the UTF-8 byte count (8 ASCII + 你好 = 6 → 14)
    expect(text.startsWith("PUB dp.i1.rpc.config.set _INBOX.r1 14\r\n")).toBe(true);
    expect(text.endsWith("\r\n")).toBe(true);
  });
});
