# desktop-proxy

> Universal Electron app injection framework for request interception and UI customization.

> 中文文档见 [README-zh.md](./README-zh.md)。

`desktop-proxy` patches a locally installed Electron application so it loads a small
runtime on startup. That runtime lives **outside** the app bundle, discovers local
plugins, and injects them into both the main and renderer processes — letting you
intercept network traffic, modify the UI, and add settings pages **without
rebuilding the target app**.

It is a generalization of the [Codex++](./third-project/codex-plusplus) approach
(originally Codex-only) into a framework that works against any Electron app
(Codex, Cursor, Windsurf, or any `--app` you point it at).

> ⚠️ Unofficial tooling. It modifies application bundles on disk and runs local
> code inside them. Only install plugins from sources you trust, and use at your
> own risk.

---

## Table of Contents

- [How It Works](#how-it-works)
- [Repository Layout](#repository-layout)
- [Requirements](#requirements)
- [Build From Source](#build-from-source)
- [CLI Usage](#cli-usage)
- [Where Files Live](#where-files-live)
- [Writing Plugins](#writing-plugins)
- [Plugin API](#plugin-api)
- [Safety & Recovery](#safety--recovery)
- [Logging](#logging)
- [Stealth Mode](#stealth-mode)
- [Platform Support](#platform-support)
- [Development Notes](#development-notes)

---

## How It Works

### Install flow (`desktop-proxy install`)

1. **Locate** the target `.app` bundle (known apps or `--app`).
2. **Back up** the original `app.asar`, `app.asar.unpacked`, and `Electron Framework`.
3. **Patch `app.asar`**: rewrite `package.json#main` to a tiny loader stub
   (`desktop-proxy-loader.cjs`) and remember the original entry under
   `__desktop_proxy.originalMain`.
4. **Restore integrity**: recompute the asar header SHA-256 and write it back into
   `Info.plist` → `ElectronAsarIntegrity`, then flip the Electron fuse
   `EnableEmbeddedAsarIntegrityValidation` → `off`.
5. **Re-sign** the bundle with a local self-signed identity (macOS) and clear the
   quarantine attribute.
6. **Stage** the runtime + a default plugin into your user data directory.

### Runtime flow (every launch)

```
app starts
  └─ desktop-proxy-loader.cjs            (inside app.asar)
       └─ require(<userRoot>/runtime/main.js)   ← main process
            ├─ hooks session.setPreloads → injects preload.js
            ├─ registers the IPC bridge
            └─ loads main-scope plugins
       └─ require(originalMain)           ← target app boots normally

renderer window created
  └─ preload.js runs before page JS
       ├─ installs the React DevTools global hook (fiber access)
       ├─ hooks window.fetch / XMLHttpRequest (network interception)
       ├─ installs the settings overlay (isolated Shadow-DOM panel)
       └─ on DOMContentLoaded → plugin host loads renderer-scope plugins
```

Because the renderer runs sandboxed, plugin source is fetched from the main process
over IPC and evaluated with `new Function(...)` inside the preload context.

---

## Repository Layout

This is a [pnpm](https://pnpm.io) workspace monorepo.

| Package | Name | Responsibility |
|---|---|---|
| `packages/loader` | `@desktop-proxy/loader` | Tiny `loader.cjs` stub copied into the target `app.asar`. Boots the runtime, then chains to the original entry. |
| `packages/runtime` | `@desktop-proxy/runtime` | Main-process runtime. Hooks Electron sessions, manages plugins, exposes the IPC bridge, watches plugins for hot reload. |
| `packages/preload` | `@desktop-proxy/preload` | Renderer preload. React hook + network interceptor + plugin host. |
| `packages/plugin-sdk` | `@desktop-proxy/plugin-sdk` | TypeScript types and `validateManifest()` for plugin authors. |
| `packages/installer` | `@desktop-proxy/installer` | The `desktop-proxy` CLI: asar patching, fuse flipping, code signing, install/uninstall/status/repair. |
| `packages/plugins/request-interceptor` | — | Bundled example plugin that captures AI-service requests/responses. |

`third-project/` contains vendored reference projects ([codex-plusplus](./third-project/codex-plusplus)
and [v8_killer](./third-project/v8_killer)) and is excluded from version control.

---

## Requirements

- **Node.js** ≥ 18 (developed against Node 22)
- **pnpm** ≥ 10
- **macOS** for the full install path (`codesign`, `plutil`, `security`, `openssl`).
  Other platforms can build and run the packages but the installer is macOS-first.

---

## Build From Source

```bash
pnpm install
pnpm build
```

Per-package builds are also available:

```bash
pnpm build:loader
pnpm build:runtime
pnpm build:preload
pnpm build:installer
pnpm build:plugin-sdk
```

Other workspace scripts:

```bash
pnpm typecheck   # tsc --noEmit across all packages
pnpm test        # run the Vitest suite
pnpm test:watch  # Vitest in watch mode
pnpm dev         # tsc --watch across all packages
pnpm clean       # remove dist/ in every package
```

> Note: `electron` is installed as a **dev dependency** of `runtime`/`preload` for
> its type definitions only — the Electron binary download is skipped.

---

## CLI Usage

After building, the CLI entry point is `packages/installer/dist/cli.js`.

```bash
node packages/installer/dist/cli.js <command> [options]
```

| Command | Description |
|---|---|
| `install` | Patch an Electron app and stage the runtime. |
| `uninstall` | Restore the original app from backup. |
| `status` | Show installation state, asar hash, and fuse state. |
| `repair` | Re-apply patches after the target app updates. |
| `safe-mode [on\|off]` | Run the app with all plugins disabled (toggles if no value given). |
| `logs [--follow] [--lines N]` | Print (or live-tail) the runtime log. |
| `doctor [--json]` | Diagnose the installation (health checks). |
| `plugin list [--json]` | List installed plugins and their enabled state. |
| `plugin enable\|disable <id>` | Enable/disable a plugin (applied live if the app is running). |
| `plugin check-updates [--json]` | Check each plugin's `githubRepo` for a newer release. |
| `config get [key] [--json]` | Print the config (or a single key). |
| `config set <key> <value>` | Set a config key (`logLevel`, `stealth`, `safeMode`, `autoUpdate`, `enforcePermissions`, `maxResponseBodyBytes`). |
| `watch install\|uninstall\|status` | Auto re-apply the patch when the app updates (macOS). |
| `create-plugin <dir>` | Scaffold a new plugin (`--id` / `--name` / `--scope`). |
| `validate-plugin <dir> [--json]` | Validate a plugin's manifest and entry file. |

**Options:**

| Option | Effect |
|---|---|
| `--app <path>` | Path to the `.app` bundle (`install` / `repair`; auto-detected if omitted). |
| `--no-fuse` | Skip Electron fuse flipping (`install` / `repair`). |
| `--no-resign` | Skip macOS code re-signing (`install` / `repair`). |
| `--follow, -f` | Follow the log output (`logs`). |
| `--lines <n>` | Number of lines to print (`logs`, default 200). |
| `--json` | Machine-readable output for `doctor` / `plugin list` / `config get`. |
| `--quiet` | Suppress progress output. |
| `--verbose` | Show detailed output. |

> The read commands support `--json`, so other tools or agents can drive
> desktop-proxy programmatically (e.g. `doctor --json`, `plugin list --json`,
> `config get logLevel --json`).

**Examples**

```bash
# Auto-detect a known app (Codex / Cursor / Windsurf)
node packages/installer/dist/cli.js install

# Target a specific bundle
node packages/installer/dist/cli.js install --app /Applications/Cursor.app

# Inspect current state
node packages/installer/dist/cli.js status

# Temporarily disable plugins, then re-enable
node packages/installer/dist/cli.js safe-mode on
node packages/installer/dist/cli.js safe-mode off

# Restore the original app
node packages/installer/dist/cli.js uninstall
```

> Modifying an app under `/Applications` may require elevated permissions or
> granting your terminal **Full Disk Access** in System Settings, due to macOS App
> Management protection.

---

## Where Files Live

Everything user-editable stays in `~/.desktop-proxy/`:

| Item | Location |
|---|---|
| Loader patch | inside the target `app.asar` |
| Runtime | `~/.desktop-proxy/runtime/` |
| Plugins | `~/.desktop-proxy/plugins/` |
| Per-plugin key/value (`api.storage`) | `~/.desktop-proxy/plugin-<id>.json` |
| Per-plugin files (`api.fs` sandbox) | `~/.desktop-proxy/plugin-data/<id>/` |
| Config | `~/.desktop-proxy/config.json` |
| Install state | `~/.desktop-proxy/state.json` |
| Logs | `~/.desktop-proxy/log/` (`main.log`, `loader.log`) |
| Backups | `~/.desktop-proxy/backup/` |
| Safe-mode flag | `~/.desktop-proxy/safe-mode` |

---

## Writing Plugins

A plugin is a folder under `~/.desktop-proxy/plugins/` with a manifest and an entry file:

```
my-plugin/
  manifest.json
  index.js
```

Scaffold and validate one with the CLI:

```bash
node packages/installer/dist/cli.js create-plugin ./my-plugin --name "My Plugin"
node packages/installer/dist/cli.js validate-plugin ./my-plugin
```

**`manifest.json`**

```json
{
  "id": "com.you.my-plugin",
  "name": "My Plugin",
  "version": "0.1.0",
  "description": "Adds a settings page and logs requests.",
  "author": "you",
  "main": "index.js",
  "scope": "renderer"
}
```

| Field | Required | Notes |
|---|---|---|
| `id` | yes | Unique reverse-domain identifier. |
| `name` | yes | Human-readable name. |
| `version` | yes | Semantic version. |
| `main` | yes | Entry file relative to the plugin root. |
| `scope` | yes | `"main"`, `"renderer"`, or `"both"`. |
| `description` | no | Short description. |
| `author` | no | Author name. |
| `iconUrl` | no | `data:` or `https:` icon URL. |
| `githubRepo` | no | `owner/repo` for update checks. |
| `minDesktopProxyVersion` | no | Minimum framework version (incompatible plugins are skipped). |
| `permissions` | no | Capabilities used: `cdp` (always required), `fs` / `network` (see below). |

> **Permissions:** `api.cdp` always requires the `cdp` permission. `api.fs` and
> `api.network` are open by default but log a one-time warning when used without
> being declared; set `enforcePermissions` (`config set enforcePermissions true`)
> to deny undeclared use instead.

**`index.js`** (CommonJS module shape)

```js
module.exports = {
  start(api) {
    api.log.info("plugin started");

    // Intercept network requests in the renderer
    api.network.onRequest((req) => {
      api.log.info(`${req.method} ${req.url}`);
      // return a modified request to change url/method, or nothing to pass through
    });

    // Add a settings page
    api.settings.registerPage({
      id: "main",
      title: api.manifest.name,
      render(root) {
        root.textContent = "Hello from my plugin.";
      },
    });
  },
  stop() {
    // optional cleanup
  },
};
```

Plugins are **hot-reloaded**: the runtime watches the plugins directory and
re-runs renderer plugins when files change.

---

## Plugin API

`api.start(api)` receives a `PluginAPI` object (see
[`packages/plugin-sdk/src/index.ts`](./packages/plugin-sdk/src/index.ts) for full types):

| Namespace | Description |
|---|---|
| `api.manifest` | The plugin's parsed manifest. |
| `api.process` | `"main"` or `"renderer"`. |
| `api.log` | Leveled logging (`debug`/`info`/`warn`/`error`) forwarded to `main.log`, plus `isEnabled(level)` to guard expensive logs. |
| `api.storage` | Persistent key/value store (`localStorage` in renderer, JSON file in main). |
| `api.settings` | `registerSection` / `registerPage`, rendered in the framework's overlay panel. |
| `api.react` | `getFiber` / `findOwnerByName` / `waitForElement` (renderer). |
| `api.ipc` | Namespaced `on` / `send` / `invoke` between main and renderer. |
| `api.network` | `onRequest` / `onResponse` interception hooks. Response bodies are read non-blocking (streaming-safe), capped at `maxResponseBodyBytes` (default 1 MiB), and skipped for binary types. Events carry a `source` tag; main-scope plugins also observe Node `http`/`https` traffic (axios/got/node-fetch) that `webRequest` cannot see. |
| `api.fs` | Sandboxed file I/O confined to the plugin's data dir: `read` / `write` / `exists` / `list` / `delete` / `mkdir` / `stat` (utf8 or base64). |
| `api.cdp` | Chrome DevTools Protocol: `attach`/`send`/`on`/`evaluate` plus `onResponse`/`onRequestPaused` helpers. Renderer targets its own webContents; main targets the focused window. Requires the `"cdp"` permission. |
| `api.ui` | DOM helpers: `injectCSS()` (returns a remover) and `toast()` (host-isolated notification). |
| `api.app` | `getInfo()` and `getWindows()`. |

### Example: the bundled request interceptor

[`packages/plugins/request-interceptor`](./packages/plugins/request-interceptor)
detects calls to OpenAI, Anthropic, Google AI, DeepSeek, and Codex endpoints,
captures (and redacts) API tokens and request/response bodies, and exposes a
settings page to review them. It is deployed automatically on `install`.

### Settings overlay

Pages and sections registered via `api.settings.*` are rendered in a
**framework-owned overlay panel**, not by hooking the host app's own settings UI.
The panel lives in an isolated Shadow DOM so it is unaffected by (and does not
affect) the host app's markup and CSS — making it work uniformly across any
Electron app. Open it with the floating **DP** button (bottom-right) or the
**Cmd/Ctrl+Shift+\\** hotkey; press **Esc** to close.

### CDP access

Plugins that declare `"permissions": ["cdp"]` receive `api.cdp`, a thin Chrome
DevTools Protocol client for their **own** renderer, backed by Electron's
in-process `webContents.debugger` — **no remote debugging port is opened**.
Enable a CDP domain before its events are delivered:

```js
await api.cdp.attach();
await api.cdp.send("Network.enable");
api.cdp.on("Network.responseReceived", (p) => api.log.info("response", p));
const title = await api.cdp.evaluate("document.title"); // runs in the page's main world
```

Convenience helpers wrap the Network and Fetch domains:

```js
await api.cdp.attach();

// Observe responses and fetch bodies lazily
await api.cdp.onResponse(async (res) => {
  if (res.url.includes("/api/")) {
    const { body } = await res.getBody();
    api.log.info(res.status, res.url, body.slice(0, 200));
  }
});

// Intercept and rewrite/block requests
await api.cdp.onRequestPaused((req, ctl) => {
  if (req.url.endsWith("/blocked")) return ctl.fail("BlockedByClient");
  ctl.continue();
});
```

CDP is powerful (full page inspection/control), so it is gated behind the
manifest permission. The renderer's `api.cdp` is confined to the plugin's own
webContents; for **main-process plugins** it targets the focused window (or the
first available one). `attach()` fails if DevTools is already open on that window.

### Managing the framework

The framework can be driven two ways, both backed by the same
`~/.desktop-proxy/config.json`:

- **In-app management page** — a built-in "desktop-proxy" page in the overlay
  (alongside plugin pages) to toggle plugins, safe mode, log level, and stealth.
- **CLI** — `plugin enable/disable`, `config get/set`, `doctor` (great for
  scripts/agents, with `--json`).

The runtime **watches `config.json`** and applies changes live: the log level
updates immediately, and plugin enable/disable or safe-mode changes reload the
renderer plugins. (Stealth changes need a restart, since the hooks are installed
at preload time.)

---

## Safety & Recovery

- **Safe mode** — `safe-mode on` (or creating `~/.desktop-proxy/safe-mode`)
  disables all plugins and skips preload registration on next launch.
- **Per-plugin toggles** — stored in `config.json` under `plugins.<id>.enabled`.
- **Backups** — originals are copied to `~/.desktop-proxy/backup/` before patching;
  `uninstall` restores them.
- **Repair** — re-applies the patch after the target app auto-updates (which
  usually wipes it). `repair --if-needed` only acts when the patch is missing.
- **Auto-repair watcher** — `watch install` registers a macOS LaunchAgent
  (launchd `WatchPaths`) that runs `repair --if-needed` whenever the app's
  `app.asar` changes, so updates are healed automatically.
- **Capped logs** — log files are trimmed to a 10 MB rolling cap.

---

## Logging

Framework and plugin logs are written to `~/.desktop-proxy/log/main.log`
(size-capped at 10 MB); `loader.log` covers the earliest boot stage.
Renderer/plugin logs are relayed to the main process over IPC.

View them with the CLI:

```bash
node packages/installer/dist/cli.js logs            # last 200 lines
node packages/installer/dist/cli.js logs --follow   # live tail
node packages/installer/dist/cli.js logs --lines 50
```

Set the minimum level via `config.json` or an environment variable (env wins):

```json
{ "logLevel": "debug" }
```

```bash
DESKTOP_PROXY_LOG_LEVEL=debug   # debug | info | warn | error | silent
```

Levels are ordered `debug < info < warn < error < silent` (default `info`).
Plugins can guard expensive work with `api.log.isEnabled("debug")`, and the level
is shared with renderers so suppressed messages are never sent over IPC.

---

## Stealth Mode

By default the framework leaves an easily inspectable footprint (a visible
launcher button, named globals, JS-patched `fetch`/`XHR`). For target apps that
actively detect injection, enable stealth in `~/.desktop-proxy/config.json`:

```json
{ "stealth": true }
```

With stealth on:

- patched `fetch` / `XMLHttpRequest` report native source via `fn.toString()`
  (the most common detection check);
- the framework's marker globals (`window.__desktop_proxy__`, the overlay handle)
  are not exposed — internals stay in closures;
- the settings overlay uses a **closed** shadow root with no identifying
  attribute, and the launcher button is hidden (open it with **Cmd/Ctrl+Shift+\\**).

What stealth does **not** change, and why:

- The renderer↔main IPC channels are already invisible to page scripts — they
  live in the isolated preload world, so they are not a page-detection vector.
- `__REACT_DEVTOOLS_GLOBAL_HOOK__` is kept because it is indistinguishable from
  real React DevTools.

In stealth mode the IPC channel names are also **randomized per session** (e.g.
`dp-a1b2c3:list-plugins` instead of `desktop-proxy:list-plugins`), so the host
app's own main process cannot enumerate handlers by a known name. Only the
`desktop-proxy:config-sync` bootstrap channel keeps a fixed name (the preload
uses it to learn the random prefix). Note: renderer `api.storage` still uses
visible `localStorage` keys — use `api.fs` for persistence you want hidden.

Plugins are unaffected by randomization: `api.ipc.*` takes logical channel names
that the framework prefixes consistently on both the main and renderer sides. A
plugin that bypasses `api.ipc` with a raw, hardcoded `ipcRenderer` channel would
break under randomization — always use `api.ipc`.

---

## Platform Support

| Platform | Status |
|---|---|
| macOS | Primary target. Full install path: asar patch, integrity hash, fuse flip, `codesign` re-sign. |
| Windows | Partial. App location/patching logic exists, but signing/integrity steps are macOS-specific. |
| Linux | Not implemented in the installer. |

For an alternative, file-free injection strategy (hooking the V8 compiler via
`LD_PRELOAD`), see the vendored [v8_killer](./third-project/v8_killer) reference.

---

## Development Notes

- The `installer` package is an **ESM** package (`"type": "module"`); it uses
  `import.meta.url` and the ESM-only `@electron/asar` v4.
- `runtime` and `preload` resolve Electron at runtime from the target app; the
  `electron` dependency is for **types only**.
- `plugin-sdk` is DOM-typed (it references `HTMLElement` for settings rendering)
  and intentionally has no Node types.

### Reliability

- Subscriptions a plugin acquires via `api.*` (ipc/network/cdp/settings/ui) are
  tracked per-plugin and revoked automatically on hot reload, so they don't
  accumulate even if the plugin's `stop()` doesn't unsubscribe.
- The renderer fetch hook reads response bodies off the critical path so
  streaming/SSE responses are not buffered; bodies are capped and binary types
  are skipped.
- Main-process `webRequest` handlers run under a 3s timeout, after which the
  request passes through unmodified (a hung handler can't stall traffic).
- Preload registration uses `session.registerPreloadScript` on Electron ≥ 35 and
  falls back to `setPreloads` on older versions.

### Testing

A [Vitest](https://vitest.dev) suite (`pnpm test`) covers the pure, host-free
logic — the highest-risk parts that are hard to eyeball:

- `plugin-sdk`: `validateManifest`, `isLevelEnabled`, and the `createCDP`
  helper wiring (Network/Fetch/evaluate against a mock core).
- `runtime`: the leveled `logger` (filtering, `setLevel`, namespaces, size cap)
  and the `fs-sandbox` path confinement + read/write round-trips.
- `installer`: `fuses` read/write against a synthetic Electron binary buffer.

Tests live in each package's `test/` directory (excluded from the `tsc` build).
Electron/DOM-dependent code (sessions, `webContents.debugger`, the overlay) is
not unit-tested here. A GitHub Actions workflow (`.github/workflows/ci.yml`)
runs build + typecheck + test on every push and pull request.

### Status / known gaps

- Main-process `api.network` is backed by a shared `onBeforeSendHeaders` /
  `onCompleted` hub on the default session: handlers see and may modify request
  headers and have real, independently-removable subscriptions. Limitations:
  response bodies are not available (Electron's `webRequest` does not expose
  them) and request bodies are not captured in the main process — use a
  renderer-scope plugin to observe bodies.

---

## License

No license file is currently included. Add one before distributing.
