import type { SupabaseClient } from '@supabase/supabase-js'
import { sendCapiEvent, type CapiOutcome, type CapiRow } from './client'

// Meta CAPI worker. Fully decoupled from the webhook and from the InkaClick outbox: it only reads orders/attributions and writes its own tables.
// Global switch: META_CAPI_ENABLED=true. Per-account switch: meta_capi_settings.enabled (OFF by default). Any failure stays inside this module.

export const CAPI_MAX_ATTEMPTS = 6

export interface CapiRunResult {
  enabled: boolean
  enqueued: number
  claimed: number
  sent: number
  retried: number
  rejected: number
  dead: number
  disabledAccounts: number
}

interface Claimed extends CapiRow {
  id: string
  account_id: string
  attempts: number
  access_token_enc: string
}

export function capiGloballyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.META_CAPI_ENABLED === 'true'
}

export function capiRetryDelayMs(attempt: number, retryAfterMs?: number, random: () => number = Math.random): number {
  const base = Math.min(60_000 * 2 ** Math.max(attempt - 1, 0), 6 * 3_600_000)
  return Math.max(Math.round(base * (0.8 + random() * 0.4)), retryAfterMs ?? 0)
}

export async function runCapiWorker(
  admin: SupabaseClient,
  opts: {
    enabled?: boolean
    limit?: number
    fetchImpl?: typeof fetch
    decryptToken?: (enc: string) => string
    now?: () => number
    random?: () => number
  } = {},
): Promise<CapiRunResult> {
  const result: CapiRunResult = { enabled: opts.enabled ?? capiGloballyEnabled(), enqueued: 0, claimed: 0, sent: 0, retried: 0, rejected: 0, dead: 0, disabledAccounts: 0 }
  if (!result.enabled) return result // global switch off: nothing is read, queued or sent
  const now = opts.now ?? Date.now
  const decryptToken = opts.decryptToken ?? (await import('@/lib/whatsapp/encryption')).decrypt

  const { data: n, error: enqError } = await admin.rpc('meta_capi_enqueue', { p_account: null, p_limit: 200 })
  if (enqError) throw new Error(`meta_capi_enqueue failed: ${enqError.code ?? 'error'}`)
  result.enqueued = Number(n ?? 0)

  const { data: due, error } = await admin.rpc('meta_capi_claim', { p_limit: opts.limit ?? 20, p_lease_seconds: 120, p_max_attempts: CAPI_MAX_ATTEMPTS })
  if (error) throw new Error(`meta_capi_claim failed: ${error.code ?? 'error'}`)

  for (const row of (due ?? []) as Claimed[]) {
    result.claimed++
    let outcome: CapiOutcome
    try {
      outcome = await sendCapiEvent(row, decryptToken(row.access_token_enc), opts.fetchImpl)
    } catch {
      outcome = { kind: 'auth', httpStatus: 0, code: 'token_unreadable', detail: 'access token could not be decrypted' }
    }
    const retryAt =
      outcome.kind === 'retry' ? new Date(now() + capiRetryDelayMs(row.attempts, outcome.retryAfterMs, opts.random)).toISOString() : null
    const { data: status, error: finishError } = await admin.rpc('meta_capi_finish', {
      p_event: row.id,
      p_attempt: row.attempts,
      p_outcome: outcome.kind,
      p_http: outcome.httpStatus,
      p_code: outcome.kind === 'sent' ? null : outcome.code,
      p_detail: outcome.kind === 'sent' ? null : outcome.detail,
      p_retry_at: outcome.kind === 'auth' ? new Date(now() + 3_600_000).toISOString() : retryAt,
      p_max_attempts: CAPI_MAX_ATTEMPTS,
    })
    if (finishError) throw new Error(`meta_capi_finish failed: ${finishError.code ?? 'error'}`)
    if (status === 'sent') result.sent++
    else if (status === 'failed') result.rejected++
    else if (status === 'dead') result.dead++
    else if (status === 'pending') result.retried++
    if (outcome.kind === 'auth') result.disabledAccounts++
  }
  return result
}
