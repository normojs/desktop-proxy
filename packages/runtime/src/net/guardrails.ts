/**
 * Outbound guardrails for the relay (pure).
 *
 * Rules inspect the forwarded request and either BLOCK it (reject before it leaves
 * the machine) or REDACT matches (so the upstream model never sees them). This is
 * the in-flight counterpart to capture redaction: e.g. stop a prompt that contains
 * an internal secret from being sent, or mask emails/keys out of prompts.
 *
 * Rules run in order; the first "block" match short-circuits. "redact" rules all
 * apply cumulatively.
 */

export interface GuardRule {
  /** Regex source tested against the request text. */
  pattern: string;
  /** Regex flags (default "gi"). */
  flags?: string;
  /** block → reject the request; redact → replace matches. */
  action: "block" | "redact";
  /** Replacement for redact rules (default "***"). */
  replacement?: string;
  /** Message returned/logged when a block rule fires. */
  message?: string;
}

export interface GuardResult {
  blocked: boolean;
  message?: string;
  text: string;
  redactions: number;
}

export function applyGuardrails(text: string, rules?: GuardRule[]): GuardResult {
  if (!rules || rules.length === 0) return { blocked: false, text, redactions: 0 };
  let out = text;
  let redactions = 0;
  for (const rule of rules) {
    let re: RegExp;
    try {
      re = new RegExp(rule.pattern, rule.flags ?? "gi");
    } catch {
      continue; // skip invalid patterns
    }
    if (rule.action === "block") {
      if (re.test(out)) return { blocked: true, message: rule.message ?? "blocked by guardrail", text: out, redactions };
    } else {
      out = out.replace(re, () => {
        redactions++;
        return rule.replacement ?? "***";
      });
    }
  }
  return { blocked: false, text: out, redactions };
}
