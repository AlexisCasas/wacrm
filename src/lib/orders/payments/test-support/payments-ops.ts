// Test support for the PR-06 suites (real local stack only, see logistics/test-support/qa-env). Test code only.
import { randomUUID } from 'node:crypto'

import type { QaActor, QaWorld } from '@/lib/orders/logistics/test-support/qa-env'

export const T0 = Date.parse('2027-02-01T15:00:00Z')
export const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString()

/** Turns PR-06 ON for the account with an activation moment in the past, so orders created now are TRACKED (historical ones created before are not). */
export async function enablePayments(w: QaWorld, acc: string, enabled = true, activatedAt: string | null = '2020-01-01T00:00:00Z') {
  const { error } = await w.admin.from('order_payment_settings').upsert({ account_id: acc, order_payments_enabled: enabled, ...(activatedAt ? { activated_at: activatedAt } : {}) })
  if (error) throw error
}

export type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

export function paymentsOps(w: QaWorld) {
  let n = 0
  /** A confirmed order of `total` soles WITH a conversation (contact + chat), TRACKED when PR-06 is active for the account. */
  const order = async (label: string, total = 100, acc = w.acc, extra: Record<string, unknown> = {}) => {
    const owner = acc === w.acc ? w.owner : w.foreign
    const { data: contact, error: ce } = await w.admin.from('contacts').insert({ user_id: owner.id, account_id: acc, phone: `5190${String(1_000_000 + Math.floor(Math.random() * 8_000_000))}`, name: `QA ${label}` }).select('id').single()
    if (ce) throw ce
    const { data: conv, error } = await w.admin.from('conversations').insert({ user_id: owner.id, account_id: acc, contact_id: (contact as { id: string }).id }).select('id').single()
    if (error) throw error
    const id = await w.mkOrder(acc, `pay-${label}-${(n += 1)}`, { price: total, conversation_id: (conv as { id: string }).id, ...extra })
    return { order: id, conv: (conv as { id: string }).id }
  }
  const financials = async (orderId: string) => ((await w.admin.from('order_financials').select('*').eq('order_id', orderId).maybeSingle()).data ?? null) as Row | null
  const payments = async (orderId: string) => ((await w.admin.from('order_payments').select('*').eq('order_id', orderId).order('created_at')).data ?? []) as Row[]
  const events = async (orderId: string) => ((await w.admin.from('order_payment_events').select('*').eq('order_id', orderId).order('created_at')).data ?? []) as Row[]
  const count = async (orderId: string, type: string) => (await events(orderId)).filter((e) => e.event_type === type).length

  const register = (orderId: string, over: Record<string, unknown> = {}, actor: QaActor = w.logi, acc = w.acc) =>
    w.admin.rpc('register_order_payment', {
      p_account: acc, p_actor: actor.id, p_order: orderId, p_request_key: `pay-${randomUUID()}`, p_amount: '30.00', p_kind: 'advance', p_method: 'yape', p_operation_number: null,
      p_paid_at: at(-60), p_evidence: null, p_notes: null, p_source: 'manual', p_now: at(0), ...over,
    })
  const confirm = (paymentId: string, over: Record<string, unknown> = {}, actor: QaActor = w.logi, acc = w.acc) =>
    w.admin.rpc('confirm_order_payment', { p_account: acc, p_actor: actor.id, p_payment: paymentId, p_expected_version: null, p_overpayment_reason: null, p_now: at(1), ...over })
  const reject = (paymentId: string, reason: string | null = 'ilegible', over: Record<string, unknown> = {}, actor: QaActor = w.logi, acc = w.acc) =>
    w.admin.rpc('reject_order_payment', { p_account: acc, p_actor: actor.id, p_payment: paymentId, p_expected_version: null, p_reason: reason, p_now: at(2), ...over })
  const voidPayment = (paymentId: string, reason: string | null = 'error del operador', over: Record<string, unknown> = {}, actor: QaActor = w.sup, acc = w.acc) =>
    w.admin.rpc('void_order_payment', { p_account: acc, p_actor: actor.id, p_payment: paymentId, p_expected_version: null, p_reason: reason, p_now: at(3), ...over })
  const correct = (paymentId: string, over: Record<string, unknown> = {}, actor: QaActor = w.sup, acc = w.acc) =>
    w.admin.rpc('correct_order_payment', {
      p_account: acc, p_actor: actor.id, p_payment: paymentId, p_expected_version: null, p_reason: 'monto mal digitado', p_request_key: `fix-${randomUUID()}`, p_amount: '40.00',
      p_kind: 'advance', p_method: 'yape', p_operation_number: null, p_paid_at: at(-60), p_evidence: null, p_notes: null, p_overpayment_reason: null, p_now: at(4), ...over,
    })
  /** register + confirm in one go (the common path). */
  const pay = async (orderId: string, amount: string, over: Record<string, unknown> = {}, minute = 0) => {
    const r = await register(orderId, { p_amount: amount, p_now: at(minute), ...over })
    if ((r.data as { ok?: boolean })?.ok !== true) throw new Error(`register failed: ${JSON.stringify(r)}`)
    const id = (r.data as { payment_id: string }).payment_id
    const c = await confirm(id, { p_now: at(minute) })
    if ((c.data as { ok?: boolean })?.ok !== true) throw new Error(`confirm failed: ${JSON.stringify(c)}`)
    return id
  }
  return { order, financials, payments, events, count, register, confirm, reject, voidPayment, correct, pay }
}
