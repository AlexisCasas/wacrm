import type { SupabaseClient } from '@supabase/supabase-js'

import type { OperationalRole } from '@/lib/auth/operational-role'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { DELIVERY_STATUSES, type ConfirmedOrder, type ConfirmedOrderLine } from '@/lib/orders/confirmed-orders-types'

export { DELIVERY_STATUSES }
export type { ConfirmedOrder, ConfirmedOrderLine }

// Read model of the "Pedidos confirmados" workspace (PR-02 of Comercial + Logistica). READ-ONLY: nothing here writes an order, changes a delivery
// status, calls InkaClick or touches the conversation. The source of truth stays public.order_confirmations (+ order_confirmation_items).

/**
 * The ONLY order columns the endpoint selects. No dni, phone, order_description, request_key, error codes or internal ids of other systems:
 * DNI and phone are stored but deliberately NOT exposed in PR-02.
 */
export const CONFIRMED_ORDER_COLUMNS =
  'id, confirmed_at, customer_name, product, quantity, price, seller_name, order_status, delivery_status, agency, destination, department, conversation_id' as const

export const CONFIRMED_ITEM_COLUMNS = 'order_id, line_number, product_name, quantity, unit_price, subtotal' as const

export const DEFAULT_PAGE_SIZE = 25
export const MAX_PAGE_SIZE = 50
export const MAX_SEARCH_LENGTH = 80

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Access: logistics_mvp_enabled + operational_role (account_role alone grants nothing; owner/admin who are also supervisor act as supervisor).
// ---------------------------------------------------------------------------------------------------------------------------------------------

export type ConfirmedOrdersAccess =
  | { kind: 'disabled' }
  | { kind: 'forbidden' }
  | { kind: 'ok'; operationalRole: ConfirmedOrdersRole }

/** Operational areas that work the post-confirmation (logistics) stage. Commercial hands the order over and has NO access to this section. */
export type ConfirmedOrdersRole = Extract<OperationalRole, 'supervisor' | 'logistics'>

/** supervisor and logistics see every confirmed order of the account; commercial, any unknown value and "no area" have no access. */
export function canViewConfirmedOrders(role: unknown): role is ConfirmedOrdersRole {
  return role === 'supervisor' || role === 'logistics'
}

/**
 * Decides what the CALLER may see. The account comes from the session context (never from the browser). The feature flag is read with the service
 * role (the settings table is admin-only for readers), scoped to that account; the operational role is the caller's own profile row, read with the
 * caller's client. Fail-closed: a missing flag row or a missing/unknown role means no access; a failing lookup throws (the route answers 500).
 */
export async function resolveConfirmedOrdersAccess(ctx: { supabase: SupabaseClient; userId: string; accountId: string }): Promise<ConfirmedOrdersAccess> {
  const { data: settings, error: settingsError } = await supabaseAdmin()
    .from('order_integration_settings')
    .select('logistics_mvp_enabled')
    .eq('account_id', ctx.accountId)
    .maybeSingle()
  if (settingsError) throw new Error('settings_lookup_failed')
  if (settings?.logistics_mvp_enabled !== true) return { kind: 'disabled' }

  const { data: profile, error: profileError } = await ctx.supabase
    .from('profiles')
    .select('operational_role')
    .eq('user_id', ctx.userId)
    .eq('account_id', ctx.accountId)
    .maybeSingle()
  if (profileError) throw new Error('profile_lookup_failed')

  const role = profile?.operational_role
  if (!canViewConfirmedOrders(role)) return { kind: 'forbidden' }
  return { kind: 'ok', operationalRole: role }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Query parameters
// ---------------------------------------------------------------------------------------------------------------------------------------------

/** Opaque keyset cursor over (confirmed_at DESC, id DESC). `t` is the RAW timestamp string the database returned (microsecond precision kept). */
export interface Cursor {
  t: string
  id: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

/** `null` when the value is not a well-formed cursor (the route answers 400). The parts are validated, so they can never carry filter syntax. */
export function decodeCursor(value: string): Cursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { t?: unknown; id?: unknown }
    if (typeof parsed.t !== 'string' || typeof parsed.id !== 'string') return null
    if (!TIMESTAMP.test(parsed.t) || !UUID.test(parsed.id)) return null
    return { t: parsed.t, id: parsed.id }
  } catch {
    return null
  }
}

export function parseLimit(raw: string | null): number | null {
  if (raw === null || raw === '') return DEFAULT_PAGE_SIZE
  if (!/^\d{1,3}$/.test(raw)) return null
  const n = Number(raw)
  return n >= 1 && n <= MAX_PAGE_SIZE ? n : null
}

/**
 * Free text for the customer / product / seller search. Everything that has a meaning inside a PostgREST `or=(…)` filter or an ILIKE pattern
 * (commas, parentheses, quotes, backslashes, `%`, `*`, `_`) is dropped, so the text can only ever be literal letters, digits and spaces.
 */
export function sanitizeSearch(raw: string | null): string {
  if (!raw) return ''
  return raw
    .replace(/[,()"'\\%*_:.;]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SEARCH_LENGTH)
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Response shape
// ---------------------------------------------------------------------------------------------------------------------------------------------

interface OrderRow {
  id: string
  confirmed_at: string
  customer_name: string
  product: string
  quantity: number
  price: number | string
  seller_name: string
  order_status: string
  delivery_status: string
  agency: string
  destination: string
  department: string | null
  conversation_id: string | null
}

interface ItemRow {
  order_id: string
  line_number: number
  product_name: string
  quantity: number
  unit_price: number | string
  subtotal: number | string | null
}

const num = (v: number | string | null | undefined): number => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * Builds the response order from ONE header row and its (possibly empty) item rows. Items are fetched separately and grouped here, so a
 * multi-product order is always exactly one header: it can never be duplicated by a join.
 */
export function toOrder(row: OrderRow, items: ItemRow[]): ConfirmedOrder {
  const sorted = [...items].sort((a, b) => a.line_number - b.line_number)
  const lines: ConfirmedOrderLine[] =
    sorted.length > 0
      ? sorted.map((i) => ({
          line_number: i.line_number,
          product_name: i.product_name,
          quantity: i.quantity,
          unit_price: num(i.unit_price),
          subtotal: i.subtotal === null || i.subtotal === undefined ? num(i.unit_price) * i.quantity : num(i.subtotal),
        }))
      : [{ line_number: 1, product_name: row.product, quantity: row.quantity, unit_price: null, subtotal: num(row.price) }]

  return {
    id: row.id,
    confirmed_at: row.confirmed_at,
    customer_name: row.customer_name,
    seller_name: row.seller_name,
    order_status: row.order_status,
    delivery_status: row.delivery_status,
    agency: row.agency,
    destination: row.destination,
    department: row.department ?? null,
    conversation_id: row.conversation_id ?? null,
    total: num(row.price),
    quantity: sorted.length > 0 ? sorted.reduce((sum, i) => sum + i.quantity, 0) : row.quantity,
    product_summary: sorted.length > 0 ? sorted.map((i) => `${i.quantity} × ${i.product_name}`).join(' + ') : row.product,
    lines,
    is_multiproduct: sorted.length > 1,
  }
}
