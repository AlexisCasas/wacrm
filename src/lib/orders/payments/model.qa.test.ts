// @vitest-environment node
/** PR-06 · model + RLS of the financial axis against the REAL local stack: tracking vs not_tracked, constraints, immutability, append-only audit, who can read what. LOCAL ONLY. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { createWorld, QA_ENABLED, type QaWorld } from '@/lib/orders/logistics/test-support/qa-env'
import { enablePayments, paymentsOps, type Row } from '@/lib/orders/payments/test-support/payments-ops'

let w: QaWorld
let p: ReturnType<typeof paymentsOps>

vi.setConfig({ testTimeout: 40_000, hookTimeout: 120_000 })

/** A payment row inserted straight into the table (the RPCs come in the next commit). */
async function insertPayment(order: string, over: Row = {}) {
  const row = { account_id: w.acc, order_id: order, request_key: `k-${Math.random().toString(36).slice(2)}`, amount: 30, kind: 'advance', paid_at: '2027-02-01T10:00:00Z', registered_by: w.logi.id, registered_by_name: 'QA', ...over }
  return w.admin.from('order_payments').insert(row).select('*').single()
}

describe.skipIf(!QA_ENABLED)('PR-06 model and RLS', () => {
  beforeAll(async () => {
    w = await createWorld()
    p = paymentsOps(w)
  }, 120_000)
  afterAll(async () => {
    if (w) await w.dispose()
  }, 90_000)

  describe('activation and tracking', () => {
    it('the feature is OFF by default (no settings row) and the settings table never invents one', async () => {
      expect((await w.admin.from('order_payment_settings').select('account_id').eq('account_id', w.acc)).data).toEqual([])
    })

    it('orders confirmed BEFORE the activation are NOT tracked (no row); orders after it start unpaid; the activation moment is never reset', async () => {
      const before = await p.order('historic') // account never activated: nothing happens, no financial row
      expect(await p.financials(before.order)).toBeNull()
      await w.admin.from('order_payment_settings').upsert({ account_id: w.acc, order_payments_enabled: true })
      const first = ((await w.admin.from('order_payment_settings').select('activated_at').eq('account_id', w.acc).single()).data as Row).activated_at
      expect(first).toBeTruthy()
      expect(await p.financials(before.order)).toBeNull() // still not tracked: nothing is backfilled
      const after = await p.order('after')
      expect(await p.financials(after.order)).toMatchObject({ financial_status: 'unpaid', paid_confirmed: 0, paid_at: null })
      // off and on again: activated_at is kept (orders created while OFF after the first activation ARE tracked: documented), never moved
      await w.admin.from('order_payment_settings').update({ order_payments_enabled: false, activated_at: '2030-01-01T00:00:00Z' }).eq('account_id', w.acc)
      await w.admin.from('order_payment_settings').update({ order_payments_enabled: true }).eq('account_id', w.acc)
      expect(((await w.admin.from('order_payment_settings').select('activated_at').eq('account_id', w.acc).single()).data as Row).activated_at).toBe(first)
      await enablePayments(w, w.acc, true, '2020-01-01T00:00:00Z') // QA: activation in the past so test orders are tracked
    })
  })

  describe('constraints, immutability and audit', () => {
    it('a payment: amount > 0 with 2 decimals, currency PEN only, closed kinds, free method, unique request_key', async () => {
      const { order } = await p.order('constraints', 100)
      for (const bad of [{ amount: 0 }, { amount: -5 }, { amount: 10000000 }, { currency: 'USD' }, { kind: 'refund' }, { status: 'weird' }]) {
        expect((await insertPayment(order, bad)).error?.code).toBe('23514')
      }
      const ok = await insertPayment(order, { request_key: 'dup-key', method: 'efectivo en agencia' })
      expect(ok.error).toBeNull()
      expect((ok.data as Row).amount).toBe(30)
      expect((await insertPayment(order, { request_key: 'dup-key' })).error?.code).toBe('23505')
    })

    it('the same evidence cannot back two LIVE payments; an operation number is unique while the payment is live (rejected / voided release it)', async () => {
      const { order } = await p.order('uniq', 100)
      const { order: other } = await p.order('uniq2', 100)
      const doc = await w.admin.from('order_documents').insert({
        account_id: w.acc, order_id: order, kind: 'voucher', status: 'pending_review', association: 'direct', request_key: `d-${Math.random()}`, storage_path: `account-${w.acc}/orders/${order}/x/f.pdf`,
        original_filename: 'f.pdf', mime_type: 'application/pdf', size_bytes: 10, content_hash: 'a'.repeat(64), source: 'upload', uploaded_by: w.logi.id,
      }).select('id').single()
      const docId = (doc.data as { id: string }).id
      expect((await insertPayment(order, { evidence_document_id: docId })).error).toBeNull()
      expect((await insertPayment(order, { evidence_document_id: docId })).error?.code).toBe('23505')
      const a = await insertPayment(order, { operation_number: 'OP-1' })
      expect(a.error).toBeNull()
      expect((await insertPayment(other, { operation_number: 'OP-1' })).error?.code).toBe('23505') // per ACCOUNT, any order
      await w.admin.from('order_payments').update({ status: 'rejected', rejected_at: '2027-02-01T11:00:00Z', rejected_reason: 'x' }).eq('id', (a.data as Row).id)
      expect((await insertPayment(other, { operation_number: 'OP-1' })).error).toBeNull() // released by the rejection
    })

    it('money data is IMMUTABLE; only legal transitions; rejected / voided are final; rows cannot be deleted', async () => {
      const { order } = await p.order('immutable', 100)
      const row = (await insertPayment(order)).data as Row
      for (const patch of [{ amount: 99 }, { kind: 'full' }, { paid_at: '2027-03-01T00:00:00Z' }, { notes: 'x' }, { method: 'other' }, { order_id: order }]) {
        const r = await w.admin.from('order_payments').update(patch).eq('id', row.id)
        if (!('order_id' in patch)) expect(r.error?.code).toBe('42501')
      }
      expect((await w.admin.from('order_payments').update({ status: 'voided', voided_at: '2027-02-01T12:00:00Z', voided_reason: 'x', confirmed_at: '2027-02-01T12:00:00Z' }).eq('id', row.id)).error?.code).toBe('22023') // recorded -> voided is not legal
      expect((await w.admin.from('order_payments').update({ status: 'confirmed', confirmed_at: '2027-02-01T12:00:00Z' }).eq('id', row.id)).error).toBeNull()
      expect((await w.admin.from('order_payments').update({ status: 'voided', voided_at: '2027-02-01T13:00:00Z', voided_reason: 'x' }).eq('id', row.id)).error).toBeNull()
      expect((await w.admin.from('order_payments').update({ status: 'confirmed' }).eq('id', row.id)).error?.code).toBe('22023')
      expect((await w.admin.from('order_payments').update({ voided_reason: 'again' }).eq('id', row.id)).error?.code).toBe('42501')
      expect((await w.admin.from('order_payments').delete().eq('id', row.id)).error?.code).toBe('42501')
    })

    it('the audit is append-only (no update, no delete) and its lifecycle events cannot repeat for one payment', async () => {
      const { order } = await p.order('audit', 100)
      const pay = (await insertPayment(order)).data as Row
      const ev = { account_id: w.acc, order_id: order, payment_id: pay.id, event_type: 'payment_registered', actor_name: 'QA' }
      const first = await w.admin.from('order_payment_events').insert(ev).select('id').single()
      expect(first.error).toBeNull()
      expect((await w.admin.from('order_payment_events').insert(ev)).error?.code).toBe('23505')
      expect((await w.admin.from('order_payment_events').insert({ ...ev, event_type: 'nope' })).error?.code).toBe('23514')
      expect((await w.admin.from('order_payment_events').update({ reason: 'x' }).eq('id', (first.data as Row).id)).error?.code).toBe('42501')
      expect((await w.admin.from('order_payment_events').delete().eq('id', (first.data as Row).id)).error?.code).toBe('42501')
    })

    it('order_financials: identity immutable, paid_at only while paid, never negative', async () => {
      const { order } = await p.order('fin-shape', 100)
      expect((await w.admin.from('order_financials').update({ financial_status: 'paid' }).eq('order_id', order)).error?.code).toBe('23514') // paid needs paid_at
      expect((await w.admin.from('order_financials').update({ paid_confirmed: -1 }).eq('order_id', order)).error?.code).toBe('23514')
      expect((await w.admin.from('order_financials').update({ account_id: w.accForeign }).eq('order_id', order)).error?.code).toBe('42501')
    })
  })

  describe('RLS: who reads what (browsers never write)', () => {
    it('Logistica and Supervisor read payments, events and the summary; Comercial reads ONLY the summary, and only for a chat it can work; viewer and other accounts read nothing', async () => {
      const { order, conv } = await p.order('rls', 100)
      const pay = (await insertPayment(order)).data as Row
      await w.admin.from('order_payment_events').insert({ account_id: w.acc, order_id: order, payment_id: pay.id, event_type: 'payment_registered', actor_name: 'QA' })
      const read = async (a: typeof w.logi, table: string) => ((await a.client.from(table).select('*').eq('order_id', order)).data ?? []) as Row[]
      for (const a of [w.logi, w.sup]) {
        expect(await read(a, 'order_payments')).toHaveLength(1)
        expect(await read(a, 'order_payment_events')).toHaveLength(1)
        expect(await read(a, 'order_financials')).toHaveLength(1)
      }
      // Comercial: summary yes (chat in the commercial stage), payments / events never
      expect(await read(w.comm, 'order_financials')).toHaveLength(1)
      expect(await read(w.comm, 'order_payments')).toEqual([])
      expect(await read(w.comm, 'order_payment_events')).toEqual([])
      // the chat moves to logistics (PR-03): Comercial no longer sees even the summary
      await w.admin.from('conversation_routing').insert({ conversation_id: conv, account_id: w.acc, stage: 'logistics', version: 1 })
      expect(await read(w.comm, 'order_financials')).toEqual([])
      expect(await read(w.logi, 'order_financials')).toHaveLength(1)
      for (const a of [w.viewer, w.foreign]) for (const t of ['order_payments', 'order_payment_events', 'order_financials']) expect(await read(a, t)).toEqual([])
      expect(((await w.foreign.client.from('order_payment_settings').select('*')).data ?? []).length).toBe(0)
    })

    it('browsers can not write any PR-06 table; the settings flag OFF hides everything even from Logistica', async () => {
      const { order } = await p.order('rls-write', 100)
      const pay = (await insertPayment(order)).data as Row
      for (const a of [w.logi, w.sup, w.comm, w.foreign]) {
        expect((await a.client.from('order_payments').insert({ account_id: w.acc, order_id: order, request_key: 'x', amount: 1, kind: 'other', paid_at: '2027-02-01T10:00:00Z', registered_by_name: 'x' })).error).not.toBeNull()
        expect((await a.client.from('order_payments').update({ status: 'confirmed' }).eq('id', pay.id).select('id')).data ?? []).toEqual([])
        expect((await a.client.from('order_financials').update({ paid_confirmed: 100 }).eq('order_id', order).select('order_id')).data ?? []).toEqual([])
        expect((await a.client.from('order_payment_events').insert({ account_id: w.acc, order_id: order, event_type: 'payment_registered', actor_name: 'x' })).error).not.toBeNull()
        expect((await a.client.from('order_payment_settings').update({ order_payments_enabled: false }).eq('account_id', w.acc).select('account_id')).data ?? []).toEqual([])
      }
      await enablePayments(w, w.acc, false, null)
      try {
        for (const a of [w.logi, w.sup, w.comm]) {
          expect(((await a.client.from('order_payments').select('id').eq('order_id', order)).data ?? []).length).toBe(0)
          expect(((await a.client.from('order_financials').select('order_id').eq('order_id', order)).data ?? []).length).toBe(0)
        }
        expect(await p.payments(order)).toHaveLength(1) // OFF never deletes anything
      } finally {
        await enablePayments(w, w.acc, true)
      }
    })
  })
})
