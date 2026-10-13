import { describe, expect, it, vi } from 'vitest'
import { runVersionedFlow } from './versioned-interpreter'
import { SnapshotError, SnapshotLoader } from './versioned-snapshot'
import { createSupabaseRunStore, type CommitInput, type VersionedRunStore } from './versioned-store'
import { createPsql, createPsqlSupabaseClient, lit } from './test-support/psql-client'
import { createHarness } from './test-support/versioned-pg'

/**
 * E4.2B1.3 integration: the real store + interpreter against the isolated PostgreSQL 17 container
 * (migrations 001..056, committed fixtures from scripts/sql/e42b11-fixtures.sql). Skipped unless
 * QA_PG_CONTAINER is set; scripts/sql/run-e42b13-qa.sh sets it. Every passing test prints a
 * `QA-RESULT <id> PASS` line that the runner turns into the verdict matrix.
 */
const container = process.env.QA_PG_CONTAINER
const USER = '10000000-0000-4000-8000-000000000001'
const BASE_FLOW = '50000000-0000-4000-8000-000000000001'
const OTHER_ACCOUNT_FLOW = '60000000-0000-4000-8000-000000000001'

// each interpreter step costs several `docker exec psql` round trips
vi.setConfig({ testTimeout: 120_000 })

/** flow_runs row as to_jsonb returns it; only the checkpoint needs a shape. */
interface RunJson { [column: string]: unknown; versioned_checkpoint: { cursor: unknown } }

const pass = (id: string, detail: string) => console.log(`QA-RESULT ${id} PASS ${detail}`)

describe.skipIf(!container)('E4.2B1.3 versioned interpreter on PostgreSQL', () => {
  const psql = createPsql(container ?? '')
  const newStore = (): VersionedRunStore => createSupabaseRunStore(createPsqlSupabaseClient(psql))
  let acct = ''
  let seq = 0
  const nextN = () => 300 + ++seq
  const flowId = () => `51000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`

  type NodeSpec = { key: string; type: string; config?: Record<string, unknown> }
  const lin = (...specs: NodeSpec[]) => specs
  const startEnd = lin({ key: 'start', type: 'start', config: { next_node_key: 'end' } }, { key: 'end', type: 'end' })

  async function ensureAcct() { if (!acct) acct = await psql.sql(`select account_id from public.flows where id='${BASE_FLOW}'`) }
  async function makeFlow(nodes: NodeSpec[], entry = 'start') {
    await ensureAcct()
    const id = flowId()
    await psql.sql(`insert into public.flows (id,user_id,account_id,name,trigger_type,entry_node_id) values ('${id}','${USER}','${acct}','I flow ${id}','manual',${lit(entry)})`)
    for (const n of nodes) await psql.sql(`insert into public.flow_nodes (flow_id,node_key,node_type,config) values ('${id}',${lit(n.key)},${lit(n.type)},${lit(n.config ?? {})}::jsonb)`)
    await psql.sql(`select public.qa_publish('${id}','${USER}')`)
    return { id, versionId: await psql.sql(`select active_version_id from public.flows where id='${id}'`) }
  }
  async function republish(id: string, edit: string) {
    await psql.sql(`${edit}; select public.qa_publish('${id}','${USER}')`)
    return psql.sql(`select active_version_id from public.flows where id='${id}'`)
  }
  async function createRun(flow: string) {
    return psql.sql(`select flow_run_id from public.create_versioned_flow_run('${acct}','${flow}',public.qa_new_contact(${nextN()}),null)`)
  }
  async function row(runId: string) {
    return (await psql.rows<RunJson>(`select * from public.flow_runs where id='${runId}'`))[0]
  }
  const opts = (runId: string, owner: string, extra = {}) => ({ accountId: acct, runId, owner, ...extra })

  it('I01/I08/I09/I17: START -> END completes the same run from the published snapshot', async () => {
    const f = await makeFlow(startEnd)
    const runId = await createRun(f.id)
    const before = Number(await psql.sql(`select count(*) from public.flow_runs`))
    const out = await runVersionedFlow(newStore(), opts(runId, 'worker-1'))
    const r = await row(runId)
    expect(out).toMatchObject({ kind: 'completed', steps: 2, revision: 2, nodesExecuted: 2, flowRunId: runId })
    expect(r).toMatchObject({ status: 'completed', execution_mode: 'versioned', versioned_revision: 2, versioned_nodes_executed: 2, versioned_messages_executed: 0, versioned_lease: 1, versioned_lease_owner: null, end_reason: 'end_node', versioned_node_key: 'end' })
    expect(r.ended_at).not.toBeNull()
    expect(r.root_flow_version_id).toBe(f.versionId)
    expect(r.current_flow_version_id).toBe(f.versionId)
    expect(r.versioned_checkpoint).toEqual({ cursor: { flow_version_id: f.versionId, node_key: 'end' }, step: 2, state: 'terminal', failure: null, confirmed: { flow_version_id: f.versionId, node_key: 'end', step: 1 } })
    pass('I01', `START->END completed run ${runId} in 2 CAS commits (revision 2, nodes 2)`)
    pass('I08', `cursor persisted: after START the cursor was END; final cursor end@${f.versionId.slice(0, 8)}`)
    pass('I09', 'terminal checkpoint {state:terminal, step:2, confirmed:end@step1} persisted with the completion')
    expect(Number(await psql.sql(`select count(*) from public.flow_runs`))).toBe(before)
    expect(Number(await psql.sql(`select count(*) from public.flow_runs where flow_id='${f.id}'`))).toBe(1)
    expect(Number(await psql.sql(`select count(*) from public.flow_run_call_frames where flow_run_id='${runId}'`))).toBe(0)
    expect(Number(await psql.sql(`select count(*) from public.flow_run_events where flow_run_id='${runId}'`))).toBe(0)
    pass('I17', 'one flow_run for the flow; no run created by the interpreter; no frames, no events')
  })

  it('I09b: after START the checkpoint distinguishes pending vs confirmed', async () => {
    const f = await makeFlow(startEnd)
    const runId = await createRun(f.id)
    const out = await runVersionedFlow(newStore(), opts(runId, 'worker-1', { maxSteps: 1 }))
    expect(out).toMatchObject({ kind: 'yielded', steps: 1, revision: 1 })
    const r = await row(runId)
    expect(r).toMatchObject({ status: 'active', versioned_revision: 1, versioned_nodes_executed: 1, versioned_node_key: 'end', current_node_key: 'end', versioned_lease_owner: null })
    expect(r.versioned_checkpoint).toEqual({ cursor: { flow_version_id: f.versionId, node_key: 'end' }, step: 1, state: 'pending', failure: null, confirmed: { flow_version_id: f.versionId, node_key: 'start', step: 0 } })
    pass('I09b', 'pending=end@step1, confirmed=start@step0, revision 1, nodes 1')
  })

  it('I02-I06: snapshot loading rules', async () => {
    const f = await makeFlow(startEnd)
    const store = newStore()
    const loader = new SnapshotLoader(store, acct)
    const snap = await loader.get(f.versionId)
    expect(snap.flowId).toBe(f.id)
    expect(snap.node('start')?.node_type).toBe('start')
    expect(snap.node('end')?.node_type).toBe('end')
    expect(snap.node('nope')).toBeUndefined()
    pass('I02', 'published version loads, validated by the E4.2A parser, nodes resolved by key')

    const mk = async (definition: unknown, flowIdOverride?: string) => {
      const versionNo = 100 + nextN()
      return psql.sql(`insert into public.flow_versions (flow_id,account_id,version_number,definition,definition_hash,published_by) values ('${flowIdOverride ?? BASE_FLOW}','${acct}',${versionNo},${lit(definition)}::jsonb,repeat('a',64),'${USER}') returning id`)
    }
    const flowEnv = (id: string) => ({ id, name: 'x', description: null, trigger_type: 'manual', trigger_config: {}, entry_node_id: 'start', fallback_policy: {} })
    const node = (k: string) => ({ node_key: k, node_type: 'start', config: {}, position_x: 0, position_y: 0 })
    const bad = {
      notArray: await mk({ flow: flowEnv(BASE_FLOW), nodes: 'x' }),
      duplicate: await mk({ flow: flowEnv(BASE_FLOW), nodes: [node('a'), node('a')] }),
      otherFlow: await mk({ flow: flowEnv(OTHER_ACCOUNT_FLOW), nodes: [node('a')] }),
    }
    const codes: Record<string, string> = {}
    for (const [k, v] of Object.entries(bad)) {
      try { await new SnapshotLoader(store, acct).get(v); codes[k] = 'accepted' } catch (e) { codes[k] = e instanceof SnapshotError ? e.code : String(e) }
    }
    expect(codes).toEqual({ notArray: 'invalid_definition', duplicate: 'invalid_definition', otherFlow: 'flow_mismatch' })
    pass('I03', 'invalid snapshots rejected: nodes not an array, duplicate node_key, definition of another flow')

    const otherVersion = await psql.sql(`select active_version_id from public.flows where id='${OTHER_ACCOUNT_FLOW}'`)
    await expect(new SnapshotLoader(store, acct).get(otherVersion)).rejects.toMatchObject({ code: 'version_not_found' })
    pass('I04', 'a version of another account is not found for this account')

    const run = await psql.sql(`insert into public.flow_runs (flow_id,account_id,user_id,contact_id,status,current_node_key,execution_mode,root_flow_version_id,current_flow_version_id,versioned_node_key,versioned_checkpoint)
      values ('${f.id}','${acct}','${USER}',public.qa_new_contact(${nextN()}),'active','ghost','versioned','${f.versionId}','${f.versionId}','ghost',${lit({ cursor: { flow_version_id: f.versionId, node_key: 'ghost' }, step: 0 })}::jsonb) returning id`)
    const out = await runVersionedFlow(store, opts(run, 'w'))
    expect(out).toMatchObject({ kind: 'snapshot_error', code: 'node_not_found' })
    const run2 = await psql.sql(`insert into public.flow_runs (flow_id,account_id,user_id,contact_id,status,current_node_key,execution_mode,root_flow_version_id,current_flow_version_id,versioned_node_key,versioned_checkpoint)
      values ('${f.id}','${acct}','${USER}',public.qa_new_contact(${nextN()}),'active','a','versioned','${bad.duplicate}','${bad.duplicate}','a',${lit({ cursor: { flow_version_id: bad.duplicate, node_key: 'a' }, step: 0 })}::jsonb) returning id`)
    const out2 = await runVersionedFlow(store, opts(run2, 'w'))
    expect(out2).toMatchObject({ kind: 'snapshot_error', code: 'invalid_definition' })
    for (const id of [run, run2]) expect(await row(id)).toMatchObject({ status: 'active', versioned_revision: 0, versioned_nodes_executed: 0, versioned_lease_owner: null })
    pass('I05', 'cursor on a missing node and cursor on an invalid snapshot -> controlled snapshot_error, run untouched, lease released')

    const v1 = await makeFlow(startEnd)
    const v2id = await republish(v1.id, `update public.flow_nodes set config='{"next_node_key":"end2"}' where flow_id='${v1.id}' and node_key='start'; insert into public.flow_nodes (flow_id,node_key,node_type,config) values ('${v1.id}','end2','end','{}')`)
    const s1 = await loader.get(v1.versionId), s2 = await loader.get(v2id)
    expect((s1.node('start')?.config as { next_node_key?: string }).next_node_key).toBe('end')
    expect((s2.node('start')?.config as { next_node_key?: string }).next_node_key).toBe('end2')
    expect(s1.node('end2')).toBeUndefined()
    const a = await loader.resolve({ flow_version_id: v1.versionId, node_key: 'start' })
    const b = await loader.resolve({ flow_version_id: v2id, node_key: 'start' })
    expect(a.node).not.toBe(b.node)
    await expect(loader.resolve({ flow_version_id: v1.versionId, node_key: 'end2' })).rejects.toMatchObject({ code: 'node_not_found' })
    pass('I06', "same node_key 'start' in two versions resolves to different nodes; (v1,'end2') does not exist")
  })

  it('I07: republishing during a run does not change the pinned version', async () => {
    const f = await makeFlow(startEnd)
    const runId = await createRun(f.id)
    await runVersionedFlow(newStore(), opts(runId, 'w', { maxSteps: 1 }))
    const v2 = await republish(f.id, `delete from public.flow_nodes where flow_id='${f.id}' and node_key='end'; update public.flow_nodes set config='{"next_node_key":"finish"}' where flow_id='${f.id}' and node_key='start'; insert into public.flow_nodes (flow_id,node_key,node_type,config) values ('${f.id}','finish','end','{}')`)
    expect(v2).not.toBe(f.versionId)
    const out = await runVersionedFlow(newStore(), opts(runId, 'w'))
    expect(out).toMatchObject({ kind: 'completed' })
    const r = await row(runId)
    expect(r).toMatchObject({ status: 'completed', root_flow_version_id: f.versionId, current_flow_version_id: f.versionId, versioned_node_key: 'end' })
    expect(r.versioned_checkpoint.cursor).toEqual({ flow_version_id: f.versionId, node_key: 'end' })
    expect(await psql.sql(`select active_version_id from public.flows where id='${f.id}'`)).toBe(v2)
    pass('I07', `flow republished (${v2.slice(0, 8)}) mid-run; run finished on its pinned v1 'end' node (${f.versionId.slice(0, 8)}), which v2 no longer contains`)
  })

  it('I10: simulated process death, then a new instance resumes from END', async () => {
    const f = await makeFlow(startEnd)
    const runId = await createRun(f.id)
    const dying = createHarness(container ?? '').dyingStore(newStore(), { method: 'commitTransition', when: 'after' })
    await expect(runVersionedFlow(dying, opts(runId, 'proc-1', { ttlSeconds: 4 }))).rejects.toThrow('process is gone')
    let r = await row(runId)
    expect(r).toMatchObject({ status: 'active', versioned_node_key: 'end', versioned_revision: 1, versioned_lease_owner: 'proc-1', versioned_lease: 1 })

    // new process, lease still live -> must not run
    const blocked = await runVersionedFlow(newStore(), opts(runId, 'proc-2'))
    expect(blocked).toMatchObject({ kind: 'lease_unavailable', reason: 'lease_held' })
    // wait for the server clock to expire the lease (no local clock involved)
    for (let i = 0; i < 100 && (await psql.sql(`select (versioned_lease_expires_at > clock_timestamp())::text from public.flow_runs where id='${runId}'`)) === 'true'; i++) await new Promise((x) => setTimeout(x, 100))
    const noRecovery = await runVersionedFlow(newStore(), opts(runId, 'proc-2'))
    expect(noRecovery).toMatchObject({ kind: 'lease_unavailable', reason: 'lease_expired' })

    const commits: CommitInput[] = []
    const fresh = newStore()
    const spying: VersionedRunStore = { ...fresh, commitTransition: (i) => { commits.push(i); return fresh.commitTransition(i) } }
    const out = await runVersionedFlow(spying, opts(runId, 'proc-2', { recoverExpiredLease: true }))
    expect(out).toMatchObject({ kind: 'completed', steps: 1, revision: 2, nodesExecuted: 2, flowRunId: runId })
    expect(commits).toHaveLength(1)
    expect((commits[0].checkpoint as { confirmed: unknown }).confirmed).toMatchObject({ node_key: 'end', step: 1 })
    expect(commits[0].fencingToken).toBe(2)
    r = await row(runId)
    expect(r).toMatchObject({ status: 'completed', versioned_lease: 2, versioned_nodes_executed: 2, versioned_revision: 2 })
    expect(Number(await psql.sql(`select count(*) from public.flow_runs where flow_id='${f.id}'`))).toBe(1)
    pass('I10', 'proc-1 died after confirming START; proc-2 saw lease_held, then lease_expired, reclaimed explicitly (token 2), made ONE commit (END) and completed the same run')
  })

  it('I11/I12/I13: duplicate CAS, lost lease and stale fencing', async () => {
    const f = await makeFlow(startEnd)
    const store = newStore()
    const runId = await createRun(f.id)
    const grant = await store.acquireLease(acct, runId, 'w1', 60)
    expect(grant).toMatchObject({ acquired: true, fencingToken: 1, revision: 0, reason: null })
    const cp = { cursor: { flow_version_id: f.versionId, node_key: 'end' }, step: 1, state: 'pending', confirmed: { flow_version_id: f.versionId, node_key: 'start', step: 0 }, failure: null }
    const input: CommitInput = { accountId: acct, runId, owner: 'w1', fencingToken: 1, expectedRevision: 0, checkpoint: cp, nodesDelta: 1 }
    expect(await store.commitTransition(input)).toMatchObject({ committed: true, revision: 1, nodesExecuted: 1 })
    expect(await store.commitTransition(input)).toMatchObject({ committed: false, reason: 'revision_conflict', revision: 1, nodesExecuted: 1 })
    expect(await row(runId)).toMatchObject({ versioned_revision: 1, versioned_nodes_executed: 1 })
    pass('I11', 'the same CAS replayed -> revision_conflict; revision and node budget counted once')

    // I12: lease is taken over between the interpreter's read and its commit
    const g = await makeFlow(startEnd)
    const run2 = await createRun(g.id)
    const real = newStore()
    const hijacked: VersionedRunStore = {
      ...real,
      commitTransition: async (i) => {
        await psql.sql(`update public.flow_runs set versioned_lease_expires_at = clock_timestamp() - interval '1 second' where id='${run2}'`)
        await real.reclaimLease(acct, run2, 'thief', 60)
        return real.commitTransition(i)
      },
    }
    const out = await runVersionedFlow(hijacked, opts(run2, 'w1'))
    expect(out).toMatchObject({ kind: 'lease_lost', reason: 'stale_lease' })
    expect(await row(run2)).toMatchObject({ status: 'active', versioned_revision: 0, versioned_nodes_executed: 0, versioned_node_key: 'start', versioned_lease_owner: 'thief', versioned_lease: 2 })
    pass('I12', 'lease reclaimed by another owner before the commit -> lease_lost/stale_lease; nothing written, thief keeps its lease')

    // I13: the superseded owner cannot do anything with its old token
    expect(await real.renewLease(acct, run2, 'w1', 1, 60)).toMatchObject({ renewed: false, reason: 'stale_lease' })
    expect(await real.releaseLease(acct, run2, 'w1', 1)).toMatchObject({ released: false, reason: 'stale_lease' })
    expect(await real.commitTransition({ accountId: acct, runId: run2, owner: 'w1', fencingToken: 1, expectedRevision: 0, checkpoint: cp })).toMatchObject({ committed: false, reason: 'stale_lease' })
    expect(await row(run2)).toMatchObject({ versioned_revision: 0, versioned_lease_owner: 'thief', versioned_lease: 2 })
    pass('I13', 'old token (1) refused on renew, release and commit after takeover (token 2)')
  })

  it('I14/I15: paused and completed runs are never advanced', async () => {
    const f = await makeFlow(startEnd)
    const run1 = await createRun(f.id)
    await psql.sql(`update public.flow_runs set status='paused_by_agent' where id='${run1}'`)
    expect(await runVersionedFlow(newStore(), opts(run1, 'w'))).toMatchObject({ kind: 'not_active', status: 'paused_by_agent' })
    expect(await row(run1)).toMatchObject({ status: 'paused_by_agent', versioned_lease: 0, versioned_revision: 0, versioned_lease_owner: null })

    const run2 = await createRun(f.id)
    const real = newStore()
    const pausing: VersionedRunStore = { ...real, commitTransition: async (i) => { const res = await real.commitTransition(i); await psql.sql(`update public.flow_runs set status='paused_by_agent' where id='${run2}'`); return res } }
    const out = await runVersionedFlow(pausing, opts(run2, 'w'))
    expect(out).toMatchObject({ kind: 'not_active', status: 'paused_by_agent', steps: 1 })
    expect(await row(run2)).toMatchObject({ status: 'paused_by_agent', versioned_node_key: 'end', versioned_revision: 1, versioned_nodes_executed: 1, versioned_lease_owner: null })
    await expect(psql.sql(`update public.flow_runs set status='active' where id='${run2}'`)).rejects.toThrow('55000')
    pass('I14', 'run paused before start -> not_active, no lease taken; paused by an agent after START -> interpreter stops at END, run stays paused and cannot be reactivated')

    const done = await createRun(f.id)
    await runVersionedFlow(newStore(), opts(done, 'w'))
    const snap = JSON.stringify(await row(done))
    expect(await runVersionedFlow(newStore(), opts(done, 'w2'))).toMatchObject({ kind: 'not_active', status: 'completed', steps: 0 })
    expect(JSON.stringify(await row(done))).toBe(snap)
    pass('I15', 'running a completed run again -> not_active/completed, row byte-identical')
  })

  it('I16: node budget is persisted atomically and enforced', async () => {
    const f = await makeFlow(startEnd)
    const near = await createRun(f.id)
    await psql.sql(`update public.flow_runs set versioned_nodes_executed=499 where id='${near}'`)
    const out = await runVersionedFlow(newStore(), opts(near, 'w'))
    expect(out).toMatchObject({ kind: 'failed', reason: 'node_budget_exceeded', nodesExecuted: 500, steps: 2 })
    const r = await row(near)
    expect(r).toMatchObject({ status: 'failed', versioned_nodes_executed: 500, end_reason: 'node_budget_exceeded', versioned_node_key: 'end', versioned_lease_owner: null })
    expect(r.versioned_checkpoint).toMatchObject({ state: 'terminal', failure: 'node_budget_exceeded', confirmed: { node_key: 'start' } })
    const full = await createRun(f.id)
    await psql.sql(`update public.flow_runs set versioned_nodes_executed=500 where id='${full}'`)
    expect(await runVersionedFlow(newStore(), opts(full, 'w'))).toMatchObject({ kind: 'failed', reason: 'node_budget_exceeded', steps: 1 })
    expect(await row(full)).toMatchObject({ status: 'failed', versioned_nodes_executed: 500, versioned_node_key: 'start' })
    pass('I16', 'at 499 nodes START consumed the last one and END was refused (failed, 500); at 500 START never ran')
  })

  it('I18/I19/I20: legacy untouched; unsupported node, bad edge and active frames fail the run in a controlled way', async () => {
    await ensureAcct()
    const legacy = await psql.sql(`insert into public.flow_runs (flow_id,account_id,user_id,contact_id,status,current_node_key) values ('50000000-0000-4000-8000-000000000002','${acct}','${USER}',public.qa_new_contact(${nextN()}),'active','start') returning id`)
    const legacySnap = JSON.stringify(await row(legacy))
    expect(await runVersionedFlow(newStore(), opts(legacy, 'w'))).toMatchObject({ kind: 'not_found' })
    expect(JSON.stringify(await row(legacy))).toBe(legacySnap)
    expect(await runVersionedFlow(newStore(), { accountId: '99999999-0000-4000-8000-000000000000', runId: legacy, owner: 'w' })).toMatchObject({ kind: 'not_found' })
    pass('I18', 'legacy run and a wrong account -> not_found; legacy row byte-identical')

    const msgsBefore = await psql.sql(`select count(*) from public.messages`)
    const sm = await makeFlow(lin({ key: 'start', type: 'start', config: { next_node_key: 'say' } }, { key: 'say', type: 'send_message', config: { text: 'hi', next_node_key: 'end' } }, { key: 'end', type: 'end' }))
    const smRun = await createRun(sm.id)
    expect(await runVersionedFlow(newStore(), opts(smRun, 'w'))).toMatchObject({ kind: 'failed', reason: 'unsupported_node_type:send_message', steps: 2 })
    expect(await row(smRun)).toMatchObject({ status: 'failed', versioned_node_key: 'say', versioned_nodes_executed: 1, end_reason: 'unsupported_node_type:send_message' })
    expect(await psql.sql(`select count(*) from public.messages`)).toBe(msgsBefore)

    const bad = await makeFlow(lin({ key: 'start', type: 'start', config: { next_node_key: 'nowhere' } }, { key: 'end', type: 'end' }))
    const badRun = await createRun(bad.id)
    expect(await runVersionedFlow(newStore(), opts(badRun, 'w'))).toMatchObject({ kind: 'failed', reason: 'invalid_next_node', steps: 1 })
    expect(await row(badRun)).toMatchObject({ status: 'failed', versioned_node_key: 'start', versioned_nodes_executed: 0 })
    pass('I19', 'unsupported node type (send_message) and a dangling next_node_key end the run as failed; nothing sent')

    const fr = await makeFlow(startEnd)
    const frRun = await createRun(fr.id)
    await psql.sql(`insert into public.flow_run_call_frames (flow_run_id,account_id,caller_flow_id,caller_flow_version_id,call_node_key,return_node_key,depth,callee_flow_id,callee_flow_version_id) values ('${frRun}','${acct}','${fr.id}','${fr.versionId}','start','end',1,'${BASE_FLOW}',(select active_version_id from public.flows where id='${BASE_FLOW}'))`)
    expect(await runVersionedFlow(newStore(), opts(frRun, 'w'))).toMatchObject({ kind: 'failed', reason: 'end_with_active_frames' })
    expect(await row(frRun)).toMatchObject({ status: 'failed', versioned_node_key: 'end', versioned_nodes_executed: 1 })
    pass('I20', 'END with an active call frame refuses to complete the run (failed/end_with_active_frames)')
  })

  it('I21: two interpreters racing on one run - exactly one finishes it', async () => {
    const f = await makeFlow(startEnd)
    const runId = await createRun(f.id)
    const [a, b] = await Promise.all([runVersionedFlow(newStore(), opts(runId, 'racer-a')), runVersionedFlow(newStore(), opts(runId, 'racer-b'))])
    const kinds = [a.kind, b.kind].sort()
    expect(kinds.filter((k) => k === 'completed')).toHaveLength(1)
    expect(['lease_unavailable', 'not_active']).toContain(kinds.find((k) => k !== 'completed'))
    expect(await row(runId)).toMatchObject({ status: 'completed', versioned_revision: 2, versioned_nodes_executed: 2, versioned_lease: 1 })
    pass('I21', `racing instances ended as [${kinds.join(', ')}]; run completed once (revision 2, nodes 2, one lease)`)
  })
})
