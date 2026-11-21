import { describe, expect, it } from 'vitest'
import { effectiveCallDuration } from './calling-duration'

describe('effectiveCallDuration', () => {
  it('returns the duration persisted from Meta', () => {
    expect(effectiveCallDuration({ state: 'terminated', duration_seconds: 60 })).toBe(60)
  })

  it('returns a duration derived by the webhook processor from the same terminate payload', () => {
    expect(effectiveCallDuration({ state: 'terminated', duration_seconds: 65 })).toBe(65)
  })

  it('does not derive from stored timestamps that may contain a legacy provisional ACCEPTED time', () => {
    expect(effectiveCallDuration({
      state: 'terminated',
      duration_seconds: null,
    })).toBeNull()
  })

  it('does not display duration for rejected or failed calls even if a value is present', () => {
    expect(effectiveCallDuration({ state: 'rejected', duration_seconds: 99 })).toBeNull()
    expect(effectiveCallDuration({ state: 'failed', duration_seconds: 10 })).toBeNull()
  })

  it('does not display duration for active or unanswered calls', () => {
    expect(effectiveCallDuration({ state: 'connected', duration_seconds: null })).toBeNull()
    expect(effectiveCallDuration({ state: 'terminated', duration_seconds: null })).toBeNull()
  })

  it('rejects negative, fractional and out-of-range durations', () => {
    expect(effectiveCallDuration({ state: 'terminated', duration_seconds: -1 })).toBeNull()
    expect(effectiveCallDuration({ state: 'terminated', duration_seconds: 1.5 })).toBeNull()
    expect(effectiveCallDuration({ state: 'terminated', duration_seconds: 2_147_483_648 })).toBeNull()
  })

  it('keeps an explicit zero duration', () => {
    expect(effectiveCallDuration({ state: 'terminated', duration_seconds: 0 })).toBe(0)
  })
})
