import { SnapshotError, SnapshotLoader, type VersionSnapshot } from './versioned-snapshot'
import { VERSIONED_LIMITS, parseExecuteFlowConfig, parseVersionedCheckpoint, type VersionedCheckpoint } from './versioned-runtime'
import { VersionedStoreError, type CommitResult, type SubflowResult, type VersionedRunRow, type VersionedRunStore } from './versioned-store'
import type { EffectRow } from './versioned-effects'
import { parseMessageNode, parseOutboundPayload, effectOccurrenceKey, type MessagingOptions, type SendOutcome } from './versioned-messaging'

/**
 * Interpreter for versioned runs (E4.2B1.3 + B2.2 + C2): START, END, execute_flow (subflows) and, only when
 * `messaging` is injected, send_message / send_media through the effect ledger (C1) and an injected sender. From
 * immutable published snapshots. All state lives in PostgreSQL: lease + fencing + CAS (055/056) and
 * the call-frame RPCs (057/058). This module keeps only local variables, so a restarted process
 * resumes from the persisted cursor/frames; END decides root-vs-nested from the persisted depth.
 * PostgreSQL stays the only authority for atomicity and for changing flow version: calls and
 * returns go through push/pop_versioned_run_subflow, never through the generic commit.
 *
 * Not wired to production: no route, dispatcher or cron imports this file. It has no network code: whatever it
 * "sends" goes to the injected EffectSender, which in this repository is a test double.
 *
 * Messaging rule of thumb (see versioned-messaging.ts): the ledger row, not the interpreter, is the source of
 * truth. A message is handed to the sender only right after THIS invocation obtained a fresh claim; an effect
 * found claimed by anyone else is never resent (it becomes ambiguous and waits for evidence).
 */

export interface RunVersionedFlowOptions {
  accountId: string; runId: string; owner: string
  /** Lease length requested from the server; default 60s. */
  ttlSeconds?: number
  /** Commits per invocation before yielding; default = node budget. */
  maxSteps?: number
  /** Take over an expired lease through the explicit reclaim RPC (bumps the fencing token). Default false. */
  recoverExpiredLease?: boolean
  /** Re-attempts of a transition whose outcome was ambiguous AND verified as not committed. Default 2. */
  maxAmbiguousRetries?: number
  /** Enables send_message / send_media. Without it those nodes still end the run as unsupported_node_type. */
  messaging?: MessagingOptions
}

interface OutcomeBase { flowRunId: string; steps: number }
export type VersionedRunOutcome = OutcomeBase & (
  | { kind: 'completed'; revision: number; nodesExecuted: number }
  /** The interpreter ended the run as `failed` (unsupported node, bad edge, recursion, budget...). */
  | { kind: 'failed'; reason: string; revision: number; nodesExecuted: number }
  /** maxSteps reached with the run still active; the lease was released. */
  | { kind: 'yielded'; revision: number }
  | { kind: 'not_found' }
  | { kind: 'not_active'; status: string }
  | { kind: 'lease_unavailable'; reason: string }
  | { kind: 'lease_lost'; reason: string }
  | { kind: 'revision_conflict'; revision: number }
  | { kind: 'snapshot_error'; code: string; message: string }
  | { kind: 'corrupt_checkpoint'; message: string }
  /** The effect of the pending message node is ambiguous: nothing is resent or advanced until evidence is supplied. */
  | { kind: 'awaiting_effect_resolution'; effectId: string; occurrenceRevision: number }
  /** The sender proved `not_dispatched` more often than allowed in this invocation; the effect is pending again. */
  | { kind: 'send_deferred'; effectId: string; attempts: number }
  /** The provider refused the message for a temporary reason (rate limit): the retry time is persisted in the ledger; nothing was sent. */
  | { kind: 'effect_retry_scheduled'; effectId: string; retryNotBefore: string | null; attempts: number }
)

/** Messages raised by push_versioned_run_subflow for requests that can never succeed as configured. */
const SUBFLOW_REJECTIONS: Array<[string, string]> = [
  ['active published flow not found', 'subflow_target_unavailable'],
  ['published version not found', 'subflow_target_unavailable'],
  ['published definition has no entry cursor', 'subflow_target_invalid'],
  ['return node not found in caller version', 'subflow_return_node_missing'],
  ['call node is not an execute_flow node', 'subflow_call_mismatch'],
]
const rejectionReason = (message: string) => SUBFLOW_REJECTIONS.find(([m]) => message.includes(m))?.[1] ?? 'subflow_rejected'

type Refusal = { committed: boolean; revision: number; reason: string | null }
type Attempt<R extends Refusal> =
  | { t: 'ok'; res: R }                      // committed
  | { t: 'refused'; res: R }                 // definite answer from PostgreSQL, nothing written
  | { t: 'rejected'; error: VersionedStoreError } // controlled request error (P0002 / 22023), nothing written
  | { t: 'advanced' }                        // ambiguous answer, but the persisted revision moved under our lease
  | { t: 'stop'; outcome: VersionedRunOutcome }

export async function runVersionedFlow(store: VersionedRunStore, opts: RunVersionedFlowOptions): Promise<VersionedRunOutcome> {
  const { accountId, runId, owner } = opts
  const ttl = opts.ttlSeconds ?? 60
  const maxSteps = Math.min(opts.maxSteps ?? VERSIONED_LIMITS.maxNodes, VERSIONED_LIMITS.maxNodes)
  const maxRetries = opts.maxAmbiguousRetries ?? 2
  const base = { flowRunId: runId }
  let steps = 0

  const first = await store.loadRun(accountId, runId)
  if (!first || first.execution_mode !== 'versioned') return { ...base, steps, kind: 'not_found' }
  if (first.status !== 'active') return { ...base, steps, kind: 'not_active', status: first.status }

  const messaging = opts.messaging
  if (messaging) {
    // An ambiguous effect at the current revision blocks the run: answer without touching the lease.
    const blocked = await messaging.effects.loadEffectAt(accountId, runId, first.versioned_revision)
    if (blocked?.state === 'ambiguous') return { ...base, steps, kind: 'awaiting_effect_resolution', effectId: blocked.id, occurrenceRevision: blocked.occurrence_revision }
  }

  let lease = await store.acquireLease(accountId, runId, owner, ttl)
  if (!lease.acquired && lease.reason === 'lease_expired' && opts.recoverExpiredLease) lease = await store.reclaimLease(accountId, runId, owner, ttl)
  if (!lease.acquired) {
    if (lease.reason === 'run_not_active') return { ...base, steps, kind: 'not_active', status: (await store.loadRun(accountId, runId))?.status ?? 'unknown' }
    return { ...base, steps, kind: 'lease_unavailable', reason: lease.reason ?? 'unknown' }
  }
  const token = lease.fencingToken
  const loader = new SnapshotLoader(store, accountId)
  const caller = { accountId, runId, owner, fencingToken: token }
  /** Attempts this invocation already handed to the sender; an attempt is never handed over twice. */
  const sentAttempts = new Set<string>()

  /** Gives the lease back on controlled exits only. A crash (thrown error) intentionally leaves it to expire. */
  const exit = async (outcome: VersionedRunOutcome): Promise<VersionedRunOutcome> => {
    try { await store.releaseLease(accountId, runId, owner, token) } catch { /* best effort; the lease expires on its own */ }
    return outcome
  }
  const notActive = async () => exit({ ...base, steps, kind: 'not_active', status: (await store.loadRun(accountId, runId))?.status ?? 'unknown' })

  if (messaging) {
    // Claims left by an older lease may or may not have reached the provider: they become ambiguous (never resent).
    const rec = await messaging.effects.recoverEffects(caller)
    if (rec.refusal === 'run_not_active') return notActive()
    if (rec.refusal) return { ...base, steps, kind: 'lease_lost', reason: rec.refusal }
  }

  /**
   * Runs one transition RPC. A definite answer is returned as-is. When the answer is ambiguous (transport
   * failure, malformed response) the run is re-read instead of blindly repeating the call: if the revision
   * moved under our lease the transition did commit; if nothing moved it is safe to try again (the CAS on
   * expectedRevision still protects against a double commit); if the lease is gone the run is not ours.
   */
  async function attempt<R extends Refusal>(run: VersionedRunRow, op: () => Promise<R>): Promise<Attempt<R>> {
    for (let tries = 0; ; tries++) {
      try {
        const res = await op()
        return res.committed ? { t: 'ok', res } : { t: 'refused', res }
      } catch (e) {
        if (e instanceof VersionedStoreError && (e.code === 'P0002' || e.code === '22023')) return { t: 'rejected', error: e }
        if (e instanceof VersionedStoreError && e.code === '55000') return { t: 'stop', outcome: await exit({ ...base, steps, kind: 'corrupt_checkpoint', message: e.message }) }
        const now = await store.loadRun(accountId, runId)
        if (!now) return { t: 'stop', outcome: { ...base, steps, kind: 'not_found' } }
        if (now.versioned_lease_owner !== owner || now.versioned_lease !== token) return { t: 'stop', outcome: { ...base, steps, kind: 'lease_lost', reason: 'stale_lease' } }
        if (now.status !== 'active') return { t: 'stop', outcome: await exit({ ...base, steps, kind: 'not_active', status: now.status }) }
        if (now.versioned_revision !== run.versioned_revision) return { t: 'advanced' }
        if (tries >= maxRetries) throw e
      }
    }
  }

  const commit = (run: VersionedRunRow, cp: VersionedCheckpoint, extra: { status?: 'completed' | 'failed'; endReason?: string; nodesDelta?: number }) =>
    store.commitTransition({
      accountId, runId, owner, fencingToken: token, expectedRevision: run.versioned_revision, checkpoint: cp,
      status: extra.status ?? 'active', endReason: extra.endReason ?? null, nodesDelta: extra.nodesDelta ?? 0,
    })

  const checkpointDoc = (cp: VersionedCheckpoint, over: Partial<VersionedCheckpoint>): VersionedCheckpoint => ({ ...cp, ...over })

  /** Maps a definite refusal to an outcome, or `null` meaning "the run moved under our lease, keep going". */
  async function refused(run: VersionedRunRow, res: Refusal): Promise<VersionedRunOutcome | 'continue'> {
    switch (res.reason) {
      case 'stale_lease': case 'lease_expired': return { ...base, steps, kind: 'lease_lost', reason: res.reason }
      case 'run_not_active': return notActive()
      case 'revision_conflict': {
        const now = await store.loadRun(accountId, runId)
        if (!now) return { ...base, steps, kind: 'not_found' }
        if (now.versioned_lease_owner !== owner || now.versioned_lease !== token) return { ...base, steps, kind: 'lease_lost', reason: 'stale_lease' }
        if (now.status === 'active' && now.versioned_revision !== run.versioned_revision) return 'continue'   // our earlier commit had landed
        return exit({ ...base, steps, kind: 'revision_conflict', revision: res.revision })
      }
      default: return exit({ ...base, steps, kind: 'corrupt_checkpoint', message: `unexpected refusal: ${res.reason ?? 'unknown'}` })
    }
  }

  // Terminal failure owned by the interpreter: the cursor stays on the node that could not be run.
  async function failRun(run: VersionedRunRow, cp: VersionedCheckpoint, reason: string): Promise<VersionedRunOutcome | 'continue'> {
    const a = await attempt(run, () => commit(run, checkpointDoc(cp, { step: cp.step + 1, state: 'terminal', failure: reason }), { status: 'failed', endReason: reason }))
    if (a.t === 'ok') { steps++; return { ...base, steps, kind: 'failed', reason, revision: a.res.revision, nodesExecuted: a.res.nodesExecuted } }
    if (a.t === 'refused') return refused(run, a.res)
    if (a.t === 'stop') return a.outcome
    if (a.t === 'advanced') return 'continue'
    return exit({ ...base, steps, kind: 'corrupt_checkpoint', message: a.error.message })
  }

  /** Common tail for a transition that either committed, was refused, or was rejected. */
  async function settle<R extends Refusal>(run: VersionedRunRow, cp: VersionedCheckpoint, a: Attempt<R>, onRefusal: (res: R) => string | null): Promise<VersionedRunOutcome | 'continue' | 'committed'> {
    if (a.t === 'ok') return 'committed'
    if (a.t === 'advanced') return 'continue'
    if (a.t === 'stop') return a.outcome
    if (a.t === 'rejected') return failRun(run, cp, rejectionReason(a.error.message))
    const failure = onRefusal(a.res)
    if (failure) return failRun(run, cp, failure)
    return refused(run, a.res)
  }

  const classify = (e: unknown): 'controlled' | 'corrupt' | 'transport' =>
    e instanceof VersionedStoreError && (e.code === 'P0002' || e.code === '22023') ? 'controlled'
      : e instanceof VersionedStoreError && e.code === '55000' ? 'corrupt' : 'transport'
  const corrupt = (message: string) => exit({ ...base, steps, kind: 'corrupt_checkpoint', message })

  /**
   * One message node. Every decision is taken from the persisted ledger row; the only in-process memory is the set
   * of attempts already handed to the sender (so a lost settle can be repeated with the outcome we really got,
   * but a send is never repeated).
   */
  async function processMessage(run: VersionedRunRow, cp: VersionedCheckpoint, node: { node_key: string; node_type: string; config: unknown }, snapshot: VersionSnapshot): Promise<VersionedRunOutcome | 'advanced' | 'continue'> {
    const m = messaging!
    const spec = parseMessageNode(node as never)
    if (!spec) return failRun(run, cp, `invalid_${node.node_type}_config`)
    if (!snapshot.node(spec.nextNodeKey)) return failRun(run, cp, 'invalid_next_node')
    const maxNotDispatched = m.maxNotDispatchedRetries ?? 2
    let notDispatched = 0
    let transportRetries = 0
    const transient = (e: unknown) => { if (++transportRetries > maxRetries) throw e }
    const moved = (r: VersionedRunRow) => r.versioned_lease_owner !== owner || r.versioned_lease !== token

    for (let guard = 0; guard < 60; guard++) {
      const effect: EffectRow | null = await m.effects.loadEffectAt(accountId, runId, run.versioned_revision)

      // 1. register (idempotent per step; the payload is built from the variables only when no row exists yet)
      if (!effect) {
        try {
          const reg = await m.effects.registerEffect({ ...caller, expectedRevision: run.versioned_revision, effectType: spec.effectType, request: spec.build(run.vars) })
          if (!reg.registered && reg.reason !== 'already_registered' && reg.reason !== 'payload_mismatch') {
            if (reg.reason === 'stale_lease' || reg.reason === 'lease_expired') return { ...base, steps, kind: 'lease_lost', reason: reg.reason }
            if (reg.reason === 'run_not_active') return notActive()
            if (reg.reason === 'budget_exceeded') return failRun(run, cp, 'message_budget_exceeded')
            if (reg.reason === 'revision_conflict') return refused(run, { committed: false, revision: reg.occurrenceRevision, reason: 'revision_conflict' }).then((r) => (r === 'continue' ? 'continue' : r))
            return corrupt(`unexpected registration refusal: ${reg.reason ?? 'unknown'}`)
          }
        } catch (e) {
          const c = classify(e)
          if (c === 'controlled') return failRun(run, cp, 'effect_rejected')
          if (c === 'corrupt') return corrupt((e as Error).message)
          transient(e)
        }
        continue   // always re-read the ledger: it decides
      }
      if (effect.effect_type !== spec.effectType || effect.node_key !== node.node_key || effect.flow_version_id !== cp.cursor.flow_version_id) {
        return corrupt('ledger effect does not belong to the pending node')
      }

      switch (effect.state) {
        case 'confirmed': {
          // 2. advance: never sends; the ledger already holds the provider's acceptance
          for (let tries = 0; ; tries++) {
            try {
              const res = await m.effects.commitEffectStep({ ...caller, expectedRevision: run.versioned_revision, effectId: effect.id, checkpoint: {
                cursor: { flow_version_id: cp.cursor.flow_version_id, node_key: spec.nextNodeKey }, step: cp.step + 1, state: 'pending', failure: null,
                confirmed: { flow_version_id: cp.cursor.flow_version_id, node_key: cp.cursor.node_key, step: cp.step } } })
              if (res.committed) return 'advanced'
              if (res.reason === 'stale_lease' || res.reason === 'lease_expired') return { ...base, steps, kind: 'lease_lost', reason: res.reason }
              if (res.reason === 'run_not_active') return notActive()
              if (res.reason === 'budget_exceeded') return failRun(run, cp, 'message_budget_exceeded')
              if (res.reason === 'revision_conflict') return refused(run, { committed: false, revision: res.revision, reason: 'revision_conflict' })
              return corrupt(`unexpected advance refusal: ${res.reason ?? 'unknown'}`)
            } catch (e) {
              const c = classify(e)
              if (c === 'corrupt') return corrupt((e as Error).message)
              if (c === 'controlled') return corrupt((e as Error).message)
              const now = await store.loadRun(accountId, runId)
              if (!now) return { ...base, steps, kind: 'not_found' }
              if (moved(now)) return { ...base, steps, kind: 'lease_lost', reason: 'stale_lease' }
              if (now.status !== 'active') return exit({ ...base, steps, kind: 'not_active', status: now.status })
              if (now.versioned_revision !== run.versioned_revision) return 'advanced'   // the answer was lost, the advance landed
              if (tries >= maxRetries) throw e
            }
          }
        }
        case 'failed':
          return failRun(run, cp, 'effect_failed')
        case 'ambiguous':
          return exit({ ...base, steps, kind: 'awaiting_effect_resolution', effectId: effect.id, occurrenceRevision: effect.occurrence_revision })
        case 'pending': {
          // 3. claim; the claim is committed before anything is handed to the sender
          try {
            const c = await m.effects.claimEffect(caller, effect.id)
            if (!c.claimed && c.reason === 'retry_not_due') {
              // a temporary rejection set a time that has not come yet (PostgreSQL clock, persisted): wait, do not send
              return exit({ ...base, steps, kind: 'effect_retry_scheduled', effectId: effect.id, retryNotBefore: effect.retry_not_before, attempts: effect.attempt })
            }
            if (!c.claimed && c.reason !== 'effect_not_pending') {
              if (c.reason === 'stale_lease' || c.reason === 'lease_expired') return { ...base, steps, kind: 'lease_lost', reason: c.reason }
              if (c.reason === 'run_not_active') return notActive()
              return corrupt(`unexpected claim refusal: ${c.reason ?? 'unknown'}`)
            }
          } catch (e) {
            const k = classify(e)
            if (k === 'corrupt' || k === 'controlled') return corrupt((e as Error).message)
            transient(e)
          }
          continue   // re-read: the persisted state says whether we really hold the claim
        }
        case 'claimed': {
          const mine = effect.claimed_owner === owner && effect.claimed_fencing_token === token && !!effect.attempt_id
          if (!mine) {
            // someone else's (older) claim: never resend; recovery turns it into ambiguous
            const rec = await m.effects.recoverEffects(caller)
            if (rec.refusal === 'run_not_active') return notActive()
            if (rec.refusal) return { ...base, steps, kind: 'lease_lost', reason: rec.refusal }
            const again = await m.effects.loadEffectAt(accountId, runId, run.versioned_revision)
            if (again?.state === 'claimed') return corrupt('effect is claimed by a live foreign lease')
            continue
          }
          if (sentAttempts.has(effect.attempt_id!)) return corrupt('attempt was already handed to the sender but its outcome is not recorded')
          const payload = parseOutboundPayload(effect.request)
          if (!payload) return corrupt('ledger payload is not sendable')

          // 4. send: only here, with a fresh claim of this lease that this process has not used yet
          sentAttempts.add(effect.attempt_id!)
          let outcome: SendOutcome
          try {
            outcome = await m.sender.send({ effectId: effect.id, attemptId: effect.attempt_id!, attempt: effect.attempt, occurrenceKey: effectOccurrenceKey(runId, effect.occurrence_revision),
              effectType: effect.effect_type, contactId: effect.contact_id, conversationId: effect.conversation_id, payload })
          } catch {
            outcome = { kind: 'ambiguous', errorCode: 'sender_error' }      // an exception says nothing about delivery
          }
          if (outcome.kind === 'accepted' && (typeof outcome.providerMessageId !== 'string' || !outcome.providerMessageId)) outcome = { kind: 'ambiguous', errorCode: 'accepted_without_id' }
          if (outcome.kind === 'retryable_rejection') {
            const cap = m.maxRetryableAttempts ?? 6
            if (effect.attempt >= cap) {
              outcome = { kind: 'rejected', errorCode: 'rate_limit_exhausted' }        // too many temporary refusals: stop waiting
            } else {
              // provably not accepted: re-open the effect with a persisted wait. Never retried inside this invocation.
              for (let tries = 0; ; tries++) {
                try {
                  const r = await m.effects.deferEffect({ ...caller, effectId: effect.id, attemptId: effect.attempt_id!, retryAfterSeconds: outcome.retryAfterSeconds, errorCode: outcome.errorCode.slice(0, 64) })
                  if (r.deferred) return exit({ ...base, steps, kind: 'effect_retry_scheduled', effectId: effect.id, retryNotBefore: r.retryNotBefore, attempts: effect.attempt })
                  if (r.reason === 'stale_lease' || r.reason === 'lease_expired') return { ...base, steps, kind: 'lease_lost', reason: r.reason }
                  if (r.reason === 'run_not_active') return notActive()
                  const now = await m.effects.loadEffectAt(accountId, runId, run.versioned_revision)
                  if (now?.state === 'claimed') return corrupt(`deferral refused: ${r.reason ?? 'unknown'}`)
                  break
                } catch (e) {
                  const k = classify(e)
                  if (k === 'corrupt' || k === 'controlled') return corrupt((e as Error).message)
                  const now = await m.effects.loadEffectAt(accountId, runId, run.versioned_revision)
                  if (now?.state === 'pending' && now.retry_not_before) return exit({ ...base, steps, kind: 'effect_retry_scheduled', effectId: effect.id, retryNotBefore: now.retry_not_before, attempts: effect.attempt })
                  if (now && now.state !== 'claimed') break
                  if (tries >= maxRetries) throw e
                }
              }
              continue   // the row moved on (re-read it); the deferral itself was either recorded above or the state decides
            }
          }
          let settle = outcome.kind === 'accepted' ? { outcome: 'confirmed' as const, providerMessageId: outcome.providerMessageId }
            : outcome.kind === 'rejected' ? { outcome: 'failed' as const, errorCode: outcome.errorCode }
            : { outcome: 'ambiguous' as const, errorCode: outcome.errorCode }

          // 5. settle with the outcome we really got; a lost answer is repeated only while the row still says "claimed"
          for (let tries = 0; ; tries++) {
            try {
              const r = await m.effects.settleEffect({ ...caller, effectId: effect.id, attemptId: effect.attempt_id!, ...settle })
              if (r.settled) break
              if (r.reason === 'stale_lease' || r.reason === 'lease_expired') return { ...base, steps, kind: 'lease_lost', reason: r.reason }
              if (r.reason === 'run_not_active') return notActive()
              if (r.reason === 'provider_message_conflict') {
                // the provider id is already another effect's: keep the attempt, record it as ambiguous for a human to reconcile
                settle = { outcome: 'ambiguous' as const, errorCode: 'wamid_conflict' }
                continue
              }
              const now = await m.effects.loadEffectAt(accountId, runId, run.versioned_revision)
              if (now?.state === 'claimed') return corrupt(`settle refused: ${r.reason ?? 'unknown'}`)
              break
            } catch (e) {
              const k = classify(e)
              if (k === 'corrupt' || k === 'controlled') return corrupt((e as Error).message)
              const now = await m.effects.loadEffectAt(accountId, runId, run.versioned_revision)
              if (now && now.state !== 'claimed') break
              if (tries >= maxRetries) throw e
            }
          }

          if (outcome.kind === 'not_dispatched') {
            // proven never delivered: the only automatic retry. Re-open with the sender's own evidence.
            for (let tries = 0; ; tries++) {
              try {
                const r = await m.effects.resolveEffect({ ...caller, effectId: effect.id, resolution: 'not_sent',
                  evidence: `sender reported not_dispatched${outcome.errorCode ? ` (${outcome.errorCode})` : ''}: the request never reached the provider (attempt ${effect.attempt})` })
                if (r.resolved) break
                if (r.reason === 'stale_lease' || r.reason === 'lease_expired') return { ...base, steps, kind: 'lease_lost', reason: r.reason }
                if (r.reason === 'run_not_active') return notActive()
                break
              } catch (e) {
                const k = classify(e)
                if (k === 'corrupt' || k === 'controlled') return corrupt((e as Error).message)
                const now = await m.effects.loadEffectAt(accountId, runId, run.versioned_revision)
                if (now && now.state !== 'ambiguous') break
                if (tries >= maxRetries) throw e
              }
            }
            if (++notDispatched > maxNotDispatched) return exit({ ...base, steps, kind: 'send_deferred', effectId: effect.id, attempts: effect.attempt })
          }
          continue   // re-read: confirmed -> advance, failed -> fail the run, ambiguous -> wait, pending -> next attempt
        }
      }
    }
    return corrupt('message node made no progress')
  }

  while (true) {
    const run = await store.loadRun(accountId, runId)
    if (!run) return { ...base, steps, kind: 'not_found' }
    if (run.status !== 'active') return exit({ ...base, steps, kind: 'not_active', status: run.status })
    if (steps >= maxSteps) return exit({ ...base, steps, kind: 'yielded', revision: run.versioned_revision })

    const cp = parseVersionedCheckpoint(run.versioned_checkpoint)
    if (!cp) return exit({ ...base, steps, kind: 'corrupt_checkpoint', message: 'versioned_checkpoint is malformed' })
    if (cp.state === 'terminal') return exit({ ...base, steps, kind: 'corrupt_checkpoint', message: 'active run carries a terminal checkpoint' })
    if (cp.cursor.flow_version_id !== run.current_flow_version_id || cp.cursor.node_key !== run.versioned_node_key) {
      return exit({ ...base, steps, kind: 'corrupt_checkpoint', message: 'checkpoint cursor and run cursor disagree' })
    }

    let snapshot: VersionSnapshot, node
    try { ({ snapshot, node } = await loader.resolve(cp.cursor)) } catch (e) {
      if (e instanceof SnapshotError) return exit({ ...base, steps, kind: 'snapshot_error', code: e.code, message: e.message })
      throw e
    }

    if (steps > 0) {
      const renewed = await store.renewLease(accountId, runId, owner, token, ttl)
      if (!renewed.renewed) return renewed.reason === 'run_not_active' ? notActive() : { ...base, steps, kind: 'lease_lost', reason: renewed.reason ?? 'unknown' }
    }

    if (run.versioned_nodes_executed + 1 > VERSIONED_LIMITS.maxNodes) {
      const r = await failRun(run, cp, 'node_budget_exceeded')
      if (r === 'continue') continue
      return r
    }

    const confirmed = { flow_version_id: cp.cursor.flow_version_id, node_key: cp.cursor.node_key, step: cp.step }
    const budgetFailure = (res: Refusal) => (res.reason === 'budget_exceeded' ? 'node_budget_exceeded' : null)
    let verdict: VersionedRunOutcome | 'continue' | 'committed'

    if (node.node_type === 'start') {
      const next = (node.config as { next_node_key?: unknown }).next_node_key
      if (typeof next !== 'string' || !snapshot.node(next)) { const r = await failRun(run, cp, 'invalid_next_node'); if (r === 'continue') continue; return r }
      const a = await attempt(run, () => commit(run, {
        cursor: { flow_version_id: snapshot.versionId, node_key: next }, step: cp.step + 1, state: 'pending', confirmed, failure: null,
      }, { nodesDelta: 1 }))
      verdict = await settle(run, cp, a, budgetFailure)
    } else if (node.node_type === 'execute_flow') {
      const cfg = parseExecuteFlowConfig(node.config)
      if (!cfg || !snapshot.node(cfg.next_node_key)) { const r = await failRun(run, cp, 'invalid_execute_flow_config'); if (r === 'continue') continue; return r }
      const a = await attempt(run, () => store.pushSubflow({
        accountId, runId, owner, fencingToken: token, expectedRevision: run.versioned_revision,
        callNodeKey: node.node_key, returnNodeKey: cfg.next_node_key, targetFlowId: cfg.target_flow_id,
      }))
      verdict = await settle<SubflowResult>(run, cp, a, (res) => {
        switch (res.reason) {
          case 'budget_exceeded': return 'node_budget_exceeded'
          case 'depth_exceeded': return 'subflow_depth_exceeded'
          case 'recursion_detected': return 'subflow_recursion'
          default: return null
        }
      })
    } else if (node.node_type === 'end') {
      if (run.versioned_depth > 0) {
        // nested END: return to the caller recorded in the persisted top frame; the run stays active
        const a = await attempt(run, () => store.popSubflow({ accountId, runId, owner, fencingToken: token, expectedRevision: run.versioned_revision }))
        verdict = await settle<SubflowResult>(run, cp, a, budgetFailure)
      } else {
        if ((await store.countCallFrames(accountId, runId)) > 0) { const r = await failRun(run, cp, 'end_with_active_frames'); if (r === 'continue') continue; return r }
        if (cp.cursor.flow_version_id !== run.root_flow_version_id) { const r = await failRun(run, cp, 'end_outside_root_flow'); if (r === 'continue') continue; return r }
        const a = await attempt(run, () => commit(run, checkpointDoc(cp, { step: cp.step + 1, state: 'terminal', failure: null, confirmed }),
          { status: 'completed', endReason: 'end_node', nodesDelta: 1 }))
        verdict = await settle(run, cp, a, budgetFailure)
        if (verdict === 'committed' && a.t === 'ok') { steps++; return { ...base, steps, kind: 'completed', revision: a.res.revision, nodesExecuted: a.res.nodesExecuted } }
      }
    } else if (messaging && (node.node_type === 'send_message' || node.node_type === 'send_media')) {
      const r = await processMessage(run, cp, node, snapshot)
      if (r === 'advanced') { steps++; continue }
      if (r === 'continue') continue
      return r
    } else {
      const r = await failRun(run, cp, `unsupported_node_type:${node.node_type}`)
      if (r === 'continue') continue
      return r
    }

    if (verdict === 'committed') { steps++; continue }
    if (verdict === 'continue') continue
    return verdict
  }
}

export type { CommitResult }
