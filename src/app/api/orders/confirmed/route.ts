import { NextResponse } from 'next/server'

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import {
  CONFIRMED_ITEM_COLUMNS,
  CONFIRMED_ORDER_COLUMNS,
  DELIVERY_STATUSES,
  decodeCursor,
  encodeCursor,
  idPrefixRange,
  parseLimit,
  resolveConfirmedOrdersAccess,
  sanitizeSearch,
  toOrder,
} from '@/lib/orders/confirmed-orders'

// GET /api/orders/confirmed   "Pedidos confirmados" workspace (PR-02). READ-ONLY: it never writes, never calls InkaClick/WhatsApp and never changes
// a delivery status.
//
// Authority (all server side; nothing the browser sends can widen it):
//   1. a valid session (401 otherwise);
//   2. the account is the session's account (an `account_id` query/body value is never read);
//   3. order_integration_settings.logistics_mvp_enabled = TRUE for that account (403 feature_disabled otherwise);
//   4. the caller's operational_role: supervisor / logistics -> every confirmed order of the account; commercial (it hands the order over and
//      has no access to this stage) and no area -> 403. account_role alone grants nothing (an owner/admin that is also supervisor acts as supervisor).
// Orders are read with the CALLER's client, so the row-level policy (agent+ members of the account) applies on top of the explicit filters.
// The free-text search `q` matches customer / product / seller, and also the order id (a full UUID or a prefix of at least 8 hex characters).
// Keyset pagination over (confirmed_at DESC, id DESC); items are fetched in a second query and grouped, so a multi-product order is one row.
// DNI and phone are never selected.
export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount()

    const access = await resolveConfirmedOrdersAccess(ctx)
    if (access.kind === 'disabled') return NextResponse.json({ error: 'feature_disabled' }, { status: 403 })
    if (access.kind === 'forbidden') return NextResponse.json({ error: 'operational_role_required' }, { status: 403 })

    const params = new URL(request.url).searchParams

    const limit = parseLimit(params.get('limit'))
    if (limit === null) return NextResponse.json({ error: 'invalid limit' }, { status: 400 })

    const status = params.get('status')
    if (status !== null && status !== '' && !(DELIVERY_STATUSES as readonly string[]).includes(status)) {
      return NextResponse.json({ error: 'invalid status' }, { status: 400 })
    }

    const financial = params.get('financial')
    if (financial !== null && financial !== '' && !['balance', 'unpaid', 'partially_paid', 'paid'].includes(financial)) {
      return NextResponse.json({ error: 'invalid financial status' }, { status: 400 })
    }

    const rawCursor = params.get('cursor')
    const cursor = rawCursor ? decodeCursor(rawCursor) : null
    if (rawCursor && !cursor) return NextResponse.json({ error: 'invalid cursor' }, { status: 400 })

    const q = sanitizeSearch(params.get('q'))

    const select = financial
      ? `${CONFIRMED_ORDER_COLUMNS},order_financials!inner(financial_status)`
      : CONFIRMED_ORDER_COLUMNS
    let query = ctx.supabase.from('order_confirmations').select(select).eq('account_id', ctx.accountId)
    if (status) query = query.eq('delivery_status', status)
    if (financial === 'balance') query = query.in('order_financials.financial_status', ['unpaid', 'partially_paid'])
    else if (financial) query = query.eq('order_financials.financial_status', financial)
    if (q) {
      const idRange = idPrefixRange(q)
      const idFilter = idRange ? `,and(id.gte.${idRange.lo},id.lte.${idRange.hi})` : ''
      query = query.or(`customer_name.ilike.*${q}*,product.ilike.*${q}*,seller_name.ilike.*${q}*${idFilter}`)
    }
    if (cursor) query = query.or(`confirmed_at.lt.${cursor.t},and(confirmed_at.eq.${cursor.t},id.lt.${cursor.id})`)

    const { data, error } = await query
      .order('confirmed_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1)
    if (error) {
      console.error('[orders] confirmed list failed:', error.code)
      return NextResponse.json({ error: 'Could not load the orders' }, { status: 500 })
    }

    const rows = (data ?? []) as unknown as Array<Parameters<typeof toOrder>[0] & { id: string }>
    const page = rows.slice(0, limit)
    const hasMore = rows.length > limit

    const itemsByOrder = new Map<string, Array<Parameters<typeof toOrder>[1][number]>>()
    if (page.length > 0) {
      const { data: items, error: itemsError } = await ctx.supabase
        .from('order_confirmation_items')
        .select(CONFIRMED_ITEM_COLUMNS)
        .eq('account_id', ctx.accountId)
        .in('order_id', page.map((r) => r.id))
        .order('order_id', { ascending: true })
        .order('line_number', { ascending: true })
      if (itemsError) {
        console.error('[orders] confirmed items failed:', itemsError.code)
        return NextResponse.json({ error: 'Could not load the orders' }, { status: 500 })
      }
      for (const item of (items ?? []) as unknown as Array<Parameters<typeof toOrder>[1][number]>) {
        const list = itemsByOrder.get(item.order_id) ?? []
        list.push(item)
        itemsByOrder.set(item.order_id, list)
      }
    }

    const last = page[page.length - 1]
    return NextResponse.json({
      enabled: true,
      orders: page.map((row) => toOrder(row, itemsByOrder.get(row.id) ?? [])),
      next_cursor: hasMore && last ? encodeCursor({ t: last.confirmed_at, id: last.id }) : null,
    })
  } catch (error) {
    return toErrorResponse(error)
  }
}
