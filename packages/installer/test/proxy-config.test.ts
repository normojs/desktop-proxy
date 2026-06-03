import { describe, it, expect } from "vitest";

import {
  toHostPort,
  toProxyUrl,
  buildVscodeSettingsPatch,
  buildArgvJsonPatch,
  parseJsonc,
  mergeJson,
  removeKeys,
  nodeCaEnvHint,
  isVscodeFork,
  resolveForkPaths,
  PROXY_SETTING_KEYS,
} from "../src/proxy-config";

describe("address normalization", () => {
  it("toHostPort strips scheme + trailing slash", () => {
    expect(toHostPort("http://127.0.0.1:8888/")).toBe("127.0.0.1:8888");
    expect(toHostPort("127.0.0.1:8888")).toBe("127.0.0.1:8888");
  });
  it("toProxyUrl adds http:// when missing", () => {
    expect(toProxyUrl("127.0.0.1:8888")).toBe("http://127.0.0.1:8888");
    expect(toProxyUrl("socks5://h:1")).toBe("socks5://h:1");
  });
});

describe("config patches", () => {
  it("builds VS Code settings (lax TLS by default)", () => {
    expect(buildVscodeSettingsPatch({ proxyServer: "127.0.0.1:8888" })).toEqual({
      "http.proxy": "http://127.0.0.1:8888",
      "http.proxyStrictSSL": false,
      "http.proxySupport": "on",
    });
    expect(buildVscodeSettingsPatch({ proxyServer: "h:1", strictSSL: true })["http.proxyStrictSSL"]).toBe(true);
  });
  it("builds argv.json patch (bare host:port + optional bypass)", () => {
    expect(buildArgvJsonPatch({ proxyServer: "http://127.0.0.1:8888" })).toEqual({ "proxy-server": "127.0.0.1:8888" });
    expect(buildArgvJsonPatch({ proxyServer: "h:1", bypass: "localhost" })).toEqual({
      "proxy-server": "h:1",
      "proxy-bypass-list": "localhost",
    });
  });
  it("nodeCaEnvHint prints the env line", () => {
    expect(nodeCaEnvHint("/x/ca.pem")).toBe('export NODE_EXTRA_CA_CERTS="/x/ca.pem"');
  });
});

describe("JSONC parse / merge / remove", () => {
  const jsonc = `{
  // a comment
  "a": 1,
  "url": "http://x//y", /* keep this string intact */
  "b": 2,
}`;

  it("parses comments, trailing commas, and preserves // inside strings", () => {
    expect(parseJsonc(jsonc)).toEqual({ a: 1, url: "http://x//y", b: 2 });
  });
  it("returns {} for empty text", () => {
    expect(parseJsonc("")).toEqual({});
  });
  it("merges a patch over existing keys", () => {
    const out = mergeJson(jsonc, { a: 9, "http.proxy": "http://p" });
    expect(JSON.parse(out)).toEqual({ a: 9, url: "http://x//y", b: 2, "http.proxy": "http://p" });
  });
  it("removes keys", () => {
    const out = removeKeys('{"http.proxy":"x","http.proxyStrictSSL":false,"keep":1}', PROXY_SETTING_KEYS);
    expect(JSON.parse(out)).toEqual({ keep: 1 });
  });
});

describe("fork path resolution", () => {
  it("recognizes VS Code forks", () => {
    expect(isVscodeFork("com.cursor.app")).toBe(true);
    expect(isVscodeFork("com.codeium.windsurf")).toBe(true);
    expect(isVscodeFork("com.openai.codex")).toBe(false);
    expect(isVscodeFork(null)).toBe(false);
  });

  it("resolves Cursor paths on macOS", () => {
    const p = resolveForkPaths("com.cursor.app", { platform: "darwin", home: "/Users/me" });
    expect(p).toEqual({
      dataDir: "Cursor",
      argvJson: "/Users/me/.cursor/argv.json",
      settingsJson: "/Users/me/Library/Application Support/Cursor/User/settings.json",
    });
  });

  it("resolves Windsurf paths on Linux", () => {
    const p = resolveForkPaths("com.codeium.windsurf", { platform: "linux", home: "/home/me" });
    expect(p?.argvJson).toBe("/home/me/.windsurf/argv.json");
    expect(p?.settingsJson).toBe("/home/me/.config/Windsurf/User/settings.json");
  });

  it("resolves Cursor paths for a Windows target (backslashes, regardless of host)", () => {
    const p = resolveForkPaths("com.cursor.app", { platform: "win32", home: "C:\\Users\\me" });
    expect(p?.argvJson).toBe("C:\\Users\\me\\.cursor\\argv.json");
    expect(p?.settingsJson.endsWith("Cursor\\User\\settings.json")).toBe(true);
  });

  it("returns null for non-fork or unknown apps", () => {
    expect(resolveForkPaths("com.openai.codex", { platform: "darwin", home: "/x" })).toBeNull();
    expect(resolveForkPaths(null)).toBeNull();
  });
});
