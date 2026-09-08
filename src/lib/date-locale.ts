import { es, enUS, type Locale } from 'date-fns/locale';
import { useLocale } from 'next-intl';

import { normalizeLocale, type AppLocale } from '@/i18n/config';

/**
 * Maps the app's active locale (src/i18n/config.ts) to the corresponding
 * date-fns / Intl locale, so month/day names and relative-time phrases
 * (`format(date, 'MMMM')`, `formatDistanceToNow`, `toLocaleDateString`)
 * follow `profiles.locale` instead of defaulting to English.
 */
const DATE_FNS_LOCALES: Record<AppLocale, Locale> = {
  es,
  en: enUS,
};

const INTL_LOCALE_TAGS: Record<AppLocale, string> = {
  es: 'es-ES',
  en: 'en-US',
};

export function getDateFnsLocale(locale: AppLocale): Locale {
  return DATE_FNS_LOCALES[locale];
}

export function getIntlLocaleTag(locale: AppLocale): string {
  return INTL_LOCALE_TAGS[locale];
}

/** Client-side hook: the current locale's date-fns Locale, for `format()` / `formatDistanceToNow()`. */
export function useDateFnsLocale(): Locale {
  return getDateFnsLocale(normalizeLocale(useLocale()));
}

/** Client-side hook: the current locale as a BCP-47 tag, for `toLocaleDateString()` / `toLocaleString()`. */
export function useIntlLocaleTag(): string {
  return getIntlLocaleTag(normalizeLocale(useLocale()));
}
