import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Locale dictionaries are hand-maintained. English is the source of
// truth (src/i18n/request.ts falls back to en.json only when a whole
// locale file is missing — there is no per-key fallback), so a key
// that lands in en.json and not in a translation renders as a raw
// keypath for users on that locale. This guards the parity.
//
// P1 — es.json is now a REQUIRED, app-supported locale (see
// src/i18n/config.ts's SUPPORTED_LOCALES — Spanish is the commercial
// default and universal fallback).
//
// ko.json is intentionally EXCLUDED from this parity check. It predates
// SUPPORTED_LOCALES, is not selectable by any user-facing locale
// resolution/preference, and is not required to track new keys (e.g.
// the auth/language namespaces added for P1). It is left on disk as a
// legacy artifact rather than deleted, per explicit product decision,
// but is no longer treated as a maintained, app-supported catalogue.

const MESSAGES_DIR = join(process.cwd(), 'messages');
const SOURCE_LOCALE = 'en';
const TRANSLATED_LOCALES = ['es'];

function loadKeys(locale: string): Set<string> {
  const raw = readFileSync(join(MESSAGES_DIR, `${locale}.json`), 'utf8');
  const out = new Set<string>();
  const walk = (node: unknown, path: string) => {
    if (node && typeof node === 'object' && !Array.isArray(node)) {
      for (const [k, v] of Object.entries(node)) {
        walk(v, path ? `${path}.${k}` : k);
      }
      return;
    }
    out.add(path);
  };
  walk(JSON.parse(raw), '');
  return out;
}

describe('message catalogue parity', () => {
  const source = loadKeys(SOURCE_LOCALE);

  it.each(TRANSLATED_LOCALES)('%s.json covers every en.json key', (locale) => {
    const translated = loadKeys(locale);
    const missing = [...source].filter((k) => !translated.has(k)).sort();
    expect(missing, `${locale}.json is missing these keys`).toEqual([]);
  });

  it.each(TRANSLATED_LOCALES)('%s.json has no orphaned keys', (locale) => {
    const translated = loadKeys(locale);
    const orphaned = [...translated].filter((k) => !source.has(k)).sort();
    expect(orphaned, `${locale}.json has keys absent from en.json`).toEqual([]);
  });
});

describe('placeholder parity — every locale interpolates the same params', () => {
  // A translated string that drops, renames, or adds an ICU
  // placeholder (`{count}`, `{name}`, …) either crashes next-intl's
  // formatter or silently swallows a value the call site passed in.
  // Compares the *set* of `{identifier}` tokens per key across
  // locales — not their order or surrounding prose, which legitimately
  // differs by language.
  function extractPlaceholders(value: string): Set<string> {
    const out = new Set<string>();
    // Only record an identifier the first time we descend into a brace
    // from top level (depth 0 -> 1). A naive "match every `{identifier`"
    // regex also matches literal branch text inside nested ICU
    // plural/select blocks — e.g. `{count, plural, =1 {conversación}
    // other {conversaciones}}` — spuriously treating "conversación" as a
    // placeholder name. Tracking depth skips those nested `{...}`
    // branches, which sit at depth >= 1, and only captures genuine
    // top-level ICU arguments like `count`.
    let depth = 0;
    for (let i = 0; i < value.length; i++) {
      const ch = value[i];
      if (ch === '{') {
        if (depth === 0) {
          const m = /^\{\s*([a-zA-Z0-9_]+)/.exec(value.slice(i));
          if (m) out.add(m[1]);
        }
        depth++;
      } else if (ch === '}') {
        depth = Math.max(0, depth - 1);
      }
    }
    return out;
  }

  function loadLeaves(locale: string): Map<string, string> {
    const raw = readFileSync(join(MESSAGES_DIR, `${locale}.json`), 'utf8');
    const out = new Map<string, string>();
    const walk = (node: unknown, path: string) => {
      if (node && typeof node === 'object' && !Array.isArray(node)) {
        for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k);
        return;
      }
      if (typeof node === 'string') out.set(path, node);
    };
    walk(JSON.parse(raw), '');
    return out;
  }

  it.each(TRANSLATED_LOCALES)('%s.json uses the same placeholders as en.json for every shared key', (locale) => {
    const source = loadLeaves(SOURCE_LOCALE);
    const translated = loadLeaves(locale);
    const mismatches: string[] = [];

    for (const [key, sourceValue] of source) {
      const translatedValue = translated.get(key);
      if (translatedValue === undefined) continue; // covered by the parity tests above

      const sourcePlaceholders = extractPlaceholders(sourceValue);
      const translatedPlaceholders = extractPlaceholders(translatedValue);

      const missing = [...sourcePlaceholders].filter((p) => !translatedPlaceholders.has(p));
      const extra = [...translatedPlaceholders].filter((p) => !sourcePlaceholders.has(p));

      if (missing.length > 0 || extra.length > 0) {
        mismatches.push(
          `${key}: missing=[${missing.join(', ')}] extra=[${extra.join(', ')}]`,
        );
      }
    }

    expect(mismatches, `${locale}.json has placeholder mismatches vs en.json`).toEqual([]);
  });
});
