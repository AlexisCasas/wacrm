import { denyUnlessLogisticsInDatabase, type LogisticsCaller } from '@/lib/orders/logistics/access'
import { DOCUMENT_PUBLIC_COLUMNS, type LogisticsStatus } from '@/lib/orders/logistics/constants'
import { fail, type DocumentView, type ServiceResult } from '@/lib/orders/logistics/documents'
import { isUuid } from '@/lib/orders/logistics/files'
import { CONFIRMED_ITEM_COLUMNS, CONFIRMED_ORDER_COLUMNS, toOrder } from '@/lib/orders/confirmed-orders'
import type { ConfirmedOrder } from '@/lib/orders/confirmed-orders-types'

// Read model of the logistics panel of ONE order (PR-04). Everything is read with the CALLER's client, so RLS (flag + area + role + account) applies
// on top of the explicit account filter. The order comes from PR-02's own read model (DNI and phone are never part of it). NO ROW in order_logistics
// means `pending_voucher` (no backfill exists or is needed).

export interface LogisticsState {
  status: LogisticsStatus
  version: number
  voucher_document_id: string | null
  validated_at: string | null
  evidence_document_id: string | null
  packaging_started_at: string | null
  packaging_completed_at: string | null
}

export interface OrderEventView {
  id: string
  event_type: string
  outcome: string
  attempt: number | null
  error_code: string | null
  provider: string | null
  actor_name: string
  document_id: string | null
  detail: Record<string, unknown>
  created_at: string
}

export interface DispatchView {
  id: string
  status: 'claimed' | 'sending' | 'sent' | 'failed' | 'uncertain'
  attempt: number
  error_code: string | null
  resolution: string | null
  claimed_at: string
  finished_at: string | null
}

export interface CustomerTemplateDispatchView {
  id: string
  kind: 'summary' | 'voucher'
  status: 'claimed' | 'sending' | 'sent' | 'failed' | 'uncertain'
  attempt: number
  error_code: string | null
  resolution: string | null
  voucher_document_id: string
  claimed_at: string
  sending_at: string | null
  created_at: string
}

export interface OrderPanel {
  order: ConfirmedOrder
  logistics: LogisticsState
  vouchers: DocumentView[]
  /** The active packaging evidence (private snapshot of a chat media), or null. */
  evidence: DocumentView | null
  /** The operational template sends of this order (technical state: only `uncertain` needs a person). */
  dispatches: DispatchView[]
  /** Manual customer communications. These never move the logistics state. */
  customer_dispatches: CustomerTemplateDispatchView[]
  events: OrderEventView[]
}

const EMPTY_STATE: LogisticsState = {
  status: 'pending_voucher',
  version: 0,
  voucher_document_id: null,
  validated_at: null,
  evidence_document_id: null,
  packaging_started_at: null,
  packaging_completed_at: null,
}

const EVENT_COLUMNS = 'id, event_type, outcome, attempt, error_code, provider, actor_name, document_id, detail, created_at'
const EVENT_LIMIT = 100

export async function getOrderPanel(ctx: LogisticsCaller, orderId: string): Promise<ServiceResult<OrderPanel>> {
  if (!isUuid(orderId)) return fail(400, 'invalid_order_id')

  // Second wall (the route already checked the same thing): commercial can read orders through PR-02's own policy, but the logistics panel is not
  // theirs, so it answers exactly like a non-existent order.
  const denied = await denyUnlessLogisticsInDatabase(ctx)
  if (denied) return fail(denied.status, denied.error)

  const { data: orderRow, error: orderError } = await ctx.supabase.from('order_confirmations').select(CONFIRMED_ORDER_COLUMNS).eq('account_id', ctx.accountId).eq('id', orderId).maybeSingle()
  if (orderError) {
    console.error('[logistics] panel order failed:', orderError.code)
    return fail(500, 'internal_error')
  }
  if (!orderRow) return fail(404, 'not_found')

  const [items, logistics, vouchers, evidence, dispatches, customerDispatches, events] = await Promise.all([
    ctx.supabase.from('order_confirmation_items').select(CONFIRMED_ITEM_COLUMNS).eq('account_id', ctx.accountId).eq('order_id', orderId).order('line_number', { ascending: true }),
    ctx.supabase
      .from('order_logistics')
      .select('status, version, voucher_document_id, validated_at, evidence_document_id, packaging_started_at, packaging_completed_at')
      .eq('account_id', ctx.accountId)
      .eq('order_id', orderId)
      .maybeSingle(),
    ctx.supabase.from('order_documents').select(DOCUMENT_PUBLIC_COLUMNS).eq('account_id', ctx.accountId).eq('order_id', orderId).eq('kind', 'voucher').order('created_at', { ascending: false }).order('id', { ascending: false }).limit(50),
    ctx.supabase.from('order_documents').select(DOCUMENT_PUBLIC_COLUMNS).eq('account_id', ctx.accountId).eq('order_id', orderId).eq('kind', 'evidence').eq('status', 'active').maybeSingle(),
    ctx.supabase.from('order_template_dispatches').select('id, status, attempt, error_code, resolution, claimed_at, finished_at').eq('account_id', ctx.accountId).eq('order_id', orderId).order('created_at', { ascending: false }).limit(20),
    ctx.supabase.from('order_customer_template_dispatches').select('id, kind, status, attempt, error_code, resolution, voucher_document_id, claimed_at, sending_at, created_at').eq('account_id', ctx.accountId).eq('order_id', orderId).order('created_at', { ascending: false }).limit(20),
    ctx.supabase.from('order_logistics_events').select(EVENT_COLUMNS).eq('account_id', ctx.accountId).eq('order_id', orderId).order('created_at', { ascending: false }).limit(EVENT_LIMIT),
  ])
  const failed = [items, logistics, vouchers, evidence, dispatches, customerDispatches, events].find((r) => r.error)
  if (failed?.error) {
    console.error('[logistics] panel read failed:', failed.error.code)
    return fail(500, 'internal_error')
  }

  return {
    ok: true,
    status: 200,
    body: {
      order: toOrder(orderRow as unknown as Parameters<typeof toOrder>[0], (items.data ?? []) as unknown as Parameters<typeof toOrder>[1]),
      logistics: (logistics.data as LogisticsState | null) ?? EMPTY_STATE,
      vouchers: (vouchers.data ?? []) as unknown as DocumentView[],
      evidence: (evidence.data as unknown as DocumentView | null) ?? null,
      dispatches: (dispatches.data ?? []) as unknown as DispatchView[],
      customer_dispatches: (customerDispatches.data ?? []) as unknown as CustomerTemplateDispatchView[],
      events: (events.data ?? []) as unknown as OrderEventView[],
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Compact indicator for the list of confirmed orders
// ---------------------------------------------------------------------------------------------------------------------------------------------

export interface OrderLogisticsSummary {
  status: LogisticsStatus
  /** `validated` once the order has a validated voucher; `pending_review` while there is an uploaded voucher waiting for a person; otherwise `none`. */
  voucher: 'none' | 'pending_review' | 'validated'
}

export const MAX_SUMMARY_IDS = 50

/**
 * The logistic status + voucher indicator of up to 50 orders, in TWO queries, read with the caller's client (RLS). Orders without a row are
 * `pending_voucher` (no backfill). Unknown ids / other accounts' orders simply get the default: nothing is revealed about them.
 */
export async function getLogisticsSummary(ctx: LogisticsCaller, rawIds: readonly string[]): Promise<ServiceResult<{ summary: Record<string, OrderLogisticsSummary> }>> {
  const ids = [...new Set(rawIds)]
  if (ids.length === 0 || ids.length > MAX_SUMMARY_IDS || ids.some((id) => !isUuid(id))) return fail(400, 'invalid_ids')
  const denied = await denyUnlessLogisticsInDatabase(ctx)
  if (denied) return fail(denied.status, denied.error)

  const [rows, pending] = await Promise.all([
    ctx.supabase.from('order_logistics').select('order_id, status').eq('account_id', ctx.accountId).in('order_id', ids),
    ctx.supabase.from('order_documents').select('order_id').eq('account_id', ctx.accountId).eq('kind', 'voucher').eq('status', 'pending_review').in('order_id', ids),
  ])
  if (rows.error || pending.error) {
    console.error('[logistics] summary failed:', rows.error?.code ?? pending.error?.code)
    return fail(500, 'internal_error')
  }
  const status = new Map(((rows.data ?? []) as Array<{ order_id: string; status: LogisticsStatus }>).map((r) => [r.order_id, r.status]))
  const waiting = new Set(((pending.data ?? []) as Array<{ order_id: string }>).map((r) => r.order_id))
  const summary: Record<string, OrderLogisticsSummary> = {}
  for (const id of ids) {
    const s = status.get(id) ?? 'pending_voucher'
    summary[id] = { status: s, voucher: s !== 'pending_voucher' ? 'validated' : waiting.has(id) ? 'pending_review' : 'none' }
  }
  return { ok: true, status: 200, body: { summary } }
}
