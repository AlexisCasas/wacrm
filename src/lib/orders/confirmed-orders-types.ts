// Client-safe types/constants of the "Pedidos confirmados" workspace (PR-02). Kept apart from confirmed-orders.ts, which imports the service-role
// client and must never end up in the browser bundle.

/** Delivery states that exist in the DB check constraint. Used to validate the filter (an unknown filter is a 400, never a SQL fragment). */
export const DELIVERY_STATUSES = ['held', 'pending', 'sending', 'sent', 'acknowledged', 'failed', 'dead'] as const

export interface ConfirmedOrderLine {
  line_number: number
  product_name: string
  quantity: number
  /** `null` for a legacy single-product order: its snapshot only stores the order TOTAL, not a unit price. */
  unit_price: number | null
  subtotal: number
}

export interface ConfirmedOrder {
  id: string
  confirmed_at: string
  customer_name: string
  seller_name: string
  order_status: string
  delivery_status: string
  agency: string
  destination: string
  department: string | null
  conversation_id: string | null
  /** The order total (the legacy `price` column IS the total). */
  total: number
  /** Total units (sum of the lines). */
  quantity: number
  /** One-line product summary: the item names for a multi-product order, the legacy snapshot otherwise. */
  product_summary: string
  /** Real items when the order has rows in order_confirmation_items, otherwise ONE line built from the legacy snapshot. Never both. */
  lines: ConfirmedOrderLine[]
  is_multiproduct: boolean
}

/**
 * Technical integration states (InkaClick / external system) that have NOT completed yet: everything the DB allows except `acknowledged`
 * (received). `held` = confirmed in WACRM but the integration is not enabled. Unknown / future values are NOT counted (nothing is invented).
 * This is NOT a logistics state: physical states (preparing, packed, shipped, delivered) do not exist yet.
 */
export const INTEGRATION_PENDING_STATUSES: readonly string[] = ['held', 'pending', 'sending', 'sent', 'failed', 'dead']
