import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'

import { cancelOrder, editOrder } from '@/lib/orders/payments/service'

const ORDER = '11111111-1111-4111-8111-111111111111'
const ctx = { userId: '22222222-2222-4222-8222-222222222222', accountId: '33333333-3333-4333-8333-333333333333' }
const admin = (data: unknown, error: { code?: string; message?: string } | null = null) => {
  const rpc = vi.fn(async () => ({ data, error }))
  return { rpc, client: { rpc } as unknown as SupabaseClient }
}

describe('editOrder', () => {
  it('sends only whitelisted fields, with the session identity, never money from the browser', async () => {
    const a = admin({ ok: true, changed: true, fields: ['destination'], total: 100, pending_balance: 70 })
    const r = await editOrder(ctx, a.client, ORDER, { fields: { destination: 'Cusco', customer_name: 'Ana' }, reason: 'dato corregido' })
    expect(r).toMatchObject({ ok: true, status: 200, body: { changed: true, total: 100, pending_balance: 70 } })
    expect(a.rpc).toHaveBeenCalledWith('edit_order_confirmation', expect.objectContaining({ p_account: ctx.accountId, p_actor: ctx.userId, p_order: ORDER, p_fields: { destination: 'Cusco', customer_name: 'Ana' }, p_reason: 'dato corregido' }))
  })
  it.each([[{ price: '1.00' }], [{ total: '1.00' }], [{ account_id: 'x' }], [{ request_key: 'x' }], [{}], [{ seller_user_id: 'no-uuid' }], [{ destination: 5 }]])('refuses %j without calling the database', async (fields) => {
    const a = admin({ ok: true })
    const r = await editOrder(ctx, a.client, ORDER, { fields, reason: 'x' })
    expect(r).toMatchObject({ ok: false, status: 400 })
    expect(a.rpc).not.toHaveBeenCalled()
  })
  it('requires a reason and a valid order id', async () => {
    const a = admin({ ok: true })
    expect(await editOrder(ctx, a.client, ORDER, { fields: { destination: 'A' }, reason: '  ' })).toMatchObject({ ok: false, status: 422, error: 'reason_required' })
    expect(await editOrder(ctx, a.client, 'nope', { fields: { destination: 'A' }, reason: 'x' })).toMatchObject({ ok: false, status: 400 })
    expect(a.rpc).not.toHaveBeenCalled()
  })
  it('maps the database verdicts: below_paid / order_cancelled / order_closed -> 409, forbidden -> 404, multiproduct_disabled -> 403', async () => {
    expect(await editOrder(ctx, admin({ ok: false, reason: 'below_paid', paid_confirmed: 80 }).client, ORDER, { fields: { destination: 'A' }, reason: 'x' })).toMatchObject({ ok: false, status: 409, error: 'below_paid', extra: { paid_confirmed: 80 } })
    expect(await editOrder(ctx, admin({ ok: false, reason: 'order_cancelled' }).client, ORDER, { fields: { destination: 'A' }, reason: 'x' })).toMatchObject({ status: 409, error: 'order_cancelled' })
    expect(await editOrder(ctx, admin({ ok: false, reason: 'order_closed' }).client, ORDER, { fields: { destination: 'A' }, reason: 'x' })).toMatchObject({ status: 409 })
    expect(await editOrder(ctx, admin(null, { code: '42501', message: 'forbidden' }).client, ORDER, { fields: { destination: 'A' }, reason: 'x' })).toMatchObject({ status: 404 })
    expect(await editOrder(ctx, admin(null, { code: '42501', message: 'multiproduct_disabled' }).client, ORDER, { fields: { items: [{ product_name: 'A', quantity: '1', unit_price: '1.00' }] }, reason: 'x' })).toMatchObject({ status: 403, error: 'multiproduct_disabled' })
  })
  it('normalizes line prices and refuses malformed line lists', async () => {
    const a = admin({ ok: true, changed: true })
    await editOrder(ctx, a.client, ORDER, { fields: { items: [{ product_name: 'A', quantity: 2, unit_price: '30' }] }, reason: 'x' })
    expect(a.rpc.mock.calls[0]).toBeDefined()
    expect(await editOrder(ctx, a.client, ORDER, { fields: { items: [] }, reason: 'x' })).toMatchObject({ status: 400, error: 'invalid_order_items' })
    expect(await editOrder(ctx, a.client, ORDER, { fields: { items: ['x'] }, reason: 'x' })).toMatchObject({ status: 400, error: 'invalid_order_items' })
  })
})

describe('cancelOrder', () => {
  it('passes the acknowledgement only when it is literally true', async () => {
    const a = admin({ ok: true, changed: true, refund_required: true, paid_confirmed: 40, shipment_stopped: false })
    await cancelOrder(ctx, a.client, ORDER, { reason: 'desistió', acknowledgePaid: 'true' })
    expect(a.rpc).toHaveBeenLastCalledWith('cancel_order_confirmation', expect.objectContaining({ p_ack_paid: false, p_reason: 'desistió' }))
    const r = await cancelOrder(ctx, a.client, ORDER, { reason: 'desistió', acknowledgePaid: true })
    expect(a.rpc).toHaveBeenLastCalledWith('cancel_order_confirmation', expect.objectContaining({ p_ack_paid: true }))
    expect(r).toMatchObject({ ok: true, body: { refund_required: true, paid_confirmed: 40 } })
  })
  it('a reason is required; paid orders need the acknowledgement (409) and a supervisor (403)', async () => {
    expect(await cancelOrder(ctx, admin({ ok: true }).client, ORDER, { reason: '' })).toMatchObject({ status: 422, error: 'reason_required' })
    expect(await cancelOrder(ctx, admin({ ok: false, reason: 'paid_requires_ack', paid_confirmed: 40 }).client, ORDER, { reason: 'x' })).toMatchObject({ status: 409, error: 'paid_requires_ack', extra: { paid_confirmed: 40 } })
    expect(await cancelOrder(ctx, admin({ ok: false, reason: 'supervisor_required', paid_confirmed: 40 }).client, ORDER, { reason: 'x' })).toMatchObject({ status: 403, error: 'supervisor_required' })
  })
})
