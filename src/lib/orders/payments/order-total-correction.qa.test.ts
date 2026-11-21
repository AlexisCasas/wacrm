// @vitest-environment node
/** Unit 05 · supervised order-total correction against the REAL LOCAL Supabase stack. LOCAL ONLY. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { createWorld, QA_ENABLED, type QaActor, type QaWorld } from '@/lib/orders/logistics/test-support/qa-env'
import { at, enablePayments, paymentsOps, type Row } from '@/lib/orders/payments/test-support/payments-ops'

let w: QaWorld
let p: ReturnType<typeof paymentsOps>

vi.setConfig({ testTimeout: 40_000, hookTimeout: 120_000 })

const correct = (
  order: string,
  total: string,
  reason: string | null = 'corrección supervisada QA',
  actor: QaActor | null = null,
  account?: string,
  minute = 10,
) =>
  w.admin.rpc('correct_order_total', {
    p_account: account ?? w.acc,
    p_actor: (actor ?? w.sup).id,
    p_order: order,
    p_new_total: total,
    p_reason: reason,
    p_now: at(minute),
  })

const price = async (order: string) => {
  const { data, error } = await w.admin.from('order_confirmations').select('price').eq('id', order).single()
  if (error) throw error
  return Number((data as Row).price)
}

const corrections = async (order: string) => {
  const { data, error } = await w.admin
    .from('order_total_corrections')
    .select('*')
    .eq('order_id', order)
    .order('created_at', { ascending: true })
  if (error) throw error
  return (data ?? []) as Row[]
}

describe.skipIf(!QA_ENABLED)('Unit 05 supervised order total correction', () => {
  beforeAll(async () => {
    w = await createWorld()
    p = paymentsOps(w)
    await enablePayments(w, w.acc)
  }, 120_000)

  afterAll(async () => {
    if (w) await w.dispose()
  }, 90_000)

  it('Supervisor corrects a tracked unpaid order and creates one append-only audit row', async () => {
    const { order } = await p.order('total-unpaid', 100)

    const r = await correct(order, '150.00', '  precio confirmado por supervisor  ')
    expect(r.error).toBeNull()
    expect(r.data).toMatchObject({
      ok: true,
      changed: true,
      old_total: 100,
      total: 150,
      paid_confirmed: 0,
      pending_balance: 150,
      financial_status: 'unpaid',
    })

    expect(await price(order)).toBe(150)
    expect(await p.financials(order)).toMatchObject({
      paid_confirmed: 0,
      financial_status: 'unpaid',
    })

    const audit = await corrections(order)
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({
      account_id: w.acc,
      order_id: order,
      old_total: 100,
      new_total: 150,
      reason: 'precio confirmado por supervisor',
      actor_user_id: w.sup.id,
    })
    expect(audit[0].created_at).toBeTruthy()

    const upd = await w.admin.from('order_total_corrections').update({ reason: 'alterado' }).eq('id', audit[0].id)
    expect(upd.error).not.toBeNull()

    const del = await w.admin.from('order_total_corrections').delete().eq('id', audit[0].id)
    expect(del.error).not.toBeNull()
  })

  it('recalculates balance from confirmed payments without editing, creating or deleting payment rows', async () => {
    const { order } = await p.order('total-with-payment', 100)
    await p.pay(order, '30.00')

    const before = await p.payments(order)
    expect(before).toHaveLength(1)

    const r = await correct(order, '120.00')
    expect(r.error).toBeNull()
    expect(r.data).toMatchObject({
      ok: true,
      changed: true,
      total: 120,
      paid_confirmed: 30,
      pending_balance: 90,
      financial_status: 'partially_paid',
    })

    expect(await price(order)).toBe(120)
    expect(await p.financials(order)).toMatchObject({
      paid_confirmed: 30,
      financial_status: 'partially_paid',
    })

    const after = await p.payments(order)
    expect(after).toEqual(before)
    expect(await corrections(order)).toHaveLength(1)
  })

  it('allows total equal to confirmed payments and rejects a total below confirmed payments', async () => {
    const equal = await p.order('total-equal-paid', 100)
    await p.pay(equal.order, '30.00')

    const ok = await correct(equal.order, '30.00')
    expect(ok.error).toBeNull()
    expect(ok.data).toMatchObject({
      ok: true,
      changed: true,
      total: 30,
      paid_confirmed: 30,
      pending_balance: 0,
      financial_status: 'paid',
    })

    const below = await p.order('total-below-paid', 100)
    await p.pay(below.order, '30.00')
    const beforePayments = await p.payments(below.order)

    const refused = await correct(below.order, '20.00')
    expect(refused.error).toBeNull()
    expect(refused.data).toMatchObject({
      ok: false,
      reason: 'below_paid',
    })

    expect(await price(below.order)).toBe(100)
    expect(await p.payments(below.order)).toEqual(beforePayments)
    expect(await corrections(below.order)).toHaveLength(0)
  })

  it('validates total and mandatory reason', async () => {
    const { order } = await p.order('total-invalid', 100)

    for (const bad of ['0', '0.00', '-1', 'abc', '1.234', '10000000']) {
      const r = await correct(order, bad)
      expect(r.error?.code, bad).toBe('22023')
    }

    for (const badReason of [null, '', '   ', 'x'.repeat(301)]) {
      const r = await correct(order, '120.00', badReason)
      expect(r.error?.code).toBe('22023')
    }

    expect(await price(order)).toBe(100)
    expect(await corrections(order)).toHaveLength(0)
  })

  it('is Supervisor-only and does not reveal cross-account orders', async () => {
    const { order } = await p.order('total-permissions', 100)

    for (const actor of [w.logi, w.comm, w.viewer]) {
      const r = await correct(order, '120.00', 'permiso', actor)
      expect(r.error?.code).toBe('42501')
    }

    const foreign = await correct(order, '120.00', 'otra cuenta', w.foreign, w.acc)
    expect(foreign.error?.code).toBe('42501')

    expect(await price(order)).toBe(100)
    expect(await corrections(order)).toHaveLength(0)
  })

  it('keeps the normal confirmed-order total immutable outside correct_order_total', async () => {
    const { order } = await p.order('total-immutable', 100)

    const direct = await w.admin.from('order_confirmations').update({ price: 199 }).eq('id', order)
    expect(direct.error).not.toBeNull()

    expect(await price(order)).toBe(100)

    const viaRpc = await correct(order, '199.00')
    expect(viaRpc.error).toBeNull()
    expect(viaRpc.data).toMatchObject({ ok: true, changed: true, total: 199 })
    expect(await price(order)).toBe(199)
  })

  it('refuses a closed/delivered order without changing its total', async () => {
    const { order } = await p.readyOrder('total-closed', 100)

    await p.markDelivered(order, 2)

    const r = await correct(order, '150.00')
    expect(r.error).toBeNull()
    expect(r.data).toMatchObject({
      ok: false,
      reason: 'order_closed',
    })

    expect(await price(order)).toBe(100)
    expect(await corrections(order)).toHaveLength(0)
  })

  it('same-total correction is a no-op and creates no audit row', async () => {
    const { order } = await p.order('total-noop', 100)

    const r = await correct(order, '100.00')
    expect(r.error).toBeNull()
    expect(r.data).toMatchObject({
      ok: true,
      changed: false,
      total: 100,
      paid_confirmed: 0,
      pending_balance: 100,
    })

    expect(await corrections(order)).toHaveLength(0)
  })

  it('serializes two concurrent corrections and leaves a coherent audit chain and financial state', async () => {
    const { order } = await p.order('total-concurrent', 100)

    const [a, b] = await Promise.all([
      correct(order, '150.00', 'concurrente A', w.sup, w.acc, 20),
      correct(order, '180.00', 'concurrente B', w.sup, w.acc, 21),
    ])

    expect(a.error).toBeNull()
    expect(b.error).toBeNull()
    expect((a.data as Row).ok).toBe(true)
    expect((b.data as Row).ok).toBe(true)

    const finalPrice = await price(order)
    expect([150, 180]).toContain(finalPrice)

    const audit = await corrections(order)
    expect(audit).toHaveLength(2)

    expect(Number(audit[0].old_total)).toBe(100)
    expect(Number(audit[1].old_total)).toBe(Number(audit[0].new_total))
    expect(finalPrice).toBe(Number(audit[1].new_total))

    expect(await p.financials(order)).toMatchObject({
      paid_confirmed: 0,
      financial_status: 'unpaid',
    })

    expect(await p.payments(order)).toHaveLength(0)
  })
})
