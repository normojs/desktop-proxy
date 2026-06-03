import { describe, it, expect } from "vitest";

import {
  MACOS_INJECT_ENTITLEMENTS,
  buildEntitlementsPlist,
  buildBootstrap,
  buildV8HookConfig,
  planMacosInjection,
  type InjectionPlanInput,
} from "../src/macos-inject";

describe("buildEntitlementsPlist", () => {
  it("emits a valid plist granting every injection entitlement", () => {
    const plist = buildEntitlementsPlist();
    expect(plist).toContain('<plist version="1.0">');
    expect(plist).toContain("<dict>");
    for (const key of MACOS_INJECT_ENTITLEMENTS) {
      expect(plist).toContain(`<key>${key}</key>`);
    }
    // each key is followed by <true/>
    expect(plist.match(/<true\/>/g)?.length).toBe(MACOS_INJECT_ENTITLEMENTS.length);
    expect(plist).toContain("com.apple.security.cs.disable-library-validation");
  });

  it("honors a custom key set", () => {
    const plist = buildEntitlementsPlist(["com.apple.security.cs.allow-jit"]);
    expect(plist).toContain("<key>com.apple.security.cs.allow-jit</key>");
    expect(plist.match(/<true\/>/g)?.length).toBe(1);
  });
});

describe("buildBootstrap", () => {
  const boot = buildBootstrap({
    userRoot: "/Users/me/.desktop-proxy",
    runtimeDir: "/Users/me/.desktop-proxy/runtime",
    runtimeEntry: "/Users/me/.desktop-proxy/runtime/index.js",
  });

  it("sets env before requiring the runtime", () => {
    const envIdx = boot.indexOf("DESKTOP_PROXY_USER_ROOT");
    const reqIdx = boot.indexOf("require(");
    expect(envIdx).toBeGreaterThan(-1);
    expect(reqIdx).toBeGreaterThan(envIdx);
    expect(boot).toContain('"/Users/me/.desktop-proxy/runtime/index.js"');
  });

  it("guards to the main process and against double-boot", () => {
    expect(boot).toContain('process.type !== "browser"');
    expect(boot).toContain("__desktopProxyBooted");
  });

  it("safely encodes paths containing quotes/backslashes", () => {
    const b = buildBootstrap({
      userRoot: 'a"b\\c',
      runtimeDir: "d",
      runtimeEntry: "e",
    });
    expect(b).toContain(JSON.stringify('a"b\\c'));
  });
});

describe("buildV8HookConfig", () => {
  it("matches the entry by keyword and inserts the bootstrap", () => {
    const toml = buildV8HookConfig({ entryKeyword: "main.js", bootstrap: "console.log(1)" });
    expect(toml).toContain("[rules.desktop_proxy_bootstrap]");
    expect(toml).toContain('type = "resource-name-keyword"');
    expect(toml).toContain('keyword = "main.js"');
    expect(toml).toContain('type = "insert-before"');
    expect(toml).toContain("'''");
    expect(toml).toContain("console.log(1)");
  });

  it("sanitizes the rule name", () => {
    const toml = buildV8HookConfig({ entryKeyword: "x", bootstrap: "y", ruleName: "my rule!" });
    expect(toml).toContain("[rules.my_rule_]");
  });

  it("rejects a bootstrap that would break the literal string", () => {
    expect(() => buildV8HookConfig({ entryKeyword: "x", bootstrap: "a ''' b" })).toThrow();
  });
});

describe("planMacosInjection", () => {
  const base: InjectionPlanInput = {
    appRoot: "/Applications/Cursor.app",
    electronBinary: "/Applications/Cursor.app/Contents/Frameworks/Electron Framework.framework/Electron Framework",
    metaPath: "/Applications/Cursor.app/Contents/Info.plist",
    platform: "darwin",
    vector: "lc-load-dylib",
    dylibPath: "/Users/me/.desktop-proxy/libv8_killer_core.dylib",
    configPath: "/Users/me/.desktop-proxy/v8hook.toml",
    bootstrapPath: "/Users/me/.desktop-proxy/bootstrap.js",
    entitlementsPath: "/Users/me/.desktop-proxy/inject.entitlements",
  };

  it("plans the lc-load-dylib vector in order", () => {
    const ops = planMacosInjection(base).map((s) => s.op);
    expect(ops[0]).toBe("backup");
    expect(ops).toContain("inject-load-command");
    expect(ops).not.toContain("install-shim");
    // re-sign must come after the binary mutation and before clearing quarantine
    expect(ops.indexOf("resign-entitlements")).toBeGreaterThan(ops.indexOf("inject-load-command"));
    expect(ops.indexOf("clear-quarantine")).toBeGreaterThan(ops.indexOf("resign-entitlements"));
    expect(ops[ops.length - 1]).toBe("write-state");
  });

  it("plans the dyld-shim vector", () => {
    const ops = planMacosInjection({ ...base, vector: "dyld-shim" }).map((s) => s.op);
    expect(ops).toContain("install-shim");
    expect(ops).not.toContain("inject-load-command");
    expect(ops.indexOf("resign-entitlements")).toBeGreaterThan(ops.indexOf("install-shim"));
  });

  it("refuses non-darwin platforms", () => {
    const steps = planMacosInjection({ ...base, platform: "linux" });
    expect(steps).toHaveLength(1);
    expect(steps[0].op).toBe("precondition");
  });
});
