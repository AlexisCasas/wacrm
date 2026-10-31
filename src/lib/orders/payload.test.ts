import { describe, expect, it } from 'vitest'
import { buildInkaclickPayload, toLimaIso, toTwoDecimals, type OrderRow } from './payload'

const row: OrderRow = {
  id: '0b8e9f4e-5a52-4d0e-9d6e-3c7c4f0a1111', confirmed_at: '2026-11-01T03:05:09.000Z', customer_name: 'Cliente Sintetico', dni: null,
  phone: '51900000001', product: 'Nivel laser', quantity: 2, price: '150.5', order_description: null, agency: 'Shalom', destination: 'Arequipa',
  seller_name: 'Vendedor Uno', order_status: 'Pedido confirmado', department: null,
}

describe('toLimaIso', () => {
  it('uses America/Lima (UTC-5, no DST), crossing the day boundary', () => {
    expect(toLimaIso('2026-11-01T03:05:09.000Z')).toBe('2026-10-31T22:05:09-05:00')
    expect(toLimaIso('2026-01-01T05:00:00.000Z')).toBe('2026-01-01T00:00:00-05:00')
  })
})

describe('buildInkaclickPayload', () => {
  it('is typed, tagged source=wacrm and carries the stable external id; the phone stays text', () => {
    const p = buildInkaclickPayload(row)
    expect(p).toMatchObject({
      source: 'wacrm', external_order_id: row.id, telefono: '51900000001', cantidad_productos: 2, precio: '150.50',
      estado_pedido: 'Pedido confirmado', agencia: 'Shalom', vendedor: 'Vendedor Uno', dni: null, departamento: null, descripcion_pedido: null,
    })
    expect(typeof p.telefono).toBe('string')
    expect(JSON.parse(JSON.stringify(p))).toEqual(p)
  })
  it('never carries ManyChat identifiers', () => {
    expect(Object.keys(buildInkaclickPayload(row)).join(',')).not.toMatch(/manychat/i)
  })
  it('keeps monetary precision as a string', () => {
    expect(toTwoDecimals('150.5')).toBe('150.50')
    expect(toTwoDecimals(7)).toBe('7.00')
    expect(toTwoDecimals('0.1')).toBe('0.10')
  })
})
