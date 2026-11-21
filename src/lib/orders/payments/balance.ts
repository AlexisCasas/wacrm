import type { SupabaseClient } from '@supabase/supabase-js'

// The balance a customer-facing template may show. It comes ONLY from the PR-06 financial row (WACRM is the financial source of truth):
//     pending_balance = order total (order_confirmations.price) - paid_confirmed (CONFIRMED payments), never negative.
// TRUST CUTOFF (fail-closed): order_payment_settings.balance_trusted_since is the official moment from which the WACRM balance may be shown to a customer. NULL = OFF = no order has a
// usable balance; an order confirmed BEFORE the cutoff never does (`balance_not_trusted`): during the coexistence the initial payment / price corrections of those orders live in InkaClick.
// EVERY customer communication that carries pending_balance resolves it HERE (packaging, arrival, day-15, any future one): there is no other source.
// An order with no financial row (a historical / NOT TRACKED order, or payments switched off) has NO balance: `available: false`. It is never reported as zero:
// zero means "tracked and fully paid", not "unknown". Server side only (service-role client).

export type BalanceUnavailableReason = 'payments_disabled' | 'not_tracked' | 'order_not_found' | 'lookup_failed' | 'balance_not_trusted'

export type OrderBalance =
  | { available: true; total: number; paid: number; pending: number; status: 'unpaid' | 'partially_paid' | 'paid' }
  | { available: false; reason: BalanceUnavailableReason }

const round2 = (n: number) => Math.round(n * 100) / 100

export function computePendingBalance(total: number, paid: number): number {
  if (!Number.isFinite(total) || !Number.isFinite(paid)) return 0
  return Math.max(round2(total - paid), 0)
}

/** "S/ 150.00": the exact text a template variable carries (the template wording holds no currency symbol of its own). */
export function formatSoles(amount: number): string {
  return `S/ ${round2(Math.max(amount, 0)).toFixed(2)}`
}

/** The stable error code a caller surfaces when no balance may be shown (no new code path: one mapping for every communication). */
export function balanceErrorCode(reason: BalanceUnavailableReason): 'internal_error' | 'balance_not_trusted' | 'pending_balance_unavailable' {
  return reason === 'lookup_failed' ? 'internal_error' : reason === 'balance_not_trusted' ? 'balance_not_trusted' : 'pending_balance_unavailable'
}

/** Fail-closed: no cutoff (NULL / unparsable) -> not trusted; an order confirmed before the cutoff (or with no confirmation time) -> not trusted; at or after the cutoff -> trusted. */
export function isTrusted(trustedSince: string | null, confirmedAt: string | null): boolean {
  if (!trustedSince || !confirmedAt) return false
  const cutoff = Date.parse(trustedSince)
  const at = Date.parse(confirmedAt)
  if (Number.isNaN(cutoff) || Number.isNaN(at)) return false
  return at >= cutoff
}

export async function resolveOrderBalance(admin: SupabaseClient, accountId: string, orderId: string): Promise<OrderBalance> {
  const { data: settings, error: settingsError } = await admin.from('order_payment_settings').select('order_payments_enabled, balance_trusted_since').eq('account_id', accountId).maybeSingle()
  if (settingsError) return { available: false, reason: 'lookup_failed' }
  const s = settings as { order_payments_enabled?: boolean; balance_trusted_since?: string | null } | null
  if (s?.order_payments_enabled !== true) return { available: false, reason: 'payments_disabled' }

  const [fin, order] = await Promise.all([
    admin.from('order_financials').select('paid_confirmed, financial_status').eq('account_id', accountId).eq('order_id', orderId).maybeSingle(),
    admin.from('order_confirmations').select('price, confirmed_at').eq('account_id', accountId).eq('id', orderId).maybeSingle(),
  ])
  if (fin.error || order.error) return { available: false, reason: 'lookup_failed' }
  if (!order.data) return { available: false, reason: 'order_not_found' }
  if (!isTrusted(s?.balance_trusted_since ?? null, (order.data as { confirmed_at?: string | null }).confirmed_at ?? null)) return { available: false, reason: 'balance_not_trusted' }
  if (!fin.data) return { available: false, reason: 'not_tracked' }
  const total = Number((order.data as { price: number | string }).price)
  const f = fin.data as { paid_confirmed: number | string; financial_status: 'unpaid' | 'partially_paid' | 'paid' }
  const paid = Number(f.paid_confirmed)
  return { available: true, total, paid, pending: computePendingBalance(total, paid), status: f.financial_status }
}

/** The account's configured payment instructions (one line), or `null` when none is configured. */
export async function readPaymentInstructions(admin: SupabaseClient, accountId: string): Promise<string | null> {
  const { data } = await admin.from('order_payment_settings').select('customer_payment_instructions').eq('account_id', accountId).maybeSingle()
  const text = (data as { customer_payment_instructions?: string | null } | null)?.customer_payment_instructions
  return typeof text === 'string' && text.trim() !== '' ? text.trim() : null
}
