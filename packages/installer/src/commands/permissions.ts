/**
 * `permissions` command — explain and assist re-granting OS permissions after an
 * install that re-signs the app (macOS TCC). Opens the relevant System Settings
 * pane; on Windows/Linux it explains that no re-grant is needed.
 *
 * macOS can't auto-grant permissions (TCC forbids it), so this is assisted-manual.
 */

import { spawnSync } from "node:child_process";
import { platform } from "node:os";

import {
  privacyPanes,
  privacyPaneUrl,
  rootPrivacyUrl,
  permissionsNote,
  openerCommand,
} from "../permissions.js";

export interface PermissionsOptions {
  /** Open a specific pane by id (e.g. "screen-recording"). */
  open?: string;
  /** Open the root privacy pane (used by the post-install hint). */
  openRoot?: boolean;
  json?: boolean;
}

function openUrl(plat: string, url: string): boolean {
  const opener = openerCommand(plat);
  if (!opener) return false;
  const r = spawnSync(opener.cmd, opener.args(url), { stdio: "ignore" });
  return r.status === 0 || r.status === null;
}

export function permissions(opts: PermissionsOptions = {}): void {
  const plat = platform();
  const panes = privacyPanes(plat);
  const note = permissionsNote(plat);

  if (opts.json) {
    console.log(JSON.stringify({ platform: plat, note, panes, root: rootPrivacyUrl(plat) }, null, 2));
    return;
  }

  console.log(`\ndesktop-proxy permissions\n`);
  console.log(`  ${note}\n`);

  if (panes.length === 0) {
    console.log(`  No action needed on this platform.\n`);
    return;
  }

  for (const p of panes) {
    console.log(`  - ${p.label}${p.manual ? "  (toggle manually)" : "  (re-prompts in-app)"}`);
    console.log(`      ${p.url}`);
  }

  if (opts.open) {
    const url = privacyPaneUrl(plat, opts.open);
    if (!url) {
      console.error(`\n  Unknown pane "${opts.open}". Valid: ${panes.map((p) => p.id).join(", ")}\n`);
      process.exit(1);
      return;
    }
    openUrl(plat, url);
    console.log(`\n  Opened: ${url}\n`);
    return;
  }

  if (opts.openRoot) {
    const root = rootPrivacyUrl(plat);
    if (root && openUrl(plat, root)) console.log(`\n  Opened Privacy settings (${root}).`);
  }
  console.log(`\n  Open a specific pane: desktop-proxy permissions --open <id>\n`);
}
