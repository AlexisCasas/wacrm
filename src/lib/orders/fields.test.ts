import { describe, expect, it } from 'vitest'
import { normalizePeruPhone, normalizePrice, validateOrderInput } from './fields'

const base = { customer_name: 'Cliente Sintetico', phone: '900000001', product: 'Nivel laser', quantity: '2', price: '150.5', destination: 'Arequipa' }

describe('normalizePeruPhone', () => {
  it.each([['900000001', '51900000001'], ['+51 900 000 001', '51900000001'], ['51900000001', '51900000001'], [900000001, '51900000001']])('%s -> %s', (input, out) => {
    expect(normalizePeruPhone(input)).toBe(out)
  })
  it.each(['', '12345', '800000001', '5190000000', 'abc'])('rejects %j', (input) => {
    expect(normalizePeruPhone(input)).toBeNull()
  })
})

describe('normalizePrice (order total, keeps cents)', () => {
  it.each([['150', '150.00'], ['150.5', '150.50'], ['150,50', '150.50'], ['0.99', '0.99'], [12, '12.00'], ['007', '7.00']])('%s -> %s', (input, out) => {
    expect(normalizePrice(input)).toBe(out)
  })
  it.each(['0', '0.00', '-5', '1.234', '1,234.50', 'abc', '', '99999999'])('rejects %j', (input) => {
    expect(normalizePrice(input)).toBeNull()
  })
})

describe('validateOrderInput', () => {
  it('accepts the minimum: DNI, description and department are optional; agency defaults to Shalom', () => {
    const v = validateOrderInput(base)
    expect(v.ok).toBe(true)
    expect(v.value).toMatchObject({ phone: '51900000001', quantity: 2, price: '150.50', agency: 'Shalom', dni: '', department: '', order_description: '' })
  })

  it('warns, but does not block, on a DNI that is not 8 digits', () => {
    const v = validateOrderInput({ ...base, dni: '1234' })
    expect(v.ok).toBe(true)
    expect(v.warnings.dni).toBe('not_8_digits')
    expect(validateOrderInput({ ...base, dni: '12345678' }).warnings.dni).toBeUndefined()
  })

  it.each(['customer_name', 'phone', 'product', 'quantity', 'price', 'destination'] as const)('%s is required', (field) => {
    const v = validateOrderInput({ ...base, [field]: '' })
    expect(v.ok).toBe(false)
    expect(v.errors[field]).toBeDefined()
  })

  it.each(['0', '-1', '1.5', 'dos', '10001'])('rejects quantity %j', (q) => {
    expect(validateOrderInput({ ...base, quantity: q }).errors.quantity).toBe('invalid_quantity')
  })

  it('a price of 0 is invalid (InkaClick would mark the order paid)', () => {
    expect(validateOrderInput({ ...base, price: '0' }).errors.price).toBe('invalid_price')
  })

  it('canonicalises a valid department (case/accents) and rejects an unknown one', () => {
    expect(validateOrderInput({ ...base, department: 'ancash' }).value?.department).toBe('Áncash')
    expect(validateOrderInput({ ...base, department: 'SAN MARTIN' }).value?.department).toBe('San Martín')
    expect(validateOrderInput({ ...base, department: 'Narnia' }).errors.department).toBe('unknown_department')
    expect(validateOrderInput({ ...base, department: '' }).ok).toBe(true)
  })

  it('keeps free text and URL descriptions verbatim (trimmed)', () => {
    expect(validateOrderInput({ ...base, order_description: '  2 niveles, color rojo  ' }).value?.order_description).toBe('2 niveles, color rojo')
    expect(validateOrderInput({ ...base, order_description: 'https://example.invalid/foto.jpg' }).value?.order_description).toBe('https://example.invalid/foto.jpg')
    expect(validateOrderInput({ ...base, order_description: 'x'.repeat(2001) }).errors.order_description).toBe('too_long')
  })

  it('keeps the multi-line product list InkaClick already supports', () => {
    expect(validateOrderInput({ ...base, product: '2 Niveles\n1 Tripode' }).value?.product).toBe('2 Niveles\n1 Tripode')
  })
})
