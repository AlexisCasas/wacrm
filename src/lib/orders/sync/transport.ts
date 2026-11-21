import type { SupabaseClient } from '@supabase/supabase-js'

export interface OrderSyncTransportConfig {
  url: string
  token: string
  timeoutMs?: number
}

export interface ClaimedSyncEvent {
  event_id: string
  origin_system: 'wacrm' | 'inkaclick'
  origin_event_id: string
  canonical_order_id: string
  event_type: string
  event_version: number
  idempotency_key: string
  occurred_at: string
  payload: Record<string, unknown>
  attempts: number
  claim_token: string
}

export interface OrderSyncRunResult {
  claimed: number
  applied: number
  retried: number
  conflicts: number
  dead: number
}

type Delivery =
  | { outcome: 'applied'; code: null }
  | { outcome: 'retry' | 'conflict' | 'dead_letter'; code: string }

const SAFE_CODE = /^[a-z][a-z0-9_]{0,63}$/

export function readOrderSyncConfig(env: NodeJS.ProcessEnv = process.env): OrderSyncTransportConfig | null {
  const url = env.INKACLICK_SYNC_EVENTS_URL?.trim()
  const token = env.ORDER_SYNC_TOKEN?.trim()
  if (env.ORDER_SYNC_ENABLED !== 'true' || !url || !token) return null
  return { url, token }
}

async function parseCode(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { code?: unknown }
    return typeof body?.code === 'string' && SAFE_CODE.test(body.code) ? body.code : null
  } catch {
    return null
  }
}

export async function deliverSyncEvent(
  row: ClaimedSyncEvent,
  cfg: OrderSyncTransportConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<Delivery> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs ?? 10_000)
  try {
    const res = await fetchImpl(cfg.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.token}`,
        'idempotency-key': row.origin_event_id,
      },
      body: JSON.stringify({
        origin_system: row.origin_system,
        origin_event_id: row.origin_event_id,
        canonical_order_id: row.canonical_order_id,
        event_type: row.event_type,
        event_version: row.event_version,
        idempotency_key: row.idempotency_key,
        occurred_at: row.occurred_at,
        payload: row.payload,
      }),
      signal: controller.signal,
    })
    if (res.ok) return { outcome: 'applied', code: null }
    const code = (await parseCode(res)) ?? `http_${res.status}`
    if (res.status === 409) return { outcome: 'conflict', code }
    if (res.status === 408 || res.status === 429 || res.status >= 500) return { outcome: 'retry', code }
    return { outcome: 'dead_letter', code }
  } catch (error) {
    return {
      outcome: 'retry',
      code: error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'network_error',
    }
  } finally {
    clearTimeout(timer)
  }
}

export async function runOrderSyncOutbox(
  admin: SupabaseClient,
  cfg: OrderSyncTransportConfig | null,
  opts: { limit?: number; fetchImpl?: typeof fetch } = {},
): Promise<OrderSyncRunResult> {
  const result: OrderSyncRunResult = { claimed: 0, applied: 0, retried: 0, conflicts: 0, dead: 0 }
  if (!cfg) return result

  const { data, error } = await admin.rpc('claim_order_sync_outbound', {
    p_consumer: 'inkaclick',
    p_limit: opts.limit ?? 10,
    p_lease_seconds: 120,
    p_max_attempts: 8,
  })
  if (error) throw new Error(`claim_order_sync_outbound failed: ${error.message}`)

  for (const row of (data ?? []) as ClaimedSyncEvent[]) {
    result.claimed++
    const delivery = await deliverSyncEvent(row, cfg, opts.fetchImpl)
    const { data: status, error: finishError } = await admin.rpc('finish_order_sync_outbound', {
      p_event: row.event_id,
      p_consumer: 'inkaclick',
      p_claim_token: row.claim_token,
      p_outcome: delivery.outcome,
      p_error_code: delivery.code,
    })
    if (finishError) throw new Error(`finish_order_sync_outbound failed: ${finishError.message}`)
    if (status === 'applied') result.applied++
    else if (status === 'pending') result.retried++
    else if (status === 'conflict') result.conflicts++
    else if (status === 'dead_letter') result.dead++
  }
  return result
}
