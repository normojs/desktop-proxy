import { describe, it, expect } from "vitest";
import { createAccount } from "nkeys.js";
import { decode } from "nats-jwt";

import { mintHubCreds, mintDeviceCreds } from "../src/net/remote-jwt";

function account(): { seed: string; id: string } {
  const akp = createAccount();
  return { seed: new TextDecoder().decode(akp.getSeed()), id: akp.getPublicKey() };
}

interface UserClaims {
  nats: { pub: { allow: string[] }; sub: { allow: string[] }; issuer_account: string };
  sub: string;
}

describe("remote-jwt minting", () => {
  it("mints a hub JWT scoped to the instance with the account as issuer", async () => {
    const acc = account();
    const { jwt, seed } = await mintHubCreds(acc.seed, acc.id, "i1");
    expect(jwt.split(".")).toHaveLength(3);
    expect(seed.startsWith("SU")).toBe(true);

    const claims = decode<UserClaims["nats"]>(jwt) as unknown as UserClaims;
    expect(claims.nats.issuer_account).toBe(acc.id);
    expect(claims.nats.sub.allow).toContain("dp.i1.c2h.event.>");
    expect(claims.nats.pub.allow).toContain("dp.i1.h2c.event.>");
    expect(claims.sub.startsWith("U")).toBe(true); // user public key
  });

  it("mints a device JWT confined to client-facing subjects", async () => {
    const acc = account();
    const { jwt } = await mintDeviceCreds(acc.seed, acc.id, "i1");
    const claims = decode(jwt) as unknown as UserClaims;
    expect(claims.nats.pub.allow).toContain("dp.i1.c2h.event.>");
    expect(claims.nats.pub.allow).toContain("dp.i1.rpc.>");
    expect(claims.nats.sub.allow).toContain("dp.i1.h2c.event.>");
    // device cannot subscribe the hub-facing (inbound) subjects
    expect(claims.nats.sub.allow).not.toContain("dp.i1.c2h.event.>");
  });

  it("issues a unique user key per mint", async () => {
    const acc = account();
    const a = await mintDeviceCreds(acc.seed, acc.id, "i1");
    const b = await mintDeviceCreds(acc.seed, acc.id, "i1");
    expect(a.seed).not.toBe(b.seed);
  });
});
