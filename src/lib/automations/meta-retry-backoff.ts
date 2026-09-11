/**
 * Backoff schedule for Meta 131056 (Business/Consumer Account pair rate
 * limit) durable retries — Automations only, Phase 3 of
 * docs/META_131056_AUTOMATION_RETRY_AUDIT.md.
 *
 * Deliberately NOT the same helper as `src/lib/broadcast-retry.ts`
 * (`batchRetryDelayMs`) — that one is a short-lived, in-request retry
 * for a broadcast batch (cap 120s, no persistence); this one backs a
 * DURABLE retry that survives redeploy via a new
 * `automation_pending_executions` row and a cron pickup, on a much
 * longer, fixed 1/2/5/10/15-minute schedule. Same spirit (respect
 * `Retry-After`, never let it be more aggressive than our own floor),
 * different mechanism.
 */

/** Total durable retries after the initial attempt. The initial attempt
 *  itself does not count — 1 initial + up to 5 retries = 6 tries total. */
export const MAX_META_RATE_LIMIT_RETRIES = 5

/** retryNumber -> base delay in seconds. retryNumber is 1-indexed (the
 *  Nth retry, not the Nth attempt) and always looked up after the
 *  caller has already confirmed `retryNumber <= MAX_META_RATE_LIMIT_RETRIES`. */
const BASE_BACKOFF_SECONDS: Readonly<Record<number, number>> = {
  1: 60,
  2: 120,
  3: 300,
  4: 600,
  5: 900,
}

/** Upper bound of the deterministic jitter added on top of the
 *  (base vs. provider-supplied) delay — small enough to never meanfully
 *  undercut the backoff schedule, just enough to avoid every retry for
 *  every contact landing on the exact same wall-clock second. */
const MAX_JITTER_MS = 5000

export interface MetaRateLimitDelayArgs {
  /** 1-indexed retry attempt number — must be within
   *  1..MAX_META_RATE_LIMIT_RETRIES. Anything else is a programming
   *  error in the caller (a retry that was never supposed to be
   *  scheduled in the first place), not a runtime condition to degrade
   *  gracefully from — this throws rather than silently clamping. */
  retryNumber: number
  /** Meta's own `Retry-After`, in seconds, if the failed response
   *  carried one (see `MetaApiError.retryAfterSeconds` /
   *  `parseRetryAfterSeconds` in meta-api.ts). */
  retryAfterSeconds?: number
  /** Deterministic input for the jitter component — the SAME seed
   *  always produces the SAME jitter, so tests never flake and a given
   *  (automation, contact, step, retry number) combination always
   *  backs off by a reproducible amount. Callers should combine
   *  automation id + contact id + step id + retryNumber, e.g.
   *  `` `${automationId}:${contactId}:${stepId}:${retryNumber}` `` —
   *  this module doesn't prescribe the exact format, only that it be
   *  stable for the same logical retry.
   */
  seed: string
}

/**
 * Total delay (milliseconds) before a Meta-rate-limited step should be
 * retried: `max(our own backoff floor, Meta's Retry-After) + a small
 * deterministic jitter`.
 *
 * Meta's `Retry-After` is respected but never allowed to make the
 * schedule MORE aggressive than our own floor for that retry number —
 * a small `Retry-After` (e.g. 2 minutes on retry #3, whose floor is 5
 * minutes) must not shorten our wait; a LARGER `Retry-After` (e.g. 10
 * minutes on retry #2, whose floor is 2 minutes) correctly extends it.
 * `Math.max` on the two millisecond values is the entire rule.
 */
export function metaRateLimitDelayMs(args: MetaRateLimitDelayArgs): number {
  const { retryNumber, retryAfterSeconds, seed } = args
  const baseSeconds = BASE_BACKOFF_SECONDS[retryNumber]
  if (baseSeconds === undefined) {
    throw new Error(
      `metaRateLimitDelayMs: retryNumber must be an integer between 1 and ${MAX_META_RATE_LIMIT_RETRIES}, got ${retryNumber}`,
    )
  }

  const baseMs = baseSeconds * 1000
  const providerMs =
    typeof retryAfterSeconds === 'number' && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? retryAfterSeconds * 1000
      : 0
  const delayBeforeJitter = Math.max(baseMs, providerMs)

  return delayBeforeJitter + deterministicJitterMs(seed)
}

/**
 * Deterministic pseudo-jitter in `[0, MAX_JITTER_MS]` derived from
 * `seed` — the same seed always yields the same value (no
 * `Math.random()`, so tests are never flaky), different seeds spread
 * out across the range. Not cryptographic — this only needs to avoid
 * a thundering-herd of identical `run_at` timestamps, not resist
 * an adversary.
 */
function deterministicJitterMs(seed: string): number {
  let hash = 0
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0
  }
  return Math.abs(hash) % (MAX_JITTER_MS + 1)
}
