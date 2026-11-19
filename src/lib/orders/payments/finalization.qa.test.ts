// @vitest-environment node
/**
 * PR-06 · "pedido completamente finalizado" = Entregado AND Pagado, finalized_at = the LAST condition, clear before the return, the multi-order rule of the automatic return
 * and the manual delivery for orders without Shalom tracking. REAL local stack. LOCAL ONLY.
 */
import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { runFinalizedReturn } from '@/lib/conversations/finalized-return'
import { createWorld, QA_ENABLED, type QaWorld } from '@/lib/orders/logistics/test-support/qa-env'
import { at, enablePayments, paymentsOps, type Row } from '@/lib/orders/payments/test-support/payments-ops'
import { setShipmentFlag } from '@/lib/orders/shalom/test-support/ready-order'
import { shalomOps } from '@/lib/orders/shalom/test-support/shalom-ops'

let w: QaWorld
let p: ReturnType<typeof paymentsOps>
let o: ReturnType<typeof shalomOps>
vi.setConfig({ testTimeout: 40_000, hookTimeout: 120_000 })

const finalization = async (order: string) => ((await w.admin.from('order_finalizations').select('*').eq('order_id', order).maybeSingle()).data ?? null) as Row | null
const routing = async (conv: string) => ((await w.admin.from('conversation_routing').select('*').eq('conversation_id', conv).maybeSingle()).data ?? null) as Row | null
const routingEvents = async (conv: string) => ((await w.admin.from('conversation_routing_events').select('*').eq('conversation_id', conv).order('created_at')).data ?? []) as Row[]
const logisticsChat = (conv: string) => w.admin.from('conversation_routing').insert({ conversation_id: conv, account_id: w.acc, stage: 'logistics', version: 1 })
const tick = (minute: number) => runFinalizedReturn(w.admin, { now: new Date(Date.parse(at(minute))), graceMinutes: 10, accountId: w.acc })
const sweep = (minute: number) => w.admin.rpc('evaluate_order_finalizations', { p_now: at(minute), p_limit: 200, p_account: w.acc })
const iso = (ms: number) => new Date(ms).toISOString()

describe.skipIf(!QA_ENABLED)('PR-06 finalization, multi-order return and manual delivery', () => {
  beforeAll(async () => {
    w = await createWorld()
    p = paymentsOps(w)
    o = shalomOps(w)
    await enablePayments(w, w.acc)
    await setShipmentFlag(w, w.acc, true)
  }, 120_000)
  afterAll(async () => {
    if (w) await w.dispose()
  }, 90_000)

  describe('the two conditions', () => {
    it('Entregado + saldo parcial NO finaliza; Pagado + no entregado NO finaliza; Entregado + pagado SÍ finaliza', async () => {
      const a = await p.readyOrder('partial', 100)
      await p.pay(a.order, '30.00', {}, 0)
      await p.markDelivered(a.order, 1)
      expect(await finalization(a.order)).toBeNull()
      const b = await p.readyOrder('notdelivered', 100)
      await p.pay(b.order, '100.00', {}, 0)
      expect(await finalization(b.order)).toBeNull()
      expect((await sweep(30)).data).toMatchObject({ marked: 0 })
      // the missing condition arrives: finalized
      await p.pay(a.order, '70.00', {}, 5)
      expect(await finalization(a.order)).toMatchObject({ source: 'pr06_paid_and_delivered', return_state: 'pending' })
      await p.markDelivered(b.order, 6)
      expect(await finalization(b.order)).toMatchObject({ source: 'pr06_paid_and_delivered' })
      expect(await p.count(a.order, 'finalization_marked')).toBe(1)
    })

    it('finalized_at is the LAST condition: paid 10:00 + delivered 10:15 -> 10:15; delivered 10:00 + paid 10:20 -> 10:20 (never the cron hour)', async () => {
      const a = await p.readyOrder('paid-first', 100)
      await p.pay(a.order, '100.00', {}, 0) // 15:00
      await p.markDelivered(a.order, 15) // 15:15
      expect(Date.parse((await finalization(a.order))!.finalized_at)).toBe(Date.parse(at(15)))
      const b = await p.readyOrder('delivered-first', 100)
      await p.markDelivered(b.order, 0)
      await p.pay(b.order, '100.00', {}, 20)
      expect(Date.parse((await finalization(b.order))!.finalized_at)).toBe(Date.parse(at(20)))
      const ev = (await p.events(a.order)).find((e) => e.event_type === 'finalization_marked') as Row
      expect(ev.detail).toMatchObject({ delivered_source: 'manual' })
    })

    it('Shalom delivered AFTER the payment: nothing in PR-05 calls PR-06, the durable sweeper finds it and uses the delivery time (not its own clock)', async () => {
      const { order } = await o.shipAt('shalom-after', 'delivered', { destinationAt: null }) // delivered by Shalom at the PR-05 test clock (2026-12-01)
      expect(await p.financials(order)).not.toBeNull()
      const sh = await o.shipment(order)
      expect(sh.tracking_state).toBe('delivered')
      await p.register(order, { p_amount: '10.00', p_paid_at: '2026-12-01T14:00:00Z', p_now: '2026-12-01T14:00:00Z' }).then(async (r) => p.confirm((r.data as { payment_id: string }).payment_id, { p_now: '2026-12-01T14:00:00Z' }))
      // paid at 14:00 (the order price of the helper is 10.00), delivered later by Shalom: the confirm hook already saw "delivered" ...
      const z = await finalization(order)
      expect(z).not.toBeNull()
      expect(Date.parse(z!.finalized_at)).toBe(Date.parse(sh.status_changed_at)) // the LATER of paid_at and delivered_at
      expect((await sweep(60)).data).toMatchObject({ marked: 0 }) // already marked: the sweeper changes nothing
    })

    it('the sweeper marks an order paid BEFORE a later Shalom delivery that the confirm hook could not know about', async () => {
      const r = await o.ready('sweeper')
      expect(await p.financials(r)).not.toBeNull()
      await o.register(r)
      const [c] = await o.claim('2026-12-01T15:01:00Z', r)
      // paid first (10.00 order), THEN delivered by Shalom
      const reg = await p.register(r, { p_amount: '10.00', p_paid_at: '2026-12-01T14:00:00Z', p_now: '2026-12-01T14:00:00Z' })
      await p.confirm((reg.data as { payment_id: string }).payment_id, { p_now: '2026-12-01T14:00:00Z' })
      expect(await finalization(r)).toBeNull()
      await o.apply(c, { p_normalized: 'delivered', p_started_at: '2026-12-01T15:01:00Z', p_finished_at: '2026-12-01T15:02:00Z', p_now: '2026-12-01T15:02:00Z', p_raw_hash: 'dlv' })
      expect(await finalization(r)).toBeNull() // PR-05 does not call PR-06
      expect((await sweep(5)).data).toMatchObject({ marked: expect.any(Number) })
      const z = await finalization(r)
      expect(z).toMatchObject({ source: 'pr06_paid_and_delivered' })
      expect(Date.parse(z!.finalized_at)).toBe(Date.parse((await o.shipment(r)).status_changed_at))
      expect((await sweep(6)).data).toMatchObject({ marked: 0 }) // idempotent
    })
  })

  describe('clear before the return / after the return', () => {
    it('void a payment BEFORE +10: the finalization is cleared and the conversation does NOT return; paying again reopens the clock', async () => {
      const a = await p.readyOrder('clear', 100)
      await logisticsChat(a.conv)
      const pay = await p.pay(a.order, '100.00', {}, 0)
      await p.markDelivered(a.order, 1)
      expect(await finalization(a.order)).toMatchObject({ return_state: 'pending' })
      expect((await p.voidPayment(pay, 'pago devuelto', { p_now: at(5) })).data).toMatchObject({ ok: true, financial_status: 'unpaid' })
      expect(await finalization(a.order)).toMatchObject({ return_state: 'skipped_cleared' })
      expect(await p.count(a.order, 'finalization_cleared')).toBe(1)
      await tick(11)
      expect((await routing(a.conv))?.stage).toBe('logistics')
      // paid again at +20: marked again, +10 from THIS moment
      await p.pay(a.order, '100.00', {}, 20)
      expect(Date.parse((await finalization(a.order))!.finalized_at)).toBe(Date.parse(at(20)))
      expect(await tick(29)).toMatchObject({ returned: 0 })
      expect(await tick(30)).toMatchObject({ returned: 1 })
      expect((await routing(a.conv))?.stage).toBe('commercial')
    })

    it('a correction that keeps the order paid does not touch the finalization; one that drops it clears it', async () => {
      const a = await p.readyOrder('corr', 100)
      const pay = await p.pay(a.order, '100.00', {}, 0)
      await p.markDelivered(a.order, 1)
      const before = await finalization(a.order)
      expect((await p.correct(pay, { p_amount: '100.00', p_now: at(3) })).data).toMatchObject({ ok: true, financial_status: 'paid' })
      expect(await finalization(a.order)).toMatchObject({ return_state: 'pending', finalized_at: before!.finalized_at })
      const nowPay = ((await p.payments(a.order)).find((x) => x.status === 'confirmed') as Row).id
      expect((await p.correct(nowPay, { p_amount: '40.00', p_now: at(4) })).data).toMatchObject({ ok: true, financial_status: 'partially_paid' })
      expect(await finalization(a.order)).toMatchObject({ return_state: 'skipped_cleared' })
    })

    it('void AFTER the return: the conversation is NOT moved back; the fact is recorded', async () => {
      const a = await p.readyOrder('after', 100)
      await logisticsChat(a.conv)
      const pay = await p.pay(a.order, '100.00', {}, 0)
      await p.markDelivered(a.order, 1)
      await tick(11)
      expect((await routing(a.conv))?.stage).toBe('commercial')
      await p.voidPayment(pay, 'devolución tardía', { p_now: at(30) })
      expect((await routing(a.conv))?.stage).toBe('commercial') // untouched
      expect(await finalization(a.order)).toMatchObject({ return_state: 'returned' })
      expect(await p.count(a.order, 'finalization_revoked_after_return')).toBe(1)
      expect((await routingEvents(a.conv)).filter((e) => e.reason === 'order_finalized_grace_elapsed')).toHaveLength(1)
    })
  })

  describe('routing: +9 / +10 and the multi-order rule', () => {
    it('G/F. one order: +9 min stays in Logistica, +10 returns to Comercial (same chat, system actor, reason order_finalized_grace_elapsed)', async () => {
      const a = await p.readyOrder('route', 100)
      await logisticsChat(a.conv)
      await p.pay(a.order, '100.00', {}, 0)
      await p.markDelivered(a.order, 1) // finalized_at = +1
      expect(await tick(10)).toMatchObject({ returned: 0 }) // +9
      expect((await routing(a.conv))?.stage).toBe('logistics')
      expect(await tick(11)).toMatchObject({ returned: 1 }) // +10
      expect(await routing(a.conv)).toMatchObject({ stage: 'commercial' })
      const ev = (await routingEvents(a.conv)).filter((e) => e.reason === 'order_finalized_grace_elapsed')
      expect(ev).toHaveLength(1)
      expect(ev[0]).toMatchObject({ actor_user_id: null, actor_name: 'system', order_id: a.order, from_stage: 'logistics', to_stage: 'commercial' })
      expect(await tick(60)).toMatchObject({ returned: 0 })
    })

    it('I. two orders in the SAME chat: one finalized + the other active -> NO return; both finalized -> grace from the LAST one -> return', async () => {
      const a = await p.readyOrder('multi-a', 100)
      await logisticsChat(a.conv)
      const owner = w.owner
      const bId = await w.mkOrder(w.acc, `multi-b-${randomUUID()}`, { price: 50, conversation_id: a.conv })
      void owner
      expect(await p.financials(bId)).not.toBeNull() // tracked
      await p.pay(a.order, '100.00', {}, 0)
      await p.markDelivered(a.order, 1) // A finalized at +1
      expect(await tick(30)).toMatchObject({ returned: 0, deferred: 1 }) // B is still operative
      expect((await routing(a.conv))?.stage).toBe('logistics')
      expect(await finalization(a.order)).toMatchObject({ return_state: 'pending' })
      // B finishes at +40 (paid; delivered manually needs ready_for_dispatch, so deliver through the sweeper path with a Shalom-less manual delivery row)
      await w.admin.from('order_logistics').insert({ order_id: bId, account_id: w.acc, status: 'ready_for_dispatch', voucher_document_id: null, validated_at: at(0), validated_by: w.logi.id }).then(() => null, () => null)
      await w.admin.from('order_manual_deliveries').insert({ order_id: bId, account_id: w.acc, delivered_at: at(40), delivered_by_name: 'QA' })
      await p.pay(bId, '50.00', {}, 40)
      expect(await finalization(bId)).toMatchObject({ source: 'pr06_paid_and_delivered' })
      expect(await tick(49)).toMatchObject({ returned: 0 }) // grace counts from the LAST (+40), not from A (+1)
      expect((await routing(a.conv))?.stage).toBe('logistics')
      expect(await tick(50)).toMatchObject({ returned: 1 })
      expect((await routing(a.conv))?.stage).toBe('commercial')
      expect((await routingEvents(a.conv)).filter((e) => e.reason === 'order_finalized_grace_elapsed')).toHaveLength(1)
      expect((await finalization(a.order))?.return_state).toBe('returned')
      expect((await finalization(bId))?.return_state).toBe('returned')
    })

    it('a HISTORICAL (not tracked) order of the chat never blocks the return', async () => {
      const a = await p.readyOrder('hist-a', 100)
      await logisticsChat(a.conv)
      const histId = await w.mkOrder(w.acc, `hist-b-${randomUUID()}`, { price: 70, conversation_id: a.conv })
      await w.admin.from('order_financials').delete().eq('order_id', histId) // confirmed before the activation: no row
      await p.pay(a.order, '100.00', {}, 0)
      await p.markDelivered(a.order, 1)
      expect(await tick(11)).toMatchObject({ returned: 1 })
      expect((await routing(a.conv))?.stage).toBe('commercial')
    })

    it('a human routing decision after the finalization is still never overwritten (manual Derivar a Comercial -> shared)', async () => {
      const a = await p.readyOrder('human', 100)
      await logisticsChat(a.conv)
      await p.pay(a.order, '100.00', {}, 0)
      await p.markDelivered(a.order, 1)
      expect((await w.logi.client.rpc('derive_conversation_to_commercial', { p_conversation_id: a.conv })).error).toBeNull()
      await tick(11)
      expect(await routing(a.conv)).toMatchObject({ stage: 'shared' })
      expect(await finalization(a.order)).toMatchObject({ return_state: 'skipped_not_logistics' })
    })

    it('PR-06 OFF: no finalization is created and an order of the chat does not block the PR-05C behaviour', async () => {
      const a = await p.readyOrder('off', 100)
      await p.pay(a.order, '100.00', {}, 0)
      await enablePayments(w, w.acc, false, null)
      try {
        expect((await p.markDelivered(a.order, 1)).error?.code).toBe('42501')
        expect((await sweep(50)).data).toMatchObject({ marked: 0 })
        expect(await finalization(a.order)).toBeNull()
      } finally {
        await enablePayments(w, w.acc, true)
      }
    })
  })

  describe('manual delivery (carriers without Shalom tracking, e.g. Olva)', () => {
    it('J. Logistica / Supervisor mark it delivered: manual, audited (who / when / note), idempotent; it does not touch Shalom or the payments', async () => {
      const a = await p.readyOrder('olva', 100)
      const r1 = await p.markDelivered(a.order, 0, w.logi, w.acc, 'entregado por Olva en agencia')
      expect(r1.data).toMatchObject({ ok: true, changed: true })
      const again = await p.markDelivered(a.order, 5, w.sup)
      expect(again.data).toMatchObject({ ok: true, changed: false })
      expect(Date.parse((again.data as Row).delivered_at)).toBe(Date.parse(at(0))) // the first moment stays
      const row = (await w.admin.from('order_manual_deliveries').select('*').eq('order_id', a.order).single()).data as Row
      expect(row).toMatchObject({ delivered_by: w.logi.id, note: 'entregado por Olva en agencia' })
      expect(await p.count(a.order, 'order_delivered_manual')).toBe(1)
      expect((await w.admin.from('order_shipments').select('id').eq('order_id', a.order)).data).toEqual([])
      expect(await p.payments(a.order)).toEqual([])
      expect((await p.financials(a.order))?.financial_status).toBe('unpaid') // delivered is NOT paid
      expect(await finalization(a.order)).toBeNull()
      // the record is immutable / protected
      expect((await w.admin.from('order_manual_deliveries').update({ note: 'x' }).eq('order_id', a.order)).error?.code).toBe('42501')
      expect((await w.admin.from('order_manual_deliveries').delete().eq('order_id', a.order)).error?.code).toBe('42501')
      // paying it completes the pair
      await p.pay(a.order, '100.00', {}, 10)
      expect(await finalization(a.order)).toMatchObject({ source: 'pr06_paid_and_delivered' })
    })

    it('refused for an order with an ACTIVE / delivered Shalom shipment, allowed once stopped; needs ready_for_dispatch; a Shalom guide can not follow a manual delivery', async () => {
      const s = await p.readyOrder('shalom-active', 100)
      await o.register(s.order)
      expect((await p.markDelivered(s.order, 0)).data).toMatchObject({ ok: false, reason: 'shalom_tracking_active' })
      await w.admin.rpc('stop_order_shipment', { p_account: w.acc, p_actor: w.sup.id, p_order: s.order, p_reason: 'manual', p_now: at(1) })
      expect((await p.markDelivered(s.order, 2)).data).toMatchObject({ ok: true, changed: true })
      const d = await o.shipAt('shalom-delivered', 'delivered', {})
      expect((await p.markDelivered(d.order, 0)).data).toMatchObject({ ok: false, reason: 'shalom_tracking_active' })
      const plain = await p.order('not-ready', 100)
      expect((await p.markDelivered(plain.order, 0)).data).toMatchObject({ ok: false, reason: 'not_ready_for_dispatch' })
      const fresh = await p.readyOrder('manual-then-shalom', 100)
      await p.markDelivered(fresh.order, 0)
      expect((await o.register(fresh.order)).error?.message ?? JSON.stringify((await o.register(fresh.order)).data)).toMatch(/manual_delivery_exists|forbidden|rejected|ok":false/)
      expect((await w.admin.from('order_shipments').select('id').eq('order_id', fresh.order)).data).toEqual([])
    })

    it('Commercial, viewer and other accounts can not mark a delivery; the RPC is service-role only', async () => {
      const a = await p.readyOrder('manual-auth', 100)
      for (const actor of [w.comm, w.viewer]) expect((await p.markDelivered(a.order, 0, actor)).error?.code).toBe('42501')
      expect((await p.markDelivered(a.order, 0, w.foreign, w.accForeign)).error?.code).toBe('42501')
      expect((await w.logi.client.rpc('mark_order_delivered_manual', {})).error).not.toBeNull()
      expect((await w.admin.from('order_manual_deliveries').select('order_id').eq('order_id', a.order)).data).toEqual([])
      const read = async (x: typeof w.logi) => ((await x.client.from('order_manual_deliveries').select('order_id')).data ?? []).length
      await p.markDelivered(a.order, 0)
      expect(await read(w.logi)).toBeGreaterThan(0)
      for (const x of [w.comm, w.viewer, w.foreign]) expect(await read(x)).toBe(0)
    })
  })
})
