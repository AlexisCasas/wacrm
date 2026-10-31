import { describe, expect, it } from 'vitest'
import { nextAttemptDelayMs } from './backoff'

describe('nextAttemptDelayMs', () => {
  const mid = () => 0.5
  it('grows exponentially from 30 s and is capped at 1 h', () => {
    expect([1, 2, 3, 4].map((a) => nextAttemptDelayMs(a, undefined, mid))).toEqual([30_000, 60_000, 120_000, 240_000])
    expect(nextAttemptDelayMs(20, undefined, mid)).toBe(3_600_000)
  })
  it('jitters +/-20 %', () => {
    expect(nextAttemptDelayMs(1, undefined, () => 0)).toBe(24_000)
    expect(nextAttemptDelayMs(1, undefined, () => 1)).toBe(36_000)
  })
  it('Retry-After wins when longer', () => {
    expect(nextAttemptDelayMs(1, 600_000, mid)).toBe(600_000)
    expect(nextAttemptDelayMs(3, 1_000, mid)).toBe(120_000)
  })
})
