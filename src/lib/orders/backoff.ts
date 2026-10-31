// Delay before the next delivery attempt: 30 s, 1 min, 2 min, ... capped at 1 h, +/-20 % jitter so a recovering receiver is not hit in lockstep.
// A Retry-After from the receiver wins when it is longer.
export const MAX_ATTEMPTS = 8

export function nextAttemptDelayMs(attempt: number, retryAfterMs?: number, random: () => number = Math.random): number {
  const base = Math.min(30_000 * 2 ** Math.max(attempt - 1, 0), 3_600_000)
  const jittered = Math.round(base * (0.8 + random() * 0.4))
  return Math.max(jittered, retryAfterMs ?? 0)
}
