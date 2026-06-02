/**
 * Plugin scaffolding — create-plugin / validate-plugin.
 *
 * Lowers the barrier for plugin authors: generate a valid plugin skeleton and
 * validate a plugin's manifest + entry file before shipping it.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";

import { validateManifest } from "@desktop-proxy/plugin-sdk";

const INDEX_TEMPLATE = `module.exports = {
  start(api) {
    api.log.info("plugin started");

    // Add a page to the desktop-proxy settings overlay.
    api.settings.registerPage({
      id: "main",
      title: api.manifest.name,
      render(root) {
        root.textContent = "Hello from " + api.manifest.name;
      },
    });
  },
  stop() {},
};
`;

export interface CreatePluginOptions {
  id?: string;
  name?: string;
  scope?: string;
  json?: boolean;
}

export function createPlugin(dir: string | undefined, opts: CreatePluginOptions = {}): void {
  const json = opts.json ?? false;
  if (!dir) {
    emitError("usage: create-plugin <dir> [--id <id>] [--name <name>] [--scope <scope>]", json);
    return;
  }

  const target = resolve(dir);
  const folder = basename(target);
  const name = opts.name ?? folder;
  const id = opts.id ?? `com.example.${folder.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "plugin"}`;
  const scope = opts.scope ?? "renderer";

  if (!["main", "renderer", "both"].includes(scope)) {
    emitError(`invalid scope "${scope}" (use main | renderer | both)`, json);
    return;
  }
  if (existsSync(join(target, "manifest.json"))) {
    emitError(`a plugin already exists at ${target}`, json);
    return;
  }

  mkdirSync(target, { recursive: true });
  const manifest = {
    id,
    name,
    version: "0.1.0",
    description: "A desktop-proxy plugin.",
    author: "",
    main: "index.js",
    scope,
  };
  writeFileSync(join(target, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(target, "index.js"), INDEX_TEMPLATE);

  if (json) {
    console.log(JSON.stringify({ ok: true, dir: target, id, name, scope }));
  } else {
    console.log(`\n  Created plugin "${name}" (${id}) at ${target}`);
    console.log(`  Copy it into ~/.desktop-proxy/plugins/ (or symlink it) to load it.\n`);
  }
}

export function validatePlugin(dir: string | undefined, json = false): void {
  if (!dir) {
    emitError("usage: validate-plugin <dir>", json);
    return;
  }

  const target = resolve(dir);
  const manifestPath = join(target, "manifest.json");
  const errors: string[] = [];
  let manifest: { id?: string; main?: string } | null = null;

  if (!existsSync(manifestPath)) {
    errors.push("manifest.json not found");
  } else {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (e) {
      errors.push(`manifest.json is not valid JSON: ${String(e)}`);
    }
  }

  if (manifest) {
    const result = validateManifest(manifest);
    if (!result.valid) {
      errors.push(...result.errors);
    } else if (manifest.main && !existsSync(join(target, manifest.main))) {
      errors.push(`entry file not found: ${manifest.main}`);
    }
  }

  const valid = errors.length === 0;
  if (json) {
    console.log(JSON.stringify({ valid, errors }));
  } else if (valid) {
    console.log(`\n  ✓ ${manifest?.id ?? "plugin"} is valid.\n`);
  } else {
    console.error("\n  ✗ invalid plugin:");
    for (const e of errors) console.error(`    - ${e}`);
    console.error("");
  }
  if (!valid) process.exit(1);
}

function emitError(message: string, json: boolean): void {
  if (json) console.log(JSON.stringify({ error: message }));
  else console.error(`\n  Error: ${message}\n`);
  process.exit(1);
}
