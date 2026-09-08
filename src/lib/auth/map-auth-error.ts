/**
 * Maps a raw Supabase Auth error into a stable, localized copy key —
 * P1 (Spanish by default). Auth pages must never show
 * `error.message` directly: Supabase's own error text is always
 * English regardless of the signed-out visitor's locale (which
 * defaults to Spanish), so `setError(error.message)` silently mixed
 * English technical text into an otherwise-localized page.
 *
 * `t` must be a translator already scoped to the `AuthErrors`
 * namespace (`useTranslations("AuthErrors")`) — this returns the
 * rendered copy, not a raw key, so callers can drop it straight into
 * `setError(...)`.
 *
 * The real error is still logged to the console for debugging — this
 * only changes what the USER sees, never what gets logged.
 */

export type AuthErrorContext = 'login' | 'signup' | 'passwordReset';

type AuthErrorLike = {
  code?: string;
  status?: number;
  message?: string;
};

/** Supabase Auth's own `.code` values (supabase-js v2), when present —
 *  the most reliable signal, checked before any message-text guess. */
const CODE_TO_KEY: Record<string, string> = {
  invalid_credentials: 'invalidCredentials',
  email_not_confirmed: 'emailNotConfirmed',
  user_already_exists: 'userAlreadyExists',
  email_exists: 'userAlreadyExists',
  weak_password: 'weakPassword',
  over_email_send_rate_limit: 'rateLimited',
  over_request_rate_limit: 'rateLimited',
  otp_expired: 'expiredInvite',
  session_not_found: 'sessionExpired',
  refresh_token_not_found: 'sessionExpired',
};

/** Fallback for older client versions / edge cases where `.code` is
 *  absent — matches Supabase's documented English message text.
 *  Order matters: more specific patterns first. */
const MESSAGE_PATTERNS: Array<[RegExp, string]> = [
  [/invalid login credentials/i, 'invalidCredentials'],
  [/email not confirmed/i, 'emailNotConfirmed'],
  [/(user )?already registered/i, 'userAlreadyExists'],
  [/password.*(should be|at least|weak)/i, 'weakPassword'],
  [/rate limit/i, 'rateLimited'],
  [/expired/i, 'expiredInvite'],
  [/(network|fetch failed|failed to fetch|load failed)/i, 'networkError'],
];

function genericKeyFor(context: AuthErrorContext): string {
  switch (context) {
    case 'login':
      return 'genericLogin';
    case 'signup':
      return 'genericSignup';
    case 'passwordReset':
      return 'genericPasswordReset';
  }
}

export function mapAuthError(
  error: unknown,
  t: (key: string) => string,
  context: AuthErrorContext,
): string {
  if (error) {
    // Technical detail stays in the console/server logs — never the
    // user-facing string returned below.
    console.error(
      `[auth:${context}]`,
      error instanceof Error ? error.message : error,
    );
  }

  const err = (error ?? {}) as AuthErrorLike;

  if (err.code && CODE_TO_KEY[err.code]) {
    return t(CODE_TO_KEY[err.code]);
  }

  if (err.status === 429) {
    return t('rateLimited');
  }

  const message =
    typeof err.message === 'string'
      ? err.message
      : error instanceof Error
        ? error.message
        : '';

  for (const [pattern, key] of MESSAGE_PATTERNS) {
    if (pattern.test(message)) {
      return t(key);
    }
  }

  return t(genericKeyFor(context));
}
