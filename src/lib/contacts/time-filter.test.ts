import { describe, expect, it } from 'vitest'
import { isTimeFilterActive, parseLocalDate, resolveTimeRange } from './time-filter'

const NOW = new Date(2026, 10, 5, 15, 30, 0) // 5 Nov 2026 15:30 local
const DAY = 24 * 60 * 60 * 1000
const range = (f: Parameters<typeof resolveTimeRange>[0], from = '', to = '') => {
  const r = resolveTimeRange(f, NOW, from, to)
  if (!r.ok) throw new Error(r.reason)
  return r.range
}

describe('resolveTimeRange (contacts.created_at window [from, to))', () => {
  it('Todos: no window at all', () => {
    expect(range('all')).toEqual({ from: null, to: null })
    expect(isTimeFilterActive(range('all'))).toBe(false)
  })
  it('Hoy: from the start of the local day, no upper bound', () => {
    expect(range('today')).toEqual({ from: new Date(2026, 10, 5).toISOString(), to: null })
  })
  it.each([[ 'last7', 7 ], [ 'last30', 30 ], [ 'last60', 60 ], [ 'last90', 90 ]] as const)('%s: created in the last %i days', (f, days) => {
    expect(range(f)).toEqual({ from: new Date(NOW.getTime() - days * DAY).toISOString(), to: null })
  })
  it.each([[ 'older30', 30 ], [ 'older60', 60 ], [ 'older90', 90 ]] as const)('%s: created before now - %i days (exclusive)', (f, days) => {
    expect(range(f)).toEqual({ from: null, to: new Date(NOW.getTime() - days * DAY).toISOString() })
  })
  it('custom: Desde inclusive, Hasta inclusive (window ends at the start of the next local day)', () => {
    expect(range('custom', '2026-10-01', '2026-10-31')).toEqual({ from: new Date(2026, 9, 1).toISOString(), to: new Date(2026, 10, 1).toISOString() })
  })
  it('custom: one open end is allowed', () => {
    expect(range('custom', '2026-10-01', '')).toEqual({ from: new Date(2026, 9, 1).toISOString(), to: null })
    expect(range('custom', '', '2026-10-31')).toEqual({ from: null, to: new Date(2026, 10, 1).toISOString() })
  })
  it('custom: same day is a one-day window', () => {
    expect(range('custom', '2026-10-15', '2026-10-15')).toEqual({ from: new Date(2026, 9, 15).toISOString(), to: new Date(2026, 9, 16).toISOString() })
  })
  it('custom: inverted, empty or malformed ranges are not applied', () => {
    expect(resolveTimeRange('custom', NOW, '2026-10-31', '2026-10-01')).toEqual({ ok: false, reason: 'invalid_range' })
    expect(resolveTimeRange('custom', NOW, '', '')).toEqual({ ok: false, reason: 'incomplete' })
    expect(resolveTimeRange('custom', NOW, '2026-02-31', '')).toEqual({ ok: false, reason: 'incomplete' })
  })
  it('parseLocalDate only accepts real calendar days', () => {
    expect(parseLocalDate('2026-02-28')).not.toBeNull()
    expect(parseLocalDate('2026-02-30')).toBeNull()
    expect(parseLocalDate('10/05/2026')).toBeNull()
  })
})
