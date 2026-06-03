import { describe, it, expect } from "vitest";

import { applySystemTransforms, applyParams, transformsActive } from "../src/net/transform";

describe("applySystemTransforms", () => {
  it("appends to an existing Chat system message", () => {
    const out = applySystemTransforms(
      { messages: [{ role: "system", content: "Base." }, { role: "user", content: "hi" }] },
      { systemPrompt: { mode: "append", text: "Be terse." } },
    );
    const messages = out.messages as Array<Record<string, unknown>>;
    expect(messages[0].content).toBe("Base.\n\nBe terse.");
    expect(messages[1].content).toBe("hi"); // untouched
  });

  it("inserts a Chat system message when none exists", () => {
    const out = applySystemTransforms({ messages: [{ role: "user", content: "hi" }] }, { rules: ["No secrets"] });
    const messages = out.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({ role: "system", content: "- No secrets" });
    expect(messages[1].role).toBe("user");
  });

  it("modifies Responses `instructions` (prepend/replace)", () => {
    const appended = applySystemTransforms({ instructions: "X", input: [] }, { systemPrompt: { text: "Y" } });
    expect(appended.instructions).toBe("X\n\nY");
    const prepended = applySystemTransforms({ instructions: "X", input: [] }, { systemPrompt: { mode: "prepend", text: "Y" } });
    expect(prepended.instructions).toBe("Y\n\nX");
    const replaced = applySystemTransforms({ instructions: "X", input: [] }, { systemPrompt: { mode: "replace", text: "Y" } });
    expect(replaced.instructions).toBe("Y");
  });

  it("combines systemPrompt and rules", () => {
    const out = applySystemTransforms({ instructions: "" }, { systemPrompt: { text: "Policy:" }, rules: ["a", "b"] });
    expect(out.instructions).toBe("Policy:\n\n- a\n- b");
  });

  it("does not mutate the original body", () => {
    const body = { messages: [{ role: "system", content: "Base." }] };
    applySystemTransforms(body, { systemPrompt: { text: "Z" } });
    expect((body.messages[0] as Record<string, unknown>).content).toBe("Base.");
  });

  it("is a no-op without transforms", () => {
    const body = { messages: [] };
    expect(applySystemTransforms(body, undefined)).toBe(body);
    expect(applySystemTransforms(body, {})).toBe(body);
  });
});

describe("applyParams", () => {
  it("overrides top-level params", () => {
    expect(applyParams({ model: "x", temperature: 1 }, { params: { temperature: 0, top_p: 0.5 } })).toEqual({
      model: "x",
      temperature: 0,
      top_p: 0.5,
    });
  });
  it("is a no-op without params", () => {
    const b = { model: "x" };
    expect(applyParams(b, {})).toBe(b);
  });
});

describe("transformsActive", () => {
  it("detects whether any transform is configured", () => {
    expect(transformsActive(undefined)).toBe(false);
    expect(transformsActive({})).toBe(false);
    expect(transformsActive({ systemPrompt: { text: "x" } })).toBe(true);
    expect(transformsActive({ rules: ["x"] })).toBe(true);
    expect(transformsActive({ params: { t: 1 } })).toBe(true);
    expect(transformsActive({ rules: [] })).toBe(false);
  });
});
