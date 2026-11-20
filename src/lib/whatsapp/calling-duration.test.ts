import { describe, expect, it } from 'vitest'
import { effectiveCallDuration } from './calling-duration'

describe('effectiveCallDuration', () => {
  it('prefers the duration reported by Meta', () => {
    expect(effectiveCallDuration({
      state: 'terminated', duration_seconds: 60,
      started_at: '2026-11-20T20:00:00.000Z', ended_at: '2026-11-20T20:05:00.000Z',
    })).toBe(60)
  })

  it('derives the duration from started_at and ended_at when Meta omitted it', () => {
    expect(effectiveCallDuration({
      state: 'terminated', duration_seconds: null,
      started_at: '2026-11-20T20:00:00.000Z', ended_at: '2026-11-20T20:01:05.900Z',
    })).toBe(65)
  })

  it('returns null for unanswered, rejected or failed calls', () => {
    const base = { duration_seconds: null, started_at: null, ended_at: '2026-11-20T20:00:07.000Z' }
    expect(effectiveCallDuration({ ...base, state: 'terminated' })).toBeNull()
    expect(effectiveCallDuration({ ...base, state: 'rejected' })).toBeNull()
    expect(effectiveCallDuration({ ...base, state: 'failed', started_at: '2026-11-20T20:00:00.000Z' })).toBeNull()
  })

  it('does not report a duration for calls that are still active', () => {
    expect(effectiveCallDuration({
      state: 'connected', duration_seconds: null,
      started_at: '2026-11-20T20:00:00.000Z', ended_at: null,
    })).toBeNull()
  })

  it('ignores impossible or unparsable timestamps', () => {
    expect(effectiveCallDuration({
      state: 'terminated', duration_seconds: null,
      started_at: '2026-11-20T20:05:00.000Z', ended_at: '2026-11-20T20:00:00.000Z',
    })).toBeNull()
    expect(effectiveCallDuration({
      state: 'terminated', duration_seconds: null, started_at: 'nope', ended_at: 'nope',
    })).toBeNull()
  })

  it('keeps an explicit zero duration', () => {
    expect(effectiveCallDuration({ state: 'terminated', duration_seconds: 0 })).toBe(0)
  })
})
