/* eslint-disable */
/**
 * desktop-proxy loader stub. This file is copied into the target app's
 * app.asar by the installer, and `package.json#main` is rewritten to
 * point at it.
 *
 * Responsibilities:
 *   1. Resolve the original entry point (stored in
 *      package.json#__desktop_proxy.originalMain) and user data dir.
 *   2. Hook `require` so renderer preloads can find our runtime.
 *   3. Load the runtime's main-process entry BEFORE the original main.
 *      The runtime patches Electron's session to inject our preload script.
 *   4. Always fall through to the original main entry if anything fails.
 */

"use strict";

const path = require("node:path");
const fs = require("node:fs");
const Module = require("node:module");

const pkg = require("./package.json");
const meta = pkg.__desktop_proxy || {};
const originalMain = meta.originalMain;
const userRoot = meta.userRoot;
const MAX_LOG_BYTES = 10 * 1024 * 1024;

function appendCappedLog(file, line) {
  const incoming = Buffer.from(line);
  if (incoming.byteLength >= MAX_LOG_BYTES) {
    fs.writeFileSync(file, incoming.subarray(incoming.byteLength - MAX_LOG_BYTES));
    return;
  }
  if (fs.existsSync(file)) {
    const size = fs.statSync(file).size;
    const allowedExisting = MAX_LOG_BYTES - incoming.byteLength;
    if (size > allowedExisting) {
      const existing = fs.readFileSync(file);
      fs.writeFileSync(file, existing.subarray(Math.max(0, existing.byteLength - allowedExisting)));
    }
  }
  fs.appendFileSync(file, incoming);
}

function safe(label, fn) {
  try {
    fn();
  } catch (e) {
    try {
      const logDir = path.join(userRoot || "", "log");
      fs.mkdirSync(logDir, { recursive: true });
      const line = `[${new Date().toISOString()}] ${label}: ${(e && e.stack) || e}\n`;
      appendCappedLog(path.join(logDir, "loader.log"), line);
    } catch (_) {
      process.stderr.write(`[desktop-proxy loader] ${label}: ${e}\n`);
    }
  }
}

safe("init", () => {
  if (!originalMain) {
    throw new Error("loader: package.json missing __desktop_proxy.originalMain");
  }
  if (!userRoot) {
    throw new Error("loader: package.json missing __desktop_proxy.userRoot");
  }

  // Allow user-installed runtime modules to be require()d from anywhere.
  const runtimeDir = path.join(userRoot, "runtime");
  if (fs.existsSync(runtimeDir)) {
    Module.globalPaths.push(path.join(runtimeDir, "node_modules"));
    process.env.DESKTOP_PROXY_USER_ROOT = userRoot;
    process.env.DESKTOP_PROXY_RUNTIME = runtimeDir;

    // Load the runtime main-process bootstrap. It will hook Electron's
    // session system before the app creates any windows.
    safe("runtime", () => require(path.join(runtimeDir, "main.js")));
  } else {
    process.stderr.write(
      `[desktop-proxy] runtime missing at ${runtimeDir}; loading app untweaked.\n`,
    );
  }
});

// Always hand control to the original entry point, even on failure.
require("./" + originalMain);
