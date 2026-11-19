import type { SupabaseClient } from '@supabase/supabase-js'

import type { AccountContext } from '@/lib/auth/account'
import { REQUEST_KEY_PATTERN } from '@/lib/orders/logistics/constants'
import { fail, type ServiceResult } from '@/lib/orders/logistics/documents'
import { isUuid } from '@/lib/orders/logistics/files'
import { normalizeAmount } from '@/lib/orders/logistics/normalize'
import { normalizePrice } from '@/lib/orders/money'

// PR-06 · the financial axis of an order, as the browser sees it. READS use the CALLER's client (RLS applies on top of the explicit account filter); WRITES go through the
// SECURITY DEFINER functions (service role) that re-validate actor / both flags / area / order inside the database. The server NEVER trusts an amount, a role, an account or
// a balance sent by the browser: the total is order_confirmations.price and the balance is computed by the database.

export type PaymentCaller = Pick<AccountContext, 'supabase' | 'accountId' | 'userId'>
export type FinancialStatus = 'unpaid' | 'partially_paid' | 'paid'

const REASON_STATUS: Record<string, number> = {
  not_tracked: 409, stale: 409, exceeds_balance: 409, overpayment_reason_required: 422, duplicate_evidence: 409, duplicate_operation: 409, invalid_evidence: 422,
  not_confirmable: 409, not_rejectable: 409, not_voidable: 409, not_correctable: 409, shalom_tracking_active: 409, not_ready_for_dispatch: 409,
}
const MESSAGE_STATUS: Record<string, [number, string]> = {
  invalid_amount: [400, 'invalid_amount'], invalid_request: [400, 'invalid_request'], reason_required: [422, 'reason_required'], request_key_conflict: [409, 'request_key_conflict'],
  overpayment_reason_required: [422, 'overpayment_reason_required'], duplicate_evidence: [409, 'duplicate_evidence'], duplicate_operation: [409, 'duplicate_operation'],
}

/** Maps a database exception to an HTTP verdict. 42501 is "not found" (cross-account and unknown ids are indistinguishable) or feature_disabled. */
export function mapPaymentError(error: { code?: string; message?: string }): ServiceResult<never> {
  const message = error.message ?? ''
  if (error.code === '42501') return message.includes('feature_disabled') ? fail(403, 'feature_disabled') : fail(404, 'not_found')
  if (error.code === '22023') {
    for (const [key, [status, code]] of Object.entries(MESSAGE_STATUS)) if (message.includes(key)) return fail(status, code)
    return fail(400, 'invalid_request')
  }
  console.error('[payments] rpc failed:', error.code)
  return fail(500, 'internal_error')
}

function settle<T>(data: unknown, error: { code?: string; message?: string } | null, ok: (o: Record<string, unknown>) => T): ServiceResult<T> {
  if (error) return mapPaymentError(error)
  const out = (data ?? {}) as Record<string, unknown>
  if (out.ok === true) return { ok: true, status: 200, body: ok(out) }
  return fail(REASON_STATUS[String(out.reason ?? '')] ?? 409, String(out.reason ?? 'rejected'), out.pending_balance !== undefined ? { pending_balance: out.pending_balance } : undefined)
}

const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : null)
const keyOf = (v: unknown): string | null => (typeof v === 'string' && REQUEST_KEY_PATTERN.test(v) ? v : null)
const dateOf = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : new Date(t).toISOString()
}

export interface PaymentInput {
  requestKey?: unknown
  amount?: unknown
  kind?: unknown
  method?: unknown
  operationNumber?: unknown
  paidAt?: unknown
  evidenceDocumentId?: unknown
  notes?: unknown
}

function paymentArgs(input: PaymentInput) {
  const amount = normalizePrice(input.amount)
  const evidence = input.evidenceDocumentId === undefined || input.evidenceDocumentId === null || input.evidenceDocumentId === '' ? null : input.evidenceDocumentId
  return { amount, kind: typeof input.kind === 'string' ? input.kind : '', method: text(input.method, 40), operation: text(input.operationNumber, 60), paidAt: dateOf(input.paidAt), evidence, notes: text(input.notes, 500), key: keyOf(input.requestKey) }
}

export async function registerPayment(ctx: Pick<PaymentCaller, 'userId' | 'accountId'>, admin: SupabaseClient, orderId: string, input: PaymentInput, now: Date = new Date()): Promise<ServiceResult<{ payment_id: string; created: boolean; status: string; row_version: number }>> {
  if (!isUuid(orderId)) return fail(400, 'invalid_order_id')
  const a = paymentArgs(input)
  if (!a.key) return fail(400, 'invalid_request_key')
  if (!a.amount) return fail(400, 'invalid_amount')
  if (!['advance', 'balance', 'full', 'other'].includes(a.kind)) return fail(400, 'invalid_kind')
  if (!a.paidAt) return fail(400, 'invalid_paid_at')
  if (a.evidence !== null && !isUuid(a.evidence)) return fail(400, 'invalid_evidence')
  const { data, error } = await admin.rpc('register_order_payment', {
    p_account: ctx.accountId, p_actor: ctx.userId, p_order: orderId, p_request_key: a.key, p_amount: a.amount, p_kind: a.kind, p_method: a.method, p_operation_number: a.operation,
    p_paid_at: a.paidAt, p_evidence: a.evidence, p_notes: a.notes, p_source: 'manual', p_now: now.toISOString(),
  })
  const r = settle(data, error, (o) => ({ payment_id: String(o.payment_id), created: o.created === true, status: String(o.status), row_version: Number(o.row_version) }))
  return r.ok && r.body.created ? { ...r, status: 201 } : r
}

function versionOf(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : null
}

export async function confirmPayment(ctx: Pick<PaymentCaller, 'userId' | 'accountId'>, admin: SupabaseClient, paymentId: unknown, input: { expectedVersion?: unknown; overpaymentReason?: unknown }, now: Date = new Date()) {
  if (!isUuid(paymentId)) return fail(400, 'invalid_payment_id')
  const { data, error } = await admin.rpc('confirm_order_payment', { p_account: ctx.accountId, p_actor: ctx.userId, p_payment: paymentId, p_expected_version: versionOf(input.expectedVersion), p_overpayment_reason: text(input.overpaymentReason, 300), p_now: now.toISOString() })
  return settle(data, error, (o) => ({ changed: o.changed === true, status: String(o.status), financial_status: (o.financial_status as FinancialStatus | undefined) ?? null, paid_confirmed: o.paid_confirmed ?? null, pending_balance: o.pending_balance ?? null, overpayment: o.overpayment === true }))
}

export async function rejectPayment(ctx: Pick<PaymentCaller, 'userId' | 'accountId'>, admin: SupabaseClient, paymentId: unknown, input: { expectedVersion?: unknown; reason?: unknown }, now: Date = new Date()) {
  if (!isUuid(paymentId)) return fail(400, 'invalid_payment_id')
  const { data, error } = await admin.rpc('reject_order_payment', { p_account: ctx.accountId, p_actor: ctx.userId, p_payment: paymentId, p_expected_version: versionOf(input.expectedVersion), p_reason: text(input.reason, 300), p_now: now.toISOString() })
  return settle(data, error, (o) => ({ changed: o.changed === true, status: String(o.status) }))
}

export async function voidPayment(ctx: Pick<PaymentCaller, 'userId' | 'accountId'>, admin: SupabaseClient, paymentId: unknown, input: { expectedVersion?: unknown; reason?: unknown }, now: Date = new Date()) {
  if (!isUuid(paymentId)) return fail(400, 'invalid_payment_id')
  const { data, error } = await admin.rpc('void_order_payment', { p_account: ctx.accountId, p_actor: ctx.userId, p_payment: paymentId, p_expected_version: versionOf(input.expectedVersion), p_reason: text(input.reason, 300), p_now: now.toISOString() })
  return settle(data, error, (o) => ({ changed: o.changed === true, status: String(o.status), financial_status: (o.financial_status as FinancialStatus | undefined) ?? null, paid_confirmed: o.paid_confirmed ?? null, pending_balance: o.pending_balance ?? null }))
}

export async function correctPayment(ctx: Pick<PaymentCaller, 'userId' | 'accountId'>, admin: SupabaseClient, paymentId: unknown, input: PaymentInput & { expectedVersion?: unknown; reason?: unknown; overpaymentReason?: unknown }, now: Date = new Date()) {
  if (!isUuid(paymentId)) return fail(400, 'invalid_payment_id')
  const a = paymentArgs(input)
  if (!a.key) return fail(400, 'invalid_request_key')
  if (!a.amount) return fail(400, 'invalid_amount')
  if (!['advance', 'balance', 'full', 'other'].includes(a.kind)) return fail(400, 'invalid_kind')
  if (!a.paidAt) return fail(400, 'invalid_paid_at')
  if (a.evidence !== null && !isUuid(a.evidence)) return fail(400, 'invalid_evidence')
  const { data, error } = await admin.rpc('correct_order_payment', {
    p_account: ctx.accountId, p_actor: ctx.userId, p_payment: paymentId, p_expected_version: versionOf(input.expectedVersion), p_reason: text(input.reason, 300), p_request_key: a.key, p_amount: a.amount,
    p_kind: a.kind, p_method: a.method, p_operation_number: a.operation, p_paid_at: a.paidAt, p_evidence: a.evidence, p_notes: a.notes, p_overpayment_reason: text(input.overpaymentReason, 300), p_now: now.toISOString(),
  })
  return settle(data, error, (o) => ({ changed: o.changed === true, payment_id: String(o.payment_id), voided_payment_id: (o.voided_payment_id as string | undefined) ?? null, financial_status: (o.financial_status as FinancialStatus | undefined) ?? null, paid_confirmed: o.paid_confirmed ?? null, pending_balance: o.pending_balance ?? null, overpayment: o.overpayment === true }))
}

export async function markDeliveredManual(ctx: Pick<PaymentCaller, 'userId' | 'accountId'>, admin: SupabaseClient, orderId: string, note: unknown, now: Date = new Date()) {
  if (!isUuid(orderId)) return fail(400, 'invalid_order_id')
  const { data, error } = await admin.rpc('mark_order_delivered_manual', { p_account: ctx.accountId, p_actor: ctx.userId, p_order: orderId, p_note: text(note, 300), p_now: now.toISOString() })
  return settle(data, error, (o) => ({ changed: o.changed === true, delivered_at: String(o.delivered_at) }))
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------------------------------------------------------

/** The database says whether THIS person works payments in THIS account (both flags + area + role). */
export async function denyUnlessPayments(ctx: Pick<PaymentCaller, 'supabase' | 'accountId'>): Promise<ServiceResult<never> | null> {
  const { data, error } = await ctx.supabase.rpc('order_payments_access', { p_account_id: ctx.accountId })
  if (error) return fail(500, 'internal_error')
  return data === true ? null : fail(404, 'not_found')
}

export interface PaymentView {
  id: string
  amount: number
  kind: string
  method: string | null
  operation_number: string | null
  paid_at: string
  status: 'recorded' | 'confirmed' | 'rejected' | 'voided'
  evidence_document_id: string | null
  notes: string | null
  supersedes_payment_id: string | null
  overpayment_reason: string | null
  registered_by_name: string
  registered_at: string
  confirmed_by_name: string | null
  confirmed_at: string | null
  rejected_reason: string | null
  voided_reason: string | null
  voided_at: string | null
  row_version: number
}
const PAYMENT_COLUMNS = 'id, amount, kind, method, operation_number, paid_at, status, evidence_document_id, notes, supersedes_payment_id, overpayment_reason, registered_by_name, registered_at, confirmed_by_name, confirmed_at, rejected_reason, voided_reason, voided_at, row_version'

export interface PaymentEventView {
  id: string
  payment_id: string | null
  event_type: string
  actor_name: string
  amount: number | null
  balance_before: number | null
  balance_after: number | null
  financial_status_after: string | null
  reason: string | null
  created_at: string
}

export interface PaymentsPanel {
  tracked: boolean
  total: number
  paid_confirmed: number
  pending_balance: number
  financial_status: FinancialStatus | null
  payments: PaymentView[]
  events: PaymentEventView[]
  delivery: { delivered: boolean; source: 'shalom' | 'manual' | null; delivered_at: string | null; can_mark_manual: boolean }
  finalization: { finalized_at: string; return_state: string } | null
  /** A validated PR-04 voucher NOT linked to a live payment: offered as evidence, with its amount as a HINT only (a person confirms). */
  voucher_candidate: { id: string; filename: string; amount_hint: number | null } | null
  is_supervisor: boolean
}

export async function getPaymentsPanel(ctx: PaymentCaller, admin: SupabaseClient, orderId: string, isSupervisor: boolean): Promise<ServiceResult<PaymentsPanel>> {
  if (!isUuid(orderId)) return fail(400, 'invalid_order_id')
  const denied = await denyUnlessPayments(ctx)
  if (denied) return denied
  const { data: order, error: orderError } = await ctx.supabase.from('order_confirmations').select('id, price').eq('account_id', ctx.accountId).eq('id', orderId).maybeSingle()
  if (orderError) return fail(500, 'internal_error')
  if (!order) return fail(404, 'not_found')
  const total = Number((order as { price: number | string }).price)

  const [financials, payments, events, logistics, shipment, manual, voucher, finalization] = await Promise.all([
    ctx.supabase.from('order_financials').select('paid_confirmed, financial_status').eq('account_id', ctx.accountId).eq('order_id', orderId).maybeSingle(),
    ctx.supabase.from('order_payments').select(PAYMENT_COLUMNS).eq('account_id', ctx.accountId).eq('order_id', orderId).order('created_at', { ascending: true }).limit(100),
    ctx.supabase.from('order_payment_events').select('id, payment_id, event_type, actor_name, amount, balance_before, balance_after, financial_status_after, reason, created_at').eq('account_id', ctx.accountId).eq('order_id', orderId).order('created_at', { ascending: false }).limit(60),
    ctx.supabase.from('order_logistics').select('status').eq('account_id', ctx.accountId).eq('order_id', orderId).maybeSingle(),
    ctx.supabase.from('order_shipments').select('logistic_status, tracking_state, status_changed_at').eq('account_id', ctx.accountId).eq('order_id', orderId).maybeSingle(),
    ctx.supabase.from('order_manual_deliveries').select('delivered_at').eq('account_id', ctx.accountId).eq('order_id', orderId).maybeSingle(),
    ctx.supabase.from('order_documents').select('id, original_filename, reviewed_data').eq('account_id', ctx.accountId).eq('order_id', orderId).eq('kind', 'voucher').eq('status', 'validated').maybeSingle(),
    admin.from('order_finalizations').select('finalized_at, return_state, cleared_at').eq('account_id', ctx.accountId).eq('order_id', orderId).maybeSingle(),
  ])
  if (financials.error || payments.error || events.error || logistics.error || shipment.error || manual.error || voucher.error || finalization.error) {
    console.error('[payments] panel read failed')
    return fail(500, 'internal_error')
  }
  const f = financials.data as { paid_confirmed: number | string; financial_status: FinancialStatus } | null
  const paid = f ? Number(f.paid_confirmed) : 0
  const rows = ((payments.data ?? []) as unknown as PaymentView[]).map((p) => ({ ...p, amount: Number(p.amount) }))
  const sh = shipment.data as { logistic_status: string | null; tracking_state: string; status_changed_at: string | null } | null
  const md = manual.data as { delivered_at: string } | null
  const shalomDelivered = sh?.logistic_status === 'delivered' && sh.tracking_state === 'delivered'
  const status = (logistics.data as { status: string } | null)?.status
  const linked = new Set(rows.filter((p) => p.status === 'recorded' || p.status === 'confirmed').map((p) => p.evidence_document_id).filter(Boolean))
  const v = voucher.data as { id: string; original_filename: string; reviewed_data: Record<string, string> | null } | null
  const fz = finalization.data as { finalized_at: string; return_state: string; cleared_at: string | null } | null
  return {
    ok: true,
    status: 200,
    body: {
      tracked: f !== null,
      total,
      paid_confirmed: paid,
      pending_balance: Math.max(Math.round((total - paid) * 100) / 100, 0),
      financial_status: f?.financial_status ?? null,
      payments: rows,
      events: ((events.data ?? []) as unknown as PaymentEventView[]).map((e) => ({ ...e, amount: e.amount === null ? null : Number(e.amount), balance_before: e.balance_before === null ? null : Number(e.balance_before), balance_after: e.balance_after === null ? null : Number(e.balance_after) })),
      delivery: {
        delivered: shalomDelivered || md !== null,
        source: shalomDelivered ? 'shalom' : md ? 'manual' : null,
        delivered_at: shalomDelivered ? sh?.status_changed_at ?? null : md?.delivered_at ?? null,
        can_mark_manual: f !== null && !shalomDelivered && md === null && status === 'ready_for_dispatch' && !(sh && ['active', 'requires_attention', 'delivered'].includes(sh.tracking_state)),
      },
      finalization: fz && fz.cleared_at === null ? { finalized_at: fz.finalized_at, return_state: fz.return_state } : null,
      voucher_candidate: v && !linked.has(v.id) ? { id: v.id, filename: v.original_filename, amount_hint: normalizeAmount(v.reviewed_data?.amount ?? null) } : null,
      is_supervisor: isSupervisor,
    },
  }
}

export const MAX_SUMMARY_IDS = 50

export interface PaymentSummary {
  financial_status: FinancialStatus
  total: number
  paid_confirmed: number
  pending_balance: number
}

/** One light row per TRACKED order for the list chip (orders without a financial row are simply absent: not tracked). */
export async function getPaymentsSummary(ctx: PaymentCaller, ids: string[]): Promise<ServiceResult<{ summaries: Record<string, PaymentSummary> }>> {
  const unique = [...new Set(ids)]
  if (unique.length === 0 || unique.length > MAX_SUMMARY_IDS || !unique.every(isUuid)) return fail(400, 'invalid_ids')
  const denied = await denyUnlessPayments(ctx)
  if (denied) return denied
  const [fin, orders] = await Promise.all([
    ctx.supabase.from('order_financials').select('order_id, paid_confirmed, financial_status').eq('account_id', ctx.accountId).in('order_id', unique),
    ctx.supabase.from('order_confirmations').select('id, price').eq('account_id', ctx.accountId).in('id', unique),
  ])
  if (fin.error || orders.error) return fail(500, 'internal_error')
  const price = new Map(((orders.data ?? []) as Array<{ id: string; price: number | string }>).map((o) => [o.id, Number(o.price)]))
  const summaries: Record<string, PaymentSummary> = {}
  for (const r of (fin.data ?? []) as Array<{ order_id: string; paid_confirmed: number | string; financial_status: FinancialStatus }>) {
    const total = price.get(r.order_id) ?? 0
    const paid = Number(r.paid_confirmed)
    summaries[r.order_id] = { financial_status: r.financial_status, total, paid_confirmed: paid, pending_balance: Math.max(Math.round((total - paid) * 100) / 100, 0) }
  }
  return { ok: true, status: 200, body: { summaries } }
}

export const MAX_BALANCE_IDS = 500

/** The ids of the TRACKED orders that still have a balance (unpaid / partially paid): the "Con saldo" filter of Pedidos Confirmados. */
export async function listOrdersWithBalance(ctx: PaymentCaller): Promise<ServiceResult<{ order_ids: string[] }>> {
  const denied = await denyUnlessPayments(ctx)
  if (denied) return denied
  const { data, error } = await ctx.supabase.from('order_financials').select('order_id').eq('account_id', ctx.accountId).in('financial_status', ['unpaid', 'partially_paid']).order('updated_at', { ascending: false }).limit(MAX_BALANCE_IDS)
  if (error) return fail(500, 'internal_error')
  return { ok: true, status: 200, body: { order_ids: ((data ?? []) as Array<{ order_id: string }>).map((r) => r.order_id) } }
}

export interface ConversationFinancial {
  order_id: string
  product: string
  confirmed_at: string
  financial_status: FinancialStatus
  total: number
  paid_confirmed: number
  pending_balance: number
}

/** READ-ONLY Total / Pagado / Saldo / Estado of the TRACKED orders of ONE conversation, for the chat panel. Comercial included (for a chat it can work); no payments, evidence or events. */
export async function getConversationFinancials(ctx: PaymentCaller, conversationId: string): Promise<ServiceResult<{ orders: ConversationFinancial[] }>> {
  if (!isUuid(conversationId)) return fail(400, 'invalid_conversation_id')
  const { data: allowed, error: accessError } = await ctx.supabase.rpc('order_payments_summary_access', { p_account_id: ctx.accountId, p_conversation_id: conversationId })
  if (accessError) return fail(500, 'internal_error')
  if (allowed !== true) return fail(404, 'not_found')
  const { data: orders, error } = await ctx.supabase.from('order_confirmations').select('id, product, price, confirmed_at').eq('account_id', ctx.accountId).eq('conversation_id', conversationId).order('confirmed_at', { ascending: true }).limit(50)
  if (error) return fail(500, 'internal_error')
  const list = (orders ?? []) as Array<{ id: string; product: string; price: number | string; confirmed_at: string }>
  if (list.length === 0) return { ok: true, status: 200, body: { orders: [] } }
  const { data: fin, error: finError } = await ctx.supabase.from('order_financials').select('order_id, paid_confirmed, financial_status').eq('account_id', ctx.accountId).in('order_id', list.map((o) => o.id))
  if (finError) return fail(500, 'internal_error')
  const byOrder = new Map(((fin ?? []) as Array<{ order_id: string; paid_confirmed: number | string; financial_status: FinancialStatus }>).map((r) => [r.order_id, r]))
  const out: ConversationFinancial[] = []
  for (const o of list) {
    const r = byOrder.get(o.id)
    if (!r) continue // not tracked (historical)
    const total = Number(o.price)
    const paid = Number(r.paid_confirmed)
    out.push({ order_id: o.id, product: o.product, confirmed_at: o.confirmed_at, financial_status: r.financial_status, total, paid_confirmed: paid, pending_balance: Math.max(Math.round((total - paid) * 100) / 100, 0) })
  }
  return { ok: true, status: 200, body: { orders: out } }
}
