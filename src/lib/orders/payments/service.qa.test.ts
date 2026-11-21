// @vitest-environment node
/** PR-06 · the service layer (what the routes call) against the REAL local stack: validation, panel, summary, balance filter, Comercial's read-only view. LOCAL ONLY. */
import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { createWorld, QA_ENABLED, type QaWorld } from '@/lib/orders/logistics/test-support/qa-env'
import { enablePayments, paymentsOps, type Row } from '@/lib/orders/payments/test-support/payments-ops'
import { confirmPayment, correctPayment, getConversationFinancials, getPaymentsPanel, getPaymentsSummary, listOrdersWithBalance, markDeliveredManual, registerPayment, rejectPayment, voidPayment } from '@/lib/orders/payments/service'

let w: QaWorld
let p: ReturnType<typeof paymentsOps>
vi.setConfig({ testTimeout: 40_000, hookTimeout: 120_000 })
const who = (a = w.logi) => ({ userId: a.id, accountId: w.acc })
const input = (over: Record<string, unknown> = {}) => ({ requestKey: `k-${randomUUID()}`, amount: '30.00', kind: 'advance', method: 'yape', paidAt: new Date(Date.now() - 3_600_000).toISOString(), ...over })

describe.skipIf(!QA_ENABLED)('PR-06 service layer', () => {
  beforeAll(async () => {
    w = await createWorld()
    p = paymentsOps(w)
    await enablePayments(w, w.acc)
  }, 120_000)
  afterAll(async () => {
    if (w) await w.dispose()
  }, 90_000)

  it('registers with validated input (comma decimals accepted), confirms, and answers 201 only for a NEW payment; invalid input never reaches the database', async () => {
    const { order } = await p.order('svc', 100)
    const bad = [{ amount: '0' }, { amount: '-3' }, { amount: 'abc' }, { amount: '1.234' }, { kind: 'refund' }, { paidAt: 'yesterday' }, { requestKey: 'bad key' }, { evidenceDocumentId: 'nope' }]
    for (const b of bad) expect(await registerPayment(who(), w.admin, order, input(b)), JSON.stringify(b)).toMatchObject({ ok: false, status: 400 })
    expect(await p.payments(order)).toEqual([])
    const key = `k-${randomUUID()}`
    const r1 = await registerPayment(who(), w.admin, order, input({ requestKey: key, amount: '30,5' }))
    expect(r1).toMatchObject({ ok: true, status: 201, body: { created: true, status: 'recorded' } })
    const r2 = await registerPayment(who(), w.admin, order, input({ requestKey: key, amount: '30.50' }))
    expect(r2).toMatchObject({ ok: true, status: 200, body: { created: false } })
    expect((await p.payments(order))[0].amount).toBe(30.5)
    const id = r1.ok ? r1.body.payment_id : ''
    expect(await confirmPayment(who(), w.admin, id, {})).toMatchObject({ ok: true, body: { changed: true, financial_status: 'partially_paid', pending_balance: 69.5 } })
    expect(await confirmPayment(who(), w.admin, 'nope', {})).toMatchObject({ ok: false, status: 400 })
  })

  it('verdicts: exceeds_balance 409 (with the pending balance), overpayment reason 422, stale 409, duplicates 409, reasons required 422, forbidden roles 404/403', async () => {
    const { order } = await p.order('svc-verdicts', 100)
    const a = await registerPayment(who(), w.admin, order, input({ amount: '80.00', operationNumber: 'OP-S1' }))
    await confirmPayment(who(), w.admin, a.ok ? a.body.payment_id : '', {})
    const b = await registerPayment(who(), w.admin, order, input({ amount: '50.00' }))
    const bid = b.ok ? b.body.payment_id : ''
    expect(await confirmPayment(who(), w.admin, bid, {})).toMatchObject({ ok: false, status: 409, error: 'exceeds_balance', extra: { pending_balance: 20 } })
    expect(await confirmPayment(who(w.sup), w.admin, bid, {})).toMatchObject({ ok: false, status: 422, error: 'overpayment_reason_required' })
    expect(await confirmPayment(who(), w.admin, bid, { expectedVersion: 9 })).toMatchObject({ ok: false, status: 409, error: 'stale' })
    expect(await registerPayment(who(), w.admin, order, input({ operationNumber: 'OP-S1' }))).toMatchObject({ ok: false, status: 409, error: 'duplicate_operation' })
    expect(await rejectPayment(who(), w.admin, bid, { reason: '   ' })).toMatchObject({ ok: false, status: 422 })
    expect(await voidPayment(who(), w.admin, a.ok ? a.body.payment_id : '', { reason: 'x' })).toMatchObject({ ok: false, status: 404 }) // Logistica: forbidden -> not found
    expect(await confirmPayment(who(w.comm), w.admin, bid, {})).toMatchObject({ ok: false, status: 404 })
    expect(await confirmPayment({ userId: w.foreign.id, accountId: w.accForeign }, w.admin, bid, {})).toMatchObject({ ok: false }) // that account never activated PR-06 (403) / does not own the payment (404)
    expect(await correctPayment(who(w.sup), w.admin, a.ok ? a.body.payment_id : '', input({ reason: 'ajuste', amount: '85.00' }))).toMatchObject({ ok: true, body: { changed: true, paid_confirmed: 85 } })
  })

  it('panel: Total / Pagado / Saldo / Estado, payments, audit, delivery and a voucher CANDIDATE (the PR-04 validated voucher) with an amount HINT; no payment is created from it', async () => {
    const hintOrder = await p.order('svc-hint', 100)
    const doc = await w.admin.from('order_documents').insert({
      account_id: w.acc, order_id: hintOrder.order, kind: 'voucher', status: 'validated', association: 'direct', request_key: `v-${randomUUID()}`, storage_path: `account-${w.acc}/orders/${hintOrder.order}/vouchers/${randomUUID()}/f.pdf`,
      original_filename: 'yape-30.pdf', mime_type: 'application/pdf', size_bytes: 10, content_hash: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''), source: 'upload', uploaded_by: w.logi.id,
      version: 1, reviewed_data: { amount: 'S/ 30.00' }, validated_by: w.logi.id, validated_at: '2026-11-01T10:00:00Z',
    }).select('id').single()
    if (doc.error) throw doc.error
    const caller = { supabase: w.logi.client, userId: w.logi.id, accountId: w.acc }
    const hint = await getPaymentsPanel(caller, w.admin, hintOrder.order, false)
    expect(hint.ok && hint.body.voucher_candidate).toMatchObject({ id: (doc.data as Row).id, amount_hint: 30, filename: 'yape-30.pdf' })
    expect(await p.payments(hintOrder.order)).toEqual([]) // the candidate created nothing
    const linked = await registerPayment(who(), w.admin, hintOrder.order, input({ evidenceDocumentId: (doc.data as Row).id }))
    expect(linked).toMatchObject({ ok: true })
    expect((await getPaymentsPanel(caller, w.admin, hintOrder.order, false)).ok && true).toBe(true)
    const afterLink = await getPaymentsPanel(caller, w.admin, hintOrder.order, false)
    expect(afterLink.ok && afterLink.body.voucher_candidate).toBeNull() // already linked to a live payment

    const { order } = await p.readyOrder('svc-panel', 100)
    const panel = await getPaymentsPanel(caller, w.admin, order, false)
    expect(panel).toMatchObject({ ok: true, body: { tracked: true, total: 100, paid_confirmed: 0, pending_balance: 100, financial_status: 'unpaid', payments: [], is_supervisor: false } })
    expect(panel.ok && panel.body.voucher_candidate).toMatchObject({ amount_hint: null }) // the PR-04 voucher has no usable amount: nothing is pre-filled
    expect(panel.ok && panel.body.delivery).toMatchObject({ delivered: false, can_mark_manual: true })
    const r = await registerPayment(who(), w.admin, order, input())
    await confirmPayment(who(), w.admin, r.ok ? r.body.payment_id : '', {})
    const after = await getPaymentsPanel(caller, w.admin, order, true)
    expect(after).toMatchObject({ ok: true, body: { paid_confirmed: 30, pending_balance: 70, financial_status: 'partially_paid', is_supervisor: true } })
    expect(after.ok && after.body.events.map((e) => e.event_type)).toEqual(expect.arrayContaining(['payment_registered', 'payment_confirmed']))
    expect(await markDeliveredManual(who(), w.admin, order, 'Olva')).toMatchObject({ ok: true, body: { changed: true } })
    const done = await getPaymentsPanel(caller, w.admin, order, false)
    expect(done.ok && done.body.delivery).toMatchObject({ delivered: true, source: 'manual', can_mark_manual: false })
    expect(done.ok && done.body.finalization).toBeNull() // delivered but only partially paid: NOT finalized
    for (const a of [w.comm, w.viewer]) expect(await getPaymentsPanel({ supabase: a.client, userId: a.id, accountId: w.acc }, w.admin, order, false)).toMatchObject({ ok: false, status: 404 })
    expect(await getPaymentsPanel({ supabase: w.foreign.client, userId: w.foreign.id, accountId: w.accForeign }, w.admin, order, false)).toMatchObject({ ok: false })
  })

  it('summary + "Con saldo" filter: only TRACKED orders, only their own account; a paid order leaves the filter', async () => {
    const a = await p.order('svc-sum-a', 100)
    const b = await p.order('svc-sum-b', 50)
    await p.pay(b.order, '50.00')
    const caller = { supabase: w.logi.client, userId: w.logi.id, accountId: w.acc }
    const hist = await w.mkOrder(w.acc, `hist-${randomUUID()}`, { price: 10 })
    await w.admin.from('order_financials').delete().eq('order_id', hist)
    const sum = await getPaymentsSummary(caller, [a.order, b.order, hist])
    expect(sum).toMatchObject({ ok: true, body: { summaries: { [a.order]: { financial_status: 'unpaid', total: 100, pending_balance: 100 }, [b.order]: { financial_status: 'paid', pending_balance: 0 } } } })
    expect(sum.ok && Object.keys(sum.body.summaries)).not.toContain(hist) // not tracked: absent
    expect(await getPaymentsSummary(caller, [])).toMatchObject({ ok: false, status: 400 })
    expect(await getPaymentsSummary(caller, Array.from({ length: 51 }, () => randomUUID()))).toMatchObject({ ok: false, status: 400 })
    const bal = await listOrdersWithBalance(caller)
    expect(bal.ok && bal.body.order_ids).toContain(a.order)
    expect(bal.ok && bal.body.order_ids).not.toContain(b.order)
    expect(await listOrdersWithBalance({ supabase: w.comm.client, userId: w.comm.id, accountId: w.acc })).toMatchObject({ ok: false, status: 404 })
    expect(await getPaymentsSummary({ supabase: w.foreign.client, userId: w.foreign.id, accountId: w.accForeign }, [a.order])).toMatchObject({ ok: false, status: 404 })
  })

  it('Comercial: READ-ONLY Total / Pagado / Saldo / Estado of the chat it can work; nothing once the chat is in Logistica; no payments / evidence / audit; Logistica / Supervisor always', async () => {
    const a = await p.order('svc-chat', 100)
    await p.pay(a.order, '30.00')
    const second = await w.mkOrder(w.acc, `chat-2-${randomUUID()}`, { price: 40, conversation_id: a.conv })
    void second
    const asComm = { supabase: w.comm.client, userId: w.comm.id, accountId: w.acc }
    const view = await getConversationFinancials(asComm, a.conv)
    expect(view).toMatchObject({ ok: true })
    expect(view.ok && view.body.orders).toHaveLength(2)
    expect(view.ok && view.body.orders.find((o) => o.order_id === a.order)).toMatchObject({ total: 100, paid_confirmed: 30, pending_balance: 70, financial_status: 'partially_paid' })
    expect(JSON.stringify(view)).not.toMatch(/payment_id|evidence|method|operation/)
    await w.admin.from('conversation_routing').insert({ conversation_id: a.conv, account_id: w.acc, stage: 'logistics', version: 1 })
    expect(await getConversationFinancials(asComm, a.conv)).toMatchObject({ ok: false, status: 404 }) // Comercial no longer works this chat
    for (const x of [w.logi, w.sup]) expect(await getConversationFinancials({ supabase: x.client, userId: x.id, accountId: w.acc }, a.conv)).toMatchObject({ ok: true })
    expect(await getConversationFinancials({ supabase: w.viewer.client, userId: w.viewer.id, accountId: w.acc }, a.conv)).toMatchObject({ ok: false, status: 404 })
    expect(await getConversationFinancials({ supabase: w.foreign.client, userId: w.foreign.id, accountId: w.accForeign }, a.conv)).toMatchObject({ ok: false, status: 404 })
    expect(await getConversationFinancials(asComm, 'nope')).toMatchObject({ ok: false, status: 400 })
    await enablePayments(w, w.acc, false, null)
    try {
      expect(await getConversationFinancials({ supabase: w.logi.client, userId: w.logi.id, accountId: w.acc }, a.conv)).toMatchObject({ ok: false, status: 404 })
    } finally {
      await enablePayments(w, w.acc, true)
    }
  })
})
