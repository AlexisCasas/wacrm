import { describe, expect, it } from 'vitest'

import { compareWithOrder, type OrderForComparison } from '@/lib/orders/logistics/compare'
import { maskTail, nameTokens, normalizeAmount, normalizeDni, normalizePhone } from '@/lib/orders/logistics/normalize'

describe('normalizers', () => {
  it('DNI: exactly 8 digits once separators are gone', () => {
    expect(normalizeDni('12.345.678')).toBe('12345678')
    expect(normalizeDni(' 12345678 ')).toBe('12345678')
    expect(normalizeDni('1234567')).toBeNull()
    expect(normalizeDni('123456789')).toBeNull()
    expect(normalizeDni(null)).toBeNull()
    expect(normalizeDni('')).toBeNull()
  })

  it('phone: 51XXXXXXXXX from +51 / 51 / bare 9 digits; anything else is not comparable', () => {
    expect(normalizePhone('+51 900 000 001')).toBe('51900000001')
    expect(normalizePhone('51900000001')).toBe('51900000001')
    expect(normalizePhone('900000001')).toBe('51900000001')
    expect(normalizePhone('0900000001')).toBeNull()
    expect(normalizePhone('12345')).toBeNull()
    expect(normalizePhone(undefined)).toBeNull()
  })

  it('amount: currency symbols, thousands and decimal separators in both conventions', () => {
    expect(normalizeAmount('S/ 1,200.50')).toBe(1200.5)
    expect(normalizeAmount('1.200,50')).toBe(1200.5)
    expect(normalizeAmount('10')).toBe(10)
    expect(normalizeAmount('10,5')).toBe(10.5)
    expect(normalizeAmount('1,200')).toBe(1200)
    expect(normalizeAmount('abc')).toBeNull()
    expect(normalizeAmount('')).toBeNull()
  })

  it('names: lowercase, accent-less words of 2+ letters', () => {
    expect(nameTokens('  María-José  Ñañez ')).toEqual(['maria', 'jose', 'nanez'])
    expect(nameTokens(null)).toEqual([])
  })

  it('maskTail never reveals more than the last 3 characters', () => {
    expect(maskTail('12345678')).toBe('*****678')
    expect(maskTail('51900000001')).toBe('******001')
    expect(maskTail('ab')).toBe('**')
  })
})

const order: OrderForComparison = { customer_name: 'Juan Carlos Pérez Soto', dni: '12345678', phone: '51900000001', price: '120.50' }
const f = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { value: v }]))
const by = (c: ReturnType<typeof compareWithOrder>, field: string) => c.find((x) => x.field === field)!

describe('compareWithOrder (the order is already known: this is validation, never matching)', () => {
  it('everything consistent -> all match', () => {
    const c = compareWithOrder(f({ dni: '12.345.678', phone: '+51 900 000 001', customer_name: 'PEREZ SOTO JUAN CARLOS', amount: 'S/ 120.50' }), order)
    expect(c.map((x) => x.status)).toEqual(['match', 'match', 'match', 'match'])
  })

  it('different DNI / phone / amount -> mismatch; a different person -> mismatch', () => {
    const c = compareWithOrder(f({ dni: '87654321', phone: '51900000002', customer_name: 'Ana Gomez Ruiz', amount: '99' }), order)
    expect(c.map((x) => x.status)).toEqual(['mismatch', 'mismatch', 'mismatch', 'mismatch'])
  })

  it('a field the OCR did not read is `missing`; an order without DNI is `not_comparable`', () => {
    const c = compareWithOrder(f({ phone: '900000001' }), { ...order, dni: null })
    expect(by(c, 'dni').status).toBe('missing')
    expect(by(c, 'amount').status).toBe('missing')
    const withDni = compareWithOrder(f({ dni: '12345678' }), { ...order, dni: null })
    expect(by(withDni, 'dni').status).toBe('not_comparable')
  })

  it('an unreadable value (not a DNI / phone / amount) is `not_comparable`, never a false mismatch', () => {
    const c = compareWithOrder(f({ dni: 'ABCD', phone: '123', amount: 'gratis' }), order)
    expect([by(c, 'dni').status, by(c, 'phone').status, by(c, 'amount').status]).toEqual(['not_comparable', 'not_comparable', 'not_comparable'])
  })

  it('names need at least 2 shared words and 75 % of the shorter name', () => {
    expect(by(compareWithOrder(f({ customer_name: 'Juan Perez' }), order), 'customer_name').status).toBe('match')
    expect(by(compareWithOrder(f({ customer_name: 'Juan' }), order), 'customer_name').status).toBe('mismatch')
    expect(by(compareWithOrder(f({ customer_name: 'Juan Lopez Diaz' }), order), 'customer_name').status).toBe('mismatch')
  })

  it('DNI and phone of the order are only ever returned masked; the OCR value (voucher content) is returned as read', () => {
    const c = compareWithOrder(f({ dni: '12345678', phone: '900000001' }), order)
    expect(by(c, 'dni').order_value).toBe('*****678')
    expect(by(c, 'phone').order_value).toBe('******001')
    expect(JSON.stringify(c)).not.toContain('12345678678')
    expect(JSON.stringify(c.map((x) => x.order_value))).not.toContain('51900000001')
  })
})
