import type { SupabaseClient } from '@supabase/supabase-js'

import { denyUnlessLogisticsInDatabase, type LogisticsCaller } from '@/lib/orders/logistics/access'
import { CONFIRMED_ORDER_COLUMNS, sanitizeSearch } from '@/lib/orders/confirmed-orders'
import { fail, mapRpcError, readDocumentView, type DocumentView, type ServiceResult } from '@/lib/orders/logistics/documents'
import { isUuid } from '@/lib/orders/logistics/files'
import { decideMatch, extractSignals, type MatchCandidateHint, type MatchCandidateOrder, type PendingReason, type StrongSignal } from '@/lib/orders/logistics/matching'
import { runDocumentOcr, type RunOcrOptions } from '@/lib/orders/logistics/ocr/run'
import type { OcrErrorCode, VoucherOcrProvider } from '@/lib/orders/logistics/ocr/types'

// BULK vouchers: N documents uploaded without an order -> OCR each one -> look for a candidate order -> associated (single safe candidate) or
// PENDING ASSOCIATION (a person chooses). Everything is persisted per document (association, OCR status), so closing the screen loses nothing and
// a later request can continue with what is still unprocessed. The matching RULE is in matching.ts; this file only fetches candidates and applies
// the decision. Candidates are always the orders of the caller's account that are still `pending_voucher`; DNI / phone of an order are never returned.

export interface CandidateSummary {
  order_id: string
  customer_name: string
  product_summary: string
  total: number
  destination: string
  confirmed_at: string
  /** Strong signals this order shares with the voucher (empty for a manual search result). */
  signals: StrongSignal[]
}

export type ProcessOutcome =
  | { outcome: 'associated'; association: 'auto'; order_id: string; signals: StrongSignal[] }
  | { outcome: 'already_associated'; association: string; order_id: string }
  | { outcome: 'pending'; reason: PendingReason | 'ocr_failed' | 'association_refused'; ocr_error_code: OcrErrorCode | null; candidates: CandidateSummary[] }

interface OrderRow {
  id: string
  dni: string | null
  phone: string
  customer_name: string
  product: string
  quantity: number
  price: number | string
  destination: string
  confirmed_at: string
}

const SUMMARY_COLUMNS = 'id, customer_name, product, price, destination, confirmed_at'
const toSummary = (row: Record<string, unknown>, signals: StrongSignal[]): CandidateSummary => ({
  order_id: String(row.id),
  customer_name: String(row.customer_name),
  product_summary: String(row.product),
  total: Number(row.price),
  destination: String(row.destination),
  confirmed_at: String(row.confirmed_at),
  signals,
})

/** Ids among `ids` whose logistic row exists and is already past `pending_voucher` (they are not candidates any more). */
async function alreadyAdvanced(admin: SupabaseClient, accountId: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  const { data } = await admin.from('order_logistics').select('order_id, status').eq('account_id', accountId).in('order_id', ids)
  return new Set(((data ?? []) as Array<{ order_id: string; status: string }>).filter((r) => r.status !== 'pending_voucher').map((r) => r.order_id))
}

async function findCandidates(admin: SupabaseClient, accountId: string, usable: Partial<Record<StrongSignal, string>>): Promise<MatchCandidateOrder[]> {
  const filters: string[] = []
  if (usable.dni) filters.push(`dni.eq.${usable.dni}`)
  if (usable.phone) filters.push(`phone.eq.${usable.phone}`)
  if (filters.length === 0) return []
  const { data, error } = await admin
    .from('order_confirmations')
    .select('id, dni, phone')
    .eq('account_id', accountId)
    .or(filters.join(','))
    .order('confirmed_at', { ascending: false })
    .limit(50)
  if (error) throw new Error('candidate_lookup_failed')
  const rows = (data ?? []) as Array<{ id: string; dni: string | null; phone: string }>
  const advanced = await alreadyAdvanced(admin, accountId, rows.map((r) => r.id))
  return rows.filter((r) => !advanced.has(r.id))
}

async function summarize(admin: SupabaseClient, accountId: string, hints: MatchCandidateHint[]): Promise<CandidateSummary[]> {
  const top = hints.slice(0, 5)
  if (top.length === 0) return []
  const { data } = await admin.from('order_confirmations').select(SUMMARY_COLUMNS).eq('account_id', accountId).in('id', top.map((h) => h.orderId))
  const byId = new Map(((data ?? []) as Array<Record<string, unknown>>).map((r) => [String(r.id), r]))
  return top.flatMap((h) => {
    const row = byId.get(h.orderId)
    return row ? [toSummary(row, h.signals)] : []
  })
}

export interface ProcessDeps {
  provider: VoucherOcrProvider
  ocr?: RunOcrOptions
}

export async function processBulkDocument(
  ctx: Pick<LogisticsCaller, 'userId' | 'accountId'>,
  admin: SupabaseClient,
  deps: ProcessDeps,
  documentId: string,
): Promise<ServiceResult<ProcessOutcome>> {
  if (!isUuid(documentId)) return fail(400, 'invalid_document_id')
  const load = async () =>
    admin.from('order_documents').select('id, kind, status, association, order_id, ocr_status, ocr_result').eq('account_id', ctx.accountId).eq('id', documentId).maybeSingle()

  const first = await load()
  if (first.error) return fail(500, 'internal_error')
  const doc = first.data as { kind: string; status: string; association: string; order_id: string | null; ocr_status: string; ocr_result: { fields?: Record<string, { value?: string | null; confidence?: number }> } | null } | null
  if (!doc) return fail(404, 'not_found')
  if (doc.kind !== 'voucher' || doc.status !== 'pending_review') return fail(409, 'frozen')
  if (doc.association !== 'pending' && doc.order_id) return { ok: true, status: 200, body: { outcome: 'already_associated', association: doc.association, order_id: doc.order_id } }

  // OCR only when there is no good result yet (a retry of "process" never spends the provider twice).
  let fields = doc.ocr_result?.fields ?? {}
  if (doc.ocr_status !== 'done') {
    const ocr = await runDocumentOcr(ctx, admin, deps.provider, documentId, deps.ocr)
    if (!ocr.ok) return ocr
    if (ocr.body.ocr_status !== 'done') {
      return { ok: true, status: 200, body: { outcome: 'pending', reason: 'ocr_failed', ocr_error_code: ocr.body.error_code, candidates: [] } }
    }
    const reloaded = await load()
    fields = (reloaded.data as { ocr_result: { fields?: typeof fields } | null } | null)?.ocr_result?.fields ?? {}
  }

  const { usable } = extractSignals(fields)
  let candidates: MatchCandidateOrder[]
  try {
    candidates = await findCandidates(admin, ctx.accountId, usable)
  } catch {
    return fail(500, 'internal_error')
  }
  const decision = decideMatch(fields, candidates)

  if (decision.kind === 'pending') {
    return { ok: true, status: 200, body: { outcome: 'pending', reason: decision.reason, ocr_error_code: null, candidates: await summarize(admin, ctx.accountId, decision.candidates) } }
  }

  const { data: assoc, error: assocError } = await admin.rpc('associate_order_document', {
    p_account: ctx.accountId,
    p_actor: ctx.userId,
    p_doc: documentId,
    p_order: decision.orderId,
    p_method: 'auto',
    p_signals: decision.signals,
  })
  if (assocError) return mapRpcError(assocError)
  const out = (assoc ?? {}) as { ok?: boolean }
  if (out.ok !== true) {
    // e.g. the order moved on in the meantime: never force it, hand it to a person
    return { ok: true, status: 200, body: { outcome: 'pending', reason: 'association_refused', ocr_error_code: null, candidates: await summarize(admin, ctx.accountId, [{ orderId: decision.orderId, signals: decision.signals }]) } }
  }
  return { ok: true, status: 200, body: { outcome: 'associated', association: 'auto', order_id: decision.orderId, signals: decision.signals } }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Manual association (a person decides)
// ---------------------------------------------------------------------------------------------------------------------------------------------

export async function associateDocument(
  ctx: Pick<LogisticsCaller, 'userId' | 'accountId'>,
  admin: SupabaseClient,
  documentId: string,
  orderId: unknown,
): Promise<ServiceResult<{ document: DocumentView; changed: boolean; order_id: string }>> {
  if (!isUuid(documentId)) return fail(400, 'invalid_document_id')
  if (!isUuid(orderId)) return fail(400, 'invalid_order_id')
  const { data, error } = await admin.rpc('associate_order_document', {
    p_account: ctx.accountId,
    p_actor: ctx.userId,
    p_doc: documentId,
    p_order: orderId,
    p_method: 'manual',
    p_signals: [],
  })
  if (error) return mapRpcError(error)
  const out = (data ?? {}) as { ok?: boolean; changed?: boolean; reason?: string }
  if (out.ok !== true) return fail(409, out.reason ?? 'rejected')
  const document = await readDocumentView(admin, ctx.accountId, documentId)
  if (!document) return fail(500, 'internal_error')
  return { ok: true, status: 200, body: { document, changed: out.changed !== false, order_id: orderId } }
}

/**
 * Manual search among the orders still waiting for a voucher (by customer or product), for the person who has to choose when the rule leaves a
 * voucher pending. Read with the CALLER's client (RLS) after the database-level logistics check; no DNI / phone is selected.
 */
export async function searchPendingOrders(ctx: LogisticsCaller, rawQuery: string | null): Promise<ServiceResult<{ orders: CandidateSummary[] }>> {
  const denied = await denyUnlessLogisticsInDatabase(ctx)
  if (denied) return fail(denied.status, denied.error)
  const q = sanitizeSearch(rawQuery)

  let query = ctx.supabase.from('order_confirmations').select(CONFIRMED_ORDER_COLUMNS).eq('account_id', ctx.accountId)
  if (q) query = query.or(`customer_name.ilike.*${q}*,product.ilike.*${q}*`)
  const { data, error } = await query.order('confirmed_at', { ascending: false }).limit(60)
  if (error) {
    console.error('[logistics] pending order search failed:', error.code)
    return fail(500, 'internal_error')
  }
  const rows = (data ?? []) as unknown as OrderRow[]
  const { data: advanced } = await ctx.supabase.from('order_logistics').select('order_id, status').eq('account_id', ctx.accountId).in('order_id', rows.map((r) => r.id))
  const gone = new Set(((advanced ?? []) as Array<{ order_id: string; status: string }>).filter((r) => r.status !== 'pending_voucher').map((r) => r.order_id))
  const orders = rows.filter((r) => !gone.has(r.id)).slice(0, 20).map((r) => toSummary(r as unknown as Record<string, unknown>, []))
  return { ok: true, status: 200, body: { orders } }
}
