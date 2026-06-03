/**
 * `desktop-proxy pair` — print a QR / link to pair a phone with this desktop's
 * remote bus (NATS).
 *
 * Decentralized JWT mode (recommended): with `remote.accountSeed` + `accountId`
 * in config, this mints a fresh device user JWT scoped to this instance — no
 * server operation needed. Static fallback uses `remote.deviceUser/Pass`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import qrcode from "qrcode-terminal";
import { encodeUser } from "nats-jwt";
import { createUser } from "nkeys.js";

// Pairing payload format — must match packages/runtime/src/net/remote-subjects.ts.
interface PairingPayload {
  v: 1;
  instanceId: string;
  url: string;
  name?: string;
  jwt?: string;
  seed?: string;
  user?: string;
  pass?: string;
}
function pairingToString(p: PairingPayload): string {
  return `desktopproxy://pair?d=${Buffer.from(JSON.stringify(p), "utf8").toString("base64url")}`;
}

// Device subject permissions — must match remote-subjects.devicePermissions().
function devicePermissions(id: string): { publish: string[]; subscribe: string[] } {
  return {
    publish: [`dp.${id}.c2h.event.>`, `dp.${id}.rpc.>`, "_INBOX.>"],
    subscribe: [`dp.${id}.h2c.event.>`, "_INBOX.>"],
  };
}

async function mintDevice(accountSeed: string, accountId: string, instanceId: string): Promise<{ jwt: string; seed: string }> {
  const ukp = createUser();
  const seed = new TextDecoder().decode(ukp.getSeed());
  const perms = devicePermissions(instanceId);
  const jwt = await encodeUser(`dev_${instanceId}`, ukp, accountSeed, {
    pub: { allow: perms.publish, deny: [] },
    sub: { allow: perms.subscribe, deny: [] },
    issuer_account: accountId,
  });
  return { jwt, seed };
}

const USER_ROOT = join(homedir(), ".desktop-proxy");
const CONFIG_FILE = join(USER_ROOT, "config.json");

interface RemoteCfg {
  url?: string;
  accountSeed?: string;
  accountId?: string;
  deviceUser?: string;
  devicePass?: string;
}
interface Cfg {
  instanceId?: string;
  remote?: RemoteCfg;
}

function readConfig(): Cfg {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as Cfg;
  } catch {
    return {};
  }
}

export async function pair(opts: { name?: string } = {}): Promise<void> {
  const cfg = readConfig();
  const r = cfg.remote ?? {};
  const jwtMode = !!(r.accountSeed && r.accountId);

  const missing: string[] = [];
  if (!cfg.instanceId) missing.push("instanceId (launch the app once after enabling remote)");
  if (!r.url) missing.push("remote.url");
  if (!jwtMode) {
    if (!r.deviceUser) missing.push("remote.deviceUser (or set remote.accountSeed + accountId for JWT mode)");
    if (!r.devicePass) missing.push("remote.devicePass");
  }
  if (missing.length) {
    console.log("\n  Cannot pair yet — missing config:");
    for (const m of missing) console.log(`    - ${m}`);
    console.log(`\n  Configure the remote bus in ${CONFIG_FILE} and set up the NATS server`);
    console.log(`  (see docs/nats-deploy.md), then run "desktop-proxy pair" again.\n`);
    return;
  }

  let payload: PairingPayload;
  if (jwtMode) {
    const creds = await mintDevice(r.accountSeed!, r.accountId!, cfg.instanceId!);
    payload = { v: 1, instanceId: cfg.instanceId!, url: r.url!, name: opts.name ?? "desktop-proxy", jwt: creds.jwt, seed: creds.seed };
  } else {
    payload = { v: 1, instanceId: cfg.instanceId!, url: r.url!, name: opts.name ?? "desktop-proxy", user: r.deviceUser, pass: r.devicePass };
  }

  const link = pairingToString(payload);
  console.log(`\n  Pair your phone with "${payload.name}" — scan this QR in the app:\n`);
  qrcode.generate(link, { small: true }, (qr) => console.log(qr));
  console.log(`\n  Or paste this link:\n  ${link}\n`);
  console.log(`  Instance: ${payload.instanceId}`);
  console.log(`  Server:   ${payload.url}`);
  console.log(`  Mode:     ${jwtMode ? "decentralized JWT (freshly minted device creds)" : "static user/pass"}\n`);
}
