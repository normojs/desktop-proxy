# Changelog

All notable changes to this project are documented here. The format is loosely
based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Model Relay — a model-control layer for AI IDEs

A local proxy an IDE's model client points at, to observe/redirect/rewrite/fail
over/translate/govern model traffic — including out-of-process cores (Codex's Rust
`app-server`) that injection can't reach. See [docs/model-relay.md](docs/model-relay.md).

- **Run modes**: standalone daemon (`dprox relay daemon`, no app injection), a
  managed background service (`dprox relay service install` — launchd/systemd/Task
  Scheduler), or inside the injected app.
- **Routing**: model rewrite (`--map`), conditional `routes` (by incoming model /
  prompt content / size / message count), and `fallbackModels` failover.
- **Protocol translation**: Responses API ⇄ Chat Completions (`--upstream-api chat`)
  — text, function/parallel tool calls, multi-turn `reasoning_content`, usage —
  so Codex runs on chat-only backends (e.g. DeepSeek).
- **In-flight transforms**: inject/override system prompt, append rules, override
  params (`config.relay.transforms`, `--system`).
- **Guardrails**: block (HTTP 422) or redact matching content before it's forwarded.
- **Cost budgets**: daily/monthly USD cap with warn or block (`--budget`,
  `--budget-block`); spend persisted across restarts.
- **Secret redaction**: scrub auth headers + sk-/Bearer/JSON tokens from persisted
  capture (default on; `config.redactSecrets`).
- **Observability**: standalone-daemon local dashboard (traffic + token/cost by
  model), `dprox relay doctor` (end-to-end setup diagnostics), `dprox relay logs`.
- **Codex setup**: `--codex` wires `~/.codex/config.toml` (with backup/restore) and
  writes `auth.json` for **login bypass**.

### Cross-platform × multi-IDE

- `IdeAdapter` layer (`ide/adapters.ts`) — per-IDE locate/injection/model-control as
  the single source of truth; `platform.ts` derives discovery from it.
- Windows/Linux install hardening: per-OS permission guidance, AppImage detection;
  per-OS post-injection step (`os/post-inject.ts`); fork paths join with the target
  platform's separator.
- CI matrix (ubuntu + windows + macos) — green on all three.
- Windsurf investigated: not redirectable (Codeium-proprietary; observe-only via
  proxy + CA). See [docs/cross-platform-plan.md](docs/cross-platform-plan.md).

### Architecture

- Relay decoupled from the runtime so config-redirect IDEs (Codex) need **zero
  injection** (no re-sign/sudo/TCC).
- Relay commands dispatch on the `IdeAdapter` (`--ide`), with honest per-IDE behavior.
- Unified message bus (`BusRouter`) over IPC + a NATS remote bus with decentralized
  JWT auth for phone/CLI access. See [docs/architecture-remote-bus.md](docs/architecture-remote-bus.md).

### Earlier

- Network interception across Node `fetch`/`http`/`https` + renderer `fetch`, with
  request racing/failover (P-race) and a DevTools-style Network Inspector (filter
  DSL, AI token/cost analysis).
- macOS installer reliability (sudo-aware ownership, ad-hoc signing, dot-safe
  `ElectronAsarIntegrity`).
