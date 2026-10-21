import { describe, expect, it } from "vitest";
import { PRODUCT_KEY_MAX_LENGTH, normalizeProductValue } from "./normalize";

const key = (v: unknown) => {
  const r = normalizeProductValue(v);
  return r.ok ? r.key : r.reason;
};

describe("normalizeProductValue", () => {
  it("folds case, accents and extra spaces to one key", () => {
    for (const v of ["Combo XTD", " combo   xtd ", "COMBO XTD", "Cómbo XTD", "combo\txtd", "combo xtd", "combo\nxtd", "ＣＯＭＢＯ　ＸＴＤ", "Cómbo XTD", "combo​ xtd"]) {
      expect(key(v)).toBe("combo xtd");
    }
  });

  it("removes diacritics from Spanish text", () => {
    expect(key("Amoladora Ángulo Ñandú Pingüino")).toBe("amoladora angulo nandu pinguino");
    expect(key("TALADRO + AMOLADORA")).toBe("taladro + amoladora");
  });

  it("keeps characters that are not letters, so different products stay different", () => {
    expect(key("Combo XTD")).not.toBe(key("Combo XTD 2"));
    expect(key("Taladro+Amoladora")).not.toBe(key("Taladro Amoladora"));
    expect(key("Combo-1")).toBe("combo-1");
  });

  it("is idempotent", () => {
    const once = key("  Cómbo   Ñ  ");
    expect(key(once)).toBe(once);
  });

  it("reports empty, blank and invisible-only values as empty", () => {
    for (const v of ["", "   ", "\t\n", "​​", " "]) expect(key(v)).toBe("empty");
  });

  it("reports non-text and over-long values", () => {
    for (const v of [null, undefined, 42, {}, [], true]) expect(key(v)).toBe("not_text");
    expect(key("a".repeat(PRODUCT_KEY_MAX_LENGTH))).toBe("a".repeat(PRODUCT_KEY_MAX_LENGTH));
    expect(key("a".repeat(PRODUCT_KEY_MAX_LENGTH + 1))).toBe("too_long");
  });

  it("always produces a key the database accepts (lower case, single spaces, no edge spaces)", () => {
    for (const v of ["Ünï  Cödé ", "A  B   C", "X", "ǅ lj", "İstanbul"]) {
      const k = key(v);
      expect(k).toBe(k.toLowerCase());
      expect(k).toMatch(/^[^\s]+( [^\s]+)*$/u);
    }
  });
});
