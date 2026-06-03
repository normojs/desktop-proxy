#!/usr/bin/env node
/**
 * Remote bus smoke test — verifies a deployed NATS server end to end (TLS + JWT
 * minting + connectivity + pub/sub) without needing the Electron app.
 *
 * Usage (from the repo root, on a machine that can reach the server):
 *   node scripts/remote-smoke.mjs "tls://nats.example.com:4222" "<accountSeed SA...>" "<accountId A...>"
 *   # optional 4th arg: a CA file path for self-signed TLS
 *
 * Prints "OK round-trip" on success.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";
import fs from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
// Resolve nats/nats-jwt/nkeys from the runtime package's node_modules.
const req = createRequire(path.join(here, "..", "packages", "runtime", "package.json"));
const { connect, JSONCodec, jwtAuthenticator } = req("nats");
const { encodeUser } = req("nats-jwt");
const { createUser } = req("nkeys.js");

const [url, accountSeed, accountId, caFile] = process.argv.slice(2);
if (!url || !accountSeed || !accountId) {
  console.error('Usage: node scripts/remote-smoke.mjs "tls://host:4222" "<accountSeed>" "<accountId>" [caFile]');
  process.exit(2);
}

const SUBJECT = "dp.smoke.test";

async function mint() {
  const ukp = createUser();
  const seed = new TextDecoder().decode(ukp.getSeed());
  const jwt = await encodeUser("smoke", ukp, accountSeed, {
    pub: { allow: ["dp.smoke.>", "_INBOX.>"], deny: [] },
    sub: { allow: ["dp.smoke.>", "_INBOX.>"], deny: [] },
    issuer_account: accountId,
  });
  return { jwt, seed };
}

const main = async () => {
  const { jwt, seed } = await mint();
  const opts = {
    servers: url,
    authenticator: jwtAuthenticator(jwt, new TextEncoder().encode(seed)),
    timeout: 8000,
    name: "remote-smoke",
  };
  if (caFile) opts.tls = { caFile: fs.realpathSync(caFile) };

  console.log(`connecting to ${url} ...`);
  const nc = await connect(opts);
  console.log("connected; server:", nc.info?.server_name ?? "(unknown)");
  const jc = JSONCodec();

  const sub = nc.subscribe(SUBJECT, { max: 1 });
  const got = (async () => {
    for await (const m of sub) return jc.decode(m.data);
  })();

  const payload = { hello: Date.now() };
  nc.publish(SUBJECT, jc.encode(payload));

  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("timeout waiting for message")), 5000));
  const received = await Promise.race([got, timeout]);
  console.log("received:", received);

  await nc.drain();
  console.log("\n✅ OK round-trip — server, TLS, JWT auth and pub/sub all work.");
  process.exit(0);
};

main().catch((e) => {
  console.error("\n❌ FAILED:", e?.message || e);
  console.error("Checks: server reachable on that host:port? cert valid (or pass a caFile)? accountSeed/accountId correct? firewall/security-group open?");
  process.exit(1);
});
