import { describe, expect, it } from 'vitest'
import { HEADERS, KEY_COLUMN_INDEX, ProjectionError, columnLetter, limaSerial, projectOrder, toCents, type OrderInput } from './layout'

const base: OrderInput = {
  id: '11111111-1111-4111-8111-111111111111', account_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', confirmed_at: '2026-11-04T15:30:05.000Z',
  customer_name: 'Cliente Sintetico', dni: '00000001', phone: '51900000001', product: 'Hidrolavadora INGCO 2030 PSI', quantity: 1, price: '145.00',
  order_description: null, agency: 'Shalom', destination: 'Lima', seller_name: 'Vendedor Uno', order_status: 'Pedido confirmado', department: 'Lima',
}
const items = [
  { line_number: 1, catalog_product_id: null, product_name: 'Hidrolavadora INGCO 2030 PSI', quantity: 1, unit_price: '95.00', subtotal: '95.00' },
  { line_number: 2, catalog_product_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', product_name: 'Paquete de 100 discos', quantity: 1, unit_price: '50.00', subtotal: '50.00' },
]

describe('projectOrder', () => {
  it('multiproduct: one row per line, one order id, order total repeated but line prices are subtotals', () => {
    const p = projectOrder({ ...base, quantity: 2 }, items, '2026-11-06T00:00:00.000Z')
    expect(p.lines).toHaveLength(2)
    expect(p.units).toBe(2)
    expect(p.totalCents).toBe(14500)
    expect(p.lines.map((l) => l.cells[HEADERS.indexOf('Precio')])).toEqual([95, 50])
    expect(new Set(p.lines.map((l) => l.cells[HEADERS.indexOf('ID pedido')]))).toEqual(new Set([base.id]))
    expect(p.lines.map((l) => l.cells[KEY_COLUMN_INDEX])).toEqual([`${base.id}:1`, `${base.id}:2`])
    expect(p.lines.every((l) => l.cells[HEADERS.indexOf('Importe del pedido (no sumar)')] === 145)).toBe(true)
    expect(p.lines.every((l) => l.cells.length === HEADERS.length)).toBe(true)
    expect(p.lines.reduce((a, l) => a + l.cents, 0)).toBe(p.totalCents)
  })
  it('traditional order: one row, never invents a unit price', () => {
    const p = projectOrder({ ...base, quantity: 3, price: 120 }, [], 'x')
    expect(p.lines).toHaveLength(1)
    expect(p.lines[0].cells[HEADERS.indexOf('Precio unitario')]).toBe('')
    expect(p.lines[0].cells[HEADERS.indexOf('Tipo')]).toBe('tradicional')
    expect(p.lines[0].cells[HEADERS.indexOf('Precio')]).toBe(120)
  })
  it('refuses inconsistent data instead of exporting a guess', () => {
    expect(() => projectOrder({ ...base, price: '146.00' }, items, 'x')).toThrow(ProjectionError)
    expect(() => projectOrder(base, [{ ...items[0], subtotal: '96.00' }, items[1]], 'x')).toThrow(/subtotal|total/)
  })
  it('keeps text exactly as stored (sheets are written RAW, so "=" stays text)', () => {
    const p = projectOrder({ ...base, customer_name: '=HYPERLINK("x")' }, [], 'x')
    expect(p.lines[0].cells[2]).toBe('=HYPERLINK("x")')
  })
  it('converts the timestamp to Lima wall-clock Sheets serials', () => {
    const s = limaSerial('2026-11-04T15:30:05.000Z')   // 10:30:05 Lima
    expect(s.date).toBe(46330)
    expect(Math.round((s.dateTime - s.date) * 86400)).toBe(10 * 3600 + 30 * 60 + 5)
    expect(limaSerial('2026-11-05T03:00:00.000Z').date).toBe(46330)  // 22:00 Lima of the 4th
  })
  it('is deterministic apart from the export timestamp', () => {
    const a = projectOrder(base, [], 't1').lines[0].cells, b = projectOrder(base, [], 't2').lines[0].cells
    expect(a.filter((_, i) => i !== HEADERS.indexOf('Exportado (UTC)'))).toEqual(b.filter((_, i) => i !== HEADERS.indexOf('Exportado (UTC)')))
  })
})
describe('helpers', () => {
  it('toCents is exact', () => { expect(toCents('0.10') + toCents('0.20')).toBe(30); expect(toCents(95)).toBe(9500); expect(() => toCents('1.234')).toThrow() })
  it('columnLetter', () => { expect([0, 25, 26, 27].map(columnLetter)).toEqual(['A', 'Z', 'AA', 'AB']); expect(columnLetter(KEY_COLUMN_INDEX)).toBe('Q') })
})
