import { describe, it, expect } from "vitest";

import { applyGuardrails, type GuardRule } from "../src/net/guardrails";

describe("applyGuardrails", () => {
  it("is a no-op without rules", () => {
    expect(applyGuardrails("hello", undefined)).toEqual({ blocked: false, text: "hello", redactions: 0 });
  });

  it("blocks on a matching block rule (short-circuits)", () => {
    const rules: GuardRule[] = [{ pattern: "INTERNAL-ONLY", action: "block", message: "contains secret marker" }];
    const r = applyGuardrails('{"prompt":"this is INTERNAL-ONLY data"}', rules);
    expect(r.blocked).toBe(true);
    expect(r.message).toBe("contains secret marker");
  });

  it("redacts matches and counts them", () => {
    const rules: GuardRule[] = [{ pattern: "\\b[\\w.]+@[\\w.]+\\b", action: "redact", replacement: "[email]" }];
    const r = applyGuardrails("mail a@b.com and c@d.io", rules);
    expect(r.blocked).toBe(false);
    expect(r.text).toBe("mail [email] and [email]");
    expect(r.redactions).toBe(2);
  });

  it("applies redact rules cumulatively, block wins if earlier", () => {
    const rules: GuardRule[] = [
      { pattern: "foo", action: "redact", replacement: "X" },
      { pattern: "STOP", action: "block" },
    ];
    expect(applyGuardrails("foo foo", rules).text).toBe("X X");
    expect(applyGuardrails("foo STOP", rules).blocked).toBe(true);
  });

  it("ignores invalid regex", () => {
    const r = applyGuardrails("text", [{ pattern: "(", action: "redact" }]);
    expect(r).toEqual({ blocked: false, text: "text", redactions: 0 });
  });
});
