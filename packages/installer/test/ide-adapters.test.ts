import { describe, it, expect } from "vitest";

import { ADAPTERS, getIdeAdapter, listIdeAdapters, searchPathsFor } from "../src/ide/adapters.js";

describe("ide adapters", () => {
  it("registers codex/cursor/windsurf", () => {
    const ids = listIdeAdapters().map((a) => a.id).sort();
    expect(ids).toEqual(["codex", "cursor", "windsurf"]);
  });

  it("looks up by id (case-insensitive)", () => {
    expect(getIdeAdapter("Codex")?.displayName).toBe("Codex");
    expect(getIdeAdapter("CURSOR")?.id).toBe("cursor");
    expect(getIdeAdapter("nope")).toBeNull();
  });

  it("all current targets are Electron (asar injection)", () => {
    for (const a of listIdeAdapters()) expect(a.injection).toBe("asar");
  });

  it("encodes the right model-control strategy per IDE", () => {
    const codex = ADAPTERS.codex.modelControl;
    expect(codex.kind).toBe("config-redirect");
    if (codex.kind === "config-redirect") {
      expect(codex.configFile).toMatch(/\.codex[/\\]config\.toml$/);
      expect(codex.authFile).toMatch(/\.codex[/\\]auth\.json$/);
      expect(codex.wireApi).toBe("responses");
    }
    expect(ADAPTERS.cursor.modelControl.kind).toBe("in-process");
    expect(ADAPTERS.windsurf.modelControl.kind).toBe("language-server");
  });

  it("search paths include the macOS .app location", () => {
    expect(searchPathsFor("Codex")).toContain("/Applications/Codex.app");
    expect(ADAPTERS.cursor.searchPaths()).toContain("/Applications/Cursor.app");
  });

  it("exposes each IDE's config dir", () => {
    expect(ADAPTERS.codex.configDir()).toMatch(/\.codex$/);
    expect(ADAPTERS.windsurf.configDir()).toMatch(/\.codeium$/);
  });
});
