/**
 * Minimal, surgical editing of `~/.codex/config.toml` to route Codex's native
 * core (`codex app-server`) through the dprox relay — the only way to observe /
 * redirect / race Codex's model traffic, since it lives outside the Electron app.
 *
 * We deliberately avoid a full TOML parser/serializer (which would reorder and
 * strip comments from a user's hand-tuned file). Instead we make two precise
 * edits that respect TOML's "top-level keys before any [section]" rule:
 *   1. flip the top-level `model_provider` in place (leaving a restore breadcrumb),
 *   2. append a marked `[model_providers.dprox]` section at the end.
 * Both are reversible by `removeCodexRelay`.
 *
 * The pure functions here are unit-tested; the command layer only does file I/O.
 */

export const DPROX_PROVIDER = "dprox";

const BEGIN = "# >>> dprox relay (managed) >>>";
const END = "# <<< dprox relay (managed) <<<";
const PREV_RE = /# dprox: previous model_provider = "([^"]*)"/;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface ProviderInfo {
  name: string;
  baseUrl: string | null;
  token: string | null;
}

/** Read the active provider (`model_provider` + its `[model_providers.X]`). */
export function currentProvider(toml: string): ProviderInfo | null {
  const name = /^[ \t]*model_provider\s*=\s*"([^"]+)"/m.exec(toml)?.[1];
  if (!name) return null;
  const body =
    new RegExp(`\\[model_providers\\.${escapeRe(name)}\\]([\\s\\S]*?)(?=\\n\\[|$)`).exec(toml)?.[1] ?? "";
  return {
    name,
    baseUrl: /base_url\s*=\s*"([^"]+)"/.exec(body)?.[1] ?? null,
    token: /experimental_bearer_token\s*=\s*"([^"]+)"/.exec(body)?.[1] ?? null,
  };
}

/** True if our managed relay block is currently applied. */
export function hasDproxRelay(toml: string): boolean {
  return toml.includes(BEGIN);
}

export interface CodexRelayOpts {
  /** Our relay base, e.g. http://127.0.0.1:8788/v1 */
  baseUrl: string;
  /** experimental_bearer_token the core should present (passed through by the relay). */
  token?: string;
  /** wire_api (Codex uses "responses"). */
  wireApi?: string;
}

/**
 * Point Codex at the dprox relay. Idempotent: re-applying replaces our block.
 * Preserves the previous `model_provider` (as a breadcrumb) for clean removal.
 */
export function applyCodexRelay(toml: string, opts: CodexRelayOpts): string {
  let out = removeCodexRelay(toml); // drop any prior managed block first (idempotent)

  const prev = /^[ \t]*model_provider\s*=\s*"([^"]*)"[ \t]*$/m.exec(out)?.[1];
  if (prev !== undefined && prev !== DPROX_PROVIDER) {
    // Real previous provider — leave a breadcrumb so removal restores it.
    out = out.replace(
      /^[ \t]*model_provider\s*=\s*"[^"]*"[ \t]*$/m,
      `# dprox: previous model_provider = "${prev}"\nmodel_provider = "${DPROX_PROVIDER}"`,
    );
  } else if (prev === DPROX_PROVIDER) {
    // Already ours with no original to preserve — keep it, but DON'T breadcrumb "dprox".
    out = out.replace(/^[ \t]*model_provider\s*=\s*"[^"]*"[ \t]*$/m, `model_provider = "${DPROX_PROVIDER}"`);
  } else {
    // No existing top-level model_provider — add ours at the very top.
    out = `model_provider = "${DPROX_PROVIDER}"\n${out}`;
  }

  const section = [
    BEGIN,
    `[model_providers.${DPROX_PROVIDER}]`,
    `name = "${DPROX_PROVIDER}"`,
    `wire_api = "${opts.wireApi ?? "responses"}"`,
    `requires_openai_auth = true`,
    `base_url = "${opts.baseUrl}"`,
    `experimental_bearer_token = "${opts.token ?? "dprox-local"}"`,
    END,
  ].join("\n");

  return `${out.replace(/\s*$/, "")}\n\n${section}\n`;
}

/** Remove our managed relay block and restore the previous `model_provider`. */
export function removeCodexRelay(toml: string): string {
  let out = toml.replace(new RegExp(`\\n*${escapeRe(BEGIN)}[\\s\\S]*?${escapeRe(END)}\\n?`, "g"), "\n");
  const m = PREV_RE.exec(out);
  if (m) {
    // Restore the recorded original provider.
    out = out.replace(
      new RegExp(`# dprox: previous model_provider = "[^"]*"\\n[ \\t]*model_provider\\s*=\\s*"[^"]*"`),
      `model_provider = "${m[1]}"`,
    );
  } else {
    // No breadcrumb: the `model_provider = "dprox"` we added had no original to
    // restore, so drop the line entirely (back to the pre-dprox state).
    out = out.replace(new RegExp(`^[ \\t]*model_provider\\s*=\\s*"${DPROX_PROVIDER}"[ \\t]*\\r?\\n?`, "m"), "");
  }
  return out.replace(/\n{3,}/g, "\n\n");
}
