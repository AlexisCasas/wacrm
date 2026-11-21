import { describe, expect, it } from 'vitest'

import { fieldEquals, parseAmount, scorePilot, sweepThresholds, type PilotRecord } from '@/lib/orders/logistics/ocr/pilot-metrics'

const rec = (over: Partial<PilotRecord> = {}): PilotRecord => ({
  truth: { dni: '12345678', phone: '900000001', customer_name: 'Ana María Pérez', amount: '150.50', shalom_number: '104453167', shalom_code: 'N3WC' },
  ocr: { dni: { value: '12345678', confidence: 0.97 }, phone: { value: '51900000001', confidence: 0.95 }, customer_name: { value: 'PEREZ ANA MARIA', confidence: 0.93 }, amount: { value: '150,50', confidence: 0.92 }, shalom_number: { value: '104453167', confidence: 0.96 }, shalom_code: { value: 'n3wc', confidence: 0.9 } },
  ms: 2000,
  costUsd: 0.01,
  ...over,
})

describe('fieldEquals', () => {
  it('compares each field in its canonical form', () => {
    expect(fieldEquals('dni', '12.345.678', '12345678')).toBe(true)
    expect(fieldEquals('dni', '1234567', '1234567')).toBe(false) // not a valid DNI: never "equal"
    expect(fieldEquals('phone', '+51 900 000 001', '900000001')).toBe(true)
    expect(fieldEquals('amount', '150,5', '150.50')).toBe(true)
    expect(fieldEquals('customer_name', 'Pérez Ana María', 'ana maria perez')).toBe(true)
    expect(fieldEquals('customer_name', 'Ana Pérez', 'Ana María Pérez')).toBe(false)
    expect(fieldEquals('shalom_code', 'n3-wc', 'N3WC')).toBe(true)
    expect(fieldEquals('destination', null, null)).toBe(true)
    expect(fieldEquals('destination', 'Piura', null)).toBe(false)
  })
})

describe('amount comparison ignores ONLY monetary presentation', () => {
  it('S/ 150.00, S/150.00, 150.00, 150 (and 150.0 / PEN / spaces) are the same value', () => {
    for (const v of ['S/ 150.00', 'S/150.00', 's/. 150.00', '150.00', '150', '150.0', 'PEN 150', ' 150.00 ']) expect(fieldEquals('amount', v, '150.00')).toBe(true)
    expect(fieldEquals('amount', 'S/ 150.00', 'S/150')).toBe(true)
    expect(fieldEquals('amount', '150,50', 'S/ 150.50')).toBe(true)
    expect(fieldEquals('amount', 'S/ 1,150.00', '1150')).toBe(true)
  })

  it('numerically different values still FAIL (no rounding, no digit-only matching)', () => {
    for (const v of ['S/ 150.01', '150.10', '15.00', '1500', 'S/ 105.00', '150.00.00', 'ciento cincuenta', 'S/ ', '']) expect(fieldEquals('amount', v, '150.00')).toBe(false)
    expect(fieldEquals('amount', 'S/ 150.50', '150.05')).toBe(false)
  })

  it('parseAmount: cents, or null when it is not a plain number', () => {
    expect(parseAmount('S/ 150.5')).toBe(15050)
    expect(parseAmount('abc')).toBeNull()
    expect(parseAmount('1.2.3')).toBeNull()
  })
})

describe('usage is optional', () => {
  it('a voucher answered without token usage is reported as usage_unavailable, is NOT a failure, and cost is never invented', () => {
    const r = scorePilot([rec({ costUsd: undefined }), rec({ costUsd: 0.02 })])
    expect(r.failed).toBe(0)
    expect(r.usageUnavailable).toBe(1)
    expect(r.costPerVoucherUsd).toBe(0.02) // only over the voucher that reported usage
    expect(scorePilot([rec({ costUsd: undefined })]).costPerVoucherUsd).toBeNull()
    expect(scorePilot([rec({ costUsd: undefined })]).fields.dni.accuracy).toBe(1)
  })
})

describe('scorePilot', () => {
  it('a perfect, confident voucher is clean and counts no false positive', () => {
    const r = scorePilot([rec()])
    expect(r.fields.dni).toMatchObject({ total: 1, correct: 1, accuracy: 1, falsePositives: 0 })
    expect(r.cleanRate).toBe(1)
    expect(r.needReviewRate).toBe(0)
    expect(r.costPerVoucherUsd).toBe(0.01)
    expect(r.meanMs).toBe(2000)
  })

  it('a CONFIDENT wrong value is a false positive; a wrong value read with low confidence is only doubtful (it already forces review)', () => {
    const confidentWrong = rec({ ocr: { ...rec().ocr, dni: { value: '87654321', confidence: 0.96 } } })
    const doubtfulWrong = rec({ ocr: { ...rec().ocr, dni: { value: '87654321', confidence: 0.5 } } })
    const r = scorePilot([confidentWrong, doubtfulWrong])
    expect(r.fields.dni.falsePositives).toBe(1)
    expect(r.fields.dni.doubtful).toBe(1)
    expect(r.fields.dni.accuracy).toBe(0)
    expect(r.needReviewRate).toBe(1)
  })

  it('a failed attempt (timeout / error / not configured) is counted by code and ALWAYS goes to manual review', () => {
    const r = scorePilot([rec(), { truth: rec().truth, ocr: undefined, errorCode: 'ocr_timeout' }, { truth: rec().truth, ocr: undefined, errorCode: 'ocr_not_configured' }])
    expect(r.failed).toBe(2)
    expect(r.failedByCode).toEqual({ ocr_timeout: 1, ocr_not_configured: 1 })
    expect(r.needReviewRate).toBeCloseTo(2 / 3)
  })

  it('matching: auto-matches are scored against the true order; a wrong auto-match is reported separately; pending is not an error', () => {
    const r = scorePilot([rec({ matchedOrder: 'o1', trueOrder: 'o1' }), rec({ matchedOrder: 'o2', trueOrder: 'o3' }), rec({ matchedOrder: null, trueOrder: 'o4' })])
    expect(r.matching).toMatchObject({ attempted: 3, autoMatched: 2, autoCorrect: 1, autoWrong: 1, pending: 1, correctRate: 0.5 })
  })

  it('a missing field is counted as missed', () => {
    const r = scorePilot([rec({ ocr: { ...rec().ocr, phone: { value: null, confidence: 0 } } })])
    expect(r.fields.phone.missed).toBe(1)
  })

  it('sweep: a higher threshold never has more false positives and never less review load', () => {
    const records = [rec(), rec({ ocr: { ...rec().ocr, dni: { value: '87654321', confidence: 0.88 } } })]
    const s = sweepThresholds(records)
    for (let i = 1; i < s.length; i++) {
      expect(s[i].falsePositives).toBeLessThanOrEqual(s[i - 1].falsePositives)
      expect(s[i].needReviewRate).toBeGreaterThanOrEqual(s[i - 1].needReviewRate)
    }
    expect(s.find((x) => x.threshold === 0.9)!.falsePositives).toBe(0)
    expect(s.find((x) => x.threshold === 0.85)!.falsePositives).toBe(1)
  })
})
