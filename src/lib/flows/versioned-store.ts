import type { SupabaseClient } from '@supabase/supabase-js'

/** Thin, typed access to the B1.1-B1.3 RPCs and the few tables the versioned interpreter reads.
 * PostgREST returns RETURNS TABLE functions as an array of row objects; every response is
 * validated here so the interpreter only ever sees well-formed values. */

export class VersionedStoreError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'VersionedStoreError' }
}

export interface VersionedRunRow {
  id: string; account_id: string; flow_id: string; status: string; execution_mode: string
  root_flow_version_id: string | null; current_flow_version_id: string | null; versioned_node_key: string | null
  versioned_nodes_executed: number; versioned_messages_executed: number; versioned_depth: number
  versioned_checkpoint: unknown; versioned_lease: number; versioned_revision: number
  versioned_lease_owner: string | null; versioned_lease_expires_at: string | null
}
export interface FlowVersionRow { id: string; flow_id: string; account_id: string; definition: unknown }

export type LeaseDenial = 'lease_held' | 'lease_expired' | 'no_lease' | 'run_not_active'
export interface LeaseGrant { acquired: boolean; fencingToken: number; leaseExpiresAt: string | null; revision: number; reason: LeaseDenial | null }
export interface RenewResult { renewed: boolean; leaseExpiresAt: string | null; reason: 'stale_lease' | 'lease_expired' | 'run_not_active' | null }
export interface ReleaseResult { released: boolean; reason: 'stale_lease' | null }
export type CommitDenial = 'run_not_active' | 'stale_lease' | 'lease_expired' | 'revision_conflict' | 'budget_exceeded'
export interface CommitInput {
  accountId: string; runId: string; owner: string; fencingToken: number; expectedRevision: number
  checkpoint: unknown; status?: 'active' | 'completed' | 'handed_off' | 'failed'; endReason?: string | null
  nodesDelta?: number; messagesDelta?: number
}
export interface CommitResult { committed: boolean; revision: number; reason: CommitDenial | null; nodesExecuted: number; messagesExecuted: number }

export interface VersionedRunStore {
  loadRun(accountId: string, runId: string): Promise<VersionedRunRow | null>
  loadVersion(accountId: string, versionId: string): Promise<FlowVersionRow | null>
  countCallFrames(accountId: string, runId: string): Promise<number>
  acquireLease(accountId: string, runId: string, owner: string, ttlSeconds: number): Promise<LeaseGrant>
  reclaimLease(accountId: string, runId: string, owner: string, ttlSeconds: number): Promise<LeaseGrant>
  renewLease(accountId: string, runId: string, owner: string, fencingToken: number, ttlSeconds: number): Promise<RenewResult>
  releaseLease(accountId: string, runId: string, owner: string, fencingToken: number): Promise<ReleaseResult>
  commitTransition(input: CommitInput): Promise<CommitResult>
}

const RUN_COLUMNS = 'id,account_id,flow_id,status,execution_mode,root_flow_version_id,current_flow_version_id,versioned_node_key,versioned_nodes_executed,versioned_messages_executed,versioned_depth,versioned_checkpoint,versioned_lease,versioned_revision,versioned_lease_owner,versioned_lease_expires_at'

function isRecord(v: unknown): v is Record<string, unknown> { return !!v && typeof v === 'object' && !Array.isArray(v) }
/** bigint columns may arrive as JSON numbers or strings depending on the transport. */
function toInt(v: unknown, field: string): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  if (typeof n !== 'number' || !Number.isSafeInteger(n)) throw new VersionedStoreError('bad_response', `unexpected ${field}: ${String(v)}`)
  return n
}
function toBool(v: unknown, field: string): boolean {
  if (typeof v !== 'boolean') throw new VersionedStoreError('bad_response', `unexpected ${field}: ${String(v)}`)
  return v
}
function toNullableString(v: unknown, field: string): string | null {
  if (v === null || v === undefined) return null
  if (typeof v !== 'string') throw new VersionedStoreError('bad_response', `unexpected ${field}`)
  return v
}
/** RETURNS TABLE -> `[row]` over PostgREST; a bare object is tolerated, anything else is an error. */
export function firstRow(data: unknown, fn: string): Record<string, unknown> {
  const row = Array.isArray(data) ? data[0] : data
  if (!isRecord(row)) throw new VersionedStoreError('bad_response', `${fn} returned no row`)
  return row
}

export function createSupabaseRunStore(client: SupabaseClient): VersionedRunStore {
  async function rpc(fn: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { data, error } = await client.rpc(fn, args)
    if (error) throw new VersionedStoreError(error.code || 'rpc_error', `${fn}: ${error.message}`)
    return firstRow(data, fn)
  }
  const grant = (row: Record<string, unknown>): LeaseGrant => ({
    acquired: toBool(row.acquired, 'acquired'), fencingToken: toInt(row.fencing_token, 'fencing_token'),
    leaseExpiresAt: toNullableString(row.lease_expires_at, 'lease_expires_at'), revision: toInt(row.revision, 'revision'),
    reason: toNullableString(row.reason, 'reason') as LeaseDenial | null,
  })
  return {
    async loadRun(accountId, runId) {
      const { data, error } = await client.from('flow_runs').select(RUN_COLUMNS).eq('id', runId).eq('account_id', accountId).maybeSingle()
      if (error) throw new VersionedStoreError(error.code || 'query_error', `flow_runs: ${error.message}`)
      if (!data) return null
      const r = data as unknown as Record<string, unknown>
      return { ...(r as unknown as VersionedRunRow), versioned_nodes_executed: toInt(r.versioned_nodes_executed, 'versioned_nodes_executed'),
        versioned_messages_executed: toInt(r.versioned_messages_executed, 'versioned_messages_executed'), versioned_depth: toInt(r.versioned_depth, 'versioned_depth'),
        versioned_lease: toInt(r.versioned_lease, 'versioned_lease'), versioned_revision: toInt(r.versioned_revision, 'versioned_revision') }
    },
    async loadVersion(accountId, versionId) {
      const { data, error } = await client.from('flow_versions').select('id,flow_id,account_id,definition').eq('id', versionId).eq('account_id', accountId).maybeSingle()
      if (error) throw new VersionedStoreError(error.code || 'query_error', `flow_versions: ${error.message}`)
      return (data as FlowVersionRow | null) ?? null
    },
    async countCallFrames(accountId, runId) {
      const { count, error } = await client.from('flow_run_call_frames').select('id', { count: 'exact', head: true }).eq('flow_run_id', runId).eq('account_id', accountId)
      if (error) throw new VersionedStoreError(error.code || 'query_error', `flow_run_call_frames: ${error.message}`)
      return count ?? 0
    },
    async acquireLease(accountId, runId, owner, ttlSeconds) {
      return grant(await rpc('acquire_versioned_run_lease', { p_account_id: accountId, p_run_id: runId, p_owner: owner, p_ttl_seconds: ttlSeconds }))
    },
    async reclaimLease(accountId, runId, owner, ttlSeconds) {
      return grant(await rpc('reclaim_versioned_run_lease', { p_account_id: accountId, p_run_id: runId, p_owner: owner, p_ttl_seconds: ttlSeconds }))
    },
    async renewLease(accountId, runId, owner, fencingToken, ttlSeconds) {
      const row = await rpc('renew_versioned_run_lease', { p_account_id: accountId, p_run_id: runId, p_owner: owner, p_fencing_token: fencingToken, p_ttl_seconds: ttlSeconds })
      return { renewed: toBool(row.renewed, 'renewed'), leaseExpiresAt: toNullableString(row.lease_expires_at, 'lease_expires_at'), reason: toNullableString(row.reason, 'reason') as RenewResult['reason'] }
    },
    async releaseLease(accountId, runId, owner, fencingToken) {
      const row = await rpc('release_versioned_run_lease', { p_account_id: accountId, p_run_id: runId, p_owner: owner, p_fencing_token: fencingToken })
      return { released: toBool(row.released, 'released'), reason: toNullableString(row.reason, 'reason') as ReleaseResult['reason'] }
    },
    async commitTransition(i) {
      const row = await rpc('commit_versioned_run_transition', {
        p_account_id: i.accountId, p_run_id: i.runId, p_owner: i.owner, p_fencing_token: i.fencingToken, p_expected_revision: i.expectedRevision,
        p_checkpoint: i.checkpoint, p_status: i.status ?? 'active', p_end_reason: i.endReason ?? null,
        p_nodes_delta: i.nodesDelta ?? 0, p_messages_delta: i.messagesDelta ?? 0,
      })
      return { committed: toBool(row.committed, 'committed'), revision: toInt(row.revision, 'revision'), reason: toNullableString(row.reason, 'reason') as CommitDenial | null,
        nodesExecuted: toInt(row.nodes_executed, 'nodes_executed'), messagesExecuted: toInt(row.messages_executed, 'messages_executed') }
    },
  }
}
