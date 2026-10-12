import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { runVersionedFlow } from './versioned-interpreter'
import { buildSnapshot, SnapshotError, SnapshotLoader } from './versioned-snapshot'
import { parseVersionedCheckpoint } from './versioned-runtime'
import { createSupabaseRunStore, VersionedStoreError, type VersionedRunRow, type VersionedRunStore } from './versioned-store'

const A = 'acct-1', RUN = 'run-1', V = 'ver-1'
const node = (key: string, type: string, config: Record<string, unknown> = {}) => ({ node_key: key, node_type: type, config, position_x: 0, position_y: 0 })
const definition = (nodes: unknown[]) => ({ flow: { id: 'flow-1', name: 'F', description: null, trigger_type: 'manual', trigger_config: {}, entry_node_id: 'start', fallback_policy: {} }, nodes })
const versionRow = (nodes: unknown[], over = {}) => ({ id: V, flow_id: 'flow-1', account_id: A, definition: definition(nodes), ...over })
const runRow = (over: Partial<VersionedRunRow> = {}): VersionedRunRow => ({
  id: RUN, account_id: A, flow_id: 'flow-1', status: 'active', execution_mode: 'versioned', root_flow_version_id: V, current_flow_version_id: V, versioned_node_key: 'start',
  versioned_nodes_executed: 0, versioned_messages_executed: 0, versioned_depth: 0, versioned_checkpoint: { cursor: { flow_version_id: V, node_key: 'start' }, step: 0 },
  versioned_lease: 0, versioned_revision: 0, versioned_lease_owner: null, versioned_lease_expires_at: null, ...over,
})

function stubStore(over: Partial<VersionedRunStore> = {}): VersionedRunStore & { calls: string[] } {
  const calls: string[] = []
  const track = <T>(name: string, value: T) => (async () => { calls.push(name); return value })
  const store: VersionedRunStore = {
    loadRun: async () => runRow(),
    loadVersion: async () => versionRow([node('start', 'start', { next_node_key: 'end' }), node('end', 'end')]),
    countCallFrames: async () => 0,
    acquireLease: track('acquire', { acquired: true, fencingToken: 1, leaseExpiresAt: 'x', revision: 0, reason: null }),
    reclaimLease: track('reclaim', { acquired: true, fencingToken: 2, leaseExpiresAt: 'x', revision: 0, reason: null }),
    renewLease: track('renew', { renewed: true, leaseExpiresAt: 'x', reason: null }),
    releaseLease: track('release', { released: true, reason: null }),
    commitTransition: track('commit', { committed: true, revision: 1, reason: null, nodesExecuted: 1, messagesExecuted: 0 }),
    ...over,
  }
  return Object.assign(store, { calls })
}
const opts = { accountId: A, runId: RUN, owner: 'w1' }

describe('parseVersionedCheckpoint', () => {
  it('accepts the creation checkpoint and interpreter checkpoints', () => {
    expect(parseVersionedCheckpoint({ cursor: { flow_version_id: V, node_key: 'start' }, step: 0 })).toEqual({ cursor: { flow_version_id: V, node_key: 'start' }, step: 0, state: 'pending', confirmed: null, failure: null })
    expect(parseVersionedCheckpoint({ cursor: { flow_version_id: V, node_key: 'end' }, step: 2, state: 'terminal', confirmed: { flow_version_id: V, node_key: 'end', step: 1 }, failure: 'x' })?.state).toBe('terminal')
  })
  it.each([null, [], {}, { cursor: {}, step: 0 }, { cursor: { flow_version_id: V, node_key: 'a' }, step: -1 }, { cursor: { flow_version_id: V, node_key: 'a' }, step: 1.5 },
    { cursor: { flow_version_id: V, node_key: 'a' }, step: 0, state: 'weird' }, { cursor: { flow_version_id: V, node_key: 'a' }, step: 0, confirmed: 'x' }])('rejects %j', (v) => expect(parseVersionedCheckpoint(v)).toBeNull())
})

describe('snapshots', () => {
  it('rejects another account, invalid definitions, duplicate keys and a foreign flow definition', () => {
    const ok = [node('start', 'start')]
    expect(() => buildSnapshot(versionRow(ok, { account_id: 'other' }), A)).toThrowError(expect.objectContaining({ code: 'account_mismatch' }))
    expect(() => buildSnapshot(versionRow('nope' as unknown as unknown[]), A)).toThrowError(expect.objectContaining({ code: 'invalid_definition' }))
    expect(() => buildSnapshot(versionRow([node('a', 'start'), node('a', 'end')]), A)).toThrowError(expect.objectContaining({ code: 'invalid_definition' }))
    expect(() => buildSnapshot(versionRow(ok, { flow_id: 'flow-2' }), A)).toThrowError(expect.objectContaining({ code: 'flow_mismatch' }))
    expect(buildSnapshot(versionRow(ok), A).node('start')?.node_type).toBe('start')
  })
  it('caches immutable versions and never touches live flow tables', async () => {
    const loadVersion = vi.fn(async () => versionRow([node('start', 'start')]))
    const loader = new SnapshotLoader({ loadVersion }, A)
    await loader.get(V); await loader.get(V)
    expect(loadVersion).toHaveBeenCalledTimes(1)
    await expect(new SnapshotLoader({ loadVersion: async () => null }, A).get('x')).rejects.toBeInstanceOf(SnapshotError)
    await expect(loader.resolve({ flow_version_id: V, node_key: 'ghost' })).rejects.toMatchObject({ code: 'node_not_found' })
  })
})

describe('createSupabaseRunStore (PostgREST response shapes)', () => {
  const clientWith = (rpc: (fn: string, args: Record<string, unknown>) => unknown) => ({ rpc: async (fn: string, args: Record<string, unknown>) => rpc(fn, args) }) as unknown as SupabaseClient
  it('reads RETURNS TABLE results as an array of rows, tolerates bigint strings and a bare object', async () => {
    const store = createSupabaseRunStore(clientWith(() => ({ data: [{ acquired: true, fencing_token: 3, lease_expires_at: '2026-01-01T00:00:00Z', revision: '7', reason: null }], error: null })))
    expect(await store.acquireLease(A, RUN, 'w', 30)).toEqual({ acquired: true, fencingToken: 3, leaseExpiresAt: '2026-01-01T00:00:00Z', revision: 7, reason: null })
    const bare = createSupabaseRunStore(clientWith(() => ({ data: { released: false, reason: 'stale_lease' }, error: null })))
    expect(await bare.releaseLease(A, RUN, 'w', 1)).toEqual({ released: false, reason: 'stale_lease' })
  })
  it('maps arguments to the SQL parameter names and parses commit results', async () => {
    const rpc = vi.fn(() => ({ data: [{ committed: false, revision: 4, reason: 'revision_conflict', nodes_executed: 2, messages_executed: 0 }], error: null }))
    const store = createSupabaseRunStore(clientWith(rpc))
    const res = await store.commitTransition({ accountId: A, runId: RUN, owner: 'w', fencingToken: 2, expectedRevision: 3, checkpoint: { c: 1 }, nodesDelta: 1 })
    expect(res).toEqual({ committed: false, revision: 4, reason: 'revision_conflict', nodesExecuted: 2, messagesExecuted: 0 })
    expect(rpc).toHaveBeenCalledWith('commit_versioned_run_transition', { p_account_id: A, p_run_id: RUN, p_owner: 'w', p_fencing_token: 2, p_expected_revision: 3, p_checkpoint: { c: 1 }, p_status: 'active', p_end_reason: null, p_nodes_delta: 1, p_messages_delta: 0 })
  })
  it('raises typed errors for RPC errors and malformed responses', async () => {
    const err = createSupabaseRunStore(clientWith(() => ({ data: null, error: { code: 'P0002', message: 'versioned run not found' } })))
    await expect(err.acquireLease(A, RUN, 'w', 30)).rejects.toMatchObject({ name: 'VersionedStoreError', code: 'P0002' })
    for (const data of [[], null, [{ acquired: 'yes', fencing_token: 1, revision: 0 }], [{ acquired: true, fencing_token: 'x', revision: 0 }]]) {
      const bad = createSupabaseRunStore(clientWith(() => ({ data, error: null })))
      await expect(bad.acquireLease(A, RUN, 'w', 30)).rejects.toBeInstanceOf(VersionedStoreError)
    }
  })
})

describe('runVersionedFlow control flow (stubbed store)', () => {
  it('returns not_found for missing and legacy runs without touching leases', async () => {
    const s1 = stubStore({ loadRun: async () => null })
    expect(await runVersionedFlow(s1, opts)).toMatchObject({ kind: 'not_found' })
    const s2 = stubStore({ loadRun: async () => runRow({ execution_mode: 'legacy' }) })
    expect(await runVersionedFlow(s2, opts)).toMatchObject({ kind: 'not_found' })
    expect([...s1.calls, ...s2.calls]).toEqual([])
  })
  it('does not release a lease it never got, and only reclaims an expired lease when asked', async () => {
    const held = stubStore({ acquireLease: async () => ({ acquired: false, fencingToken: 1, leaseExpiresAt: null, revision: 0, reason: 'lease_held' }) })
    expect(await runVersionedFlow(held, { ...opts, recoverExpiredLease: true })).toMatchObject({ kind: 'lease_unavailable', reason: 'lease_held' })
    expect(held.calls).toEqual([])
    const expired = { acquired: false, fencingToken: 1, leaseExpiresAt: null, revision: 0, reason: 'lease_expired' as const }
    const off = stubStore({ acquireLease: async () => expired })
    expect(await runVersionedFlow(off, opts)).toMatchObject({ kind: 'lease_unavailable', reason: 'lease_expired' })
    expect(off.calls).not.toContain('reclaim')
    const on = stubStore({ acquireLease: async () => expired, loadRun: vi.fn().mockResolvedValueOnce(runRow()).mockResolvedValue(runRow({ status: 'paused_by_agent' })) })
    await runVersionedFlow(on, { ...opts, recoverExpiredLease: true })
    expect(on.calls[0]).toBe('reclaim')
    expect(on.calls).toContain('release')
  })
  it('keeps a corrupt checkpoint untouched and releases the lease', async () => {
    const store = stubStore({ loadRun: vi.fn().mockResolvedValueOnce(runRow()).mockResolvedValue(runRow({ versioned_checkpoint: { nope: true } })) })
    expect(await runVersionedFlow(store, opts)).toMatchObject({ kind: 'corrupt_checkpoint' })
    expect(store.calls).toEqual(['acquire', 'release'])
  })
  it('detects a checkpoint that disagrees with the run cursor', async () => {
    const store = stubStore({ loadRun: vi.fn().mockResolvedValueOnce(runRow()).mockResolvedValue(runRow({ versioned_node_key: 'end' })) })
    expect(await runVersionedFlow(store, opts)).toMatchObject({ kind: 'corrupt_checkpoint' })
  })
  it('on a thrown error (process death) leaves the lease alone', async () => {
    const store = stubStore({ commitTransition: async () => { throw new Error('boom') } })
    await expect(runVersionedFlow(store, opts)).rejects.toThrow('boom')
    expect(store.calls).toEqual(['acquire'])
  })
  it('treats stale_lease / lease_expired commits as lease_lost without releasing', async () => {
    for (const reason of ['stale_lease', 'lease_expired'] as const) {
      const store = stubStore({ commitTransition: async () => ({ committed: false, revision: 0, reason, nodesExecuted: 0, messagesExecuted: 0 }) })
      expect(await runVersionedFlow(store, opts)).toMatchObject({ kind: 'lease_lost', reason })
      expect(store.calls).toEqual(['acquire'])
    }
  })
  it('reports revision_conflict and releases', async () => {
    const store = stubStore({ commitTransition: async () => ({ committed: false, revision: 5, reason: 'revision_conflict', nodesExecuted: 1, messagesExecuted: 0 }) })
    expect(await runVersionedFlow(store, opts)).toMatchObject({ kind: 'revision_conflict', revision: 5 })
    expect(store.calls).toEqual(['acquire', 'release'])
  })
  it('commits START with one node of budget and a pending cursor at the next node', async () => {
    const commits: unknown[] = []
    const store = stubStore({ commitTransition: async (i) => { commits.push(i); return { committed: true, revision: 1, reason: null, nodesExecuted: 1, messagesExecuted: 0 } } })
    expect(await runVersionedFlow(store, { ...opts, maxSteps: 1 })).toMatchObject({ kind: 'yielded', steps: 1 })
    expect(commits[0]).toMatchObject({ expectedRevision: 0, fencingToken: 1, nodesDelta: 1, status: 'active', checkpoint: { cursor: { flow_version_id: V, node_key: 'end' }, step: 1, state: 'pending', confirmed: { node_key: 'start', step: 0 } } })
  })
})

describe('isolation from production code', () => {
  it('is not imported by any non-test module', () => {
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) { walk(p); continue }
        if (!/\.(ts|tsx)$/.test(name) || /\.test\.tsx?$/.test(name) || p.includes('/test-support/')) continue
        if (/^versioned-(interpreter|store|snapshot)\.ts$/.test(name)) continue
        if (/versioned-(interpreter|store|snapshot)['"]/.test(readFileSync(p, 'utf8'))) offenders.push(p)
      }
    }
    walk(join(process.cwd(), 'src'))
    expect(offenders).toEqual([])
  })
})
