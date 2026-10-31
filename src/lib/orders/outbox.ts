import type { SupabaseClient } from '@supabase/supabase-js'
import { nextAttemptDelayMs, MAX_ATTEMPTS } from './backoff'
import type { OrderRow } from './payload'
import { lookupInkaclickOrder, sendOrderToInkaclick, type InkaclickConfig } from './sender'

// Outbox worker: lease due orders (SKIP LOCKED, in SQL), deliver each one, report the result. Safe to run concurrently from several processes and
// to be killed at any point: an expired lease is retried and the receiver is idempotent on `external_order_id`.

export interface OutboxResult {
  claimed: number
  sent: number
  retried: number
  rejected: number
  dead: number
  reconciled: number
}

export function readInkaclickConfig(env: NodeJS.ProcessEnv = process.env): InkaclickConfig | null {
  const url = env.INKACLICK_ORDERS_URL?.trim()
  const token = env.INKACLICK_ORDERS_TOKEN?.trim()
  if (env.INKACLICK_ORDERS_ENABLED !== 'true' || !url || !token) return null
  return { url, token }
}

export async function runOrderOutbox(
  admin: SupabaseClient,
  cfg: InkaclickConfig | null,
  opts: { limit?: number; fetchImpl?: typeof fetch; now?: () => number; random?: () => number } = {},
): Promise<OutboxResult> {
  const result: OutboxResult = { claimed: 0, sent: 0, retried: 0, rejected: 0, dead: 0, reconciled: 0 }
  // No configuration = global switch off: nothing is leased, so nothing changes state.
  if (!cfg) return result
  const now = opts.now ?? Date.now

  const { data: due, error } = await admin.rpc('claim_order_deliveries', { p_limit: opts.limit ?? 10, p_lease_seconds: 120, p_max_attempts: MAX_ATTEMPTS })
  if (error) throw new Error(`claim_order_deliveries failed: ${error.message}`)

  for (const row of (due ?? []) as (OrderRow & { attempts: number })[]) {
    result.claimed++
    const outcome = await sendOrderToInkaclick(row, cfg, opts.fetchImpl)
    const retryAt = outcome.kind === 'retry' ? new Date(now() + nextAttemptDelayMs(row.attempts, outcome.retryAfterMs, opts.random)).toISOString() : null
    const { data: status, error: finishError } = await admin.rpc('finish_order_delivery', {
      p_order: row.id,
      p_attempt: row.attempts,
      p_outcome: outcome.kind,
      p_http_status: outcome.httpStatus,
      p_error_code: outcome.kind === 'sent' ? null : outcome.code,
      p_error_detail: outcome.kind === 'sent' ? null : outcome.detail,
      p_inkaclick_id: outcome.kind === 'sent' ? outcome.inkaclickId : null,
      p_retry_at: retryAt,
      p_max_attempts: MAX_ATTEMPTS,
    })
    if (finishError) throw new Error(`finish_order_delivery failed: ${finishError.message}`)
    if (status === 'sent') result.sent++
    else if (status === 'failed') result.rejected++
    else if (status === 'dead') result.dead++
    else if (status === 'pending') result.retried++
  }

  // Reconciliation: a 'sent' order becomes 'acknowledged' only when the receiver confirms it holds that external id.
  const { data: sent } = await admin
    .from('order_confirmations')
    .select('id, inkaclick_order_id')
    .eq('delivery_status', 'sent')
    .lt('sent_at', new Date(now() - 60_000).toISOString())
    .limit(opts.limit ?? 10)
  for (const o of (sent ?? []) as { id: string; inkaclick_order_id: string | null }[]) {
    const found = await lookupInkaclickOrder(o.id, cfg, opts.fetchImpl)
    if (!found) continue
    const { error: ackError } = await admin.rpc('acknowledge_order_delivery', { p_order: o.id, p_inkaclick_id: found })
    if (!ackError) result.reconciled++
  }
  return result
}
