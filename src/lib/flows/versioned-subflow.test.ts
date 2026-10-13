import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { CUSTOM_CONDITION_ACCOUNT_IDS_ENV, isCustomConditionEnabledForAccount } from './custom-condition-capability'
import { isAutoAdvancing, isSuspending, isTerminal } from './engine'
import { runVersionedFlow } from './versioned-interpreter'
import { parseExecuteFlowConfig } from './versioned-runtime'
import { createSupabaseRunStore, VersionedStoreError, type SubflowResult, type VersionedRunRow, type VersionedRunStore } from './versioned-store'
import { validateFlowForActivation } from './validate'

const A = 'acct-1', RUN = 'run-1', VA = 'ver-a', VB = 'ver-b'
const TARGET = '0a1b2c3d-0000-4000-8000-000000000001'
const node = (key: string, type: string, config: Record<string, unknown> = {}) => ({ node_key: key, node_type: type, config, position_x: 0, position_y: 0 })
const defn = (id: string, nodes: unknown[]) => ({ flow: { id, name: id, description: null, trigger_type: 'manual', trigger_config: {}, entry_node_id: 'start', fallback_policy: {} }, nodes })
const versions: Record<string, unknown> = {
  [VA]: { id: VA, flow_id: 'flow-a', account_id: A, definition: defn('flow-a', [node('start', 'start', { next_node_key: 'call' }), node('call', 'execute_flow', { target_flow_id: TARGET, next_node_key: 'fin' }), node('fin', 'end')]) },
  [VB]: { id: VB, flow_id: 'flow-b', account_id: A, definition: defn('flow-b', [node('bstart', 'start', { next_node_key: 'bend' }), node('bend', 'end')]) },
}
const run = (over: Partial<VersionedRunRow> = {}): VersionedRunRow => ({
  id: RUN, account_id: A, flow_id: 'flow-a', status: 'active', execution_mode: 'versioned', root_flow_version_id: VA, current_flow_version_id: VA, versioned_node_key: 'call',
  versioned_nodes_executed: 1, versioned_messages_executed: 0, versioned_depth: 0, versioned_checkpoint: { cursor: { flow_version_id: VA, node_key: 'call' }, step: 1 },
  versioned_lease: 1, versioned_revision: 1, versioned_lease_owner: 'w1', versioned_lease_expires_at: 'x', ...over,
})
const pushed: SubflowResult = { committed: true, revision: 2, reason: null, newDepth: 1, cursorFlowVersionId: VB, cursorNodeKey: 'bstart', nodesExecuted: 2, messagesExecuted: 0 }
const refusal = (reason: SubflowResult['reason']): SubflowResult => ({ ...pushed, committed: false, reason, revision: 1 })

function store(over: Partial<VersionedRunStore> = {}) {
  const calls: Array<[string, unknown]> = []
  const rec = <T>(name: string, value: T) => async (input?: unknown) => { calls.push([name, input]); return value }
  const s: VersionedRunStore = {
    loadRun: async () => run(), loadVersion: async (_a, id) => (versions[id] as never) ?? null, countCallFrames: async () => 0,
    acquireLease: rec('acquire', { acquired: true, fencingToken: 1, leaseExpiresAt: 'x', revision: 1, reason: null }),
    reclaimLease: rec('reclaim', { acquired: true, fencingToken: 2, leaseExpiresAt: 'x', revision: 1, reason: null }),
    renewLease: rec('renew', { renewed: true, leaseExpiresAt: 'x', reason: null }), releaseLease: rec('release', { released: true, reason: null }),
    commitTransition: rec('commit', { committed: true, revision: 2, reason: null, nodesExecuted: 2, messagesExecuted: 0 }),
    pushSubflow: rec('push', pushed), popSubflow: rec('pop', { ...pushed, newDepth: 0, cursorFlowVersionId: VA, cursorNodeKey: 'fin' }), ...over,
  }
  return Object.assign(s, { calls })
}
const opts = { accountId: A, runId: RUN, owner: 'w1' }
const names = (s: { calls: Array<[string, unknown]> }) => s.calls.map(([n]) => n)

describe('execute_flow in the validator', () => {
  const flow = { name: 'F', trigger_type: 'manual' as const, trigger_config: {}, entry_node_id: 'start' }
  const nodes = (cfg: Record<string, unknown>) => [
    { node_key: 'start', node_type: 'start', config: { next_node_key: 'call' } },
    { node_key: 'call', node_type: 'execute_flow', config: cfg },
    { node_key: 'fin', node_type: 'end', config: {} },
  ]
  it('is rejected by default, so the legacy activation path can never publish it', () => {
    const issues = validateFlowForActivation(flow, nodes({ target_flow_id: TARGET, next_node_key: 'fin' }))
    expect(issues.some((i) => i.severity === 'error' && i.node_key === 'call' && /versioned execution/.test(i.message))).toBe(true)
  })
  it('is accepted with versionedExecution when well formed', () => {
    const issues = validateFlowForActivation(flow, nodes({ target_flow_id: TARGET, next_node_key: 'fin' }), { versionedExecution: true })
    expect(issues.filter((i) => i.severity === 'error')).toEqual([])
  })
  it.each([
    [{ next_node_key: 'fin' }, 'target_flow_id'], [{ target_flow_id: 'nope', next_node_key: 'fin' }, 'target_flow_id'],
    [{ target_flow_id: TARGET }, 'next_node_key'], [{ target_flow_id: TARGET, next_node_key: 'ghost' }, 'next_node_key'],
  ])('rejects %j on %s', (cfg, field) => {
    const issues = validateFlowForActivation(flow, nodes(cfg), { versionedExecution: true })
    expect(issues.some((i) => i.severity === 'error' && i.field === field && i.node_key === 'call')).toBe(true)
  })
})

describe('parseExecuteFlowConfig', () => {
  it('requires a uuid target and a continuation key', () => {
    expect(parseExecuteFlowConfig({ target_flow_id: TARGET.toUpperCase(), next_node_key: 'n' })).toEqual({ target_flow_id: TARGET, next_node_key: 'n' })
    for (const bad of [null, [], {}, { target_flow_id: 'x', next_node_key: 'n' }, { target_flow_id: TARGET }, { target_flow_id: TARGET, next_node_key: '' }, { target_flow_id: 5, next_node_key: 'n' }]) {
      expect(parseExecuteFlowConfig(bad)).toBeNull()
    }
  })
})

describe('legacy engine and rollout gates stay untouched', () => {
  it('the legacy runner classifies execute_flow as nothing, so it falls to its unknown-node failure', () => {
    expect([isAutoAdvancing('execute_flow'), isSuspending('execute_flow'), isTerminal('execute_flow')]).toEqual([false, false, false])
    const src = readFileSync(join(process.cwd(), 'src/lib/flows/engine.ts'), 'utf8')
    expect(src).not.toContain('execute_flow')
    expect(src).toContain('unknown_node_type')
  })
  it('F04 stays off unless an operator lists the account, and nothing new reads that gate', () => {
    delete process.env[CUSTOM_CONDITION_ACCOUNT_IDS_ENV]
    expect(isCustomConditionEnabledForAccount('0a1b2c3d-0000-4000-8000-000000000001')).toBe(false)
  })
})

describe('createSupabaseRunStore push/pop', () => {
  const client = (rpc: (fn: string, args: Record<string, unknown>) => unknown) => ({ rpc: async (fn: string, args: Record<string, unknown>) => rpc(fn, args) }) as unknown as SupabaseClient
  it('maps arguments and parses the PostgREST row', async () => {
    const rpc = vi.fn(() => ({ data: [{ committed: true, revision: '3', reason: null, new_depth: 1, cursor_flow_version_id: VB, cursor_node_key: 'bstart', nodes_executed: 2, messages_executed: 0 }], error: null }))
    const s = createSupabaseRunStore(client(rpc))
    expect(await s.pushSubflow({ accountId: A, runId: RUN, owner: 'w', fencingToken: 2, expectedRevision: 2, callNodeKey: 'call', returnNodeKey: 'fin', targetFlowId: TARGET })).toEqual({ ...pushed, revision: 3 })
    expect(rpc).toHaveBeenCalledWith('push_versioned_run_subflow', { p_account_id: A, p_run_id: RUN, p_owner: 'w', p_fencing_token: 2, p_expected_revision: 2, p_call_node_key: 'call', p_return_node_key: 'fin', p_target_flow_id: TARGET })
    await s.popSubflow({ accountId: A, runId: RUN, owner: 'w', fencingToken: 2, expectedRevision: 3 })
    expect(rpc).toHaveBeenLastCalledWith('pop_versioned_run_subflow', { p_account_id: A, p_run_id: RUN, p_owner: 'w', p_fencing_token: 2, p_expected_revision: 3 })
  })
  it('turns SQL errors into typed errors the interpreter can classify', async () => {
    const s = createSupabaseRunStore(client(() => ({ data: null, error: { code: 'P0002', message: 'active published flow not found' } })))
    await expect(s.pushSubflow({ accountId: A, runId: RUN, owner: 'w', fencingToken: 1, expectedRevision: 0, callNodeKey: 'c', returnNodeKey: 'r', targetFlowId: TARGET })).rejects.toMatchObject({ code: 'P0002' })
  })
})

describe('interpreter: execute_flow and END (stubbed store)', () => {
  it('calls the push RPC with the snapshot node config and nothing else', async () => {
    const s = store({ loadRun: vi.fn().mockResolvedValueOnce(run()).mockResolvedValueOnce(run()).mockResolvedValue(run({ status: 'paused_by_agent' })) })
    expect(await runVersionedFlow(s, opts)).toMatchObject({ kind: 'not_active', status: 'paused_by_agent', steps: 1 })
    expect(names(s)).toEqual(['acquire', 'push', 'release'])
    expect(s.calls[1][1]).toEqual({ accountId: A, runId: RUN, owner: 'w1', fencingToken: 1, expectedRevision: 1, callNodeKey: 'call', returnNodeKey: 'fin', targetFlowId: TARGET })
  })
  it('a nested END (persisted depth > 0) pops and does not complete the run', async () => {
    const nested = run({ current_flow_version_id: VB, versioned_node_key: 'bend', versioned_depth: 1, versioned_checkpoint: { cursor: { flow_version_id: VB, node_key: 'bend' }, step: 3 } })
    const s = store({ loadRun: vi.fn().mockResolvedValueOnce(nested).mockResolvedValueOnce(nested).mockResolvedValue(nested) })
    expect(await runVersionedFlow(s, { ...opts, maxSteps: 1 })).toMatchObject({ kind: 'yielded', steps: 1 })
    expect(names(s)).toEqual(['acquire', 'pop', 'release'])
    expect(names(s)).not.toContain('commit')
  })
  it('a root END (depth 0, no frames) completes through the CAS commit and never pops', async () => {
    const root = run({ versioned_node_key: 'fin', versioned_checkpoint: { cursor: { flow_version_id: VA, node_key: 'fin' }, step: 4 } })
    const s = store({ loadRun: async () => root })
    expect(await runVersionedFlow(s, opts)).toMatchObject({ kind: 'completed', steps: 1 })
    expect(names(s)).toEqual(['acquire', 'commit'])
    expect(s.calls[1][1]).toMatchObject({ status: 'completed', endReason: 'end_node', nodesDelta: 1 })
  })
  it.each([
    ['depth_exceeded', 'subflow_depth_exceeded'], ['recursion_detected', 'subflow_recursion'], ['budget_exceeded', 'node_budget_exceeded'],
  ] as const)('PostgreSQL refusal %s ends the run as failed/%s', async (reason, expected) => {
    const s = store({ pushSubflow: async () => refusal(reason) })
    expect(await runVersionedFlow(s, opts)).toMatchObject({ kind: 'failed', reason: expected })
    expect(s.calls.at(-1)?.[1]).toMatchObject({ status: 'failed', endReason: expected, nodesDelta: 0 })
  })
  it.each([
    ['active published flow not found', 'subflow_target_unavailable'], ['published definition has no entry cursor', 'subflow_target_invalid'],
    ['return node not found in caller version', 'subflow_return_node_missing'], ['call node is not an execute_flow node matching the requested call', 'subflow_call_mismatch'],
  ])('SQL rejection "%s" ends the run as failed/%s', async (message, expected) => {
    const s = store({ pushSubflow: async () => { throw new VersionedStoreError('P0002', `push_versioned_run_subflow: ${message}`) } })
    expect(await runVersionedFlow(s, opts)).toMatchObject({ kind: 'failed', reason: expected })
  })
  it('lease loss and stale fencing from push stop the interpreter without releasing', async () => {
    for (const reason of ['stale_lease', 'lease_expired'] as const) {
      const s = store({ pushSubflow: async () => refusal(reason) })
      expect(await runVersionedFlow(s, opts)).toMatchObject({ kind: 'lease_lost', reason })
      expect(names(s)).toEqual(['acquire'])
    }
  })
  it('a malformed execute_flow config fails the run locally without touching the RPC', async () => {
    const bad = { ...(versions[VA] as object), definition: defn('flow-a', [node('call', 'execute_flow', { target_flow_id: 'nope', next_node_key: 'fin' }), node('fin', 'end')]) }
    const s = store({ loadVersion: async () => bad as never })
    expect(await runVersionedFlow(s, opts)).toMatchObject({ kind: 'failed', reason: 'invalid_execute_flow_config' })
    expect(names(s)).not.toContain('push')
  })
  it('an ambiguous push is verified against the persisted run before anything is repeated', async () => {
    // lost answer, revision moved under our lease -> treated as committed, no second push
    const moved = run({ versioned_revision: 2, current_flow_version_id: VB, versioned_node_key: 'bend', versioned_depth: 1, versioned_checkpoint: { cursor: { flow_version_id: VB, node_key: 'bend' }, step: 2 } })
    const lost = vi.fn(async () => { throw new Error('socket hang up') })
    const a = store({ pushSubflow: lost, loadRun: vi.fn().mockResolvedValueOnce(run()).mockResolvedValueOnce(run()).mockResolvedValue(moved) })
    expect(await runVersionedFlow(a, { ...opts, maxSteps: 1 })).toMatchObject({ kind: 'yielded', steps: 1 })
    expect(lost).toHaveBeenCalledTimes(1)                                    // not repeated: the revision had moved
    // unchanged -> retried at most maxAmbiguousRetries times, then the original error surfaces
    const push = vi.fn(async () => { throw new Error('socket hang up') })
    const b = store({ pushSubflow: push })
    await expect(runVersionedFlow(b, { ...opts, maxAmbiguousRetries: 1 })).rejects.toThrow('socket hang up')
    expect(push).toHaveBeenCalledTimes(2)
    // lease no longer ours -> lease_lost instead of retrying
    const c = store({ pushSubflow: async () => { throw new Error('socket hang up') }, loadRun: vi.fn().mockResolvedValueOnce(run()).mockResolvedValueOnce(run()).mockResolvedValue(run({ versioned_lease_owner: 'thief', versioned_lease: 2 })) })
    expect(await runVersionedFlow(c, opts)).toMatchObject({ kind: 'lease_lost' })
  })
  it('SQL state 55000 (inconsistent stack) is reported as corrupt, not retried', async () => {
    const push = vi.fn(async () => { throw new VersionedStoreError('55000', 'push_versioned_run_subflow: versioned call stack is inconsistent with versioned_depth') })
    const s = store({ pushSubflow: push })
    expect(await runVersionedFlow(s, opts)).toMatchObject({ kind: 'corrupt_checkpoint' })
    expect(push).toHaveBeenCalledTimes(1)
  })
})
