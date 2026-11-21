import { describe, expect, it } from 'vitest'
import { effectiveCallDuration } from './calling-duration'

describe('effectiveCallDuration', () => {
  it('prefers Meta duration when it differs from the timestamp delta', () => {
    expect(effectiveCallDuration({
      state: 'terminated', duration_seconds: 60,
      started_at: '2026-11-20T20:00:00.000Z', ended_at: '2026-11-20T20:01:05.000Z',
    })).toBe(60)
  })

  it('derives whole seconds from authoritative start and end timestamps when Meta omits duration', () => {
    expect(effectiveCallDuration({
      state: 'terminated', duration_seconds: null,
      started_at: '2026-11-20T15:00:00-05:00', ended_at: '2026-11-20T20:01:05.900Z',
    })).toBe(65)
  })

  it('does not display duration for rejected or failed calls even if a value is present', () => {
    expect(effectiveCallDuration({
      state: 'rejected', duration_seconds: 99,
      started_at: '2026-11-20T20:00:00.000Z', ended_at: '2026-11-20T20:01:39.000Z',
    })).toBeNull()
    expect(effectiveCallDuration({ state: 'failed', duration_seconds: 10 })).toBeNull()
  })

  it('does not display duration for active or unanswered calls', () => {
    expect(effectiveCallDuration({
      state: 'connected', duration_seconds: null,
      started_at: '2026-11-20T20:00:00.000Z', ended_at: null,
    })).toBeNull()
    expect(effectiveCallDuration({
      state: 'terminated', duration_seconds: null,
      started_at: null, ended_at: '2026-11-20T20:00:07.000Z',
    })).toBeNull()
  })

  it('rejects negative, reversed and invalid timestamp pairs', () => {
    expect(effectiveCallDuration({
      state: 'terminated', duration_seconds: null,
      started_at: '2026-11-20T20:05:00.000Z', ended_at: '2026-11-20T20:00:00.000Z',
    })).toBeNull()
    expect(effectiveCallDuration({
      state: 'terminated', duration_seconds: null, started_at: 'nope', ended_at: 'nope',
    })).toBeNull()
    expect(effectiveCallDuration({
      state: 'terminated', duration_seconds: -1,
      started_at: '2026-11-20T20:00:00.000Z', ended_at: '2026-11-20T20:00:08.000Z',
    })).toBe(8)
  })

  it('keeps an explicit zero duration', () => {
    expect(effectiveCallDuration({ state: 'terminated', duration_seconds: 0 })).toBe(0)
  })
})
