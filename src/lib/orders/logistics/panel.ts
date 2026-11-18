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

export interface OrderPanel {
  order: ConfirmedOrder
  logistics: LogisticsState
  vouchers: DocumentView[]
  /** The active packaging evidence (private snapshot of a chat media), or null. */
  evidence: DocumentView | null
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

  const [items, logistics, vouchers, evidence, events] = await Promise.all([
    ctx.supabase.from('order_confirmation_items').select(CONFIRMED_ITEM_COLUMNS).eq('account_id', ctx.accountId).eq('order_id', orderId).order('line_number', { ascending: true }),
    ctx.supabase
      .from('order_logistics')
      .select('status, version, voucher_document_id, validated_at, evidence_document_id, packaging_started_at, packaging_completed_at')
      .eq('account_id', ctx.accountId)
      .eq('order_id', orderId)
      .maybeSingle(),
    ctx.supabase.from('order_documents').select(DOCUMENT_PUBLIC_COLUMNS).eq('account_id', ctx.accountId).eq('order_id', orderId).eq('kind', 'voucher').order('created_at', { ascending: false }).order('id', { ascending: false }).limit(50),
    ctx.supabase.from('order_documents').select(DOCUMENT_PUBLIC_COLUMNS).eq('account_id', ctx.accountId).eq('order_id', orderId).eq('kind', 'evidence').eq('status', 'active').maybeSingle(),
    ctx.supabase.from('order_logistics_events').select(EVENT_COLUMNS).eq('account_id', ctx.accountId).eq('order_id', orderId).order('created_at', { ascending: false }).limit(EVENT_LIMIT),
  ])
  const failed = [items, logistics, vouchers, evidence, events].find((r) => r.error)
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
      events: (events.data ?? []) as unknown as OrderEventView[],
    },
  }
}
