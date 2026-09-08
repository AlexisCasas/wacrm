import { getRequestConfig } from 'next-intl/server';
import { createClient } from '@/lib/supabase/server';
import { DEFAULT_LOCALE, normalizeLocale, type AppLocale } from './config';

/**
 * Per-request, per-user server-side locale resolution — P1 (Spanish
 * by default + per-user Spanish/English switch).
 *
 * Replaces the old `NEXT_PUBLIC_APP_LOCALE || 'en'` env-based global
 * default: that variable is no longer read here and is no longer the
 * source of truth for which language a request renders in (grep the
 * repo for `NEXT_PUBLIC_APP_LOCALE` if you find a stray reference —
 * it should not affect the commercial rule below).
 *
 * Resolution order, every branch failing closed to
 * {@link DEFAULT_LOCALE} ('es') — NEVER the browser's
 * Accept-Language, NEVER `navigator.language`:
 *   1. No Supabase session at all (signed-out visitor, auth pages,
 *      middleware-protected routes before login) -> 'es'.
 *   2. Signed in -> read `profiles.locale` for the current user via
 *      the normal RLS-scoped session client (no service_role — the
 *      existing `profiles_select` policy already lets a user read
 *      their own row).
 *   3. No profile row / locale null / unrecognized value / the query
 *      itself throws or errors -> 'es'.
 *   4. `profile.locale === 'en'` -> 'en'. Anything else
 *      (including a literal 'es') -> 'es', via {@link normalizeLocale}.
 *
 * Never lets a locale-resolution problem break the page render — every
 * failure mode here resolves to a valid locale + a loadable dictionary,
 * not a thrown error.
 */
async function resolveLocale(): Promise<AppLocale> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return DEFAULT_LOCALE;
    }

    const { data, error } = await supabase
      .from('profiles')
      .select('locale')
      .eq('user_id', user.id)
      .maybeSingle();

    if (error || !data) {
      return DEFAULT_LOCALE;
    }

    return normalizeLocale((data as { locale?: unknown }).locale);
  } catch {
    // Any unexpected failure (network, auth, malformed cookie, …) —
    // never let locale resolution take the page down with it.
    return DEFAULT_LOCALE;
  }
}

async function loadMessages(locale: AppLocale) {
  try {
    return (await import(`../../messages/${locale}.json`)).default;
  } catch {
    // A dictionary file failing to load is a build/deploy problem,
    // not a reason to guess another language — fall back to the
    // commercial default's own dictionary, never to English
    // specifically and never to the browser's preference.
    return (await import(`../../messages/${DEFAULT_LOCALE}.json`)).default;
  }
}

export default getRequestConfig(async () => {
  const locale = await resolveLocale();
  const messages = await loadMessages(locale);

  return {
    locale,
    messages,
  };
});
