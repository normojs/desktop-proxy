# Model Relay — a universal model-control layer for AI IDEs

The relay lets you **observe, redirect, rewrite, fail over, and protocol-translate**
the model traffic of AI IDEs (Codex, Windsurf, Cursor, …) — including IDEs whose
model client runs **outside** the Electron app, which in-process injection alone
cannot reach.

## Why it exists

AI IDEs fall into two camps:

| Camp | Examples | Where the model call happens | How we reach it |
|---|---|---|---|
| **In-process** | Cursor | Electron renderer / Node | Our injection (`api.network` intercept / `raceRequest`) sees it directly. |
| **Native sidecar** | **Codex** (`codex app-server`, Rust), **Windsurf** (`language_server`) | a separate native process | Electron injection **can't** see it. Redirect the core's `base_url` to the relay. |

For the sidecar camp, the only way to see/modify the model request is to point
the core's config at a local relay we run — then we own the request/response.
(This is the same technique CodexPlusPlus uses for Codex; the relay generalizes
it and feeds everything into our inspector + bus.)

## What the relay does

A small HTTP server (inside the injected runtime, config-gated by `config.relay`):

1. **Captures** every request/response into the traffic recorder → visible in the
   Network inspector and streamed to a paired phone over the bus (tagged `source: relay`).
2. **Forwards** upstream with `undici` — deliberately bypassing our own
   `fetch`/`http` patches, so the relay never captures or races itself.
3. **Rewrites the model** in-flight (`modelMap`, exact or `prefix*`) — e.g. fix an
   IDE that hardcodes model names the backend rejects.
4. **Fails over** (`fallbackModels`) — retry with the next model on error.
5. **Translates protocols** (`upstreamApi: "chat"`) — converts Codex's **Responses
   API** ⇄ **Chat Completions**, so chat-only backends (DeepSeek, most relays) work.
6. **Bypasses login** (Codex) — writes `~/.codex/auth.json` with `OPENAI_API_KEY`
   so Codex uses API-key auth instead of the ChatGPT OAuth screen.
7. **Injects the upstream key** — the real key lives only in our config; the core
   sends a placeholder and the relay swaps in the real `Authorization`.

## `config.relay`

```jsonc
{
  "relay": {
    "enabled": true,
    "port": 8788,                       // local listen port (127.0.0.1)
    "upstream": "https://api.deepseek.com/v1",
    "apiKey": "sk-…",                   // real upstream key (overrides client auth)
    "proxy": "http://127.0.0.1:7897",   // optional outbound proxy (CN networks)
    "modelMap": { "gpt-*": "deepseek-v4-flash" },
    "fallbackModels": ["deepseek-v4-pro"],
    "upstreamApi": "chat"               // translate Responses ↔ chat/completions
  }
}
```

Changes apply **live** via the config watcher (no app restart needed for the
relay itself; the IDE core re-reads its own config on launch).

## Recipe: Codex + DeepSeek, no login (verified)

```bash
# 1) Inject the runtime (sudo on macOS to modify /Applications; lands in your ~/.desktop-proxy)
sudo node packages/installer/dist/cli.js install --app /Applications/Codex.app

# 2) Point Codex's core at the relay → DeepSeek, translate protocol, bypass login, rewrite aux models
node packages/installer/dist/cli.js relay on --codex \
  --upstream https://api.deepseek.com/v1 \
  --key sk-<YOUR_DEEPSEEK_KEY> \
  --upstream-api chat \
  --map "gpt-*=deepseek-v4-flash"

# 3) Launch Codex normally — no login, model traffic flows through the relay.
open /Applications/Codex.app
```

What this wires:
- `~/.codex/config.toml`: `model_provider = "dprox"`, provider `base_url = http://127.0.0.1:8788/v1`, `wire_api = "responses"` (Codex requires it).
- `~/.codex/auth.json`: `{"OPENAI_API_KEY": "…"}` → no ChatGPT login.
- `config.relay`: upstream DeepSeek, `upstreamApi: chat` (translate), `modelMap` (Codex's hardcoded `gpt-*` aux calls → a supported model).

Revert: `dprox relay off --codex` (restores `config.toml` + `auth.json`).

### Verified end-to-end

A clean Codex (no CodexPlusPlus, no login) driven entirely by DeepSeek through the
relay, **including the coding agent**:
- `POST 200 https://api.deepseek.com/v1/chat/completions`, `service: DeepSeek`, `kind: sse`.
- Model rewrite: `gpt-5.5`/`gpt-5.4-mini` → `deepseek-v4-flash`.
- Tool calls round-tripped (`exec_command`, …) → Codex created a real file.
- Token usage + USD cost captured per call.

## Protocol translator (`net/protocol/responses-chat.ts`)

Modern Codex only speaks the Responses API; DeepSeek (and most OpenAI-compatible
backends) only speak Chat Completions. The dedicated adapter:
- `responsesToChat()` — request: `instructions`/`input`/`tools` → `messages`/`tools`
  (incl. function calls + outputs), `max_output_tokens`→`max_tokens`, `stream` + `include_usage`.
- `ResponsesStreamConverter` — streams the chat SSE back as the Responses event
  sequence Codex expects (`response.created` / `output_item` / `content_part` /
  `output_text` / `function_call_arguments` / `reasoning_summary_*` / `completed` + usage),
  mirroring CodexPlusPlus's `protocol_proxy` event schema.

**Covered (Phase 1+2a):** text, function tool-calls, usage/cost, reasoner
`reasoning_content` summaries.
**Deferred:** `apply_patch` / custom freeform-tool encoding and inline `<think>`
detection (editing already works via the standard `exec_command` tool).

## Limitations

- The protocol translator is Phase 1+2a; very tool-heavy Codex flows that rely on
  the custom `apply_patch` tool encoding may need Phase 2b.
- Model names are backend-specific — `deepseek-v4-flash/pro` are what *that* upstream
  exposes; for DeepSeek official use the names its `/v1/models` returns.
- `upstreamApi: chat` assumes the IDE streams (Codex does).
