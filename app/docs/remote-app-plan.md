# Remote phone app — design & plan (uni-app x, Android + iOS)

A native phone app that **observes and controls** the desktop relay over the NATS
remote bus: live cost/traffic, relay configuration, and a reconstructed view of the
AI IDE's conversation. UI design: [docs/ui/remote-control.html](ui/remote-control.html)
(light + dark). Backend surface is already shipped (allowlist, `relay.summary`,
events, `wss://` + `wsUrl` pairing).

## Constraints that shape the design

uni-app x compiles to native (Kotlin/Swift/ArkTS) and **has no JS engine on the
app** — so npm JS libraries (`nats.ws`, `nkeys.js`) **cannot run on the native app**.
But `uni.connectSocket` (native `wss`, string + ArrayBuffer) **is** supported, and
native capabilities come via **UTS plugins** (shared across uni-app / uni-app x).

Consequence: on native we implement (a) a **NATS-over-WebSocket client in UTS**, and
(b) an **ed25519 UTS plugin** to sign the JWT auth nonce. Everything else (UI, bus
client, chat reconstruction) is portable `.uvue`/UTS.

We keep **decentralized JWT** auth (zero server ops). JWT is challenge-response, so
the device must sign the server nonce live — there is no way to skip it.

## Architecture (three layers)

```
uvue UI (7 screens, light/dark)            ← docs/ui design
   │ reactive store (status, summary, traffic ring, sessions, config)
Bus client (UTS, portable)                 ← request()/subscribe() over our envelopes
   │ dp.<id>.rpc.<method> (req/reply via _INBOX) + dp.<id>.h2c.event.>
NATS-over-WS client (UTS)                  ← uni.connectSocket(wss) + protocol
   │ CONNECT{jwt,sig} · SUB/PUB/MSG · PING/PONG · reconnect
ed25519 UTS plugin (native)                ← sign(nonce, seed) for JWT auth
```

### Connection + auth flow
1. `uni.connectSocket(wsUrl)` (`wss://host:8443` from pairing).
2. Server's first frame: `INFO {nonce, ...}`.
3. Compute `sig = base64url(ed25519_sign(nonce, deviceSeed))` via the UTS plugin.
4. Send `CONNECT {"jwt": <deviceJWT>, "sig": <sig>, "lang":"uts", "protocol":1, "verbose":false}`.
5. `SUB dp.<id>.h2c.event.> 1` + `SUB _INBOX.<rid>.* 2`; start `PING` keepalive.
6. Reconnect with exponential backoff; re-`SUB` on reconnect.

### Bus mapping (matches the desktop)
- `request(method, params)`: new `rid`; `PUB dp.<id>.rpc.<method> _INBOX.<rid> <n>\r\n<json>`; await `MSG` on the inbox; parse `{kind:"res", ok, result|error}`; timeout ~15s.
- `subscribe`: filter `MSG` on `dp.<id>.h2c.event.<topic>`; decode `{data}`; dispatch (`traffic`, `budget:alert`, `relay:error`, `config:changed`).
- Allowed remote methods only: `config.get/set`, `plugin.list/toggle`, `traffic.*`, `relay.summary` (server enforces; the app never calls `fs.*`).

### ed25519 UTS plugin (`uts-nkeys`)
Exposes `nkeySign(seed: string, nonce: string): string` (base64url sig):
- base32-decode the nkey seed → strip prefix byte + crc16 → 32-byte ed25519 seed.
- Android: `Ed25519` (java.security, API 33+) or BouncyCastle `Ed25519Signer`.
- iOS: CryptoKit `Curve25519.Signing.PrivateKey(rawRepresentation:)`.
- Also `nkeyPublicFromSeed` if needed. Check the DCloud plugin market first for an
  existing ed25519/crypto UTS plugin before writing our own.

### Pairing
- Scan `desktopproxy://pair?d=<base64url(json)>` → `{instanceId, url, wsUrl, jwt, seed, name}`.
- Store encrypted (keychain/keystore via a UTS plugin or `uni` encrypted storage).
- Support a **list of paired desktops**; switch the active one.

### Chat reconstruction (portable pure module)
Fold `traffic` events into sessions: group by conversation prefix hash / workspace /
time gaps; per turn derive user/assistant text, reasoning (`reasoning_content`),
tool calls (`apply_patch`/`exec_command`/`read_file`), plan (`update_plan`), files,
tokens, cost. Same algorithm the desktop could expose later as `chat.sessions`.

### Screens (from the UI design)
Pair · Overview (cost/budget/traffic) · Chat (sessions) · Conversation · Model relay
(toggle/upstream/routing/budget/guardrails) · Traffic detail · Plugins. Theme: ship
both, following the system.

## Phasing

- **P0 — H5 dev harness** (optional but recommended): run the same `.uvue` on the H5
  target where `nats.ws`/`nkeys.js` work, to validate the bus client + UI + chat
  reconstruction fast, before the native crypto/WS work. Throwaway-able.
- **P1 — Native transport**: `uts-nkeys` ed25519 plugin + NATS-over-WS UTS client +
  CONNECT/auth + reconnect. Verify against the real server with `relay.summary`.
- **P2 — MVP**: Pair + Overview + Model relay control (`config.get/set`). Live events.
- **P3 — Chat**: sessions list + conversation reconstruction.
- **P4 — Later**: composer (send → desktop injects into the IDE chat via CDP), push
  notifications (budget/error while the app is closed).

## Testing
- Pure modules (NATS protocol parse/serialize, bus envelope, nkey seed decode, chat
  reconstruction) are unit-testable in TS/UTS.
- An end-to-end smoke connects to the deployed NATS with a minted device JWT and
  calls `relay.summary` (mirrors `scripts/remote-smoke.mjs`).

## Repo layout
A separate top-level `app/` (HBuilderX uni-app x project) — kept out of the pnpm
workspace (different toolchain). Shared pure logic (envelope types, subjects, chat
reconstruction) is duplicated or published as a tiny package the app vendors.

## Open items / dependencies
- HBuilderX is required to build uni-app x (no CLI for UTS plugins yet).
- Confirm a market ed25519 UTS plugin exists, else implement `uts-nkeys`.
- iOS local-network permission prompt for `wss` to a LAN server (if ever used);
  public NATS over `wss:443/8443` is unaffected.
