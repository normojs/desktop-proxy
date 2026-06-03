# dprox-app — phone remote control (uni-app x)

Native phone app (Android / iOS / HarmonyOS) that observes and controls the
**desktop-proxy** relay over the NATS remote bus. **Nested at `desktop-proxy/app/`**
(one repo/window): the uni-app x MCP (`@dcloudio/uni-app-x-mcp`) is configured at the
desktop-proxy **root** `.cursor/mcp.json`, and the uni-app x rules live in
`app/.cursor/rules/` (Cursor scopes nested rules to this `app/` subtree). The app is
excluded from the framework's pnpm/vitest/tsc. Build/run with **HBuilderX**.

## What's here

- HBuilderX **uni-app x** project (App.uvue, pages.json, manifest.json, main.uts…).
- **`.cursor/`** — official DCloud uni-app x rules + `@dcloudio/uni-app-x-mcp`.
- **`vendor/remote-core/`** — the **tested** portable shared logic from
  `desktop-proxy/packages/remote-core` (nkey decode, UTF-8, NATS protocol, bus
  client, chat reconstruction). Reference TS to adapt to `.uts` under `uni_modules/`.

## Build plan (in this project, verified in HBuilderX)

1. **`uni_modules/dprox-core`** — port `vendor/remote-core/src/*.ts` → `.uts`
   (mostly mechanical; keep the unit tests as the spec).
2. **`uni_modules/uts-nkeys`** — UTS plugin: ed25519 `sign(seed, nonce)` (Android/iOS/
   HarmonyOS native crypto) for NATS JWT auth.
3. **NATS-over-WS client (UTS)** — `uni.connectSocket(wss)` ⇄ `NatsParser` +
   `buildConnect/Sub/Pub`; CONNECT `{jwt, sig}` (sig = uts-nkeys over INFO nonce);
   reconnect + PING.
4. **Bus** — feed MSGs to `BusClient.handleMessage`; use `request/subscribe`.
5. **Screens (`.uvue`)** — Pair · Overview · Chat (sessions) · Conversation · Relay ·
   Traffic detail · Plugins. Light/dark following the system. (UI design:
   `desktop-proxy/docs/ui/remote-control.html`.)

## Connect to a desktop

`dprox pair` on the desktop → QR / `desktopproxy://pair?d=…` with
`{ instanceId, url, wsUrl, jwt, seed }`. Scan → store → connect `wsUrl`
(`wss://…:8443`) → CONNECT with `jwt` + ed25519 `sig` of the server nonce.

Bus surface (live on the desktop): `config.get/set`, `plugin.list/toggle`,
`traffic.*`, `relay.summary` + events `traffic` / `budget:alert` / `relay:error`.
