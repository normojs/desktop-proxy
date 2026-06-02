# desktop-proxy

> Universal Electron app injection framework for request interception and UI customization.

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

**Options** (for `install` / `repair`):

| Option | Effect |
|---|---|
| `--app <path>` | Path to the `.app` bundle (auto-detected if omitted). |
| `--no-fuse` | Skip Electron fuse flipping. |
| `--no-resign` | Skip macOS code re-signing. |
| `--quiet` | Suppress progress output. |
| `--verbose` | Show detailed output. |

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
| `minDesktopProxyVersion` | no | Minimum framework version. |

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
| `api.log` | `debug` / `info` / `warn` / `error`, forwarded to `main.log`. |
| `api.storage` | Persistent key/value store (`localStorage` in renderer, JSON file in main). |
| `api.settings` | `registerSection` / `registerPage`, rendered in the framework's overlay panel. |
| `api.react` | `getFiber` / `findOwnerByName` / `waitForElement` (renderer). |
| `api.ipc` | Namespaced `on` / `send` / `invoke` between main and renderer. |
| `api.network` | `onRequest` / `onResponse` interception hooks. |
| `api.fs` | Sandboxed file I/O confined to the plugin's data dir: `read` / `write` / `exists` / `list` / `delete` / `mkdir` / `stat` (utf8 or base64). |
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

---

## Safety & Recovery

- **Safe mode** — `safe-mode on` (or creating `~/.desktop-proxy/safe-mode`)
  disables all plugins and skips preload registration on next launch.
- **Per-plugin toggles** — stored in `config.json` under `plugins.<id>.enabled`.
- **Backups** — originals are copied to `~/.desktop-proxy/backup/` before patching;
  `uninstall` restores them.
- **Repair** — re-applies the patch after the target app auto-updates (which
  usually wipes it).
- **Capped logs** — log files are trimmed to a 10 MB rolling cap.

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

### Status / known gaps

- No automated test suite yet.
- Main-process `api.network` is backed by a shared `onBeforeSendHeaders` /
  `onCompleted` hub on the default session: handlers see and may modify request
  headers and have real, independently-removable subscriptions. Limitations:
  response bodies are not available (Electron's `webRequest` does not expose
  them) and request bodies are not captured in the main process — use a
  renderer-scope plugin to observe bodies.

---

## License

No license file is currently included. Add one before distributing.
