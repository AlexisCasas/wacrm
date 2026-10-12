import { SnapshotError, SnapshotLoader, type VersionSnapshot } from './versioned-snapshot'
import { VERSIONED_LIMITS, parseVersionedCheckpoint, type VersionedCheckpoint } from './versioned-runtime'
import type { CommitResult, VersionedRunRow, VersionedRunStore } from './versioned-store'

/**
 * E4.2B1.3 minimal interpreter for versioned runs: START -> END only, from immutable published
 * snapshots. State lives in PostgreSQL (lease + fencing + CAS from migrations 055/056); this module
 * keeps nothing but local variables, so a restarted process resumes from the persisted checkpoint.
 *
 * Not wired to production: no route, dispatcher, cron or sender imports this file.
 */

export interface RunVersionedFlowOptions {
  accountId: string; runId: string; owner: string
  /** Lease length requested from the server; default 60s. */
  ttlSeconds?: number
  /** Commits per invocation before yielding; default = node budget. */
  maxSteps?: number
  /** Take over an expired lease through the explicit reclaim RPC (bumps the fencing token). Default false. */
  recoverExpiredLease?: boolean
}

interface OutcomeBase { flowRunId: string; steps: number }
export type VersionedRunOutcome = OutcomeBase & (
  | { kind: 'completed'; revision: number; nodesExecuted: number }
  /** The interpreter ended the run as `failed` (unsupported node, bad edge, budget...). */
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

export async function runVersionedFlow(store: VersionedRunStore, opts: RunVersionedFlowOptions): Promise<VersionedRunOutcome> {
  const { accountId, runId, owner } = opts
  const ttl = opts.ttlSeconds ?? 60
  const maxSteps = Math.min(opts.maxSteps ?? VERSIONED_LIMITS.maxNodes, VERSIONED_LIMITS.maxNodes)
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

  const commit = (run: VersionedRunRow, cp: VersionedCheckpoint, extra: { status?: 'completed' | 'failed'; endReason?: string; nodesDelta?: number }) =>
    store.commitTransition({
      accountId, runId, owner, fencingToken: token, expectedRevision: run.versioned_revision, checkpoint: cp,
      status: extra.status ?? 'active', endReason: extra.endReason ?? null, nodesDelta: extra.nodesDelta ?? 0,
    })

  const checkpointDoc = (cp: VersionedCheckpoint, over: Partial<VersionedCheckpoint>): VersionedCheckpoint => ({ ...cp, ...over })

  // Maps a refused commit to an outcome. The lease is only released when it is still ours.
  const refused = async (res: CommitResult): Promise<VersionedRunOutcome> => {
    switch (res.reason) {
      case 'stale_lease': case 'lease_expired': return { ...base, steps, kind: 'lease_lost', reason: res.reason }
      case 'run_not_active': {
        const now = await store.loadRun(accountId, runId)
        return exit({ ...base, steps, kind: 'not_active', status: now?.status ?? 'unknown' })
      }
      default: return exit({ ...base, steps, kind: 'revision_conflict', revision: res.revision })
    }
  }

  // Terminal failure owned by the interpreter: the cursor stays on the node that could not be run.
  const failRun = async (run: VersionedRunRow, cp: VersionedCheckpoint, reason: string): Promise<VersionedRunOutcome> => {
    const res = await commit(run, checkpointDoc(cp, { step: cp.step + 1, state: 'terminal', failure: reason }), { status: 'failed', endReason: reason })
    if (!res.committed) return refused(res)
    steps++
    return { ...base, steps, kind: 'failed', reason, revision: res.revision, nodesExecuted: res.nodesExecuted }
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
      if (!renewed.renewed) return renewed.reason === 'run_not_active'
        ? exit({ ...base, steps, kind: 'not_active', status: (await store.loadRun(accountId, runId))?.status ?? 'unknown' })
        : { ...base, steps, kind: 'lease_lost', reason: renewed.reason ?? 'unknown' }
    }

    if (run.versioned_nodes_executed + 1 > VERSIONED_LIMITS.maxNodes) return failRun(run, cp, 'node_budget_exceeded')

    let res: CommitResult
    if (node.node_type === 'start') {
      const next = (node.config as { next_node_key?: unknown }).next_node_key
      if (typeof next !== 'string' || !snapshot.node(next)) return failRun(run, cp, 'invalid_next_node')
      res = await commit(run, {
        cursor: { flow_version_id: snapshot.versionId, node_key: next }, step: cp.step + 1, state: 'pending',
        confirmed: { flow_version_id: cp.cursor.flow_version_id, node_key: cp.cursor.node_key, step: cp.step }, failure: null,
      }, { nodesDelta: 1 })
      if (res.reason === 'budget_exceeded') return failRun(run, cp, 'node_budget_exceeded')
    } else if (node.node_type === 'end') {
      if (cp.cursor.flow_version_id !== run.root_flow_version_id) return failRun(run, cp, 'end_outside_root_flow')
      if (run.versioned_depth > 0 || (await store.countCallFrames(accountId, runId)) > 0) return failRun(run, cp, 'end_with_active_frames')
      res = await commit(run, checkpointDoc(cp, {
        step: cp.step + 1, state: 'terminal', failure: null,
        confirmed: { flow_version_id: cp.cursor.flow_version_id, node_key: cp.cursor.node_key, step: cp.step },
      }), { status: 'completed', endReason: 'end_node', nodesDelta: 1 })
      if (res.reason === 'budget_exceeded') return failRun(run, cp, 'node_budget_exceeded')
    } else {
      return failRun(run, cp, `unsupported_node_type:${node.node_type}`)
    }

    if (!res.committed) return refused(res)
    steps++
    if (node.node_type === 'end') {
      return { ...base, steps, kind: 'completed', revision: res.revision, nodesExecuted: res.nodesExecuted }
    }
  }
}
