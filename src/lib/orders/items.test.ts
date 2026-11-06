import { describe, expect, it } from 'vitest'
import { validateOrderItems } from './items'
import { validateOrderInput } from './fields'

const base = { customer_name: 'Cliente QA', phone: '900000001', destination: 'Puno' }
const items = [
  { product_name: 'Guitarra', quantity: 1, unit_price: '190' },
  { product_name: 'Violin', quantity: 2, unit_price: '80' },
  { product_name: 'Tetera', quantity: 1, unit_price: '50' },
]

describe('structured order capture', () => {
  it('sums units and decimal currency without floating-point drift', () => {
    const result = validateOrderItems(items)
    expect(result).toMatchObject({ ok: true, product: '1 x Guitarra\n2 x Violin\n1 x Tetera', quantity: 4, price: '400.00' })
    expect(validateOrderItems([{ product_name: 'uno', quantity: 3, unit_price: '0.10' }])).toMatchObject({ price: '0.30' })
  })
  it('generates the identical frozen legacy header while keeping structured details', () => {
    const r = validateOrderInput({ ...base, items })
    expect(r.ok).toBe(true)
    expect(r.value).toMatchObject({ quantity: 4, price: '400.00', product: '1 x Guitarra\n2 x Violin\n1 x Tetera' })
    expect(r.value?.items).toHaveLength(3)
    expect(r.value?.items?.[0]).toMatchObject({ unit_price: '190.00', catalog_product_id: null })
  })
  it('keeps old single-product requests without detail rows', () => {
    const r = validateOrderInput({ ...base, product: '2 Guitarras', quantity: 2, price: '380' })
    expect(r.ok).toBe(true)
    expect(r.value?.items).toBeUndefined()
    expect(r.value?.price).toBe('380.00')
  })
  it('rejects invalid products, quantities, prices, excessively long summaries and totals', () => {
    const bad = [
      [{ ...items[0], product_name: 'a\nb' }],
      [{ ...items[0], quantity: 0 }],
      [{ ...items[0], unit_price: '0' }],
      [{ ...items[0], catalog_product_id: 'not-uuid' }],
      [{ ...items[0], quantity: 10000, unit_price: '9999999' }],
    ]
    for (const value of bad) expect(validateOrderInput({ ...base, items: value }).errors.items).toBeDefined()
    expect(validateOrderItems(Array.from({ length: 21 }, () => items[0])).ok).toBe(false)
    expect(validateOrderItems(Array.from({ length: 20 }, (_, i) => ({ ...items[0], product_name: 'Item-' + i + '-' + 'z'.repeat(70) }))).ok).toBe(false)
  })
  it('an explicitly empty items list is invalid, not a silent fallback to legacy', () => {
    expect(validateOrderInput({ ...base, items: [], product: 'legacy', quantity: 1, price: 90 }).errors.items).toBe('invalid_items')
  })
})
