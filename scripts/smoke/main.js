/**
 * Minimal Electron smoke test for the CDP-based network features that can't be
 * unit-tested (they need a real Electron + Chromium): cdpNetwork (observe),
 * cdpIntercept (block/mock), and cdpStreamTransform (rewrite a streaming SSE
 * response). Manual / optional-CI — requires the Electron binary.
 *
 *   pnpm build && pnpm smoke
 *
 * It spins up a throwaway userRoot with a config enabling the features and a
 * generated main-scope plugin, requires the built runtime, serves a few HTTP
 * endpoints in-process, drives them from a real BrowserWindow, and asserts the
 * observed/blocked/mocked/rewritten outcomes. Exits 0 on pass, 1 on failure.
 */

const { app, BrowserWindow } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..", "..");
const RUNTIME_DIST = path.join(REPO, "packages", "runtime", "dist", "index.js");
const PLUGIN_ID = "com.desktop-proxy.smoke";

function fail(msg) {
  console.error(`\n[smoke] FATAL: ${msg}`);
  process.exitCode = 1;
  try {
    app.quit();
  } catch {
    /* ignore */
  }
}

if (!fs.existsSync(RUNTIME_DIST)) {
  fail(`runtime not built at ${RUNTIME_DIST} — run "pnpm build" first`);
  app.quit();
  return;
}

// ── Throwaway userRoot + config + plugin ─────────────────────────────────────
const userRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dp-smoke-"));
const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-smoke-rt-"));
const obsFile = path.join(userRoot, "observed.json");

fs.mkdirSync(path.join(userRoot, "plugins", PLUGIN_ID), { recursive: true });
fs.writeFileSync(
  path.join(userRoot, "config.json"),
  JSON.stringify(
    {
      logLevel: "warn",
      cdpNetwork: true,
      cdpIntercept: true,
      cdpStreamTransform: true,
      plugins: { [PLUGIN_ID]: { enabled: true } },
    },
    null,
    2,
  ),
);
fs.writeFileSync(
  path.join(userRoot, "plugins", PLUGIN_ID, "manifest.json"),
  JSON.stringify(
    {
      id: PLUGIN_ID,
      name: "Smoke",
      version: "0.1.0",
      description: "smoke test plugin",
      main: "index.js",
      scope: "main",
      permissions: ["network"],
      minDesktopProxyVersion: "0.1.0",
    },
    null,
    2,
  ),
);
fs.writeFileSync(
  path.join(userRoot, "plugins", PLUGIN_ID, "index.js"),
  `const fs = require("node:fs");
const OBS = ${JSON.stringify(obsFile)};
module.exports = {
  start(api) {
    const observed = [];
    api.network.onRequest((req) => {
      if (req.source === "renderer-cdp") {
        observed.push(req.url);
        try { fs.writeFileSync(OBS, JSON.stringify(observed)); } catch (e) {}
      }
    });
    api.network.intercept((req, ctl) => {
      if (req.url.indexOf("/blocked") >= 0) return ctl.fail("BlockedByClient");
      if (req.url.indexOf("/mocked") >= 0) {
        return ctl.fulfill({ status: 418, headers: { "content-type": "text/plain", "access-control-allow-origin": "*" }, body: "MOCKED" });
      }
      ctl.continue();
    });
    api.network.transformStream({ urls: ["/sse"] }, function (chunk) { return chunk.replace(/cat/gi, "dog"); }, { mode: "sse" });
  },
  stop() {},
};
`,
);

// ── Boot the runtime ─────────────────────────────────────────────────────────
process.env.DESKTOP_PROXY_USER_ROOT = userRoot;
process.env.DESKTOP_PROXY_RUNTIME = runtimeDir;
process.env.DESKTOP_PROXY_LOG_LEVEL = "warn";

require(RUNTIME_DIST); // side-effectful: hooks sessions, loads plugins, sets up CDP

// ── HTTP endpoints ───────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const cors = { "access-control-allow-origin": "*" };
  if (req.url === "/") {
    res.writeHead(200, { "content-type": "text/html", ...cors });
    res.end("<!doctype html><meta charset=utf-8><title>smoke</title><body>ok</body>");
  } else if (req.url.startsWith("/api/data")) {
    res.writeHead(200, { "content-type": "application/json", ...cors });
    res.end(JSON.stringify({ ok: true }));
  } else if (req.url.startsWith("/blocked")) {
    res.writeHead(200, { "content-type": "text/plain", ...cors });
    res.end("SHOULD-NOT-REACH");
  } else if (req.url.startsWith("/mocked")) {
    res.writeHead(200, { "content-type": "text/plain", ...cors });
    res.end("REAL-RESPONSE");
  } else if (req.url.startsWith("/sse")) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", ...cors });
    res.write("data: the cat\n\n");
    res.write("data: sat on a mat\n\n");
    res.end();
  } else {
    res.writeHead(404, cors);
    res.end("nope");
  }
});

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  // Mirror real hardened IDEs (Windsurf/Codex/Cursor Desktop): a sandboxed,
  // context-isolated renderer with no Node integration. Our interception is all
  // main-side (webRequest / Node patch / CDP), so it must still work here.
  const win = new BrowserWindow({
    show: false,
    width: 400,
    height: 300,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  await win.loadURL(base + "/");
  await delay(800); // let CDP attach (Fetch.enable) + main-world wrapper inject

  const out = await win.webContents.executeJavaScript(`(async () => {
    const base = ${JSON.stringify(base)};
    const r = {};
    try { const res = await fetch(base + "/api/data"); r.dataStatus = res.status; r.data = await res.json(); } catch (e) { r.dataErr = String(e); }
    try { await fetch(base + "/blocked"); r.blocked = false; } catch (e) { r.blocked = true; }
    try { const res = await fetch(base + "/mocked"); r.mockStatus = res.status; r.mockBody = await res.text(); } catch (e) { r.mockErr = String(e); }
    try { const res = await fetch(base + "/sse"); r.sse = await res.text(); } catch (e) { r.sseErr = String(e); }
    return r;
  })()`);

  await delay(200);
  let observed = [];
  try {
    observed = JSON.parse(fs.readFileSync(obsFile, "utf8"));
  } catch {
    /* none */
  }

  const checks = [
    ["cdpNetwork observes renderer requests", observed.some((u) => u.includes("/api/data"))],
    ["normal request passes through", out.dataStatus === 200 && out.data && out.data.ok === true],
    ["cdpIntercept blocks /blocked", out.blocked === true],
    ["cdpIntercept mocks /mocked", out.mockStatus === 418 && (out.mockBody || "").includes("MOCKED")],
    ["cdpStreamTransform rewrites SSE", (out.sse || "").includes("dog") && !(out.sse || "").includes("cat")],
  ];

  let allPass = true;
  console.log("\n[smoke] results:");
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
    if (!ok) allPass = false;
  }
  if (!allPass) console.log("\n[smoke] raw:", JSON.stringify(out), "observed:", JSON.stringify(observed));
  console.log(`\n[smoke] ${allPass ? "ALL PASSED" : "FAILURES"}\n`);

  process.exitCode = allPass ? 0 : 1;
  server.close();
  win.destroy();
  app.quit();
}

// Hard timeout so a hang fails rather than blocks CI.
const killer = setTimeout(() => fail("timed out after 25s"), 25000);
killer.unref?.();

app.whenReady().then(run).catch((e) => fail(String(e && e.stack ? e.stack : e)));
app.on("window-all-closed", () => {});
