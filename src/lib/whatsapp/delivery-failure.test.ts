import { describe, expect, it, vi } from 'vitest'
import { normalizeMetaDeliveryFailure, recordMetaDeliveryFailure } from './delivery-failure'

describe('Meta delivery failure metadata', () => {
  it('uses only a numeric code and capped printable title, never a raw error message', () => {
    const result = normalizeMetaDeliveryFailure([{
      code: 131026, title: 'Not delivered\n  to recipient',
      message: 'customer phone 51900000000',
      error_data: { details: 'sensitive payload' },
    }])
    expect(result).toEqual({ code: 131026, title: 'Not delivered to recipient' })
    expect(JSON.stringify(result)).not.toContain('51900000000')
  })
  it('masks long numbers in titles before they reach the inbox', () => {
    const result = normalizeMetaDeliveryFailure([{
      code: 131026,
      title: 'Delivery blocked for 51939665944, contact +51987654321',
      message: 'private metadata',
    }])
    expect(result).toEqual({
      code: 131026,
      title: 'Delivery blocked for #, contact +#',
    })
    expect(JSON.stringify(result)).not.toContain('51939665944')
    expect(JSON.stringify(result)).not.toContain('51987654321')
  })
  it('rejects missing or malformed reasons', () => {
    for (const val of [null, {}, [], [{ code: '131026' }], [{ code: 0 }], [{ code: 1.5 }]]) {
      expect(normalizeMetaDeliveryFailure(val)).toBeNull()
    }
  })
  it('limits the title length and skips malformed earlier errors', () => {
    const result = normalizeMetaDeliveryFailure([{ code: 'bad' }, { code: 123, title: 'x'.repeat(500) }])
    expect(result?.title).toHaveLength(160)
  })
  it('does not call the database for absent reasons', async () => {
    const rpc = vi.fn()
    const db = { rpc } as never
    expect(await recordMetaDeliveryFailure(db, { accountId: 'A', wamid: 'w', errors: [] })).toBe('ignored')
    expect(rpc).not.toHaveBeenCalled()
  })
  it('contains database failure without logging private Meta details', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const rpc = vi.fn().mockResolvedValue({ error: { code: 'PGRST999', message: 'private' } })
    const db = { rpc } as never
    expect(await recordMetaDeliveryFailure(db, { accountId: 'A', wamid: 'w', errors: [{ code: 131026, title: 'Undeliverable' }] })).toBe('error')
    expect(spy.mock.calls.flat().join(' ')).not.toContain('private')
    spy.mockRestore()
  })
})
