import { describe, expect, it } from 'vitest'
import { normalizeMetaStatus, parseMetaTimestamp } from './message-status'

describe('normalizeMetaStatus', () => {
  it('keeps the four values the column stores', () => {
    for (const s of ['sent', 'delivered', 'read', 'failed'] as const) expect(normalizeMetaStatus(s)).toBe(s)
  })
  it("stores Meta's `played` (voice note) as `read`", () => {
    expect(normalizeMetaStatus('played')).toBe('read')
  })
  it('returns null for anything else, including look-alikes, other cases and non-strings', () => {
    for (const v of ['deleted', 'warning', 'pending', 'sending', 'replied', 'SENT', ' sent', 'sent ', '', null, undefined, 3, {}, ['sent']]) {
      expect(normalizeMetaStatus(v), JSON.stringify(v)).toBeNull()
    }
  })
})

describe('parseMetaTimestamp', () => {
  it('reads epoch seconds given as a string or a number', () => {
    expect(parseMetaTimestamp('1793970000')?.toISOString()).toBe('2026-11-06T13:00:00.000Z')
    expect(parseMetaTimestamp(1793970000)?.toISOString()).toBe('2026-11-06T13:00:00.000Z')
    expect(parseMetaTimestamp(' 1793970000 ')?.getTime()).toBe(1793970000_000)
  })
  it('returns null (never throws) for anything that is not a plausible instant', () => {
    for (const v of ['', 'abc', '-5', '0', 0, -1, NaN, Infinity, '1.5', '1e9', '99999999999999999999', '4102444800000', undefined, null, {}, []]) {
      expect(parseMetaTimestamp(v), JSON.stringify(v)).toBeNull()
    }
  })
  it('rejects instants before 2015 and after 2100', () => {
    expect(parseMetaTimestamp('1400000000')).toBeNull()
    expect(parseMetaTimestamp('4200000000')).toBeNull()
  })
})
