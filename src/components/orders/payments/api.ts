// Browser-side shapes of the PR-06 endpoints (mirror src/lib/orders/payments/service.ts). The browser never sends an account, role, actor or balance.

export type FinancialStatus = 'unpaid' | 'partially_paid' | 'paid'
export type PaymentStatus = 'recorded' | 'confirmed' | 'rejected' | 'voided'
export type PaymentKind = 'advance' | 'balance' | 'full' | 'other'
export const PAYMENT_KINDS: PaymentKind[] = ['advance', 'balance', 'full', 'other']

export interface PaymentView {
  id: string
  amount: number
  kind: PaymentKind
  method: string | null
  operation_number: string | null
  paid_at: string
  status: PaymentStatus
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

export interface PaymentsPanelData {
  tracked: boolean
  total: number
  paid_confirmed: number
  pending_balance: number
  financial_status: FinancialStatus | null
  payments: PaymentView[]
  events: PaymentEventView[]
  delivery: { delivered: boolean; source: 'shalom' | 'manual' | null; delivered_at: string | null; can_mark_manual: boolean }
  finalization: { finalized_at: string; return_state: string } | null
  voucher_candidate: { id: string; filename: string; amount_hint: number | null } | null
  is_supervisor: boolean
  order?: { customer_name: string; dni: string | null; phone: string; product: string; quantity: number; order_description: string | null; agency: string; destination: string; department: string | null; seller_name: string; seller_user_id: string | null }
  items?: Array<{ line_number: number; product_name: string; quantity: number; unit_price: number; catalog_product_id: string | null; item_type: 'product' | 'accessory' }>
  cancellation?: { reason: string; actor_name: string; paid_confirmed: number | string; refund_required: boolean; shipment_stopped: boolean; customer_notice: string; cancelled_at: string } | null
  edits?: Array<{ id: string; actor_name: string; reason: string; changes: Record<string, { old: unknown; new: unknown }>; created_at: string }>
}

export interface PaymentSummaryData {
  financial_status: FinancialStatus
  total: number
  paid_confirmed: number
  pending_balance: number
  cancelled?: boolean
}

export interface ConversationFinancialData extends PaymentSummaryData {
  order_id: string
  product: string
  confirmed_at: string
}

/** Broadcast "the payments of this order changed" so the list chip refreshes. */
export const PAYMENTS_CHANGED_EVENT = 'wacrm:payments-changed'
export const notifyPaymentsChanged = (orderId: string | null) => {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(PAYMENTS_CHANGED_EVENT, { detail: { orderId } }))
}

/** "S/ 110.00": always two decimals. */
export const soles = (n: number) => `S/ ${n.toFixed(2)}`
