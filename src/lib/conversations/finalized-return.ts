import type { SupabaseClient } from '@supabase/supabase-js'

// PR-05C · the automatic return of a conversation from Logistica to Comercial, N minutes after an order was declared "completamente finalizado".
// The decision and the state live in the DATABASE (order_finalizations + return_finalized_conversations): this file only asks the database to apply what is
// already due, so an app restart loses nothing and two callers cannot apply it twice. WHEN an order counts as finalized is NOT decided here (PR-06).

export const DEFAULT_FINALIZED_GRACE_MINUTES = 10

export interface FinalizedReturnResult {
  /** PR-06: orders marked as completely finalized by the sweeper (Shalom delivered after the payment). */
  finalized: number
  returned: number
  skipped: number
  /** PR-06: finalized orders whose conversation waits for the OTHER operative orders of the chat. */
  deferred: number
  errors: number
}

/** Grace period in minutes: ORDER_FINALIZED_GRACE_MINUTES (QA / tuning) or the default 10. Anything invalid falls back to 10. */
export function readFinalizedGraceMinutes(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.ORDER_FINALIZED_GRACE_MINUTES)
  return Number.isInteger(n) && n >= 1 && n <= 24 * 60 ? n : DEFAULT_FINALIZED_GRACE_MINUTES
}

/** Applies every return that is due at `now`. Never throws: a failure is counted and logged (no names, phones or ids). */
export async function runFinalizedReturn(admin: SupabaseClient, opts: { now?: Date; graceMinutes?: number; /** tests only: process one account */ accountId?: string } = {}): Promise<FinalizedReturnResult> {
  const out: FinalizedReturnResult = { finalized: 0, returned: 0, skipped: 0, deferred: 0, errors: 0 }
  try {
    // PR-06 first: an order delivered by Shalom AFTER its payment is only discovered here (nothing in PR-05 calls PR-06). A failure never blocks the return.
    const swept = await admin.rpc('evaluate_order_finalizations', { p_now: (opts.now ?? new Date()).toISOString(), p_limit: 200, p_account: opts.accountId ?? null })
    if (swept.error) console.error('[routing-return] finalization sweep failed:', swept.error.code)
    else out.finalized = ((swept.data ?? {}) as { marked?: number }).marked ?? 0
    const { data, error } = await admin.rpc('return_finalized_conversations', {
      p_now: (opts.now ?? new Date()).toISOString(),
      p_grace_minutes: opts.graceMinutes ?? readFinalizedGraceMinutes(),
      p_limit: 100,
      p_account: opts.accountId ?? null,
    })
    if (error) {
      out.errors += 1
      console.error('[routing-return] rpc failed:', error.code)
      return out
    }
    const body = (data ?? {}) as { returned?: number; skipped?: number; deferred?: number }
    out.returned = body.returned ?? 0
    out.skipped = body.skipped ?? 0
    out.deferred = body.deferred ?? 0
  } catch (e) {
    out.errors += 1
    console.error('[routing-return] failed:', e instanceof Error ? e.name : 'unknown')
  }
  return out
}
