import { createHmac, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { supabaseAdmin } from './admin-client'

/**
 * Replace-waiting-run, engine integration: the REAL engine against a disposable PostgreSQL 17 (every migration in supabase/migrations) behind a real
 * PostgREST (isolated Docker network). Sends are simulated; nothing here reaches Meta or any real customer.
 * Skipped unless QA_REST_URL is set (run through qa/replace-waiting/run-engine-qa.sh). Ids RW01...
 */
const REST = process.env.QA_REST_URL ?? ''
const CONTAINER = process.env.QA_PG_CONTAINER ?? ''
vi.setConfig({ testTimeout: 180_000 })
const pass = (id: string, detail: string) => console.log(`QA-RESULT ${id} PASS ${detail}`)

const sent = vi.hoisted(() => ({ texts: [] as Array<{ conversationId: string; text: string }>, failNext: false }))
vi.mock('./meta-send', () => ({
  engineSendText: async (a: { conversationId: string; text: string }) => {
    if (sent.failNext) { sent.failNext = false; throw new Error('simulated Meta outage') }
    sent.texts.push({ conversationId: a.conversationId, text: a.text }); return { whatsapp_message_id: `wamid.sim.${sent.texts.length}` }
  },
  engineSendMedia: async () => ({ whatsapp_message_id: 'wamid.sim.media' }),
  engineSendInteractiveButtons: async () => ({ whatsapp_message_id: 'wamid.sim.btn' }),
  engineSendInteractiveList: async () => ({ whatsapp_message_id: 'wamid.sim.list' }),
}))
vi.mock('./admin-client', () => {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
  const head = b64({ alg: 'HS256', typ: 'JWT' }); const body = b64({ role: 'service_role', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 })
  const token = `${head}.${body}.${createHmac('sha256', process.env.QA_JWT_SECRET ?? '').update(`${head}.${body}`).digest('base64url')}`
  const url = process.env.QA_REST_URL ?? ''
  // This integration suite is skipped in ordinary CI. Do not construct the
  // Supabase Realtime client unless the disposable QA stack is configured:
  // Node 20 has no native WebSocket, and creating the unused client fails
  // at import time before describe.skipIf() can skip the suite.
  const client = url && process.env.QA_PG_CONTAINER ? createClient(url, token, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => { const u = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url; if (!u.startsWith(url)) throw new Error(`blocked: ${u}`); return fetch(u.replace('/rest/v1', ''), init) } },
  })
  return { supabaseAdmin: () => {
    if (!client) throw new Error('Disposable QA PostgREST/PostgreSQL not configured')
    return client
  } }
})

const psql = (sql: string) => new Promise<string>((resolve, reject) => execFile('docker', ['exec', '-i', CONTAINER, 'psql', '-U', 'supabase_admin', '-h', '/var/run/postgresql', '-d', 'postgres', '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', '-c', sql], { maxBuffer: 8 << 20 }, (e, out, err) => (e ? reject(new Error(err || String(e))) : resolve(out.trim()))))
const rows = async <T = Record<string, any>>(q: string) => JSON.parse(await psql(`select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (${q}) t`)) as T[] // eslint-disable-line @typescript-eslint/no-explicit-any

const UA = 'a1000000-0000-4000-8000-000000000001'; const UB = 'b2000000-0000-4000-8000-000000000002'
let acctA = ''; let acctB = ''
let seq = 700
async function world(owner: 'A' | 'B', durable: Record<string, unknown> | { seconds: number }, opts: { activate?: boolean } = {}) {
  const user = owner === 'A' ? UA : UB; const acct = owner === 'A' ? acctA : acctB; const keyword = `info${++seq}${Math.floor(Math.random() * 1e6)}`
  const cfg = { ...durable, next_node_key: 'follow' }
  const flow = (await psql(`insert into public.flows (user_id, account_id, name, trigger_type, trigger_config, entry_node_id) values ('${user}','${acct}','wait ${keyword}','keyword','{"keywords":["${keyword}"]}','start') returning id`)).split('\n')[0]
  const nodes = [
    { k: 'start', t: 'start', c: { next_node_key: 'product' } }, { k: 'product', t: 'send_message', c: { text: 'Info del producto', next_node_key: 'pause' } },
    { k: 'pause', t: 'delay', c: cfg }, { k: 'follow', t: 'send_message', c: { text: 'Seguimos con tu consulta', next_node_key: 'done' } }, { k: 'done', t: 'end', c: {} },
  ]
  for (const n of nodes) await psql(`insert into public.flow_nodes (flow_id, node_key, node_type, config) values ('${flow}','${n.k}','${n.t}','${JSON.stringify(n.c)}')`)
  // activate through the operator switch (PostgREST sessions cannot set it), in one transaction
  if (opts.activate !== false) await psql(`select set_config('app.allow_durable_wait_activation','on',true), set_config('app.flow_publication','on',true); update public.flows set status='active' where id='${flow}'`)
  return { flow, keyword, user, acct }
}
async function contact(w: { user: string; acct: string }) {
  const id = randomUUID(); const conv = randomUUID(); seq += 1
  await psql(`insert into public.contacts (id,user_id,account_id,phone,name) values ('${id}','${w.user}','${w.acct}','+1560${String(seq).padStart(7, '0')}','sim ${seq}'); insert into public.conversations (id,user_id,account_id,contact_id) values ('${conv}','${w.user}','${w.acct}','${id}')`)
  return { contactId: id, conversationId: conv }
}
let engine: typeof import('./engine')
const send = (w: { acct: string; user: string; keyword: string }, c: { contactId: string; conversationId: string }, text?: string) =>
  engine.dispatchInboundToFlows({ accountId: w.acct, userId: w.user, contactId: c.contactId, conversationId: c.conversationId, message: { kind: 'text', text: text ?? w.keyword, meta_message_id: `wamid.in.${randomUUID()}` }, isFirstInboundMessage: false })
const run = async (c: { contactId: string }) => (await rows(`select * from public.flow_runs where contact_id='${c.contactId}' order by started_at desc limit 1`))[0]
const events = (runId: string) => rows(`select event_type, node_key, payload from public.flow_run_events where flow_run_id='${runId}' order by created_at, id`)
const makeDue = (runId: string) => psql(`update public.flow_runs set wait_until = clock_timestamp() - interval '1 second' where id='${runId}'`)
const textsFor = (c: { conversationId: string }) => sent.texts.filter((t) => t.conversationId === c.conversationId).map((t) => t.text)


const db = () => supabaseAdmin()

/** A plain active flow (no wait): start -> one message -> end. */
async function plainFlow(w: { user: string; acct: string }, text: string) {
  const flow = (await psql(`insert into public.flows (user_id, account_id, name, trigger_type, trigger_config, entry_node_id) values ('${w.user}','${w.acct}','plain ${text}','manual','{}','start') returning id`)).split('\n')[0]
  const nodes = [{ k: 'start', t: 'start', c: { next_node_key: 'msg' } }, { k: 'msg', t: 'send_message', c: { text, next_node_key: 'done' } }, { k: 'done', t: 'end', c: {} }]
  for (const n of nodes) await psql(`insert into public.flow_nodes (flow_id, node_key, node_type, config) values ('${flow}','${n.k}','${n.t}','${JSON.stringify(n.c)}')`)
  await psql(`select set_config('app.flow_publication','on',true); update public.flows set status='active' where id='${flow}'`)
  return flow
}
const active = (c: { contactId: string }) => rows(`select id, flow_id, status, end_reason from public.flow_runs where contact_id='${c.contactId}' and status='active'`)
const claimable = async () => ((await rows(`select * from public.claim_due_flow_waits(array['${acctA}']::uuid[])`))).length

describe.skipIf(!REST || !CONTAINER)('replace-waiting-run: engine integration (disposable database, simulated sends)', () => {
  beforeAll(async () => {
    acctA = await psql(`select account_id from public.profiles where user_id='${UA}'`); acctB = await psql(`select account_id from public.profiles where user_id='${UB}'`)
    process.env.FLOW_DURABLE_WAIT_EXECUTION_ACCOUNT_IDS = acctA
    engine = await import('./engine')
  })
  afterAll(() => { delete process.env.FLOW_DURABLE_WAIT_EXECUTION_ACCOUNT_IDS })

  it('RW01: a manual start of ANOTHER flow replaces a parked run; the old wait can no longer be claimed or resumed', async () => {
    const w = await world('A', { amount: 13, unit: 'minutes' }); const c = await contact(w); await send(w, c)
    const parked = await run(c); expect(parked).toMatchObject({ status: 'active', wait_node_key: 'pause' })
    const other = await plainFlow(w, 'Flujo nuevo')
    const res = await engine.startFlowManually({ accountId: w.acct, initiatedByUserId: w.user, flowId: other, conversationId: c.conversationId })
    expect(res).toMatchObject({ outcome: 'started', replaced_flow_run_id: parked.id })
    expect(await rows(`select status, end_reason from public.flow_runs where id='${parked.id}'`)).toEqual([{ status: 'paused_by_agent', end_reason: 'replaced_by_manual_flow' }])
    expect(await active(c)).toHaveLength(0)                                                 // the new flow already ran to its end
    expect(textsFor(c)).toEqual(['Info del producto', 'Flujo nuevo'])
    await makeDue(parked.id); expect(await claimable()).toBe(0)
    expect(await engine.resumeDueFlowWaits({ accountIds: [acctA] })).toMatchObject({ claimed: 0, resumed: 0 }); expect(textsFor(c)).not.toContain('Seguimos con tu consulta')
    pass('RW01', 'parked run closed once (paused_by_agent / replaced_by_manual_flow), new flow ran, the replaced wait is never claimed nor resumed, no stale follow-up')
  })

  it('RW02: interruptWaitingRun is a compare-and-set on the wait that was READ: a run modified concurrently is not interrupted', async () => {
    const w = await world('A', { amount: 13, unit: 'minutes' })
    const snap = async (c: { contactId: string }) => (await run(c)) as import('./types').FlowRunRow
    const unchanged = async (c: { contactId: string }, id: string) => expect(await rows(`select status, end_reason from public.flow_runs where id='${id}'`)).toEqual([{ status: 'active', end_reason: null }])
    // (a) current_node_key moved on while the wait markers stayed (no code clears them in that case, so the guard must not assume it)
    const a = await contact(w); await send(w, a); const sa = await snap(a)
    await psql(`update public.flow_runs set current_node_key='follow' where id='${sa.id}'`)
    expect(await engine.interruptWaitingRun(db(), sa, 'replaced_by_manual_flow')).toBe(false); await unchanged(a, sa.id)
    // (b) resumed and parked again on a later wait: same node, NEW wait_until (ABA)
    const b = await contact(w); await send(w, b); const sb = await snap(b)
    await psql(`update public.flow_runs set wait_until = wait_until + interval '5 minutes' where id='${sb.id}'`)
    expect(await engine.interruptWaitingRun(db(), sb, 'replaced_by_manual_flow')).toBe(false); await unchanged(b, sb.id)
    // (c) a worker claimed it after the read
    const c = await contact(w); await send(w, c); const sc = await snap(c)
    await makeDue(sc.id); expect(await claimable()).toBeGreaterThanOrEqual(1)
    expect(await engine.interruptWaitingRun(db(), sc, 'replaced_by_manual_flow')).toBe(false); await unchanged(c, sc.id)
    // (d) wait_node_key diverged from the snapshot
    const d = await contact(w); await send(w, d); const sd = await snap(d)
    await psql(`update public.flow_runs set wait_node_key='other' where id='${sd.id}'`)
    expect(await engine.interruptWaitingRun(db(), sd, 'replaced_by_manual_flow')).toBe(false); await unchanged(d, sd.id)
    // positive control: an untouched snapshot IS interrupted, exactly once
    const e = await contact(w); await send(w, e); const se = await snap(e)
    expect(await engine.interruptWaitingRun(db(), se, 'replaced_by_manual_flow')).toBe(true)
    expect(await engine.interruptWaitingRun(db(), se, 'replaced_by_manual_flow')).toBe(false)
    pass('RW02', 'node moved / re-parked with a new wait_until / claimed / wait_node_key diverged: every case answers false and leaves the run active and untouched; the untouched snapshot is interrupted exactly once')
  })

  it('RW03: the wait is consumed (scheduler) between the read and the swap: the replacement is stale, the original follow-up is sent exactly once', async () => {
    const w = await world('A', { amount: 13, unit: 'minutes' }); const c = await contact(w); await send(w, c)
    const snap = (await run(c)) as import('./types').FlowRunRow
    await makeDue(snap.id); expect(await engine.resumeDueFlowWaits({ accountIds: [acctA] })).toMatchObject({ resumed: 1 })
    expect(await engine.interruptWaitingRun(db(), snap, 'replaced_by_keyword_flow')).toBe(false)
    expect(textsFor(c)).toEqual(['Info del producto', 'Seguimos con tu consulta']); expect(await run(c)).toMatchObject({ status: 'completed', end_reason: 'end_node' })
    pass('RW03', 'consume_flow_wait won the race: interrupt answers false, follow-up sent once, run completed (not paused_by_agent)')
  })

  it('RW04: two concurrent manual starts of different flows over one parked run: exactly one wins, one active run, old run closed once', async () => {
    const w = await world('A', { amount: 13, unit: 'minutes' }); const c = await contact(w); await send(w, c); const parked = await run(c)
    const f1 = await plainFlow(w, 'Flujo uno'); const f2 = await plainFlow(w, 'Flujo dos')
    const args = (flowId: string) => ({ accountId: w.acct, initiatedByUserId: w.user, flowId, conversationId: c.conversationId })
    const results = await Promise.all([engine.startFlowManually(args(f1)), engine.startFlowManually(args(f2))])
    expect(results.filter((r) => r.outcome === 'started')).toHaveLength(1)
    expect(results.filter((r) => r.outcome === 'active_flow_exists' || r.outcome === 'error')).toHaveLength(1)
    expect(await active(c)).toHaveLength(0)                                                  // the winner is a one-message flow and already ended
    expect(await rows(`select count(*)::int as n from public.flow_runs where contact_id='${c.contactId}' and flow_id in ('${f1}','${f2}')`)).toEqual([{ n: 1 }])
    expect(await rows(`select end_reason from public.flow_runs where id='${parked.id}'`)).toEqual([{ end_reason: 'replaced_by_manual_flow' }])
    expect(textsFor(c).filter((t) => t.startsWith('Flujo '))).toHaveLength(1)
    pass('RW04', 'concurrent replacement: one new run, one swap, the loser got a conflict/stale answer, no duplicate message, never two active runs')
  })

  it('RW05: restoreInterruptedRun puts the parked run back; if the contact got another active run it fails LOUDLY and leaves the run paused', async () => {
    const w = await world('A', { amount: 13, unit: 'minutes' })
    const ok = await contact(w); await send(w, ok); const sOk = (await run(ok)) as import('./types').FlowRunRow
    expect(await engine.interruptWaitingRun(db(), sOk, 'replaced_by_manual_flow')).toBe(true)
    await engine.restoreInterruptedRun(db(), sOk, 'replaced_by_manual_flow')
    expect(await run(ok)).toMatchObject({ status: 'active', end_reason: null, wait_node_key: 'pause', current_node_key: 'pause' })
    await makeDue(sOk.id); expect(await engine.resumeDueFlowWaits({ accountIds: [acctA] })).toMatchObject({ resumed: 1 })   // still resumes normally afterwards
    expect(textsFor(ok)).toEqual(['Info del producto', 'Seguimos con tu consulta'])
    const blocked = await contact(w); await send(w, blocked); const sB = (await run(blocked)) as import('./types').FlowRunRow
    expect(await engine.interruptWaitingRun(db(), sB, 'replaced_by_manual_flow')).toBe(true)
    const other = await plainFlow(w, 'Intruso')
    await psql(`insert into public.flow_runs (flow_id, account_id, user_id, contact_id, conversation_id, status, current_node_key) values ('${other}','${w.acct}','${w.user}','${blocked.contactId}','${blocked.conversationId}','active','start')`)
    await engine.restoreInterruptedRun(db(), sB, 'replaced_by_manual_flow')
    expect(await rows(`select status, end_reason from public.flow_runs where id='${sB.id}'`)).toEqual([{ status: 'paused_by_agent', end_reason: 'replaced_by_manual_flow' }])
    expect((await events(sB.id)).some((e) => e.event_type === 'error' && e.payload.reason === 'replace_restore_failed')).toBe(true)
    expect(await active(blocked)).toHaveLength(1)                                            // the unique index held: still exactly one active run
    pass('RW05', 'restore works and the run resumes later; when another active run exists the unique index holds, the old run stays paused and a replace_restore_failed event is recorded')
  })
})
