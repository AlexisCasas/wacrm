import { SnapshotError, SnapshotLoader, type VersionSnapshot } from './versioned-snapshot'
import { VERSIONED_LIMITS, parseExecuteFlowConfig, parseVersionedCheckpoint, type VersionedCheckpoint } from './versioned-runtime'
import { VersionedStoreError, type CommitResult, type SubflowResult, type VersionedRunRow, type VersionedRunStore } from './versioned-store'

/**
 * Interpreter for versioned runs (E4.2B1.3 + B2.2): START, END and execute_flow (subflows), from
 * immutable published snapshots. All state lives in PostgreSQL: lease + fencing + CAS (055/056) and
 * the call-frame RPCs (057/058). This module keeps only local variables, so a restarted process
 * resumes from the persisted cursor/frames; END decides root-vs-nested from the persisted depth.
 * PostgreSQL stays the only authority for atomicity and for changing flow version: calls and
 * returns go through push/pop_versioned_run_subflow, never through the generic commit.
 *
 * Not wired to production: no route, dispatcher or cron imports this file. It sends nothing.
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

  let lease = await store.acquireLease(accountId, runId, owner, ttl)
  if (!lease.acquired && lease.reason === 'lease_expired' && opts.recoverExpiredLease) lease = await store.reclaimLease(accountId, runId, owner, ttl)
  if (!lease.acquired) {
    if (lease.reason === 'run_not_active') return { ...base, steps, kind: 'not_active', status: (await store.loadRun(accountId, runId))?.status ?? 'unknown' }
    return { ...base, steps, kind: 'lease_unavailable', reason: lease.reason ?? 'unknown' }
  }
  const token = lease.fencingToken
  const loader = new SnapshotLoader(store, accountId)

  /** Gives the lease back on controlled exits only. A crash (thrown error) intentionally leaves it to expire. */
  const exit = async (outcome: VersionedRunOutcome): Promise<VersionedRunOutcome> => {
    try { await store.releaseLease(accountId, runId, owner, token) } catch { /* best effort; the lease expires on its own */ }
    return outcome
  }
  const notActive = async () => exit({ ...base, steps, kind: 'not_active', status: (await store.loadRun(accountId, runId))?.status ?? 'unknown' })

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
