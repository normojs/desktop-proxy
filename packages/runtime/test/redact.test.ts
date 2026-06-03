import { describe, it, expect } from "vitest";

import { redactHeaders, redactSecretsInText, redactEntry } from "../src/net/redact";

describe("redactHeaders", () => {
  it("masks credential headers but keeps a short prefix", () => {
    const out = redactHeaders({
      authorization: "Bearer sk-abcdef1234567890",
      "x-api-key": "sk-secret9876543210",
      "content-type": "application/json",
    })!;
    expect(out["content-type"]).toBe("application/json");
    expect(out.authorization).toBe("Bearer sk-abc***");
    expect(out["x-api-key"]).toBe("sk-sec***");
    expect(out.authorization).not.toContain("1234567890");
  });

  it("masks Anthropic/Google key headers", () => {
    const out = redactHeaders({ "anthropic-api-key": "sk-ant-xxxxxxxxxxxx", "x-goog-api-key": "AIzaSyXXXXXXXX" })!;
    expect(out["anthropic-api-key"]).toContain("***");
    expect(out["x-goog-api-key"]).toContain("***");
    expect(out["x-goog-api-key"]).not.toContain("AIzaSyXXXXXXXX");
  });
});

describe("redactSecretsInText", () => {
  it("masks sk- keys, bearer tokens and JSON credential fields", () => {
    expect(redactSecretsInText("key=sk-abcd1234567890xyz")).toBe("key=sk-abc***");
    expect(redactSecretsInText("Authorization: Bearer abcdef123456789")).toBe("Authorization: Bearer ***");
    expect(redactSecretsInText('{"api_key":"super-secret-value","model":"x"}')).toBe(
      '{"api_key":"***","model":"x"}',
    );
  });

  it("passes through null/empty", () => {
    expect(redactSecretsInText(null)).toBeNull();
    expect(redactSecretsInText("")).toBe("");
    expect(redactSecretsInText("no secrets here")).toBe("no secrets here");
  });
});

describe("redactEntry", () => {
  it("scrubs headers and bodies on a copy, leaving the original intact", () => {
    const entry = {
      method: "POST",
      reqHeaders: { authorization: "Bearer sk-abcdef1234567890", accept: "*/*" },
      reqBody: '{"token":"abcdefghijklmnop","prompt":"hi"}',
      resBody: "used key sk-zzzz1111222233",
    };
    const out = redactEntry(entry);
    expect(out.reqHeaders.authorization).toBe("Bearer sk-abc***");
    expect(out.reqBody).toBe('{"token":"***","prompt":"hi"}');
    expect(out.resBody).toBe("used key sk-zzz***");
    // original untouched
    expect(entry.reqHeaders.authorization).toBe("Bearer sk-abcdef1234567890");
  });
});
