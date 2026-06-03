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
import { pluginList, pluginSetEnabled, configGet, configSet, doctor, pluginCheckUpdates } from "./commands/manage.js";
import { installWatcher, uninstallWatcher, watcherStatus } from "./commands/watch.js";
import { createPlugin, validatePlugin } from "./commands/scaffold.js";
import { isBackendName, type BackendName } from "./backends/index.js";
import { proxy, type ProxySubcommand } from "./commands/proxy.js";
import { permissions } from "./commands/permissions.js";
import { pair } from "./commands/pair.js";

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
  desktop-proxy doctor [--json]       Diagnose the installation
  desktop-proxy plugin list [--json]  List installed plugins and their state
  desktop-proxy plugin enable <id>    Enable a plugin
  desktop-proxy plugin disable <id>   Disable a plugin
  desktop-proxy plugin check-updates  Check plugins' githubRepo for newer releases
  desktop-proxy config get [key]      Print config (or a single key)
  desktop-proxy config set <key> <v>  Set a config key (logLevel, stealth, safeMode, autoUpdate)
  desktop-proxy watch install         Auto re-apply the patch when the app updates (macOS/Linux/Windows)
  desktop-proxy watch uninstall       Remove the auto-repair watcher
  desktop-proxy watch status          Show watcher state
  desktop-proxy create-plugin <dir>   Scaffold a new plugin
  desktop-proxy validate-plugin <dir> Validate a plugin's manifest and entry
  desktop-proxy proxy <on|off|status> Configure a renderer/ext-host proxy for VS Code forks (no injection)
  desktop-proxy permissions [--open <id>] Re-grant OS permissions after install (macOS TCC; opens Settings)
  desktop-proxy pair [--name <label>] Show a QR/link to pair a phone with the remote bus (NATS; see docs/nats-deploy.md)

Options:
  --app <path>      Path to the .app bundle (auto-detected if omitted)
  --backend <name>  Injection backend: asar (default) | dyld (not yet implemented)
  --no-fuse         Skip Electron fuse flipping
  --no-resign       Skip code re-signing (macOS)
  --if-needed       repair only if the app is not already patched
  --follow, -f      Follow the log output (logs command)
  --lines <n>       Number of lines to print (logs command, default 200)
  --server <host:port>     Proxy address (proxy on)
  --bypass <list>          Proxy bypass list (proxy on)
  --ca <path>              CA cert path to print NODE_EXTRA_CA_CERTS hint (proxy on)
  --strict-ssl             Keep TLS verification on (proxy on; default off)
  --id/--name/--scope <v>  create-plugin manifest fields
  --json            Machine-readable output (doctor, plugin/config/validate)
  --quiet           Suppress progress output
  --verbose         Show detailed output

Examples:
  desktop-proxy install
  desktop-proxy install --app /Applications/Cursor.app
  desktop-proxy status
  desktop-proxy doctor --json
  desktop-proxy plugin list --json
  desktop-proxy plugin disable com.desktop-proxy.request-interceptor
  desktop-proxy config set logLevel debug
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

  // Separate positional arguments from flags so subcommands (e.g. `plugin
  // enable <id>`) and flags (`--json`) can be mixed freely.
  const positionals: string[] = [];
  const opts: Record<string, string | boolean | number> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--app" && args[i + 1]) {
      opts.app = args[++i];
    } else if (a === "--backend" && args[i + 1]) {
      opts.backend = args[++i];
    } else if (a === "--server" && args[i + 1]) {
      opts.server = args[++i];
    } else if (a === "--bypass" && args[i + 1]) {
      opts.bypass = args[++i];
    } else if (a === "--ca" && args[i + 1]) {
      opts.ca = args[++i];
    } else if (a === "--strict-ssl") {
      opts.strictSSL = true;
    } else if (a === "--open" && args[i + 1]) {
      opts.open = args[++i];
    } else if (a === "--no-fuse") {
      opts.noFuse = true;
    } else if (a === "--no-resign") {
      opts.noResign = true;
    } else if (a === "--if-needed") {
      opts.ifNeeded = true;
    } else if (a === "--follow" || a === "-f") {
      opts.follow = true;
    } else if (a === "--lines" && args[i + 1]) {
      opts.lines = Number(args[++i]);
    } else if (a === "--id" && args[i + 1]) {
      opts.id = args[++i];
    } else if (a === "--name" && args[i + 1]) {
      opts.name = args[++i];
    } else if (a === "--scope" && args[i + 1]) {
      opts.scope = args[++i];
    } else if (a === "--json") {
      opts.json = true;
    } else if (a === "--quiet") {
      opts.quiet = true;
    } else if (a === "--verbose") {
      opts.verbose = true;
    } else if (!a.startsWith("-")) {
      positionals.push(a);
    }
  }

  const command = positionals[0];
  const json = opts.json as boolean | undefined;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  switch (command) {
    case "install": {
      let backend: BackendName | undefined;
      if (typeof opts.backend === "string") {
        if (!isBackendName(opts.backend)) {
          console.error(`Unknown backend "${opts.backend}". Valid: asar, dyld.`);
          process.exit(1);
        }
        backend = opts.backend;
      }
      await install({
        app: opts.app as string | undefined,
        backend,
        noFuse: opts.noFuse as boolean | undefined,
        noResign: opts.noResign as boolean | undefined,
        quiet: opts.quiet as boolean | undefined,
        verbose: opts.verbose as boolean | undefined,
      });
      break;
    }

    case "uninstall":
      uninstall(opts.quiet as boolean | undefined);
      break;

    case "status":
      status();
      break;

    case "permissions":
      permissions({
        open: opts.open as string | undefined,
        openRoot: !opts.open && !json,
        json,
      });
      break;

    case "pair":
      await pair({ name: opts.name as string | undefined });
      break;

    case "proxy": {
      const sub = (positionals[1] as ProxySubcommand | undefined) ?? "status";
      if (sub !== "on" && sub !== "off" && sub !== "status") {
        console.error(`Unknown proxy subcommand "${sub}". Use: on | off | status.`);
        process.exit(1);
      }
      proxy(sub, {
        app: opts.app as string | undefined,
        server: opts.server as string | undefined,
        bypass: opts.bypass as string | undefined,
        ca: opts.ca as string | undefined,
        strictSSL: opts.strictSSL as boolean | undefined,
      });
      break;
    }

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
        ifNeeded: opts.ifNeeded as boolean | undefined,
      });
      break;

    case "safe-mode": {
      const mode = positionals[1];
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

    case "doctor":
      doctor(json);
      break;

    case "plugin": {
      const sub = positionals[1];
      if (sub === "list") {
        pluginList(json);
      } else if (sub === "enable") {
        pluginSetEnabled(positionals[2], true, json);
      } else if (sub === "disable") {
        pluginSetEnabled(positionals[2], false, json);
      } else if (sub === "check-updates") {
        await pluginCheckUpdates(json);
      } else {
        console.error(`Unknown plugin subcommand: ${sub ?? "(none)"}. Use: list | enable <id> | disable <id> | check-updates`);
        process.exit(1);
      }
      break;
    }

    case "config": {
      const sub = positionals[1];
      if (sub === "get") {
        configGet(positionals[2], json);
      } else if (sub === "set") {
        configSet(positionals[2], positionals[3], json);
      } else {
        console.error(`Unknown config subcommand: ${sub ?? "(none)"}. Use: get [key] | set <key> <value>`);
        process.exit(1);
      }
      break;
    }

    case "watch": {
      const sub = positionals[1];
      if (sub === "install") {
        installWatcher({ app: opts.app as string | undefined, json });
      } else if (sub === "uninstall") {
        uninstallWatcher({ json });
      } else if (sub === "status") {
        watcherStatus({ json });
      } else {
        console.error(`Unknown watch subcommand: ${sub ?? "(none)"}. Use: install | uninstall | status`);
        process.exit(1);
      }
      break;
    }

    case "create-plugin":
      createPlugin(positionals[1], {
        id: opts.id as string | undefined,
        name: opts.name as string | undefined,
        scope: opts.scope as string | undefined,
        json,
      });
      break;

    case "validate-plugin":
      validatePlugin(positionals[1], json);
      break;

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
