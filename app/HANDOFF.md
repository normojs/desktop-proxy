# dprox-app — Handoff & Context

> Read this first. It is the single entry point for building the dprox phone app.
> It lives **nested at `desktop-proxy/app/`** (one repo/window). The uni-app x MCP
> is at the desktop-proxy root `.cursor/mcp.json`; the uni-app x rules are in
> `app/.cursor/rules/` (scoped to this subtree); the app is excluded from the
> framework's pnpm/vitest/tsc. Build/run with **HBuilderX**. Desktop docs are
> referenced as `../docs/…` (and key ones are copied into `app/docs/`).

## TL;DR

A native phone app (**Android / iOS / HarmonyOS**, uni-app x) that **observes and
controls** the desktop-proxy *relay* over a NATS remote bus: live token cost &
traffic, relay configuration, a reconstructed view of the AI IDE's conversation,
and plugin toggles. The **desktop + server backend is already built and shipped**;
the **shared hard logic is written and unit-tested** and vendored here.

**P1 transport is now ported to `.uts` and H5-verified** (see below). What's left is
the **native ed25519 plugin** (`uts-nkeys`, to replace the H5 `tweetnacl` signer),
**Android/iOS verification**, and the remaining `.uvue` screens (Overview/Relay/Chat).

## First steps (fresh session, after Cursor reload)

1. Confirm the **`@dcloudio/uni-app-x-mcp`** MCP is active (root `.cursor/mcp.json`);
   use it for exact UTS stdlib/API questions instead of guessing.
2. Skim `.cursor/rules/` (uts, uvue, api, ucss, conditional-compilation, best-practices,
   core-protocol). Remember the core-protocol DoD: **runtime-verified in HBuilderX**.
3. Begin **P1**: port `vendor/remote-core/src/*.ts` → `.uts` (start with `util.ts` —
   simplest; then `nkey`, `subjects`, `nats-protocol`, `bus-client`, `chat-reconstruct`).
   Keep `vendor/remote-core/test/*` as the behavioral spec. Verify each in HBuilderX.
4. Then the `uts-nkeys` ed25519 plugin + the NATS-over-WS client + the screens.

Remote *drive* (sending from the phone) is deliberately **deferred** — build the
observe-first app first (see P4 in `docs/remote-app-plan.md`).

## Current state

- ✅ **Desktop (desktop-proxy repo)** — relay platform + NATS remote bus, with the
  remote surface locked down: a method **allowlist** (only `config.*`, `plugin.*`,
  `traffic.*`, `relay.summary` are remote-reachable; `fs.*`/`cdp` are not), remote
  **secret redaction**, a **`relay.summary`** RPC, and **`budget:alert`/`relay:error`**
  events. Server `wss://` listener + pairing carries a `wsUrl`. (CI green, 349 tests.)
- ✅ **`vendor/remote-core/`** — the **tested** portable logic to vendor as `.uts`
  (see API below). Unit tests are the behavioral spec.
- ✅ **`.cursor/`** — official DCloud uni-app x rules + `@dcloudio/uni-app-x-mcp`.
- ✅ **`docs/`** — UI design (`docs/ui/remote-control.html` light + `-dark.html`,
  7 screens) and the architecture/phasing plan (`docs/remote-app-plan.md`).
- ✅ **P1 transport (this session)** — `app/common/dprox-core/*.uts` ports of
  `util`, `nkey`, `subjects` (+`pairingFromString`), `nats-protocol` (`NatsParser`
  + serializers), `bus-client`, plus `connection.uts` (NATS-over-WS via uni global
  socket API). All exercised by the `pages/index/index.uvue` self-check and **verified
  running on H5**. ed25519 on H5 uses **`tweetnacl`** (`npm` in `app/`, `#ifdef H5`);
  native uses the `uts-nkeys` plugin (TODO). The connect screen takes a pairing link →
  signs the nonce → `relay.summary`.
- ✅ **Desktop daemon remote bus** — `dprox relay daemon` now hosts the remote bus
  (`relay.summary`/`config.get` over NATS) when `config.remote` is enabled, so the
  phone connects **without injection** (correct for config-redirect Codex).
- ⚠️ **H5 ≠ native** — H5 (JS, lenient) passing does **not** prove Android/iOS
  (Kotlin/Swift, strict static types). Watch **Int vs Double** in bit-ops/array
  indexing and **array out-of-bounds** (native throws; H5 returns undefined). The
  `.uts` was written conservatively for this; still do a full **Android** compile/run
  of `dprox-core` at the milestone before calling it done.
- ⬜ **App code** — not started (this is the work).

## What the app does (features)

1. **Pair** — scan a `dprox://pair?d=…` QR → store `{instanceId, wsUrl, jwt,
   seed}` (support multiple desktops).
2. **Overview** — today's cost vs budget (ring), requests/tokens/success, a relay
   quick-toggle, and a live traffic feed.
3. **Chat** — conversations reconstructed from relay traffic: a sessions list, and a
   conversation view with the plan (`update_plan`), reasoning ("thought for…"),
   tool-call cards (`apply_patch`/`exec_command`/`read_file`), files, per-turn cost.
   (Codex-first; in-process protobuf IDEs would need a decoder later.)
4. **Model relay** — toggle enabled, upstream, model routing, daily budget, guardrails
   (writes `config.relay.*` via `config.set`).
5. **Traffic detail** — request/response bodies, tokens, rewrite trail.
6. **Plugins** — list + toggle remotely; unpair.
7. **Theme** — ship both light & dark, following the system.

## Architecture (three layers)

```
uvue UI (7 screens) ── reactive store (status, summary, traffic ring, sessions, config)
      │
BusClient (vendored)  request()/subscribe() over our envelopes
      │  dp.<id>.rpc.<method> (req/reply via _INBOX) + dp.<id>.h2c.event.>
NATS-over-WS client (UTS)  uni.connectSocket(wss) + NatsParser + buildConnect/Sub/Pub
      │
uts-nkeys (UTS plugin)  ed25519 sign(seed, nonce) for JWT auth
```

### Connection + auth flow
1. `uni.connectSocket(wsUrl)` (`wss://host:8443` from pairing).
2. First server frame: `INFO {nonce,…}`.
3. `seed32 = decodeSeed(deviceSeed).seed` (from `remote-core/nkey`); `sigBytes =
   ed25519_sign(nonce, seed32)` (uts-nkeys plugin); `sig = base64UrlFromBytes(sigBytes)`.
4. Send `buildConnect({ jwt: deviceJwt, sig })`.
5. `SUB BusClient.eventSubscription()` + `SUB BusClient.inboxSubscription()`; PING keepalive; reconnect w/ backoff.

### Bus surface (desktop endpoints)
- RPCs (request/reply): `config.get`, `config.set`, `plugin.list`, `plugin.toggle`,
  `traffic.list`, `traffic.detail`, `traffic.clear`, `traffic.export`, `traffic.replay`,
  `relay.summary`. (Anything else — `fs.*`, `cdp` — is rejected `forbidden` remotely.)
- Events (subscribe): `traffic` (each call), `budget:alert`, `relay:error`,
  `config:changed`.
- `config.get` returns the config with `relay.apiKey` / remote creds **masked** for
  remote callers; don't write a masked key back via `config.set`.

## `vendor/remote-core` API (port these to `.uts`)

- **`util`** — `utf8Encode(str): Uint8Array`, `utf8Decode(bytes): string`,
  `utf8Length(str)`, `concatBytes(a,b)`. (Byte-accurate; prompts are Chinese.)
- **`nkey`** — `decodeSeed(seedStr): { typePrefix, seed: Uint8Array(32) }`,
  `base64UrlFromBytes(bytes)`, `encode/decodeBase32`, `crc16`. (No ed25519 here — the
  *sign* is the native plugin; this decodes the seed + encodes the sig.)
- **`nats-protocol`** — `class NatsParser { push(bytes): NatsMsg[] }`,
  `buildConnect(opts)`, `buildSub`, `buildUnsub`, `buildPub(subject, reply, payload): Uint8Array`,
  `PING`, `PONG`.
- **`subjects`** — `rpcSubject`, `clientEventSubscription`, `topicFromSubject`,
  `pairingFromString(link): PairingPayload`.
- **`bus-client`** — `new BusClient(instanceId, clientId, publish, opts?)` with
  `request(method, params)`, `subscribe(topic, fn)`, `handleMessage(subject, payload)`,
  `rejectAll(reason)`, `eventSubscription()`, `inboxSubscription()`.
- **`chat-reconstruct`** — `parseTurns(reqBody)`, `reconstructSessions(entries): Session[]`,
  `sessionKey(turns)`.

Wiring sketch: `publish = (subj, reply, payload) => socket.send(buildPub(subj, reply, payload))`;
on socket message → `for (m of parser.push(bytes)) if (m.kind==='MSG') bus.handleMessage(m.subject, utf8Decode(m.payload))`.

## Build plan (phases — verify each in HBuilderX)

- **P1 transport**: `uni_modules/dprox-core` (port remote-core → `.uts`) +
  `uni_modules/uts-nkeys` (ed25519: Android `Ed25519`/BouncyCastle, iOS CryptoKit
  `Curve25519.Signing`, HarmonyOS ArkTS crypto) + the NATS-over-WS client + CONNECT/
  auth/reconnect. **DoD**: connect to the real server and `relay.summary` returns.
- **P2 MVP**: Pair + Overview + Relay control. Live events into the store.
- **P3 Chat**: sessions list + conversation reconstruction.
- **P4 later**: composer (send → desktop injects into the IDE chat via CDP), push.

## UI design

Open `docs/ui/remote-control.html` (light, full 7-screen flow) and
`docs/ui/remote-control-dark.html` (dark). Style: light & professional, Inter,
custom toggles/sliders, lucide icons, subtle dividers. Map each screen to the bus
surface per `docs/ui/README.md`.

## Constraints / gotchas

- uni-app x **native has no JS engine** → vendor logic as `.uts`; arbitrary npm libs
  won't run on-device (only H5/小程序 targets).
- **HBuilderX is required** to build/run uni-app x apps and UTS plugins (no CLI). Per
  the uni-app x core-protocol, "done" means **runtime-verified in HBuilderX**.
- **byte-accurate UTF-8** everywhere (NATS counts payload bytes; prompts are Chinese).
- **ed25519/JWT**: the nonce is per-connection — sign it live each connect; never
  pre-compute. The seed never leaves the device; store it encrypted.
- Follow `.cursor/rules/*` (uts/uvue/api/ucss/conditional-compilation) and use the
  `@dcloudio/uni-app-x-mcp` MCP for docs/API/CLI rather than guessing.

## Pairing a desktop (for testing)

On the desktop: `dprox pair` prints a QR / `dprox://pair?d=…` carrying
`{ instanceId, url, wsUrl, jwt, seed }`. Requires the desktop's `config.remote`
(NATS) set up — see desktop-proxy `docs/nats-deploy.md`.
