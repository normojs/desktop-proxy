/**
 * Decentralized NATS credential minting (no per-device server ops).
 *
 * Given an account signing-key seed (provisioned once via `nsc` + nats-resolver),
 * the desktop mints its own hub user JWT and a fresh device user JWT per phone at
 * pair time, with subject permissions scoped to this instance. The NATS server
 * validates the signature against the account it already knows — nothing to
 * configure server-side per desktop/device. See docs/nats-deploy.md.
 */

import { encodeUser } from "nats-jwt";
import { createUser } from "nkeys.js";

import { hubPermissions, devicePermissions, type SubjectPermissions } from "./remote-subjects.js";

export interface MintedCreds {
  /** Signed user JWT. */
  jwt: string;
  /** User nkey seed ("SU...") the client signs its connection with. */
  seed: string;
}

async function mint(
  name: string,
  accountSeed: string,
  accountId: string,
  perms: SubjectPermissions,
): Promise<MintedCreds> {
  const ukp = createUser();
  const seed = new TextDecoder().decode(ukp.getSeed());
  const jwt = await encodeUser(name, ukp, accountSeed, {
    pub: { allow: perms.publish, deny: [] },
    sub: { allow: perms.subscribe, deny: [] },
    issuer_account: accountId,
  });
  return { jwt, seed };
}

/** Mint credentials for the desktop (hub) side. */
export function mintHubCreds(accountSeed: string, accountId: string, instanceId: string): Promise<MintedCreds> {
  return mint(`hub_${instanceId}`, accountSeed, accountId, hubPermissions(instanceId));
}

/** Mint credentials for a paired device (phone), scoped to this instance. */
export function mintDeviceCreds(accountSeed: string, accountId: string, instanceId: string): Promise<MintedCreds> {
  return mint(`dev_${instanceId}`, accountSeed, accountId, devicePermissions(instanceId));
}
