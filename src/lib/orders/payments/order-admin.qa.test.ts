// @vitest-environment node
/** Autonomous operation · EDIT and CANCEL of a confirmed order against the REAL local stack (restored production schema). LOCAL ONLY. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { createWorld, QA_ENABLED, type QaWorld } from '@/lib/orders/logistics/test-support/qa-env'
import { cancelOrder, editOrder, getPaymentsPanel, getPaymentsSummary } from '@/lib/orders/payments/service'
import { at, enablePayments, paymentsOps, type Row } from '@/lib/orders/payments/test-support/payments-ops'
import { shalomOps } from '@/lib/orders/shalom/test-support/shalom-ops'
import { setShipmentFlag } from '@/lib/orders/shalom/test-support/ready-order'

let w: QaWorld
let p: ReturnType<typeof paymentsOps>
let sh: ReturnType<typeof shalomOps>
vi.setConfig({ testTimeout: 40_000, hookTimeout: 120_000 })

const edit = (order: string, fields: Record<string, unknown>, over: Record<string, unknown> = {}, actor = w.logi, acc = w.acc) =>
  w.admin.rpc('edit_order_confirmation', { p_account: acc, p_actor: actor.id, p_order: order, p_fields: fields, p_reason: 'corrección del comprador', p_now: at(10), ...over })
const cancel = (order: string, over: Record<string, unknown> = {}, actor = w.logi, acc = w.acc) =>
  w.admin.rpc('cancel_order_confirmation', { p_account: acc, p_actor: actor.id, p_order: order, p_reason: 'cliente desistió', p_ack_paid: false, p_now: at(20), ...over })
const row = async (order: string) => (await w.admin.from('order_confirmations').select('*').eq('id', order).single()).data as Row
const lines = [{ product_name: 'Producto A', quantity: '2', unit_price: '30.00' }, { product_name: 'Producto B', quantity: '1', unit_price: '40.00' }]

describe.skipIf(!QA_ENABLED)('autonomy · edit and cancel a confirmed order', () => {
  beforeAll(async () => {
    w = await createWorld()
    p = paymentsOps(w)
    sh = shalomOps(w)
    await enablePayments(w, w.acc)
    await setShipmentFlag(w, w.acc, true)
    const { error } = await w.admin.from('order_integration_settings').update({ multiproduct_enabled: true }).eq('account_id', w.acc)
    if (error) throw error
  }, 120_000)
  afterAll(async () => {
    if (w) await w.dispose()
  }, 90_000)

  describe('edit', () => {
    it('buyer / recipient / destination / agency change, audited with old and new values; the identity stays frozen', async () => {
      const { order } = await p.order('edit-basic', 100)
      const before = await row(order)
      const r = await edit(order, { customer_name: 'María Quispe', destination: 'Arequipa', agency: 'Olva', dni: '87654321', phone: '51987654321' })
      expect(r.data).toMatchObject({ ok: true, changed: true })
      const after = await row(order)
      expect(after).toMatchObject({ customer_name: 'María Quispe', destination: 'Arequipa', agency: 'Olva', dni: '87654321', phone: '51987654321' })
      expect([after.id, after.request_key, after.confirmed_at, after.order_status, after.price]).toEqual([before.id, before.request_key, before.confirmed_at, before.order_status, before.price])
      const audit = (await w.admin.from('order_edits').select('*').eq('order_id', order)).data as Row[]
      expect(audit).toHaveLength(1)
      expect(audit[0].changes.destination).toEqual({ old: before.destination, new: 'Arequipa' })
      expect(audit[0]).toMatchObject({ reason: 'corrección del comprador', actor_user_id: w.logi.id })
    })

    it('no change -> changed:false and no audit row; empty reason / unknown field / blank required field are refused', async () => {
      const { order } = await p.order('edit-noop', 100)
      const cur = await row(order)
      expect((await edit(order, { customer_name: cur.customer_name })).data).toMatchObject({ ok: true, changed: false })
      expect((await w.admin.from('order_edits').select('id').eq('order_id', order)).data).toHaveLength(0)
      expect((await edit(order, { customer_name: 'X' }, { p_reason: '  ' })).error?.code).toBe('22023')
      expect((await edit(order, { price: '1.00' })).error?.code).toBe('22023')
      expect((await edit(order, { request_key: 'hack' })).error?.code).toBe('22023')
      expect((await edit(order, { customer_name: '   ' })).error?.code).toBe('22023')
    })

    it('the freeze still holds everywhere else: a direct UPDATE (even service_role) of a frozen column is refused', async () => {
      const { order } = await p.order('edit-freeze', 100)
      const r = await w.admin.from('order_confirmations').update({ customer_name: 'Directo' }).eq('id', order)
      expect(r.error?.message).toMatch(/immutable/)
    })

    it('products as lines: the database derives product / quantity / total, recalculates the balance and audits the old and new lines', async () => {
      const { order } = await p.order('edit-items', 100)
      await w.admin.from('order_confirmation_items').insert({ order_id: order, account_id: w.acc, line_number: 1, product_name: 'Original', quantity: 1, unit_price: 100 })
      await p.pay(order, '30.00')
      const r = await edit(order, { items: lines })
      expect(r.data).toMatchObject({ ok: true, changed: true, total: 100, pending_balance: 70 })
      const o = await row(order)
      expect(o).toMatchObject({ quantity: 3, price: 100, product: '2 x Producto A\n1 x Producto B' })
      const r2 = await edit(order, { items: [{ product_name: 'Producto A', quantity: '3', unit_price: '50.00' }] })
      expect(r2.data).toMatchObject({ ok: true, total: 150, pending_balance: 120 })
      expect(await p.financials(order)).toMatchObject({ paid_confirmed: 30, financial_status: 'partially_paid' })
      const corrections = (await w.admin.from('order_total_corrections').select('*').eq('order_id', order)).data as Row[]
      expect(corrections.map((c) => [Number(c.old_total), Number(c.new_total)])).toEqual([[100, 150]])
      const items = (await w.admin.from('order_confirmation_items').select('*').eq('order_id', order)).data as Row[]
      expect(items).toHaveLength(1)
    })

    it('a new total below what is already paid is refused and NOTHING changes', async () => {
      const { order } = await p.order('edit-below', 100)
      await w.admin.from('order_confirmation_items').insert({ order_id: order, account_id: w.acc, line_number: 1, product_name: 'Original', quantity: 1, unit_price: 100 })
      await p.pay(order, '80.00')
      const r = await edit(order, { items: [{ product_name: 'Barato', quantity: '1', unit_price: '50.00' }], customer_name: 'No debe cambiar' })
      expect(r.data).toMatchObject({ ok: false, reason: 'below_paid', paid_confirmed: 80 })
      expect(await row(order)).toMatchObject({ price: 100, customer_name: 'Cliente Prueba' })
    })

    it('invalid lines are refused (price format, quantity, empty, >20, product+items together)', async () => {
      const { order } = await p.order('edit-bad-items', 100)
      for (const items of [[{ product_name: 'A', quantity: '1', unit_price: '10' }], [{ product_name: 'A', quantity: '0', unit_price: '10.00' }], [], [{ product_name: '', quantity: '1', unit_price: '10.00' }], Array.from({ length: 21 }, () => ({ product_name: 'A', quantity: '1', unit_price: '1.00' }))]) {
        expect((await edit(order, { items })).error?.code).toBe('22023')
      }
      expect((await edit(order, { items: lines, product: 'x' })).error?.code).toBe('22023')
    })

    it('legacy single-product order: product / quantity editable, total untouched', async () => {
      const { order } = await p.order('edit-legacy', 100)
      expect((await edit(order, { product: 'Otro producto', quantity: '4' })).data).toMatchObject({ ok: true, changed: true })
      expect(await row(order)).toMatchObject({ product: 'Otro producto', quantity: 4, price: 100 })
    })

    it('who may edit: logistics and supervisor yes; commercial, viewer, another account no (and nothing leaks)', async () => {
      const { order } = await p.order('edit-who', 100)
      expect((await edit(order, { destination: 'Cusco' }, {}, w.sup)).data).toMatchObject({ ok: true })
      for (const actor of [w.comm, w.viewer]) expect((await edit(order, { destination: 'Tacna' }, {}, actor)).error?.code).toBe('42501')
      expect((await edit(order, { destination: 'Tacna' }, {}, w.foreign, w.accForeign)).error?.code).toBe('42501')
      expect((await edit(order, { destination: 'Tacna' }, {}, w.foreign)).error?.code).toBe('42501')
      expect(await row(order)).toMatchObject({ destination: 'Cusco' })
    })

    it('browsers cannot call the RPC nor write the audit; the audit is append-only', async () => {
      const { order } = await p.order('edit-browser', 100)
      expect((await w.logi.client.rpc('edit_order_confirmation', { p_account: w.acc, p_actor: w.logi.id, p_order: order, p_fields: { destination: 'Z' }, p_reason: 'x' })).error).not.toBeNull()
      await edit(order, { destination: 'Piura' })
      expect((await w.logi.client.from('order_edits').insert({ account_id: w.acc, order_id: order, actor_user_id: w.logi.id, actor_name: 'x', reason: 'x', changes: {} })).error).not.toBeNull()
      expect((await w.admin.from('order_edits').update({ reason: 'cambiado' }).eq('order_id', order)).error?.message).toMatch(/append-only/)
      expect((await w.admin.from('order_edits').delete().eq('order_id', order)).error?.message).toMatch(/append-only/)
    })
  })

  describe('cancel (anulación)', () => {
    it('an unpaid order is cancelled by logistics; idempotent; nothing is deleted', async () => {
      const { order } = await p.order('cancel-unpaid', 100)
      expect((await cancel(order)).data).toMatchObject({ ok: true, changed: true, refund_required: false, paid_confirmed: 0 })
      expect((await cancel(order)).data).toMatchObject({ ok: true, changed: false })
      expect(await row(order)).toMatchObject({ id: order, order_status: 'Pedido confirmado' })
      expect((await w.admin.from('order_cancellations').select('*').eq('order_id', order)).data).toHaveLength(1)
      expect((await cancel(order, { p_reason: ' ' }, w.logi)).error?.code).toBe('22023')
    })

    it('a cancelled order accepts no new payment, evidence, shipment or edit', async () => {
      const { order } = await sh.ready('cancel-guards').then((id) => ({ order: id }))
      await cancel(order)
      const reg = await p.register(order, { p_amount: '10.00' })
      expect(reg.error?.message ?? '').toMatch(/order_cancelled/)
      expect((await sh.register(order)).error?.message ?? '').toMatch(/order_cancelled/)
      expect((await edit(order, { destination: 'Lima 2' })).data).toMatchObject({ ok: false, reason: 'order_cancelled' })
    })

    it('with confirmed payments: logistics is refused; supervisor needs the explicit acknowledgement; then the refund is flagged and every payment survives', async () => {
      const { order } = await p.order('cancel-paid', 100)
      await p.pay(order, '40.00')
      expect((await cancel(order, { p_ack_paid: true })).data).toMatchObject({ ok: false, reason: 'supervisor_required', paid_confirmed: 40 })
      expect((await cancel(order, {}, w.sup)).data).toMatchObject({ ok: false, reason: 'paid_requires_ack', paid_confirmed: 40 })
      expect((await w.admin.from('order_cancellations').select('id').eq('order_id', order)).data).toHaveLength(0)
      expect((await cancel(order, { p_ack_paid: true }, w.sup)).data).toMatchObject({ ok: true, changed: true, refund_required: true, paid_confirmed: 40 })
      const rows = await p.payments(order)
      expect(rows.map((r) => [r.status, Number(r.amount)])).toEqual([['confirmed', 40]])
      expect(await p.financials(order)).toMatchObject({ paid_confirmed: 40 })
      expect((await w.admin.from('order_cancellations').select('*').eq('order_id', order).single()).data).toMatchObject({ refund_required: true, actor_user_id: w.sup.id })
    })

    it('an active Shalom shipment stops being polled when its order is cancelled', async () => {
      const order = await sh.ready('cancel-ship')
      expect((await sh.register(order, { now: at(0) })).data).toMatchObject({ ok: true })
      expect((await cancel(order)).data).toMatchObject({ ok: true, shipment_stopped: true })
      const s = (await w.admin.from('order_shipments').select('tracking_state, stop_reason, next_poll_at').eq('order_id', order).single()).data as Row
      expect(s).toMatchObject({ tracking_state: 'stopped', stop_reason: 'order_cancelled', next_poll_at: null })
      const claimed = await sh.claim(at(100_000), order)
      expect(claimed).toHaveLength(0)
    })

    it('a delivered / finalized order cannot be cancelled', async () => {
      const { order } = await p.readyOrder('cancel-delivered', 100)
      await p.pay(order, '100.00')
      expect((await p.markDelivered(order)).data).toMatchObject({ ok: true })
      expect((await cancel(order, { p_ack_paid: true }, w.sup)).data).toMatchObject({ ok: false, reason: 'order_closed' })
      expect((await edit(order, { destination: 'X1' })).data).toMatchObject({ ok: false, reason: 'order_closed' })
    })

    it('who may cancel: logistics / supervisor only; the audit is append-only; browsers cannot write it', async () => {
      const { order } = await p.order('cancel-who', 100)
      for (const actor of [w.comm, w.viewer]) expect((await cancel(order, {}, actor)).error?.code).toBe('42501')
      expect((await cancel(order, {}, w.foreign, w.accForeign)).error?.code).toBe('42501')
      expect((await w.logi.client.rpc('cancel_order_confirmation', { p_account: w.acc, p_actor: w.logi.id, p_order: order, p_reason: 'x' })).error).not.toBeNull()
      await cancel(order)
      expect((await w.admin.from('order_cancellations').delete().eq('order_id', order)).error?.message).toMatch(/append-only/)
      expect((await w.admin.from('order_cancellations').update({ reason: 'otro' }).eq('order_id', order)).error?.message).toMatch(/append-only/)
      expect((await w.logi.client.from('order_cancellations').select('order_id').eq('order_id', order)).data).toHaveLength(1)
      expect((await w.foreign.client.from('order_cancellations').select('order_id').eq('order_id', order)).data).toHaveLength(0)
    })
  })
  describe('through the service layer (what the route calls)', () => {
    it('edit -> panel shows the new data and the audit; cancel -> panel + list summary show it; a second edit is refused with 409', async () => {
      const { order } = await p.order('svc', 100)
      await w.admin.from('order_confirmation_items').insert({ order_id: order, account_id: w.acc, line_number: 1, product_name: 'Original', quantity: 1, unit_price: 100 })
      await p.pay(order, '25.00')
      const who = { userId: w.logi.id, accountId: w.acc }
      const ctx = w.ctxOf(w.logi, w.acc)
      const e = await editOrder(who, w.admin, order, { fields: { customer_name: 'Rosa Huamán', items: [{ product_name: 'Kit', quantity: 2, unit_price: '45.50' }] }, reason: 'cambio de pedido' })
      expect(e).toMatchObject({ ok: true, body: { changed: true, total: 91, pending_balance: 66 } })
      const panel = await getPaymentsPanel(ctx, w.admin, order, false)
      expect(panel).toMatchObject({ ok: true, body: { total: 91, pending_balance: 66, cancellation: null, order: { customer_name: 'Rosa Huamán' } } })
      expect(panel.ok && panel.body.items).toEqual([expect.objectContaining({ product_name: 'Kit', quantity: 2, unit_price: 45.5 })])
      expect(panel.ok && panel.body.edits).toHaveLength(1)
      const refused = await cancelOrder(who, w.admin, order, { reason: 'desistió', acknowledgePaid: true })
      expect(refused).toMatchObject({ ok: false, status: 403, error: 'supervisor_required' })
      const c = await cancelOrder({ userId: w.sup.id, accountId: w.acc }, w.admin, order, { reason: 'desistió', acknowledgePaid: true })
      expect(c).toMatchObject({ ok: true, body: { changed: true, refund_required: true, paid_confirmed: 25 } })
      const after = await getPaymentsPanel(ctx, w.admin, order, false)
      expect(after).toMatchObject({ ok: true, body: { cancellation: { reason: 'desistió', refund_required: true, actor_name: expect.any(String) }, paid_confirmed: 25 } })
      const summary = await getPaymentsSummary(ctx, [order])
      expect(summary).toMatchObject({ ok: true, body: { summaries: { [order]: { cancelled: true, paid_confirmed: 25 } } } })
      expect(await editOrder(who, w.admin, order, { fields: { customer_name: 'Otra' }, reason: 'x' })).toMatchObject({ ok: false, status: 409, error: 'order_cancelled' })
    })
  })
})
