/**
 * Relay setup diagnostics (pure).
 *
 * Turns the relay/Codex configuration into a checklist so `dprox relay doctor` can
 * tell you exactly why model traffic isn't flowing: relay enabled? upstream set?
 * not pointing at itself? Codex wired to the relay + login bypass? model map sane?
 * The network probes (is the daemon listening? is the upstream reachable?) are
 * added by the command; everything here is pure + unit tested.
 */

export type CheckStatus = "ok" | "warn" | "fail";

export interface RelayCheck {
  name: string;
  status: CheckStatus;
  detail?: string;
  hint?: string;
}

export interface RelayDoctorInput {
  enabled?: boolean;
  upstream?: string;
  localBase: string;
  apiKey?: string;
  modelMap?: Record<string, string>;
  upstreamApi?: string;
  /** ~/.codex/config.toml present? */
  codexConfigPresent?: boolean;
  /** config.toml has our [model_providers.dprox] block? */
  codexHasRelay?: boolean;
  /** Current Codex provider base_url (to confirm it points at us). */
  codexProviderBaseUrl?: string | null;
  /** ~/.codex/auth.json present (login bypass)? */
  codexAuthPresent?: boolean;
}

const trim = (s: string) => s.replace(/\/+$/, "");

export function buildRelayDiagnostics(i: RelayDoctorInput): RelayCheck[] {
  const checks: RelayCheck[] = [];

  checks.push(
    i.enabled
      ? { name: "relay enabled", status: "ok" }
      : { name: "relay enabled", status: "fail", hint: 'run "dprox relay on --upstream <url> ..."' },
  );

  checks.push(
    i.upstream
      ? { name: "upstream configured", status: "ok", detail: i.upstream }
      : { name: "upstream configured", status: "fail", hint: "pass --upstream <url>" },
  );

  if (i.upstream) {
    const selfLoop = trim(i.upstream) === trim(i.localBase);
    checks.push(
      selfLoop
        ? { name: "no self-loop", status: "fail", detail: "upstream is the relay itself", hint: "set a real upstream" }
        : { name: "no self-loop", status: "ok" },
    );
  }

  if (i.codexConfigPresent) {
    const pointed =
      i.codexHasRelay === true ||
      (!!i.codexProviderBaseUrl && trim(i.codexProviderBaseUrl) === trim(i.localBase));
    checks.push(
      pointed
        ? { name: "Codex → relay", status: "ok", detail: i.localBase }
        : {
            name: "Codex → relay",
            status: "warn",
            detail: i.codexProviderBaseUrl ?? "(provider not set)",
            hint: 'run "dprox relay on --codex"',
          },
    );
    checks.push(
      i.codexAuthPresent
        ? { name: "Codex login bypass (auth.json)", status: "ok" }
        : {
            name: "Codex login bypass (auth.json)",
            status: "warn",
            hint: 'Codex will need ChatGPT login — "relay on --codex" writes auth.json',
          },
    );
  }

  const mapN = i.modelMap ? Object.keys(i.modelMap).length : 0;
  checks.push(
    mapN > 0
      ? { name: "model map", status: "ok", detail: Object.entries(i.modelMap!).map(([k, v]) => `${k}→${v}`).join(", ") }
      : { name: "model map", status: "warn", detail: "none", hint: 'optional: --map "gpt-*=<model>"' },
  );

  if (i.upstreamApi === "chat") {
    checks.push({ name: "protocol translation", status: "ok", detail: "Responses ↔ chat/completions" });
  }

  return checks;
}

/** Overall status: fail if any fail, else warn if any warn, else ok. */
export function overallStatus(checks: RelayCheck[]): CheckStatus {
  if (checks.some((c) => c.status === "fail")) return "fail";
  if (checks.some((c) => c.status === "warn")) return "warn";
  return "ok";
}
