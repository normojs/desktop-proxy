# Remote control — UI design

Design exploration for the **phone control panel** (the native/PWA client that talks
to the desktop over the NATS remote bus). Open the HTML files in a browser.

- [`remote-control.html`](remote-control.html) — **light** reference, full flow (7 screens).
- [`remote-control-dark.html`](remote-control-dark.html) — **dark** variant (representative screens).

**Theme**: ship **both**, following the system (light/dark toggle). Light is the
primary reference; the dark file fixes the dark palette.

Style: light & professional (matches the in-app Network Inspector), Inter, custom
toggles/sliders, lucide icons (1.5 stroke), subtle dividers.

## Screens → bus surface

Every element maps to an existing bus RPC/event, so the client wires straight on:

| Screen | Backed by |
|---|---|
| **Overview** — cost, budget ring, live traffic | `relay.summary` (to add) + `traffic` events + `budget:alert` event |
| **Chat (sessions)** | derived from `traffic` (group requests into conversations) |
| **Conversation** — plan, reasoning, tool calls, files, cost | reconstructed from each request's `messages` + response (`reasoning_content`, tool calls, `update_plan`, `apply_patch`/`exec_command`) |
| **Model relay** — toggle, upstream, routing, budget, guardrails | `config.get` / `config.set` (`config.relay.*`) |
| **Traffic detail** — body, tokens, rewrite trail | `traffic.detail` |
| **Plugins** — remote toggles, unpair | `plugin.list` / `plugin.toggle` |
| **Pair** — scan QR | `dprox://pair?d=…` payload (instanceId, NATS url, JWT) |

## Notes

- **Chat is Codex-first**: the conversation reconstructs cleanly from relay-routed
  Responses/chat traffic. In-process protobuf IDEs (Cursor) would need the protobuf
  decoder first.
- **The composer ("Reply from your phone") is write, not observe** — feasible by
  injecting into the IDE's chat via CDP, but a larger lift; ship Chat observe-first.
