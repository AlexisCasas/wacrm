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

// ---------------------------------------------------------------------------------------------------------------------------------------
// Names of the per-account catalogs "purpose" (finalidad) and "identifier" (identificador), migration 076.
//
// The visible NAME keeps the person's capitalisation and accents (only whitespace is tidied); the unique KEY is the same deterministic fold as a
// product key (compatibility forms, lower case, no accents, single spaces). Both are limited to 60 characters, like the database CHECKs. Two
// names that differ only in case, accents or spacing are the SAME name: the database refuses the second one.
// ---------------------------------------------------------------------------------------------------------------------------------------

export const CATALOG_NAME_MAX_LENGTH = 60;

export type NormalizedCatalogName = { ok: true; name: string; key: string } | { ok: false; reason: "not_text" | "empty" | "too_long" };

export function normalizeCatalogName(input: unknown): NormalizedCatalogName {
  if (typeof input !== "string") return { ok: false, reason: "not_text" };
  const name = input.normalize("NFC").replace(ZERO_WIDTH, "").replace(WHITESPACE_RUN, " ").trim();
  if (name === "") return { ok: false, reason: "empty" };
  const folded = normalizeProductValue(name); // same fold as a product key (its own 120-character limit is wider than ours)
  if (!folded.ok) return { ok: false, reason: folded.reason === "too_long" ? "too_long" : "empty" };
  if ([...name].length > CATALOG_NAME_MAX_LENGTH || [...folded.key].length > CATALOG_NAME_MAX_LENGTH) return { ok: false, reason: "too_long" };
  return { ok: true, name, key: folded.key };
}
