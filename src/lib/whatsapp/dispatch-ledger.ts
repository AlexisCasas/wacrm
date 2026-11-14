import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * F3 — durable "intent to dispatch" for inbound WhatsApp messages (see migration 20261125000000).
 *
 * The ledger row is written BEFORE the message insert, so "the message exists" implies "its ledger row exists". Each dispatch step is
 * pending -> started -> done. A resume (replay after a crash) re-runs only steps that are still `pending`. A step left `started`
 * (outcome unknown) is re-run only when the database shows no trace of it; otherwise it is marked `reconcile` and NEVER repeated.
 *
 * Every ledger failure degrades to the previous behaviour (no ledger): reception and dispatch must never become LESS available.
 * Nothing here logs payloads, WAMIDs, phone numbers or message text.
 */
export type LedgerStep = 'flows' | 'automations' | 'ai' | 'webhook'
export type StepState = 'pending' | 'started' | 'done' | 'skipped' | 'reconcile'
export type LedgerOutcome = 'claimed' | 'completed' | 'busy' | 'reconcile' | 'failed' | 'missing'

export interface LedgerClaim {
  outcome: LedgerOutcome
  token: string | null
  steps: Record<LedgerStep, StepState>
  isFirstInbound: boolean
  contactCreated: boolean
  flowConsumed: boolean | null
  attempts: number
}

/** 'created' = this call wrote the intent (message not seen before). 'existed' = a previous attempt did. 'off' = ledger unavailable. */
export async function ledgerBegin(
  db: SupabaseClient, accountId: string, wamid: string, isFirst: boolean, contactCreated: boolean,
): Promise<'created' | 'existed' | 'off'> {
  const { data, error } = await db.rpc('inbound_dispatch_begin', { p_account: accountId, p_wamid: wamid, p_first: isFirst, p_created: contactCreated })
  if (error || typeof data !== 'boolean') {
    console.error('[dispatch-ledger] begin unavailable', { code: error?.code ?? 'invalid_result' })
    return 'off'
  }
  return data ? 'created' : 'existed'
}

export async function ledgerSkipLegacy(db: SupabaseClient, accountId: string, wamid: string): Promise<void> {
  const { error } = await db.rpc('inbound_dispatch_skip_legacy', { p_account: accountId, p_wamid: wamid })
  if (error) console.error('[dispatch-ledger] skip_legacy failed', { code: error.code ?? 'unknown' })
}

export async function ledgerClaim(db: SupabaseClient, accountId: string, wamid: string): Promise<LedgerClaim | null> {
  const { data, error } = await db.rpc('inbound_dispatch_claim', { p_account: accountId, p_wamid: wamid })
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined
  if (error || !row || typeof row.outcome !== 'string') {
    console.error('[dispatch-ledger] claim unavailable', { code: error?.code ?? 'invalid_result' })
    return null
  }
  return {
    outcome: row.outcome as LedgerOutcome,
    token: (row.token as string | null) ?? null,
    steps: (row.steps as LedgerClaim['steps']) ?? ({} as LedgerClaim['steps']),
    isFirstInbound: row.is_first_inbound === true,
    contactCreated: row.contact_created === true,
    flowConsumed: typeof row.flow_consumed === 'boolean' ? row.flow_consumed : null,
    attempts: Number(row.attempts ?? 0),
  }
}

export interface LedgerRun {
  /** Run one dispatch step under the ledger. Returns undefined when the step must not run (already done / skipped / reconcile). */
  step<T>(name: LedgerStep, fn: () => Promise<T>, opts?: { consumedOf?: (r: T) => boolean }): Promise<{ ran: boolean; value?: T }>
  skip(name: LedgerStep): Promise<void>
  finish(): Promise<void>
  release(code: string): Promise<void>
  readonly flowConsumed: boolean | null
}

/** A runner for a successfully claimed ledger row. Every transition is fenced by the claim token. */
export function ledgerRun(db: SupabaseClient, accountId: string, wamid: string, claim: LedgerClaim, contactId: string): LedgerRun {
  const token = claim.token as string
  let flowConsumed = claim.flowConsumed
  const mark = async (name: LedgerStep, status: 'started' | 'done' | 'skipped' | 'reconcile', consumed?: boolean) => {
    const { data, error } = await db.rpc('inbound_dispatch_step', {
      p_account: accountId, p_wamid: wamid, p_token: token, p_step: name, p_status: status, p_flow_consumed: consumed ?? null,
    })
    if (error || data !== true) throw new Error('dispatch_ledger_lease_lost')
  }
  return {
    get flowConsumed() { return flowConsumed },
    async step(name, fn, opts) {
      let state = (claim.steps?.[name] ?? 'pending') as StepState
      if (state === 'done' || state === 'skipped' || state === 'reconcile') return { ran: false }
      if (state === 'started') {
        // The previous attempt died inside this step: outcome unknown. Repeat only when the database proves nothing happened.
        const { data, error } = await db.rpc('inbound_dispatch_has_trace', { p_account: accountId, p_wamid: wamid, p_contact: contactId, p_step: name })
        if (error || data !== false) {
          await mark(name, 'reconcile')
          console.warn('[dispatch-ledger] step needs reconciliation (outcome unknown, not repeated)', { step: name })
          return { ran: false }
        }
        state = 'pending'
      }
      await mark(name, 'started')
      const value = await fn()
      const consumed = opts?.consumedOf ? opts.consumedOf(value) : undefined
      if (consumed !== undefined) flowConsumed = consumed
      await mark(name, 'done', consumed)
      return { ran: true, value }
    },
    async skip(name) {
      const state = (claim.steps?.[name] ?? 'pending') as StepState
      if (state === 'pending') await mark(name, 'skipped')
    },
    async finish() {
      const { error } = await db.rpc('inbound_dispatch_finish', { p_account: accountId, p_wamid: wamid, p_token: token })
      if (error) console.error('[dispatch-ledger] finish failed', { code: error.code ?? 'unknown' })
    },
    async release(code) {
      await db.rpc('inbound_dispatch_release', { p_account: accountId, p_wamid: wamid, p_token: token, p_error: code })
        .then(undefined, () => undefined)
    },
  }
}
