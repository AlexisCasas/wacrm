import type { SupabaseClient } from '@supabase/supabase-js'
import { VersionedStoreError, firstRow } from './versioned-store'

/**
 * Typed access to the effect ledger (migration 059): the outbox that must hold every external messaging
 * effect of a versioned run BEFORE anything is sent. Internal and not wired to the interpreter, any route
 * or any sender yet (C2 will use it); this module sends nothing.
 *
 * Identity: one effect per (flow_run_id, occurrence_revision). The revision is the run's CAS revision
 * while the message node is the pending cursor, so a restart of the same step keeps the same key and a
 * second execution of the same node (second subflow call, loop) gets a new one.
 *
 * Guarantee: at most one attempt in flight. After a claim whose outcome is not recorded the effect is
 * AMBIGUOUS and is never resent without evidence; `pending` is the only state that proves "never attempted".
 * This is not exactly-once delivery: WhatsApp Cloud API has no idempotency key.
 */

export type EffectType = 'send_message' | 'send_media'
export type EffectState = 'pending' | 'claimed' | 'confirmed' | 'ambiguous' | 'failed'
export type LeaseRefusal = 'run_not_active' | 'stale_lease' | 'lease_expired'

export interface EffectCaller { accountId: string; runId: string; owner: string; fencingToken: number }

export interface RegisterEffectInput extends EffectCaller { expectedRevision: number; effectType: EffectType; request: Record<string, unknown> }
export interface RegisterEffectResult {
  registered: boolean; effectId: string | null; state: EffectState | null; occurrenceRevision: number
  reason: LeaseRefusal | 'revision_conflict' | 'already_registered' | 'payload_mismatch' | 'budget_exceeded' | null
}
export interface ClaimEffectResult {
  claimed: boolean; state: EffectState | null; attempt: number | null; attemptId: string | null
  reason: LeaseRefusal | 'effect_not_current' | 'effect_not_pending' | 'retry_not_due' | null
}
export type SettleOutcome = 'confirmed' | 'failed' | 'ambiguous'
export interface SettleEffectInput extends EffectCaller { effectId: string; attemptId: string; outcome: SettleOutcome; providerMessageId?: string; errorCode?: string }
export interface SettleEffectResult {
  settled: boolean; state: EffectState | null; reason: LeaseRefusal | 'effect_not_current' | 'effect_not_claimed' | 'attempt_mismatch' | 'provider_message_conflict' | null
}
export interface RecoveredEffect { effectId: string; previousState: EffectState; newState: EffectState }
export type ResolveOutcome = 'confirmed' | 'not_sent' | 'failed'
export interface ResolveEffectInput extends EffectCaller { effectId: string; resolution: ResolveOutcome; evidence: string; providerMessageId?: string }
export interface ResolveEffectResult { resolved: boolean; state: EffectState | null; reason: LeaseRefusal | 'effect_not_current' | 'effect_not_ambiguous' | 'provider_message_conflict' | null }
export interface CommitEffectStepInput extends EffectCaller { expectedRevision: number; effectId: string; checkpoint: unknown }
export interface CommitEffectStepResult {
  committed: boolean; revision: number; nodesExecuted: number; messagesExecuted: number
  reason: LeaseRefusal | 'revision_conflict' | 'effect_not_current' | 'effect_not_confirmed' | 'budget_exceeded' | null
}

/** The persisted ledger row, as read back by the interpreter to decide what to do next. */
export interface EffectRow {
  id: string; account_id: string; flow_run_id: string; flow_version_id: string; node_key: string; occurrence_revision: number
  effect_type: EffectType; state: EffectState; attempt: number; attempt_id: string | null
  claimed_owner: string | null; claimed_fencing_token: number | null
  contact_id: string | null; conversation_id: string | null
  /** What the sender must send. Written once at registration and never rebuilt from run variables. */
  request: Record<string, unknown>; payload_hash: string; provider_message_id: string | null; error_code: string | null
  /** Set while the effect waits after a temporary rejection; claim is refused until PostgreSQL's clock passes it. */
  retry_not_before: string | null
}

/** One row of the Inbox repair report. `failed.reason` is the SQLSTATE; no message content is ever returned. */
export interface InboxRepairRow { effectId: string; messageId: string | null; outcome: 'created' | 'already_persisted' | 'skipped' | 'failed'; reason: string | null }

export interface DeferEffectInput extends EffectCaller { effectId: string; attemptId: string; retryAfterSeconds?: number; errorCode?: string }
export interface DeferEffectResult {
  deferred: boolean; state: EffectState | null; retryNotBefore: string | null; waitSeconds: number | null
  reason: LeaseRefusal | 'effect_not_current' | 'effect_not_claimed' | 'attempt_mismatch' | null
}

export interface VersionedEffectStore {
  /**
   * Re-opens a claimed attempt that the provider refused for a provably temporary reason (rate limit): back to pending
   * with a persisted retry time (Retry-After when valid, else backoff by attempt), attempt counter and budget untouched.
   */
  deferEffect(input: DeferEffectInput): Promise<DeferEffectResult>
  /**
   * Repairs the Inbox of a run in ANY state (also completed / failed): creates the message and link that a confirmed
   * effect is missing, nothing else. No lease, no run change, never contacts the provider; service_role only.
   */
  repairInbox(accountId: string, runId: string): Promise<InboxRepairRow[]>
  /** Reads the effect of one occurrence (run + revision) straight from the ledger; null when none was registered. */
  loadEffectAt(accountId: string, runId: string, occurrenceRevision: number): Promise<EffectRow | null>
  registerEffect(input: RegisterEffectInput): Promise<RegisterEffectResult>
  claimEffect(caller: EffectCaller, effectId: string): Promise<ClaimEffectResult>
  settleEffect(input: SettleEffectInput): Promise<SettleEffectResult>
  /** For the NEW lease holder: attempts claimed under an older fencing token become ambiguous. */
  recoverEffects(caller: EffectCaller): Promise<{ recovered: RecoveredEffect[]; refusal: LeaseRefusal | null }>
  resolveEffect(input: ResolveEffectInput): Promise<ResolveEffectResult>
  /** Leave the message node once its effect is confirmed: cursor + checkpoint + revision + node/message budget, atomically. */
  commitEffectStep(input: CommitEffectStepInput): Promise<CommitEffectStepResult>
}

/** Stable identity of one execution of one node within a run. */
export function effectOccurrenceKey(runId: string, occurrenceRevision: number): string { return `${runId}:${occurrenceRevision}` }

/**
 * Only `pending` proves that no provider call was ever made for the effect. `claimed` and `ambiguous` may have
 * reached the provider; `confirmed` and `failed` are final. Anything else must be resolved with evidence first.
 */
export function isSafeToSend(state: EffectState): boolean { return state === 'pending' }

function toInt(v: unknown, field: string): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  if (typeof n !== 'number' || !Number.isSafeInteger(n)) throw new VersionedStoreError('bad_response', `unexpected ${field}: ${String(v)}`)
  return n
}
const toBool = (v: unknown, field: string): boolean => {
  if (typeof v !== 'boolean') throw new VersionedStoreError('bad_response', `unexpected ${field}: ${String(v)}`)
  return v
}
const toStr = (v: unknown, field: string): string | null => {
  if (v === null || v === undefined) return null
  if (typeof v !== 'string') throw new VersionedStoreError('bad_response', `unexpected ${field}`)
  return v
}
const toNullableInt = (v: unknown, field: string): number | null => (v === null || v === undefined ? null : toInt(v, field))

export function createSupabaseEffectStore(client: SupabaseClient): VersionedEffectStore {
  async function rpc(fn: string, args: Record<string, unknown>): Promise<unknown> {
    const { data, error } = await client.rpc(fn, args)
    if (error) throw new VersionedStoreError(error.code || 'rpc_error', `${fn}: ${error.message}`)
    return data
  }
  const who = (c: EffectCaller) => ({ p_account_id: c.accountId, p_run_id: c.runId, p_owner: c.owner, p_fencing_token: c.fencingToken })
  return {
    async deferEffect(i) {
      const row = firstRow(await rpc('defer_versioned_effect', { ...who(i), p_effect_id: i.effectId, p_attempt_id: i.attemptId,
        p_retry_after_seconds: i.retryAfterSeconds ?? null, p_error_code: i.errorCode ?? null }), 'defer_versioned_effect')
      return { deferred: toBool(row.deferred, 'deferred'), state: toStr(row.effect_state, 'effect_state') as EffectState | null, retryNotBefore: toStr(row.not_before, 'not_before'),
        waitSeconds: toNullableInt(row.wait_seconds, 'wait_seconds'), reason: toStr(row.reason, 'reason') as DeferEffectResult['reason'] }
    },
    async repairInbox(accountId, runId) {
      const data = await rpc('repair_versioned_run_inbox', { p_account_id: accountId, p_run_id: runId })
      const rows = Array.isArray(data) ? data : data ? [data] : []
      return (rows as Array<Record<string, unknown>>).map((r) => ({
        effectId: toStr(r.effect_id, 'effect_id') ?? '', messageId: toStr(r.message_id, 'message_id'),
        outcome: toStr(r.outcome, 'outcome') as InboxRepairRow['outcome'], reason: toStr(r.reason, 'reason'),
      }))
    },
    async loadEffectAt(accountId, runId, occurrenceRevision) {
      const { data, error } = await client.from('flow_run_effects')
        .select('id,account_id,flow_run_id,flow_version_id,node_key,occurrence_revision,effect_type,state,attempt,attempt_id,claimed_owner,claimed_fencing_token,contact_id,conversation_id,request,payload_hash,provider_message_id,error_code,retry_not_before')
        .eq('account_id', accountId).eq('flow_run_id', runId).eq('occurrence_revision', occurrenceRevision).maybeSingle()
      if (error) throw new VersionedStoreError(error.code || 'query_error', `flow_run_effects: ${error.message}`)
      if (!data) return null
      const r = data as unknown as EffectRow
      return { ...r, occurrence_revision: toInt(r.occurrence_revision, 'occurrence_revision'), attempt: toInt(r.attempt, 'attempt'),
        claimed_fencing_token: r.claimed_fencing_token === null ? null : toInt(r.claimed_fencing_token, 'claimed_fencing_token') }
    },
    async registerEffect(i) {
      const row = firstRow(await rpc('register_versioned_effect', { ...who(i), p_expected_revision: i.expectedRevision, p_effect_type: i.effectType, p_request: i.request }), 'register_versioned_effect')
      return { registered: toBool(row.registered, 'registered'), effectId: toStr(row.effect_id, 'effect_id'), state: toStr(row.effect_state, 'effect_state') as EffectState | null,
        occurrenceRevision: toInt(row.effect_revision, 'effect_revision'), reason: toStr(row.reason, 'reason') as RegisterEffectResult['reason'] }
    },
    async claimEffect(c, effectId) {
      const row = firstRow(await rpc('claim_versioned_effect', { ...who(c), p_effect_id: effectId }), 'claim_versioned_effect')
      return { claimed: toBool(row.claimed, 'claimed'), state: toStr(row.effect_state, 'effect_state') as EffectState | null, attempt: toNullableInt(row.attempt_no, 'attempt_no'),
        attemptId: toStr(row.claimed_attempt_id, 'claimed_attempt_id'), reason: toStr(row.reason, 'reason') as ClaimEffectResult['reason'] }
    },
    async settleEffect(i) {
      const row = firstRow(await rpc('settle_versioned_effect', { ...who(i), p_effect_id: i.effectId, p_attempt_id: i.attemptId, p_outcome: i.outcome,
        p_provider_message_id: i.providerMessageId ?? null, p_error_code: i.errorCode ?? null }), 'settle_versioned_effect')
      return { settled: toBool(row.settled, 'settled'), state: toStr(row.effect_state, 'effect_state') as EffectState | null, reason: toStr(row.reason, 'reason') as SettleEffectResult['reason'] }
    },
    async recoverEffects(c) {
      const data = await rpc('recover_versioned_run_effects', who(c))
      const rows = Array.isArray(data) ? data : data ? [data] : []
      const recovered: RecoveredEffect[] = []
      let refusal: LeaseRefusal | null = null
      for (const r of rows as Array<Record<string, unknown>>) {
        const reason = toStr(r.reason, 'reason')
        if (reason) { refusal = reason as LeaseRefusal; continue }
        recovered.push({ effectId: toStr(r.effect_id, 'effect_id') ?? '', previousState: toStr(r.previous_state, 'previous_state') as EffectState, newState: toStr(r.new_state, 'new_state') as EffectState })
      }
      return { recovered, refusal }
    },
    async resolveEffect(i) {
      const row = firstRow(await rpc('resolve_versioned_effect', { ...who(i), p_effect_id: i.effectId, p_resolution: i.resolution, p_evidence: i.evidence, p_provider_message_id: i.providerMessageId ?? null }), 'resolve_versioned_effect')
      return { resolved: toBool(row.resolved, 'resolved'), state: toStr(row.effect_state, 'effect_state') as EffectState | null, reason: toStr(row.reason, 'reason') as ResolveEffectResult['reason'] }
    },
    async commitEffectStep(i) {
      const row = firstRow(await rpc('commit_versioned_effect_step', { ...who(i), p_expected_revision: i.expectedRevision, p_effect_id: i.effectId, p_checkpoint: i.checkpoint }), 'commit_versioned_effect_step')
      return { committed: toBool(row.committed, 'committed'), revision: toInt(row.revision, 'revision'), nodesExecuted: toInt(row.nodes_executed, 'nodes_executed'),
        messagesExecuted: toInt(row.messages_executed, 'messages_executed'), reason: toStr(row.reason, 'reason') as CommitEffectStepResult['reason'] }
    },
  }
}
