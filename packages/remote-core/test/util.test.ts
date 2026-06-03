import { describe, it, expect } from "vitest";

import { utf8Encode, utf8Decode, utf8Length } from "../src/util";

describe("utf8", () => {
  it("round-trips ASCII, Chinese and emoji", () => {
    for (const s of ["hello", "你好，世界", "think step by step 🚀", ""]) {
      expect(utf8Decode(utf8Encode(s))).toBe(s);
    }
  });
  it("counts bytes, not UTF-16 units", () => {
    expect(utf8Length("ab")).toBe(2);
    expect(utf8Length("你好")).toBe(6); // 3 bytes each
    expect(utf8Length("🚀")).toBe(4);
  });
});
