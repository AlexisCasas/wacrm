import { describe, expect, it, vi } from 'vitest'
import { runVersionedFlow } from './versioned-interpreter'
import { createHarness, type NodeSpec } from './test-support/versioned-pg'

/**
 * E4.2B2.2: subflow execution by the real interpreter + store against the isolated PostgreSQL 17
 * container (migrations 001..058). Skipped unless QA_PG_CONTAINER is set (run-e42b22-qa.sh sets it).
 * Every passing test prints `QA-RESULT <id> PASS ...` for the runner's matrix. Nothing here sends a
 * message: the interpreter only knows START, END and execute_flow.
 */
const container = process.env.QA_PG_CONTAINER
vi.setConfig({ testTimeout: 180_000 })
const pass = (id: string, detail: string) => console.log(`QA-RESULT ${id} PASS ${detail}`)

describe.skipIf(!container)('E4.2B2.2 subflow interpreter on PostgreSQL', () => {
  const h = createHarness(container ?? '')
  const { call, start, end } = h
  const opts = (acct: string, runId: string, owner: string, extra = {}) => ({ accountId: acct, runId, owner, ...extra })
  const run = async (runId: string, owner: string, extra = {}, store = h.newStore()) => runVersionedFlow(store, opts(await h.account(), runId, owner, extra))

  /** A: start -> call(B, next end) -> end ; B: start -> end   (note: same node keys 'start'/'end' in both) */
  async function twoLevel() {
    const A = h.id(), B = h.id()
    const vb = await h.synth(B, [start('start', 'end'), end('end')], 'start')
    const va = await h.synth(A, [start('start', 'call'), call('call', B, 'end'), end('end')], 'start')
    return { A, B, va, vb }
  }
  /** A: start -> call(B, next fin) -> fin ; B: bstart -> bcall(C, next bend) -> bend ; C: cstart -> cend */
  async function threeLevel() {
    const A = h.id(), B = h.id(), C = h.id()
    const vc = await h.synth(C, [start('cstart', 'cend'), end('cend')], 'cstart')
    const vb = await h.synth(B, [start('bstart', 'bcall'), call('bcall', C, 'bend'), end('bend')], 'bstart')
    const va = await h.synth(A, [start('start', 'call'), call('call', B, 'fin'), end('fin')], 'start')
    return { A, B, C, va, vb, vc }
  }

  it('I22/I24/I26: A -> B -> A runs on one flow_run, keeps variables, same node keys in two versions', async () => {
    const f = await twoLevel()
    const runId = await h.createRun(f.A)
    await h.psql.sql(`update public.flow_runs set vars='{"k":[1,2],"who":"caller"}' where id='${runId}'`)
    const before = await h.run(runId)
    const total = Number(await h.psql.sql('select count(*) from public.flow_runs'))
    const out = await run(runId, 'w1')
    const r = await h.run(runId)
    expect(out).toMatchObject({ kind: 'completed', steps: 5, nodesExecuted: 5, flowRunId: runId })
    expect(r).toMatchObject({ status: 'completed', execution_mode: 'versioned', versioned_depth: 0, versioned_nodes_executed: 5, versioned_revision: 5, versioned_lease_owner: null, end_reason: 'end_node', versioned_node_key: 'end' })
    expect(r.root_flow_version_id).toBe(f.va)
    expect(r.current_flow_version_id).toBe(f.va)
    expect(r.versioned_checkpoint).toMatchObject({ state: 'terminal', cursor: { flow_version_id: f.va, node_key: 'end' }, confirmed: { flow_version_id: f.va, node_key: 'end' } })
    expect(await h.frames(runId)).toEqual([])
    pass('I22', `A->B->A: start, call(push), B.start, B.end(pop), A.end(complete) = 5 nodes, 5 CAS revisions, frames 0, run completed on root version ${f.va.slice(0, 8)}`)
    expect(r.id).toBe(before.id)
    expect(Number(await h.psql.sql('select count(*) from public.flow_runs'))).toBe(total)
    expect(r.vars).toEqual({ k: [1, 2], who: 'caller' })
    expect({ c: r.contact_id, conv: r.conversation_id, flow: r.flow_id, user: r.user_id }).toEqual({ c: before.contact_id, conv: before.conversation_id, flow: before.flow_id, user: before.user_id })
    pass('I24', 'same flow_run id for the whole execution, no run created, variables/contact/conversation/root flow unchanged')
    const called = await h.events(runId, 'subflow_called'), returned = await h.events(runId, 'subflow_returned')
    expect(called).toHaveLength(1); expect(returned).toHaveLength(1)
    expect(called[0].payload).toMatchObject({ caller_flow_id: f.A, caller_flow_version_id: f.va, callee_flow_id: f.B, callee_flow_version_id: f.vb, call_node_key: 'call', return_node_key: 'end', depth: 1 })
    expect(returned[0].payload).toMatchObject({ callee_flow_version_id: f.vb, caller_flow_version_id: f.va, call_node_key: 'call', return_node_key: 'end', depth: 1 })
    expect(JSON.stringify([called, returned])).not.toContain('caller"') // no variable content
    pass('I26', "node keys 'start' and 'end' exist in both versions; the trace distinguishes them by (version,key): called A.call->B v" + f.vb.slice(0, 8) + ', returned to A.end')
  })

  it('I23: A -> B -> C -> B -> A with depth 2 and the inverse return', async () => {
    const f = await threeLevel()
    const runId = await h.createRun(f.A)
    // yield inside C to look at the persisted stack
    const mid = await run(runId, 'w1', { maxSteps: 5 })
    expect(mid).toMatchObject({ kind: 'yielded', steps: 5 })
    const r1 = await h.run(runId)
    const fr = await h.frames(runId)
    expect(r1).toMatchObject({ versioned_depth: 2, current_flow_version_id: f.vc, versioned_node_key: 'cend', status: 'active' })
    expect(fr.map((x) => [x.depth, x.callee_flow_version_id, x.caller_flow_version_id, x.call_node_key, x.return_node_key])).toEqual([[1, f.vb, f.va, 'call', 'fin'], [2, f.vc, f.vb, 'bcall', 'bend']])
    const out = await run(runId, 'w2')
    const r = await h.run(runId)
    expect(out).toMatchObject({ kind: 'completed', flowRunId: runId })
    expect(r).toMatchObject({ status: 'completed', versioned_depth: 0, versioned_nodes_executed: 8, current_flow_version_id: f.va, versioned_node_key: 'fin' })
    expect((await h.events(runId)).map((e) => e.event_type + ':' + e.node_key)).toEqual(['subflow_called:call', 'subflow_called:bcall', 'subflow_returned:bend', 'subflow_returned:fin'])
    pass('I23', 'A->B->C persisted two frames (depth 1: B pinned, depth 2: C pinned); C END popped to B.bend, B END popped to A.fin, A END completed the same run; 8 nodes; trace called,called,returned,returned')
  })

  it('I25: republishing a callee mid-run does not change the execution', async () => {
    const f = await twoLevel()
    const runId = await h.createRun(f.A)
    await run(runId, 'w1', { maxSteps: 3 })              // start, call(push), B.start -> now at B.end
    expect(await h.run(runId)).toMatchObject({ versioned_depth: 1, current_flow_version_id: f.vb, versioned_node_key: 'end' })
    const vb2 = await h.synth(f.B, [start('start', 'gone'), end('gone')], 'start')   // v2 has no 'end' node at all
    expect(vb2).not.toBe(f.vb)
    const out = await run(runId, 'w1')
    expect(out).toMatchObject({ kind: 'completed' })
    expect((await h.run(runId)).root_flow_version_id).toBe(f.va)
    expect((await h.events(runId, 'subflow_returned'))[0].payload).toMatchObject({ callee_flow_version_id: f.vb })
    // a brand new run entering B now gets v2
    const run2 = await h.createRun(f.A)
    await run(run2, 'w1', { maxSteps: 2 })
    expect((await h.run(run2)).current_flow_version_id).toBe(vb2)
    pass('I25', `B republished (${vb2.slice(0, 8)}) while the run sat inside B v1 (${f.vb.slice(0, 8)}); the run finished on v1 (its END no longer exists in v2); a later run pinned v2`)
  })

  it('I27: interruption before/after push and pop, and inside an A -> B -> C chain', async () => {
    const cases: Array<{ id: string; method: 'pushSubflow' | 'popSubflow'; when: 'before' | 'after'; nth?: number }> = [
      { id: 'before push', method: 'pushSubflow', when: 'before' }, { id: 'after push', method: 'pushSubflow', when: 'after' },
      { id: 'before pop', method: 'popSubflow', when: 'before' }, { id: 'after pop', method: 'popSubflow', when: 'after' },
    ]
    const summary: string[] = []
    for (const c of cases) {
      const f = await twoLevel()
      const runId = await h.createRun(f.A)
      await expect(run(runId, 'proc-1', {}, h.dyingStore(h.newStore(), c))).rejects.toThrow(/process is gone|simulated crash/)
      const mid = await h.run(runId)
      expect(mid.status).toBe('active')
      expect(mid.versioned_lease_owner).toBe('proc-1')                 // the dead process still holds its lease
      await h.expireLease(runId)
      expect(await run(runId, 'proc-2', { recoverExpiredLease: false })).toMatchObject({ kind: 'lease_unavailable', reason: 'lease_expired' })
      const out = await run(runId, 'proc-2', { recoverExpiredLease: true })
      expect(out).toMatchObject({ kind: 'completed' })
      const r = await h.run(runId)
      expect(r).toMatchObject({ status: 'completed', versioned_depth: 0, versioned_lease: 2, versioned_nodes_executed: 5, versioned_revision: 5 })
      expect(await h.events(runId, 'subflow_called')).toHaveLength(1)
      expect(await h.events(runId, 'subflow_returned')).toHaveLength(1)
      expect(await h.frames(runId)).toEqual([])
      summary.push(`${c.id}: mid depth ${mid.versioned_depth}`)
    }
    // chain: die right after the SECOND push (depth 2)
    const g = await threeLevel()
    const runId = await h.createRun(g.A)
    await expect(run(runId, 'proc-1', {}, h.dyingStore(h.newStore(), { method: 'pushSubflow', when: 'after', nth: 2 }))).rejects.toThrow(/process is gone|simulated crash/)
    expect(await h.run(runId)).toMatchObject({ versioned_depth: 2, current_flow_version_id: g.vc, versioned_node_key: 'cstart' })
    await h.expireLease(runId)
    expect(await run(runId, 'proc-2', { recoverExpiredLease: true })).toMatchObject({ kind: 'completed' })
    expect(await h.events(runId, 'subflow_called')).toHaveLength(2)
    expect(await h.events(runId, 'subflow_returned')).toHaveLength(2)
    expect(await h.run(runId)).toMatchObject({ status: 'completed', versioned_nodes_executed: 8, versioned_depth: 0 })
    pass('I27', `process death before/after push, before/after pop (${summary.join('; ')}) and after the 2nd push of A->B->C: the successor reclaimed the lease explicitly, resumed from the persisted cursor/frames, never repeated a confirmed transition (exactly 1 called + 1 returned event per call) and finished the same run`)
  })

  it('I28: ambiguous answers are reconciled by re-reading the run, never by blind repetition', async () => {
    // (a) the push COMMITTED but the answer was lost
    let f = await twoLevel()
    let runId = await h.createRun(f.A)
    let flaky = h.flakyStore(h.newStore(), { method: 'pushSubflow', when: 'after', times: 1 })
    expect(await run(runId, 'w1', {}, flaky.store)).toMatchObject({ kind: 'completed' })
    expect(flaky.calls.n).toBe(1)                                         // not repeated
    expect(await h.events(runId, 'subflow_called')).toHaveLength(1)
    // (b) the request never reached the database: safe to try again once the run is seen unchanged
    f = await twoLevel(); runId = await h.createRun(f.A)
    flaky = h.flakyStore(h.newStore(), { method: 'pushSubflow', when: 'before', times: 1 })
    expect(await run(runId, 'w1', {}, flaky.store)).toMatchObject({ kind: 'completed' })
    expect(flaky.calls.n).toBe(2)
    expect(await h.events(runId, 'subflow_called')).toHaveLength(1)
    // same for pop and for the generic commit
    f = await twoLevel(); runId = await h.createRun(f.A)
    flaky = h.flakyStore(h.newStore(), { method: 'popSubflow', when: 'after', times: 1 })
    expect(await run(runId, 'w1', {}, flaky.store)).toMatchObject({ kind: 'completed' })
    expect(flaky.calls.n).toBe(1)
    expect(await h.events(runId, 'subflow_returned')).toHaveLength(1)
    // (c) a transport that never recovers: bounded retries, then the error surfaces; state is intact and the lease is still ours
    f = await twoLevel(); runId = await h.createRun(f.A)
    flaky = h.flakyStore(h.newStore(), { method: 'pushSubflow', when: 'before', times: 99 })
    await expect(run(runId, 'w1', { maxAmbiguousRetries: 2 }, flaky.store)).rejects.toThrow('simulated transport failure')
    expect(flaky.calls.n).toBe(3)
    expect(await h.run(runId)).toMatchObject({ status: 'active', versioned_depth: 0, versioned_node_key: 'call', versioned_lease_owner: 'w1' })
    expect(await h.frames(runId)).toEqual([])
    pass('I28', 'push/pop whose answer was lost after COMMIT: run re-read, revision moved -> continued WITHOUT repeating (1 call, 1 event); request lost before the database: run re-read unchanged -> exactly one retry; permanent failure: 3 attempts then the error surfaces with state intact')
  })

  it('I29: two interpreters racing over a run with subflows never duplicate a push or a pop', async () => {
    const f = await threeLevel()
    const runId = await h.createRun(f.A)
    const [a, b] = await Promise.all([run(runId, 'racer-a'), run(runId, 'racer-b')])
    const kinds = [a.kind, b.kind].sort()
    expect(kinds.filter((k) => k === 'completed')).toHaveLength(1)
    expect(['lease_unavailable', 'not_active']).toContain(kinds.find((k) => k !== 'completed'))
    expect(await h.events(runId, 'subflow_called')).toHaveLength(2)
    expect(await h.events(runId, 'subflow_returned')).toHaveLength(2)
    expect(await h.run(runId)).toMatchObject({ status: 'completed', versioned_nodes_executed: 8, versioned_revision: 8, versioned_lease: 1 })
    pass('I29', `racing interpreters ended as [${kinds.join(', ')}]; 2 pushes + 2 pops exactly once, 8 nodes, one lease`)
  })

  it('I30/I31: recursion, self-call and unavailable targets fail the run in a controlled way', async () => {
    const acct = await h.account()
    const failed = async (nodes: (self: string) => NodeSpec[], entry: string, other?: (self: string) => Promise<void>) => {
      const A = h.id(); if (other) await other(A)
      await h.synth(A, nodes(A), entry)
      const runId = await h.createRun(A)
      const out = await run(runId, 'w1')
      return { out, r: await h.run(runId), runId }
    }
    // self call
    let x = await failed((A) => [start('start', 'call'), call('call', A, 'end'), end('end')], 'start')
    expect(x.out).toMatchObject({ kind: 'failed', reason: 'subflow_recursion' })
    expect(x.r).toMatchObject({ status: 'failed', versioned_depth: 0, versioned_node_key: 'call', end_reason: 'subflow_recursion' })
    // A -> B -> A
    const A = h.id(), B = h.id()
    await h.synth(B, [start('start', 'back'), call('back', A, 'end'), end('end')], 'start')
    await h.synth(A, [start('start', 'call'), call('call', B, 'end'), end('end')], 'start')
    const runId = await h.createRun(A)
    const out = await run(runId, 'w1')
    expect(out).toMatchObject({ kind: 'failed', reason: 'subflow_recursion' })
    expect(await h.run(runId)).toMatchObject({ status: 'failed', versioned_depth: 1, versioned_node_key: 'back' })
    expect(await h.frames(runId)).toHaveLength(1)
    pass('I30', 'self-call (A->A) and cycle (A->B->A) end the run as failed/subflow_recursion; the stack at the failure (depth 1) is kept as evidence; PostgreSQL made the decision')

    const draft = '50000000-0000-4000-8000-000000000002', archived = '50000000-0000-4000-8000-000000000003', noVersion = '50000000-0000-4000-8000-000000000004'
    const otherAccount = '60000000-0000-4000-8000-000000000001', badEntry = '50000000-0000-4000-8000-000000000005'
    const results: string[] = []
    for (const [label, target, reason] of [
      ['unknown flow', h.id(), 'subflow_target_unavailable'], ['other account', otherAccount, 'subflow_target_unavailable'], ['draft', draft, 'subflow_target_unavailable'],
      ['archived', archived, 'subflow_target_unavailable'], ['no published version', noVersion, 'subflow_target_unavailable'], ['entry node missing', badEntry, 'subflow_target_invalid'],
    ] as const) {
      x = await failed(() => [start('start', 'call'), call('call', target, 'end'), end('end')], 'start')
      expect(x.out, label).toMatchObject({ kind: 'failed', reason })
      expect(await h.frames(x.runId), label).toEqual([])
      expect(x.r, label).toMatchObject({ status: 'failed', versioned_depth: 0, versioned_node_key: 'call', versioned_nodes_executed: 1 })
      results.push(label)
    }
    // continuation node that does not exist in the caller, and a malformed config
    x = await failed(() => [start('start', 'call'), call('call', h.id(), 'nowhere'), end('end')], 'start')
    expect(x.out).toMatchObject({ kind: 'failed', reason: 'invalid_execute_flow_config' })
    x = await failed(() => [start('start', 'call'), { key: 'call', type: 'execute_flow', config: { target_flow_id: 'not-a-uuid', next_node_key: 'end' } }, end('end')], 'start')
    expect(x.out).toMatchObject({ kind: 'failed', reason: 'invalid_execute_flow_config' })
    void acct
    pass('I31', `controlled failures with no frame: ${results.join(', ')}, missing continuation node, malformed execute_flow config`)
  })

  it('I32: depth 8, node budget and unsupported nodes', async () => {
    // chain of 10 flows D0..D9, each: start -> call(next) -> end
    const ids = Array.from({ length: 10 }, () => h.id())
    for (let i = 9; i >= 0; i--) {
      await h.synth(ids[i], [start('start', 'call'), call('call', ids[i + 1] ?? h.id(), 'end'), end('end')], 'start')
    }
    const runId = await h.createRun(ids[0])
    const out = await run(runId, 'w1')
    expect(out).toMatchObject({ kind: 'failed', reason: 'subflow_depth_exceeded' })
    const r = await h.run(runId)
    expect(r).toMatchObject({ status: 'failed', versioned_depth: 8, versioned_node_key: 'call' })
    expect(await h.frames(runId)).toHaveLength(8)
    expect(await h.events(runId, 'subflow_called')).toHaveLength(8)
    // budget: 499 nodes consumed -> the call node itself fits (500), the callee's START does not
    const f = await twoLevel()
    const b1 = await h.createRun(f.A)
    await run(b1, 'w1', { maxSteps: 1 })                                   // start consumed, cursor at call
    await h.psql.sql(`update public.flow_runs set versioned_nodes_executed=499 where id='${b1}'`)
    expect(await run(b1, 'w1')).toMatchObject({ kind: 'failed', reason: 'node_budget_exceeded' })
    expect(await h.run(b1)).toMatchObject({ status: 'failed', versioned_nodes_executed: 500, versioned_depth: 1 })
    const b2 = await h.createRun(f.A)
    await run(b2, 'w1', { maxSteps: 1 })
    await h.psql.sql(`update public.flow_runs set versioned_nodes_executed=500 where id='${b2}'`)
    expect(await run(b2, 'w1')).toMatchObject({ kind: 'failed', reason: 'node_budget_exceeded' })
    expect(await h.run(b2)).toMatchObject({ status: 'failed', versioned_depth: 0, versioned_node_key: 'call' })
    pass('I32', 'a chain of 10 flows: 8 nested calls accepted, the 9th failed/subflow_depth_exceeded with 8 frames + 8 events kept; node budget: at 499 the call fits and the callee START is refused, at 500 the call itself is refused')

    // unsupported node inside the subflow: failed, stack kept
    const A = h.id(), B = h.id()
    await h.synth(B, [start('start', 'say'), { key: 'say', type: 'send_message', config: { text: 'hi', next_node_key: 'end' } }, end('end')], 'start')
    await h.synth(A, [start('start', 'call'), call('call', B, 'end'), end('end')], 'start')
    const msgs = await h.psql.sql('select count(*) from public.messages')
    const runId2 = await h.createRun(A)
    expect(await run(runId2, 'w1')).toMatchObject({ kind: 'failed', reason: 'unsupported_node_type:send_message' })
    expect(await h.run(runId2)).toMatchObject({ status: 'failed', versioned_depth: 1, versioned_node_key: 'say' })
    expect(await h.psql.sql('select count(*) from public.messages')).toBe(msgs)
    pass('I33', 'unsupported node type (send_message) inside a subflow -> failed with the stack kept; no message row, nothing sent')
  })

  it('I34: an agent pause during a subflow stops the interpreter', async () => {
    const f = await twoLevel()
    const runId = await h.createRun(f.A)
    const real = h.newStore()
    const pausing = { ...real, pushSubflow: async (i: Parameters<typeof real.pushSubflow>[0]) => {
      const res = await real.pushSubflow(i)
      await h.psql.sql(`update public.flow_runs set status='paused_by_agent' where id='${runId}'`)
      return res
    } }
    expect(await run(runId, 'w1', {}, pausing)).toMatchObject({ kind: 'not_active', status: 'paused_by_agent' })
    expect(await h.run(runId)).toMatchObject({ status: 'paused_by_agent', versioned_depth: 1, versioned_lease_owner: null })
    expect(await h.frames(runId)).toHaveLength(1)
    expect(await run(runId, 'w2')).toMatchObject({ kind: 'not_active', status: 'paused_by_agent' })
    await expect(h.psql.sql(`update public.flow_runs set status='active' where id='${runId}'`)).rejects.toThrow('55000')
    pass('I34', 'run paused by an agent right after the push: interpreter stopped (not_active), frame and cursor untouched, lease released, run cannot be reactivated')
  })

  it('I35: legacy runs and the legacy validator are untouched; the interpreter stays isolated', async () => {
    const acct = await h.account()
    const legacy = await h.psql.sql(`insert into public.flow_runs (flow_id,account_id,user_id,contact_id,status,current_node_key) values ('50000000-0000-4000-8000-000000000002','${acct}','${h.USER}',public.qa_new_contact(${900}),'active','start') returning id`)
    const snap = JSON.stringify(await h.run(legacy))
    expect(await run(legacy, 'w')).toMatchObject({ kind: 'not_found' })
    expect(JSON.stringify(await h.run(legacy))).toBe(snap)
    // the table accepts the new node type only as data; every legacy type is still accepted
    for (const t of ['start', 'send_buttons', 'send_list', 'send_message', 'send_media', 'collect_input', 'condition', 'set_tag', 'delay', 'set_contact_field', 'handoff', 'http_fetch', 'end', 'execute_flow']) {
      await h.psql.sql(`select 1 where exists (select 1 from pg_constraint where conname='flow_nodes_node_type_check' and pg_get_constraintdef(oid) like '%''${t}''%')`)
      expect(await h.psql.sql(`select count(*) from pg_constraint where conname='flow_nodes_node_type_check' and pg_get_constraintdef(oid) like '%''${t}''%'`), t).toBe('1')
    }
    expect(await h.psql.sql(`select count(*) from pg_constraint where conname='flow_nodes_node_type_check' and pg_get_constraintdef(oid) like '%''bogus''%'`)).toBe('0')
    pass('I35', 'legacy run -> not_found and byte-identical; flow_nodes CHECK still accepts all 13 legacy node types plus execute_flow and rejects others')
  })
})
