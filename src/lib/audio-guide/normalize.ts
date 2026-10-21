/**
 * The deterministic key a product is stored and looked up by.
 *
 * `Combo XTD`, ` combo   xtd `, `COMBO XTD`, `Cómbo XTD` and `combo xtd` all become `combo xtd`. No AI, no fuzzy matching, no
 * locale: the same text always gives the same key, so a lookup is an exact equality on a column the database keeps in this very
 * form (migration 073: lower case, single spaces, no leading or trailing space).
 *
 *   - Unicode compatibility forms are folded (full-width letters, ligatures), then the text is lower-cased;
 *   - accents / diacritics are removed (`á` -> `a`, `ñ` -> `n`, `ü` -> `u`);
 *   - zero-width characters are dropped, every run of whitespace (tabs, line breaks, no-break spaces) becomes one space, the ends are trimmed;
 *   - an empty result is `empty`, one over 120 characters is `too_long`, a non-string is `not_text`.
 */

export const PRODUCT_KEY_MAX_LENGTH = 120;

export type NormalizedProduct = { ok: true; key: string } | { ok: false; reason: "not_text" | "empty" | "too_long" };

const ZERO_WIDTH = /[​-‍⁠﻿]/g;
const COMBINING_MARKS = /\p{M}/gu;
const WHITESPACE_RUN = /\s+/gu; // JS \s already covers tabs, line breaks, no-break and ideographic spaces

export function normalizeProductValue(input: unknown): NormalizedProduct {
  if (typeof input !== "string") return { ok: false, reason: "not_text" };
  const key = input
    .normalize("NFKC")
    .replace(ZERO_WIDTH, "")
    .toLowerCase()
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .normalize("NFC")
    .replace(WHITESPACE_RUN, " ")
    .trim();
  if (key === "") return { ok: false, reason: "empty" };
  if (key.length > PRODUCT_KEY_MAX_LENGTH) return { ok: false, reason: "too_long" };
  return { ok: true, key };
}
