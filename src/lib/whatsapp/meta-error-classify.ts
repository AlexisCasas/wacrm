import { MetaApiError } from './meta-api'

/**
 * Whether a failed Meta send is safe to automatically retry, and why.
 *
 * Deliberately narrow — see docs/META_131056_AUTOMATION_RETRY_AUDIT.md
 * section 9 for the full reasoning. This is Phase 2: only 131056 (Meta's
 * Business/Consumer Account pair rate limit) is ever classified
 * retryable. Nothing else — not a bare HTTP 429 without that specific
 * code, not a timeout, not a 5xx, not a plain `Error` whose text happens
 * to mention "131056" — because the only trustworthy signal is a real,
 * structured `MetaApiError.code`, never string matching. A plain-text
 * regex would treat a log line, a user-typed message, or a completely
 * unrelated error that happens to quote "131056" as retryable — this
 * type only ever looks at `MetaApiError.code`.
 */
export type MetaSendErrorClassification =
  | {
      retryable: true
      reason: 'meta_pair_rate_limit'
      code: 131056
      retryAfterSeconds?: number
    }
  | {
      retryable: false
      reason: 'not_retryable'
      code?: number
    }

/**
 * Classify a caught error from a Meta send attempt.
 *
 * The ONLY source of truth for "is this 131056" is
 * `error instanceof MetaApiError && error.code === 131056` — never a
 * string/regex test against `.message`. This is what makes it safe: a
 * `MetaApiError` only ever comes from `throwMetaError` parsing a REAL
 * non-2xx HTTP response Meta itself returned (see meta-api.ts), so
 * `code` reflects what Meta's error body actually said, not text that
 * merely resembles it.
 *
 * Everything else — a bare HTTP 429 without this code, any other
 * MetaApiError (400/401/403/5xx/131030/24h-window), a plain `Error`
 * (including one whose message happens to contain "131056"), a
 * `TypeError` from a failed `fetch`, `null`/`undefined`, or the
 * "sent to Meta but DB insert failed" error thrown AFTER a successful
 * send — is `retryable: false`. Retrying any of those either risks a
 * duplicate send (Meta already has the message) or simply isn't safe to
 * assume idempotent yet.
 */
export function classifyMetaSendError(error: unknown): MetaSendErrorClassification {
  if (error instanceof MetaApiError && error.code === 131056) {
    return {
      retryable: true,
      reason: 'meta_pair_rate_limit',
      code: 131056,
      retryAfterSeconds: error.retryAfterSeconds,
    }
  }
  return {
    retryable: false,
    reason: 'not_retryable',
    code: error instanceof MetaApiError ? error.code : undefined,
  }
}
