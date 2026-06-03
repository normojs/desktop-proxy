# Cross-platform × multi-IDE support

Goal: support **macOS / Windows / Linux** across **Codex, Windsurf, Cursor Desktop**
(and generic Electron apps), with clean architecture/interfaces so adding an OS or
IDE is data, not surgery. Develop on macOS, run on real Windows/Linux later.

## Current state (already cross-platform by design)

| Layer | Cross-platform? |
|---|---|
| asar backend (patch `main`→loader, backup, fuse flip) | ✅ pure file ops |
| `layout.ts` (app.asar + electron-binary paths) | ✅ macOS `.app`, Windows `resources/`+`.exe`, Linux `/opt`+`resources/` (unit-tested) |
| `platform.ts` discovery | ✅ search paths for all three OSes |
| runtime (bus, capture, relay, **Responses↔chat translator**, model rewrite, login bypass) | ✅ pure Node/Electron; deps (undici/nats/nkeys) are pure JS |
| Codex relay redirect (`~/.codex/config.toml` + `auth.json`) | ✅ via `homedir()` |
| `proxy` command (VS Code-fork settings) | ✅ |
| codesign / Info.plist integrity / TCC sudo + permissions | macOS-only, **already guarded** by `platform === "darwin"` |

On Windows/Linux the installer **skips re-signing** and relies on the **fuse flip**
to disable asar integrity — there is no Gatekeeper/App-Management wall, so the
macOS-specific friction (sudo, App Management, ad-hoc signing) does not apply.

**Verified:** macOS (real). **Unverified:** Windows/Linux real-machine runs
(paths are unit-tested only). Known gaps below.

## Architecture layers

```
CLI (install / relay / proxy / …)
  └─ IdeAdapter            ← NEW: per-IDE specifics (locate, injection, model-control, config paths)
       ├─ PlatformLayout   ← have (layout.ts): app.asar / electron-binary per OS
       ├─ InjectionBackend ← have: "asar" (cross-platform); "dyld"/"none" reserved
       └─ OS steps         ← codesign + TCC (darwin-guarded), fuse flip (all OSes)
```

### `IdeAdapter` interface

```ts
type ModelControl =
  | { kind: "config-redirect"; tool: string; configFile: string; authFile?: string; wireApi: "responses" | "chat" }  // Codex
  | { kind: "in-process"; payload: "json" | "protobuf"; redirectable: "yes" | "limited" }                            // Cursor
  | { kind: "language-server"; redirectable: boolean };                                                              // Windsurf

interface IdeAdapter {
  id: "codex" | "windsurf" | "cursor" | string;
  displayName: string;
  bundleId?: string;                       // macOS
  searchPaths(platform): string[];         // where the app lives per OS
  injection: "asar" | "none";              // Electron-injectable?
  modelControl: ModelControl;              // how to reach the model traffic
  configDir(platform): string;             // e.g. ~/.codex  (%USERPROFILE% on Windows)
}
```

Composes with the existing `InjectionBackend` + `layout.ts`. The OS-specific
re-sign/permissions stay guarded in the install pipeline.

## IDE × model-control matrix

| IDE | Model client | Injection | Model control | Notes |
|---|---|---|---|---|
| **Codex** | native Rust core (`codex app-server`) | asar (UI/observe) | **config-redirect** → relay (`~/.codex/config.toml` + `auth.json`, `wire_api=responses`) | Fully working incl. **Responses↔chat translation**, model rewrite, login bypass, coding agent. |
| **Cursor** | in-process (Electron renderer / Node) | asar | **in-process** intercept / `raceRequest` | Traffic is HTTP/2 **protobuf** to `api2.cursor.sh`: transport-level race/retry works; semantic rewrite needs protobuf decode; "external model" limited to Cursor's backend. |
| **Windsurf** | native `language_server` (Codeium) | asar (UI/observe) | **language-server** (proprietary backend) | Likely **not redirectable** to arbitrary models; observe via proxy/CA. Needs investigation of its config knobs. |

## Per-OS install nuances

- **macOS** — re-sign (ad-hoc under sudo), Info.plist integrity (best-effort), TCC
  re-grant; `sudo` needed for `/Applications` (App Management). All handled.
- **Windows** — no code-signing wall; flip the fuse on `<App>.exe`/`electron.exe`
  (verify `writeFuse` on PE). Admin rights may be needed for `Program Files`
  (prefer per-user installs under `%LOCALAPPDATA%`). Config under `%USERPROFILE%`.
- **Linux** — no signing; app in `/opt`/`~/.local`; flip fuse on the ELF launcher.
  **AppImage is read-only → unpatchable** (document; suggest extracted/`.deb`/tar installs).

## Dev on macOS → run on Windows/Linux

The build is platform-agnostic (esbuild → pure-JS `main.js`/`preload.js`), so the
same `dist` runs on any OS's Electron.

1. **VMs on the Mac** (best for GUI): Parallels/UTM/VMware → install the IDE +
   `dprox install` inside the guest.
2. **Remote machines**: `git pull` (or copy `dist`) to a Windows/Linux box, run the CLI there.
3. **CI (GitHub Actions)**: `windows-latest` + `ubuntu-latest` for unit tests + a
   headless installer smoke (asar-patch verification; Linux GUI via `xvfb`).

## Phased plan

1. **IdeAdapter layer** + registry + per-IDE specs + unit tests (this doc's interface).
2. **Windows/Linux install hardening**: verify fuse flip on PE/ELF, per-user paths,
   admin/AppImage handling; layout already done.
3. **CI matrix**: win/linux unit + asar-patch smoke.
4. **Windsurf model-control investigation** (redirectable?).
5. **Cursor protobuf** decode for semantic rewrite (optional, later).
6. Real-machine validation per OS/IDE.
