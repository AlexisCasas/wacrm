// @vitest-environment node
/** PR-06 · the financial calculation and the payment lifecycle (register / confirm / reject / void / correct) against the REAL local stack. LOCAL ONLY. */
import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { createWorld, QA_ENABLED, type QaWorld } from '@/lib/orders/logistics/test-support/qa-env'
import { at, enablePayments, paymentsOps, type Row } from '@/lib/orders/payments/test-support/payments-ops'

let w: QaWorld
let p: ReturnType<typeof paymentsOps>
vi.setConfig({ testTimeout: 40_000, hookTimeout: 120_000 })

const pid = (r: { data: unknown }) => (r.data as { payment_id: string }).payment_id
const fin = async (order: string) => (await p.financials(order)) as Row
const voucher = async (order: string, status = 'pending_review') => {
  const { data, error } = await w.admin.from('order_documents').insert({
    account_id: w.acc, order_id: order, kind: 'voucher', status, association: 'direct', request_key: `v-${randomUUID()}`, storage_path: `account-${w.acc}/orders/${order}/vouchers/${randomUUID()}/f.pdf`,
    original_filename: 'f.pdf', mime_type: 'application/pdf', size_bytes: 10, content_hash: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''), source: 'upload', uploaded_by: w.logi.id,
    ...(status === 'validated' ? { version: 1, reviewed_data: { amount: '30.00' }, validated_by: w.logi.id, validated_at: at(0) } : {}),
  }).select('id').single()
  if (error) throw error
  return (data as { id: string }).id
}

describe.skipIf(!QA_ENABLED)('PR-06 calculation and payment lifecycle', () => {
  beforeAll(async () => {
    w = await createWorld()
    p = paymentsOps(w)
    await enablePayments(w, w.acc)
  }, 120_000)
  afterAll(async () => {
    if (w) await w.dispose()
  }, 90_000)

  describe('the calculation (S/100 order)', () => {
    it('A. no payments -> unpaid, balance 100.  B. S/30 -> partially_paid, balance 70.  C. S/70 -> paid, balance 0, paid_at set', async () => {
      const { order } = await p.order('abc', 100)
      expect(await fin(order)).toMatchObject({ financial_status: 'unpaid', paid_confirmed: 0, paid_at: null })
      const first = await p.register(order, { p_amount: '30.00', p_now: at(0) })
      expect(first.data).toMatchObject({ ok: true, created: true, status: 'recorded', row_version: 1 })
      expect(await fin(order)).toMatchObject({ financial_status: 'unpaid', paid_confirmed: 0 }) // recorded is NOT money yet
      const c1 = await p.confirm(pid(first), { p_now: at(1) })
      expect(c1.data).toMatchObject({ ok: true, financial_status: 'partially_paid', paid_confirmed: 30, pending_balance: 70 })
      const second = await p.register(order, { p_amount: '70.00', p_kind: 'balance', p_now: at(5) })
      const c2 = await p.confirm(pid(second), { p_now: at(6) })
      expect(c2.data).toMatchObject({ ok: true, financial_status: 'paid', paid_confirmed: 100, pending_balance: 0 })
      const f = await fin(order)
      expect(f).toMatchObject({ financial_status: 'paid', paid_confirmed: 100 })
      expect(Date.parse(f.paid_at)).toBe(Date.parse(at(6))) // the moment it BECAME paid
    })

    it('a single full payment -> paid; kind is informative (a "balance" first payment still counts the same)', async () => {
      const { order } = await p.order('full', 250.5)
      await p.pay(order, '250.50', { p_kind: 'full' })
      expect(await fin(order)).toMatchObject({ financial_status: 'paid', paid_confirmed: 250.5 })
      const { order: o2 } = await p.order('kind', 100)
      await p.pay(o2, '40.00', { p_kind: 'balance' })
      await p.pay(o2, '60.00', { p_kind: 'other' }, 3)
      expect(await fin(o2)).toMatchObject({ financial_status: 'paid' })
    })

    it('exact decimals: 33.33 + 33.33 + 33.34 = 100.00 paid (no floating point); 33.333 / 0 / -1 / text are refused', async () => {
      const { order } = await p.order('dec', 100)
      for (const [i, a] of ['33.33', '33.33', '33.34'].entries()) await p.pay(order, a, {}, i * 2)
      expect(await fin(order)).toMatchObject({ financial_status: 'paid', paid_confirmed: 100 })
      for (const bad of ['33.333', '0', '0.00', '-1', 'abc', '', '1e3', '12345678']) {
        const r = await p.register(order, { p_amount: bad })
        expect(r.error?.code, bad).toBe('22023')
      }
    })

    it('an order that was never given payments stays unpaid and shows the full balance in the audit of the first payment', async () => {
      const { order } = await p.order('audit-balance', 100)
      await p.pay(order, '30.00', {}, 0)
      const ev = (await p.events(order)).find((e) => e.event_type === 'payment_confirmed') as Row
      expect(ev).toMatchObject({ amount: 30, paid_before: 0, paid_after: 30, balance_before: 100, balance_after: 70, financial_status_before: 'unpaid', financial_status_after: 'partially_paid', status_before: 'recorded', status_after: 'confirmed' })
      expect(ev.actor_user_id).toBe(w.logi.id)
    })
  })

  describe('idempotency and duplicates', () => {
    it('the same request_key (retry / double click) is the SAME payment: no second row, no second event, no double balance', async () => {
      const { order } = await p.order('retry', 100)
      const key = `k-${randomUUID()}`
      const results = await Promise.all([1, 2, 3].map(() => p.register(order, { p_request_key: key, p_amount: '30.00' })))
      expect(new Set(results.map(pid)).size).toBe(1)
      expect(results.filter((r) => (r.data as Row).created === true)).toHaveLength(1)
      expect(await p.payments(order)).toHaveLength(1)
      expect(await p.count(order, 'payment_registered')).toBe(1)
      const id = pid(results[0])
      const confirmations = await Promise.all([1, 2, 3].map(() => p.confirm(id)))
      expect(confirmations.filter((r) => (r.data as Row).changed === true)).toHaveLength(1)
      expect(await fin(order)).toMatchObject({ paid_confirmed: 30 })
      expect(await p.count(order, 'payment_confirmed')).toBe(1)
      // the same key with a DIFFERENT amount is a conflict, never a silent reuse
      expect((await p.register(order, { p_request_key: key, p_amount: '31.00' })).error?.code).toBe('22023')
    })

    it('the same evidence cannot back two live payments (a voucher too); the same operation number is refused while live and released by reject / void', async () => {
      const { order } = await p.order('dup', 200)
      const doc = await voucher(order)
      const a = await p.register(order, { p_evidence: doc, p_operation_number: 'OP-77' })
      expect(a.data).toMatchObject({ ok: true })
      expect((await p.register(order, { p_evidence: doc })).data).toMatchObject({ ok: false, reason: 'duplicate_evidence' })
      expect((await p.register(order, { p_operation_number: 'OP-77' })).data).toMatchObject({ ok: false, reason: 'duplicate_operation' })
      const { order: other } = await p.order('dup2', 200)
      expect((await p.register(other, { p_operation_number: 'OP-77' })).data).toMatchObject({ ok: false, reason: 'duplicate_operation' }) // per account
      await p.reject(pid(a))
      expect((await p.register(order, { p_evidence: doc, p_operation_number: 'OP-77' })).data).toMatchObject({ ok: true }) // released
      expect((await p.register(order, { p_evidence: await voucher(other) })).data).toMatchObject({ ok: false, reason: 'invalid_evidence' }) // another order's proof
      expect((await p.register(order, { p_evidence: await voucher(order, 'rejected') })).data).toMatchObject({ ok: false, reason: 'invalid_evidence' })
    })

    it('a voucher (even validated) NEVER creates a payment and a linked voucher does not change the balance until a person confirms', async () => {
      const { order } = await p.order('voucher', 100)
      const doc = await voucher(order, 'validated')
      expect(await p.payments(order)).toEqual([])
      expect(await fin(order)).toMatchObject({ financial_status: 'unpaid', paid_confirmed: 0 })
      const r = await p.register(order, { p_evidence: doc, p_amount: '30.00' })
      expect(r.data).toMatchObject({ ok: true })
      expect(await fin(order)).toMatchObject({ paid_confirmed: 0 })
      await p.confirm(pid(r))
      expect(await fin(order)).toMatchObject({ paid_confirmed: 30 })
      expect((await p.payments(order))[0].evidence_document_id).toBe(doc)
    })
  })

  describe('concurrency and stale versions', () => {
    it('two operators confirming the same payment at once = one confirmation; two payments that together exceed the balance: the second is blocked', async () => {
      const { order } = await p.order('conc', 100)
      const a = pid(await p.register(order, { p_amount: '70.00' }))
      const b = pid(await p.register(order, { p_amount: '70.00' }))
      const [r1, r2] = await Promise.all([p.confirm(a, {}, w.logi), p.confirm(b, {}, w.logi2)])
      const outcomes = [r1, r2].map((r) => r.data as Row)
      expect(outcomes.filter((o) => o.ok === true)).toHaveLength(1)
      expect(outcomes.filter((o) => o.reason === 'exceeds_balance')).toHaveLength(1)
      expect(await fin(order)).toMatchObject({ paid_confirmed: 70, financial_status: 'partially_paid' })
    })

    it('stale row_version is refused on confirm / reject / void / correct', async () => {
      const { order } = await p.order('stale', 100)
      const id = pid(await p.register(order, { p_amount: '30.00' }))
      expect((await p.confirm(id, { p_expected_version: 5 })).data).toMatchObject({ ok: false, reason: 'stale' })
      expect((await p.reject(id, 'x', { p_expected_version: 5 })).data).toMatchObject({ ok: false, reason: 'stale' })
      expect((await p.confirm(id, { p_expected_version: 1 })).data).toMatchObject({ ok: true, changed: true })
      expect((await p.voidPayment(id, 'x', { p_expected_version: 1 })).data).toMatchObject({ ok: false, reason: 'stale' }) // it is version 2 now
      expect((await p.correct(id, { p_expected_version: 1 })).data).toMatchObject({ ok: false, reason: 'stale' })
      expect((await p.voidPayment(id, 'x', { p_expected_version: 2 })).data).toMatchObject({ ok: true, changed: true })
    })
  })

  describe('reject, void and correct', () => {
    it('reject: only a recorded payment, reason mandatory, no effect on the balance, final', async () => {
      const { order } = await p.order('reject', 100)
      const id = pid(await p.register(order, { p_amount: '30.00' }))
      expect((await p.reject(id, null)).error?.code).toBe('22023')
      expect((await p.reject(id, '   ')).error?.code).toBe('22023')
      expect((await p.reject(id, 'comprobante ilegible')).data).toMatchObject({ ok: true, changed: true, status: 'rejected' })
      expect((await p.reject(id, 'again')).data).toMatchObject({ ok: true, changed: false }) // idempotent
      expect((await p.confirm(id)).data).toMatchObject({ ok: false, reason: 'not_confirmable' })
      expect(await fin(order)).toMatchObject({ paid_confirmed: 0, financial_status: 'unpaid' })
      expect(await p.count(order, 'payment_rejected')).toBe(1)
    })

    it('void: SUPERVISOR only, reason mandatory, never deletes, recalculates balance and status (paid -> partially_paid -> unpaid)', async () => {
      const { order } = await p.order('void', 100)
      const a = await p.pay(order, '30.00', {}, 0)
      const b = await p.pay(order, '70.00', {}, 5)
      expect(await fin(order)).toMatchObject({ financial_status: 'paid' })
      expect((await p.voidPayment(b, 'x', {}, w.logi)).error?.code).toBe('42501') // Logistica can not
      expect((await p.voidPayment(b, null)).error?.code).toBe('22023')
      expect((await p.voidPayment(b, 'pago devuelto por el banco')).data).toMatchObject({ ok: true, financial_status: 'partially_paid', paid_confirmed: 30, pending_balance: 70 })
      expect((await fin(order)).paid_at).toBeNull()
      expect((await p.voidPayment(b, 'again')).data).toMatchObject({ ok: true, changed: false })
      expect((await p.voidPayment(a, 'x')).data).toMatchObject({ ok: true, financial_status: 'unpaid', paid_confirmed: 0, pending_balance: 100 })
      expect(await p.payments(order)).toHaveLength(2) // nothing deleted
      expect((await p.payments(order)).map((x) => x.status)).toEqual(['voided', 'voided'])
      const ev = (await p.events(order)).filter((e) => e.event_type === 'payment_voided')
      expect(ev).toHaveLength(2)
      expect(ev[0]).toMatchObject({ actor_user_id: w.sup.id, reason: 'pago devuelto por el banco', balance_before: 0, balance_after: 70 })
      // a recorded (never confirmed) payment is rejected, not voided
      const rec = pid(await p.register(order, { p_amount: '10.00' }))
      expect((await p.voidPayment(rec, 'x')).data).toMatchObject({ ok: false, reason: 'not_voidable' })
    })

    it('correct = void the old payment + a NEW confirmed one in one transaction (Supervisor, reason mandatory); the full history stays; the key makes it idempotent', async () => {
      const { order } = await p.order('correct', 100)
      const old = await p.pay(order, '30.00', { p_operation_number: 'OP-C' }, 0)
      expect((await p.correct(old, {}, w.logi)).error?.code).toBe('42501')
      expect((await p.correct(old, { p_reason: null })).error?.code).toBe('22023')
      const key = `fix-${randomUUID()}`
      const r = await p.correct(old, { p_request_key: key, p_amount: '40.00', p_operation_number: 'OP-C' }) // the old operation number is released by the void
      expect(r.data).toMatchObject({ ok: true, changed: true, status: 'confirmed', financial_status: 'partially_paid', paid_confirmed: 40, pending_balance: 60, voided_payment_id: old })
      const rows = await p.payments(order)
      expect(rows.map((x) => [x.status, x.amount])).toEqual([['voided', 30], ['confirmed', 40]])
      expect(rows[1].supersedes_payment_id).toBe(old)
      const types = (await p.events(order)).map((e) => e.event_type)
      expect(types).toEqual(expect.arrayContaining(['payment_registered', 'payment_confirmed', 'payment_voided', 'payment_corrected']))
      const corrected = (await p.events(order)).find((e) => e.event_type === 'payment_corrected') as Row
      expect(corrected).toMatchObject({ amount: 40, paid_before: 30, paid_after: 40, balance_before: 70, balance_after: 60, reason: 'monto mal digitado' })
      expect(corrected.detail).toMatchObject({ voided_payment: old, amount_before: 30, amount_after: 40 })
      // retry of the same correction changes nothing
      expect((await p.correct(old, { p_request_key: key, p_amount: '40.00' })).data).toMatchObject({ ok: true, changed: false })
      expect(await p.payments(order)).toHaveLength(2)
      // a correction of a payment that is not confirmed / is already voided is refused
      expect((await p.correct(old, { p_request_key: `fix-${randomUUID()}` })).data).toMatchObject({ ok: false, reason: 'not_correctable' })
    })
  })

  describe('overpayment', () => {
    it('is BLOCKED for Logistica (exceeds_balance) and for a Supervisor without a reason; a Supervisor WITH a reason may; the status never becomes "overpaid"; audited', async () => {
      const { order } = await p.order('over', 100)
      await p.pay(order, '80.00', {}, 0)
      const id = pid(await p.register(order, { p_amount: '50.00', p_now: at(5) }))
      expect((await p.confirm(id, {}, w.logi)).data).toMatchObject({ ok: false, reason: 'exceeds_balance', pending_balance: 20 })
      expect((await p.confirm(id, { p_overpayment_reason: 'sobra' }, w.logi)).data).toMatchObject({ ok: false, reason: 'exceeds_balance' }) // a reason does not help Logistica
      expect((await p.confirm(id, {}, w.sup)).data).toMatchObject({ ok: false, reason: 'overpayment_reason_required' })
      expect((await p.confirm(id, { p_overpayment_reason: 'cliente pagó de más; se devolverá' }, w.sup)).data).toMatchObject({ ok: true, financial_status: 'paid', paid_confirmed: 130, pending_balance: 0, overpayment: true })
      expect((await fin(order)).financial_status).toBe('paid')
      const ex = (await p.events(order)).find((e) => e.event_type === 'overpayment_exception') as Row
      expect(ex).toMatchObject({ actor_user_id: w.sup.id, reason: 'cliente pagó de más; se devolverá' })
      expect(ex.detail).toMatchObject({ excess: 30 })
      expect((await p.payments(order)).find((x) => x.id === id)).toMatchObject({ overpayment_reason: 'cliente pagó de más; se devolverá' })
    })

    it('a correction that would exceed the balance also needs the Supervisor reason (and rolls back without it)', async () => {
      const { order } = await p.order('over-fix', 100)
      const a = await p.pay(order, '30.00', {}, 0)
      await p.pay(order, '50.00', {}, 3)
      expect((await p.correct(a, { p_amount: '60.00' })).error?.code).toBe('22023') // 50 + 60 > 100
      expect((await p.payments(order)).map((x) => x.status)).toEqual(['confirmed', 'confirmed']) // nothing was voided
      expect(await fin(order)).toMatchObject({ paid_confirmed: 80 })
      expect((await p.correct(a, { p_amount: '60.00', p_overpayment_reason: 'ajuste autorizado' })).data).toMatchObject({ ok: true, overpayment: true, paid_confirmed: 110 })
    })
  })

  describe('authority', () => {
    it('Commercial, viewer and another account can do nothing; the flag OFF refuses every write; a payment of another account is "forbidden", never revealed', async () => {
      const { order } = await p.order('auth', 100)
      const id = pid(await p.register(order, { p_amount: '30.00' }))
      for (const actor of [w.comm, w.viewer]) {
        expect((await p.register(order, {}, actor)).error?.code).toBe('42501')
        expect((await p.confirm(id, {}, actor)).error?.code).toBe('42501')
        expect((await p.reject(id, 'x', {}, actor)).error?.code).toBe('42501')
      }
      expect((await p.register(order, {}, w.foreign, w.accForeign)).error?.code).toBe('42501') // the order is not theirs
      expect((await p.confirm(id, {}, w.foreign, w.accForeign)).error?.code).toBe('42501')
      expect((await p.register(order, {}, w.logi, w.accForeign)).error?.code).toBe('42501') // the actor is not a member of that account
      for (const a of [w.logi, w.sup, w.comm, w.foreign]) for (const fn of ['register_order_payment', 'confirm_order_payment', 'void_order_payment', 'correct_order_payment']) expect((await a.client.rpc(fn, {})).error).not.toBeNull()
      await enablePayments(w, w.acc, false, null)
      try {
        expect((await p.register(order, {})).error?.code).toBe('42501')
        expect((await p.confirm(id)).error?.code).toBe('42501')
        expect((await p.voidPayment(id)).error?.code).toBe('42501')
      } finally {
        await enablePayments(w, w.acc, true)
      }
      expect(await fin(order)).toMatchObject({ paid_confirmed: 0 })
      expect(await p.payments(order)).toHaveLength(1) // OFF deletes nothing
    })

    it('an order that is NOT tracked (confirmed before the activation) refuses payments and gets no financial row', async () => {
      await enablePayments(w, w.acc, true, '2999-01-01T00:00:00Z') // no-op: activated_at is never moved...
      const historic = await w.mkOrder(w.acc, `hist-${randomUUID()}`, { price: 50, confirmed_at: '2019-01-01T00:00:00Z' })
      await w.admin.from('order_financials').delete().eq('order_id', historic) // ...so emulate a historic order: no row
      expect(await p.financials(historic)).toBeNull()
      expect((await p.register(historic, {})).data).toMatchObject({ ok: false, reason: 'not_tracked' })
      await enablePayments(w, w.acc, true)
    })
  })
})
