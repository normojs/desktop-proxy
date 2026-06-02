#!/usr/bin/env node
/**
 * desktop-proxy CLI
 *
 * Command-line tool for installing, uninstalling, and managing the
 * desktop-proxy injection framework on Electron apps.
 *
 * Usage:
 *   desktop-proxy install [--app /path/to/App.app]
 *   desktop-proxy uninstall
 *   desktop-proxy status
 *   desktop-proxy repair
 *   desktop-proxy safe-mode [on|off]
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";

import { install } from "./commands/install.js";
import { uninstall } from "./commands/uninstall.js";
import { status } from "./commands/status.js";
import { repair } from "./commands/repair.js";
import { logs } from "./commands/logs.js";

function printHelp(): void {
  console.log(`
desktop-proxy — Universal Electron App Injection Framework

Usage:
  desktop-proxy install [options]     Install injection framework on an Electron app
  desktop-proxy uninstall             Remove patches and restore original app
  desktop-proxy status                Show installation status
  desktop-proxy repair                Re-apply patches after app update
  desktop-proxy safe-mode [on|off]    Toggle safe mode (run app without plugins)
  desktop-proxy logs [--follow]       View the runtime log (~/.desktop-proxy/log/main.log)

Options:
  --app <path>      Path to the .app bundle (auto-detected if omitted)
  --no-fuse         Skip Electron fuse flipping
  --no-resign       Skip code re-signing (macOS)
  --follow, -f      Follow the log output (logs command)
  --lines <n>       Number of lines to print (logs command, default 200)
  --quiet           Suppress progress output
  --verbose         Show detailed output

Examples:
  desktop-proxy install
  desktop-proxy install --app /Applications/Cursor.app
  desktop-proxy status
  desktop-proxy safe-mode on
`);
}

function toggleSafeMode(enabled: boolean): void {
  const filePath = join(homedir(), ".desktop-proxy", "safe-mode");

  if (enabled) {
    writeFileSync(filePath, "");
    console.log("\n  Safe mode: ON (plugins disabled)");
    console.log("  Restart the app for changes to take effect.\n");
  } else {
    try { unlinkSync(filePath); } catch {}
    console.log("\n  Safe mode: OFF (plugins enabled)");
    console.log("  Restart the app for changes to take effect.\n");
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  // Parse options
  const opts: Record<string, string | boolean | number> = {};
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--app" && args[i + 1]) {
      opts.app = args[++i];
    } else if (args[i] === "--no-fuse") {
      opts.noFuse = true;
    } else if (args[i] === "--no-resign") {
      opts.noResign = true;
    } else if (args[i] === "--follow" || args[i] === "-f") {
      opts.follow = true;
    } else if (args[i] === "--lines" && args[i + 1]) {
      opts.lines = Number(args[++i]);
    } else if (args[i] === "--quiet") {
      opts.quiet = true;
    } else if (args[i] === "--verbose") {
      opts.verbose = true;
    }
  }

  switch (command) {
    case "install":
      await install({
        app: opts.app as string | undefined,
        noFuse: opts.noFuse as boolean | undefined,
        noResign: opts.noResign as boolean | undefined,
        quiet: opts.quiet as boolean | undefined,
        verbose: opts.verbose as boolean | undefined,
      });
      break;

    case "uninstall":
      uninstall(opts.quiet as boolean | undefined);
      break;

    case "status":
      status();
      break;

    case "logs":
      logs({
        follow: opts.follow as boolean | undefined,
        lines: opts.lines as number | undefined,
      });
      break;

    case "repair":
      await repair({
        app: opts.app as string | undefined,
        quiet: opts.quiet as boolean | undefined,
      });
      break;

    case "safe-mode": {
      const mode = args[1];
      if (mode === "on" || mode === "enable" || mode === "true") {
        toggleSafeMode(true);
      } else if (mode === "off" || mode === "disable" || mode === "false") {
        toggleSafeMode(false);
      } else {
        // Toggle: check current state
        const isEnabled = existsSync(join(homedir(), ".desktop-proxy", "safe-mode"));
        toggleSafeMode(!isEnabled);
      }
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});
