import { describe, expect, it } from 'vitest'
import { buildPrefill } from './prefill'

describe('buildPrefill', () => {
  it('takes name and phone from the contact and the rest from matching custom fields (case/accent-insensitive)', () => {
    const v = buildPrefill({ name: ' Cliente Sintetico ', phone: '51900000001' }, [
      { field_name: 'Producto', value: 'Nivel laser' },
      { field_name: 'PRECIO', value: '150' },
      { field_name: 'destino', value: 'Arequipa' },
      { field_name: 'Descripción de pedido', value: 'color rojo' },
      { field_name: 'Departamento', value: 'Arequipa' },
      { field_name: 'DNI', value: '12345678' },
      { field_name: 'Cantidad', value: '3' },
    ])
    expect(v).toEqual({
      customer_name: 'Cliente Sintetico', phone: '51900000001', dni: '12345678', product: 'Nivel laser', quantity: '3', price: '150',
      order_description: 'color rojo', agency: 'Shalom', destination: 'Arequipa', department: 'Arequipa',
    })
  })
  it('defaults quantity to 1 and agency to Shalom, leaves unknown values empty, ignores blank and unrelated fields', () => {
    const v = buildPrefill({ phone: '900000001' }, [{ field_name: 'Producto', value: '   ' }, { field_name: 'WALLY', value: 'x' }])
    expect(v).toMatchObject({ customer_name: '', phone: '900000001', product: '', quantity: '1', agency: 'Shalom', price: '', destination: '' })
  })
  it('keeps the phone as text, including leading zeros', () => {
    expect(buildPrefill({ phone: '0123' }, []).phone).toBe('0123')
  })
})
