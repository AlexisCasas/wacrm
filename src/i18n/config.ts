/**
 * Single source of truth for supported app locales — P1 (Spanish by
 * default + per-user Spanish/English switch).
 *
 * Every other file that needs to know "which locales exist" or "what
 * do we fall back to" imports from here rather than re-declaring
 * `['es', 'en']` or `=== 'es'` inline. `ko` is a legacy dictionary
 * (messages/ko.json) kept around so it isn't lost, but it is NOT a
 * supported app locale — no user preference, request resolution, or
 * UI picker may select it. Extending support to a third locale later
 * is a one-line change here.
 */

export const SUPPORTED_LOCALES = ['es', 'en'] as const;

export type AppLocale = (typeof SUPPORTED_LOCALES)[number];

/**
 * The commercial default and universal fallback. Applies to:
 * signed-out visitors, a profile with no locale set, an invalid/
 * unknown stored value, and any error resolving the preference.
 * Never the browser/Accept-Language — see src/i18n/request.ts.
 */
export const DEFAULT_LOCALE: AppLocale = 'es';

export function isSupportedLocale(value: unknown): value is AppLocale {
  return (
    typeof value === 'string' &&
    (SUPPORTED_LOCALES as readonly string[]).includes(value)
  );
}

/**
 * Normalize an arbitrary stored/incoming value into a supported
 * locale, defensively — DB constraints already restrict
 * `profiles.locale` to 'es' | 'en', but this is the one place that
 * decides what ANY caller (request-locale resolution, useAuth,
 * Settings) does when the value is missing, null, empty, wrong case,
 * or simply not one we support. Always fails closed to
 * {@link DEFAULT_LOCALE} — never throws, never guesses from the
 * browser.
 */
export function normalizeLocale(value: unknown): AppLocale {
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase();
    if (isSupportedLocale(lower)) return lower;
  }
  return DEFAULT_LOCALE;
}
