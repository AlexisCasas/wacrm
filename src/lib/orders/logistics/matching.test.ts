import { describe, expect, it } from 'vitest'

import { decideMatch, extractSignals, MATCHING_CONFIG, type MatchCandidateOrder } from '@/lib/orders/logistics/matching'

const f = (dni: string | null, phone: string | null, c = 0.95) => ({
  ...(dni === null ? {} : { dni: { value: dni, confidence: c } }),
  ...(phone === null ? {} : { phone: { value: phone, confidence: c } }),
})
const order = (id: string, dni: string | null, phone: string): MatchCandidateOrder => ({ id, dni, phone })
const A = order('A', '12345678', '51900000001')
const B = order('B', '87654321', '51900000002')

describe('MATCHING_CONFIG is centralized and conservative', () => {
  it('requires two distinct strong signals and a confidence floor', () => {
    expect(MATCHING_CONFIG).toEqual({ strongSignals: ['dni', 'phone'], minStrongSignals: 2, minFieldConfidence: 0.8 })
  })
})

describe('extractSignals', () => {
  it('normalizes DNI and phone and separates low-confidence ones (never used)', () => {
    expect(extractSignals(f('12.345.678', '+51 900 000 001'))).toEqual({ usable: { dni: '12345678', phone: '51900000001' }, lowConfidence: [] })
    expect(extractSignals({ dni: { value: '12345678', confidence: 0.5 }, phone: { value: '900000001', confidence: 0.9 } })).toEqual({
      usable: { phone: '51900000001' },
      lowConfidence: ['dni'],
    })
  })

  it('values that are not a DNI / phone are not signals at all', () => {
    expect(extractSignals(f('123', 'abc'))).toEqual({ usable: {}, lowConfidence: [] })
  })

  it('a confidence exactly at the floor is accepted', () => {
    expect(extractSignals(f('12345678', null, 0.8)).usable).toEqual({ dni: '12345678' })
  })
})

describe('decideMatch · automatic association only when it is unambiguous', () => {
  it('ONE candidate matching DNI and phone -> auto', () => {
    expect(decideMatch(f('12345678', '51900000001'), [A, B])).toEqual({ kind: 'auto', orderId: 'A', signals: ['dni', 'phone'] })
  })

  it('formatting differences do not matter (dots, +51, bare 9 digits)', () => {
    expect(decideMatch(f('12.345.678', '900 000 001'), [A, B])).toMatchObject({ kind: 'auto', orderId: 'A' })
  })

  it('the SAME customer with two pending orders is ambiguous: never picked arbitrarily, both offered', () => {
    const A2 = order('A2', '12345678', '51900000001')
    expect(decideMatch(f('12345678', '51900000001'), [A, A2])).toEqual({
      kind: 'pending',
      reason: 'ambiguous',
      candidates: [
        { orderId: 'A', signals: ['dni', 'phone'] },
        { orderId: 'A2', signals: ['dni', 'phone'] },
      ],
    })
  })

  it('another order sharing even ONE strong signal makes it ambiguous (conservative)', () => {
    const shared = order('S', null, '51900000001') // same phone, no DNI on file
    expect(decideMatch(f('12345678', '51900000001'), [A, shared])).toMatchObject({ kind: 'pending', reason: 'ambiguous' })
  })

  it('only ONE signal matches -> pending (insufficient), the candidate is suggested for a person', () => {
    expect(decideMatch(f('12345678', null), [A, B])).toEqual({ kind: 'pending', reason: 'insufficient_signals', candidates: [{ orderId: 'A', signals: ['dni'] }] })
    expect(decideMatch(f(null, '51900000001'), [A, B])).toEqual({ kind: 'pending', reason: 'insufficient_signals', candidates: [{ orderId: 'A', signals: ['phone'] }] })
  })

  it('an order without DNI can never be auto-matched, even if the phone matches', () => {
    expect(decideMatch(f('12345678', '51900000001'), [order('N', null, '51900000001')])).toMatchObject({ kind: 'pending', reason: 'insufficient_signals' })
  })

  it('DNI of one order and phone of another -> ambiguous (two different orders hit)', () => {
    expect(decideMatch(f('12345678', '51900000002'), [A, B])).toMatchObject({ kind: 'pending', reason: 'ambiguous' })
  })

  it('nobody matches -> pending no_candidates', () => {
    expect(decideMatch(f('11111111', '51911111111'), [A, B])).toEqual({ kind: 'pending', reason: 'no_candidates', candidates: [] })
    expect(decideMatch(f('12345678', '51900000001'), [])).toEqual({ kind: 'pending', reason: 'no_candidates', candidates: [] })
  })

  it('the OCR read no usable signal -> pending no_signals; read but unsure -> pending low_confidence', () => {
    expect(decideMatch({}, [A])).toEqual({ kind: 'pending', reason: 'no_signals', candidates: [] })
    expect(decideMatch(f('abc', '123'), [A])).toEqual({ kind: 'pending', reason: 'no_signals', candidates: [] })
    expect(decideMatch(f('12345678', '51900000001', 0.5), [A])).toEqual({ kind: 'pending', reason: 'low_confidence', candidates: [] })
  })

  it('one signal confident and the other not -> only one usable -> insufficient (the doubtful one is not trusted)', () => {
    const fields = { dni: { value: '12345678', confidence: 0.95 }, phone: { value: '51900000001', confidence: 0.3 } }
    expect(decideMatch(fields, [A])).toMatchObject({ kind: 'pending', reason: 'insufficient_signals' })
  })

  it('thresholds are configuration: a stricter rule (3 signals) can never auto-match with the two available', () => {
    expect(decideMatch(f('12345678', '51900000001'), [A], { ...MATCHING_CONFIG, minStrongSignals: 3 })).toMatchObject({ kind: 'pending', reason: 'insufficient_signals' })
    expect(decideMatch(f('12345678', '51900000001', 0.85), [A], { ...MATCHING_CONFIG, minFieldConfidence: 0.9 })).toMatchObject({ kind: 'pending', reason: 'low_confidence' })
    expect(decideMatch(f('12345678', null), [A], { ...MATCHING_CONFIG, minStrongSignals: 1 })).toMatchObject({ kind: 'auto', orderId: 'A' })
  })

  it('decisions are deterministic: the candidate order never changes the outcome', () => {
    expect(decideMatch(f('12345678', '51900000001'), [B, A])).toEqual(decideMatch(f('12345678', '51900000001'), [A, B]))
  })
})
