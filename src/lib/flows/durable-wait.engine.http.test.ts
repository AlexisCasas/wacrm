import { createHmac, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createClient } from '@supabase/supabase-js'

/**
 * Durable waits, engine integration: the REAL engine against a disposable PostgreSQL 17 (migrations 001..069) behind a real
 * PostgREST (isolated Docker network). Sends are simulated; nothing here reaches Meta or any real customer.
 * Skipped unless QA_REST_URL is set (run through qa/durable-wait/run-engine-qa.sh). Ids E01...
 */
const REST = process.env.QA_REST_URL ?? ''
const SECRET = process.env.QA_JWT_SECRET ?? ''
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
  const client = createClient(url || 'http://invalid.local', token, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => { const u = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url; if (!u.startsWith(url)) throw new Error(`blocked: ${u}`); return fetch(u.replace('/rest/v1', ''), init) } },
  })
  return { supabaseAdmin: () => client }
})

const psql = (sql: string) => new Promise<string>((resolve, reject) => execFile('docker', ['exec', '-i', CONTAINER, 'psql', '-U', 'supabase_admin', '-h', '/var/run/postgresql', '-d', 'postgres', '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', '-c', sql], { maxBuffer: 8 << 20 }, (e, out, err) => (e ? reject(new Error(err || String(e))) : resolve(out.trim()))))
const rows = async <T = Record<string, any>>(q: string) => JSON.parse(await psql(`select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (${q}) t`)) as T[] // eslint-disable-line @typescript-eslint/no-explicit-any

const UA = 'a1000000-0000-4000-8000-000000000001'; const UB = 'b2000000-0000-4000-8000-000000000002'
let acctA = ''; let acctB = ''
let seq = 100
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

describe.skipIf(!REST || !CONTAINER)('durable waits: engine integration (disposable database, simulated sends)', () => {
  beforeAll(async () => {
    acctA = await psql(`select account_id from public.profiles where user_id='${UA}'`); acctB = await psql(`select account_id from public.profiles where user_id='${UB}'`)
    process.env.FLOW_DURABLE_WAIT_EXECUTION_ACCOUNT_IDS = acctA            // execution ON for A only, in THIS test process
    engine = await import('./engine')
  })
  afterAll(() => { delete process.env.FLOW_DURABLE_WAIT_EXECUTION_ACCOUNT_IDS })

  it('E01-E04: a 13-minute wait is parked at once, never resumed early, resumed once when due, then done', async () => {
    const w = await world('A', { amount: 13, unit: 'minutes' }); const c = await contact(w)
    const t0 = Date.now(); const res = await send(w, c)
    expect(res).toMatchObject({ consumed: true }); const r1 = await run(c)
    expect(textsFor(c)).toEqual(['Info del producto'])                                   // the product info went out; the follow-up did not
    expect(r1).toMatchObject({ status: 'active', current_node_key: 'pause', wait_node_key: 'pause' }); expect(r1.wait_claim_token).toBeNull()
    const dueIn = new Date(r1.wait_until).getTime() - t0; expect(dueIn).toBeGreaterThan(13 * 60_000 - 5_000); expect(dueIn).toBeLessThan(13 * 60_000 + 10_000)
    expect((await events(r1.id)).find((e) => e.node_key === 'pause' && e.payload.durable)?.payload).toMatchObject({ durable: true, amount: 13, unit: 'minutes' })
    pass('E01', `13-minute wait: first message sent once, run active and parked at "pause", resume time = start + ${(dueIn / 60_000).toFixed(2)} min, nothing slept in-process (the call returned immediately)`)
    // 12 min 59 s: nothing happens
    await psql(`update public.flow_runs set wait_until = clock_timestamp() + interval '1 second' where id='${r1.id}'`)
    expect(await engine.resumeDueFlowWaits({ accountIds: [acctA] })).toMatchObject({ claimed: 0, resumed: 0 }); expect(textsFor(c)).toEqual(['Info del producto'])
    pass('E02', 'one second before the time: the scheduler claims nothing and sends nothing')
    await makeDue(r1.id)
    const s1 = await engine.resumeDueFlowWaits({ accountIds: [acctA] }); expect(s1).toMatchObject({ claimed: 1, resumed: 1, failed: 0 })
    expect(textsFor(c)).toEqual(['Info del producto', 'Seguimos con tu consulta'])
    const r2 = await run(c); expect(r2).toMatchObject({ status: 'completed', end_reason: 'end_node', wait_until: null, wait_node_key: null, wait_claim_token: null })
    expect((await events(r1.id)).some((e) => e.payload.reason === 'wait_resumed')).toBe(true)
    pass('E03', 'once due: claimed -> consumed -> follow-up sent exactly once -> run completed with the wait cleared and a wait_resumed event')
    expect(await engine.resumeDueFlowWaits({ accountIds: [acctA] })).toMatchObject({ claimed: 0 }); expect(textsFor(c)).toHaveLength(2)
    pass('E04', 'a second scheduler pass finds nothing: no duplicate follow-up')
  })

  it('E05: two schedulers racing over 12 due waits resume each exactly once', async () => {
    const w = await world('A', { amount: 13, unit: 'minutes' }); const cs = []
    for (let i = 0; i < 12; i++) { const c = await contact(w); await send(w, c); cs.push(c) }
    await psql(`update public.flow_runs set wait_until = clock_timestamp() - interval '1 second' where flow_id='${w.flow}'`)
    const [a, b] = await Promise.all([engine.resumeDueFlowWaits({ accountIds: [acctA], limit: 50 }), engine.resumeDueFlowWaits({ accountIds: [acctA], limit: 50 })])
    expect(a.resumed + b.resumed).toBe(12); expect(a.failed + b.failed).toBe(0)
    for (const c of cs) expect(textsFor(c)).toEqual(['Info del producto', 'Seguimos con tu consulta'])
    pass('E05', `12 simultaneous waits, two concurrent scheduler passes (${a.resumed} + ${b.resumed} resumed): every contact got the follow-up exactly once, none lost`)
  })

  it('E06: cancellation during the wait (agent, blocked contact, paused flow) prevents the follow-up', async () => {
    const w = await world('A', { amount: 2, unit: 'hours' }); const agent = await contact(w); const blocked = await contact(w); const paused = await contact(w)
    for (const c of [agent, blocked, paused]) await send(w, c)
    const rAgent = await run(agent), rBlocked = await run(blocked), rPaused = await run(paused)
    await psql(`update public.flow_runs set status='paused_by_agent', end_reason='agent_reply' where id='${rAgent.id}'`)          // what send-message does when an agent replies
    await psql(`update public.flow_runs set status='paused_by_agent', end_reason='contact_blocked' where id='${rBlocked.id}'`)    // what the block route does
    await psql(`update public.flow_runs set wait_until = clock_timestamp() - interval '1 second' where flow_id='${w.flow}'`)
    await psql(`update public.flows set status='archived' where id='${w.flow}'`)                                                  // the flow is switched off while "paused" waits
    const s = await engine.resumeDueFlowWaits({ accountIds: [acctA] })
    expect(s.resumed).toBe(0); expect(s.skipped).toBe(1)
    for (const c of [agent, blocked, paused]) expect(textsFor(c)).toEqual(['Info del producto'])
    expect(await run(paused)).toMatchObject({ status: 'failed', end_reason: 'flow_not_active_at_resume' }); expect(rPaused.id).toBeTruthy()
    expect((await run(agent)).status).toBe('paused_by_agent'); expect((await run(blocked)).end_reason).toBe('contact_blocked')
    pass('E06', 'agent took over / contact blocked: never claimed, no follow-up; flow archived during the wait: the run is ended (flow_not_active_at_resume), no follow-up')
  })

  it('E07: customer replies during the wait are recorded, never answered, never end the run; the follow-up still goes out', async () => {
    const w = await world('A', { amount: 13, unit: 'minutes' }); const c = await contact(w); await send(w, c)
    const results = []; for (let i = 0; i < 5; i++) results.push(await send(w, c, `me interesa ${i}`))    // more than the reprompt cap of the fallback policy
    for (const r of results) expect(r).toMatchObject({ consumed: false, outcome: 'waiting' })
    const r = await run(c); expect(r).toMatchObject({ status: 'active', current_node_key: 'pause', reprompt_count: 0 }); expect(r.wait_until).not.toBeNull()
    expect(textsFor(c)).toEqual(['Info del producto'])                                                    // no reprompt, no handoff text
    const ev = (await events(r.id)).filter((e) => e.event_type === 'reply_received'); expect(ev).toHaveLength(5); expect(ev.every((e) => e.payload.during_wait === true)).toBe(true)
    expect((await events(r.id)).some((e) => e.event_type === 'handoff' || e.event_type === 'fallback_fired')).toBe(false)
    await makeDue(r.id); await engine.resumeDueFlowWaits({ accountIds: [acctA] }); expect(textsFor(c)).toEqual(['Info del producto', 'Seguimos con tu consulta'])
    pass('E07', '5 replies during the wait: each logged as reply_received {during_wait:true} (no text stored), reported as consumed:false/waiting so the message stays with Inbox and other automations, no reprompt / handoff / fallback, run still waiting; the follow-up is sent after the time')
  })

  it('E08: tenancy: an account without execution enabled never has its waits resumed; its flows fail closed', async () => {
    const wb = await world('B', { amount: 13, unit: 'minutes' }); const cb = await contact(wb)
    await send(wb, cb)
    expect(await run(cb)).toMatchObject({ status: 'failed', end_reason: 'durable_wait_not_enabled', wait_until: null })      // never silently skipped or shortened
    expect(textsFor(cb)).toEqual(['Info del producto'])
    // a wait row forced into B's run is not served to a scheduler that only lists A
    const wa = await world('A', { amount: 13, unit: 'minutes' }); const ca = await contact(wa); await send(wa, ca)
    const rb = await run(cb); await psql(`update public.flow_runs set status='active', end_reason=null, ended_at=null, current_node_key='pause', wait_node_key='pause', wait_until = clock_timestamp() - interval '1 minute' where id='${rb.id}'`)
    await makeDue((await run(ca)).id)
    const s = await engine.resumeDueFlowWaits({ accountIds: [acctA] }); expect(s.resumed).toBe(1)
    expect(textsFor(cb)).toEqual(['Info del producto']); expect(textsFor(ca)).toHaveLength(2)
    expect(await engine.resumeDueFlowWaits({ accountIds: [] })).toMatchObject({ claimed: 0 })
    pass('E08', "account B (execution not enabled): its run fails closed at the wait (durable_wait_not_enabled) instead of sleeping or skipping it; even a forged due wait of B is not served to a scheduler restricted to A; an empty account list does nothing")
  })

  it('E09: crash windows between claim, consume and advance', async () => {
    const admin = (await import('./admin-client')).supabaseAdmin()
    // (a) crash right after CLAIM: the wait is intact; after the lease another worker resumes it once
    const wa = await world('A', { amount: 13, unit: 'minutes' }); const ca = await contact(wa); await send(wa, ca); const ra = await run(ca); await makeDue(ra.id)
    const claimed = await admin.rpc('claim_due_flow_waits', { p_account_ids: [acctA], p_limit: 50, p_lease_seconds: 300 }); expect((claimed.data as { run_id: string }[]).some((x) => x.run_id === ra.id)).toBe(true)
    expect(await engine.resumeDueFlowWaits({ accountIds: [acctA] })).toMatchObject({ claimed: 0 }); expect(textsFor(ca)).toEqual(['Info del producto'])    // inside the lease nobody else touches it
    await psql(`update public.flow_runs set wait_claimed_at = clock_timestamp() - interval '10 minutes' where id='${ra.id}'`)
    expect(await engine.resumeDueFlowWaits({ accountIds: [acctA] })).toMatchObject({ resumed: 1 }); expect(textsFor(ca)).toEqual(['Info del producto', 'Seguimos con tu consulta'])
    // (b) crash right after CONSUME, before any send: the follow-up is LOST (never duplicated); nobody resumes it again
    const wb = await world('A', { amount: 13, unit: 'minutes' }); const cb = await contact(wb); await send(wb, cb); const rb = await run(cb); await makeDue(rb.id)
    const cl = await admin.rpc('claim_due_flow_waits', { p_account_ids: [acctA], p_limit: 50, p_lease_seconds: 300 }); const mine = (cl.data as { run_id: string; claim_token: string }[]).find((x) => x.run_id === rb.id)!
    const consumed = await admin.rpc('consume_flow_wait', { p_account_id: acctA, p_run_id: rb.id, p_claim_token: mine.claim_token, p_next_node_key: 'follow' }); expect(consumed.data).toBe(true)
    expect(await engine.resumeDueFlowWaits({ accountIds: [acctA] })).toMatchObject({ claimed: 0 }); expect(textsFor(cb)).toEqual(['Info del producto'])
    expect(await run(cb)).toMatchObject({ status: 'active', current_node_key: 'follow', wait_until: null })        // stranded: the stale-run sweep ends it after on_timeout_hours
    // (c) the send itself fails after consume: one attempt, the run fails, nothing is retried
    const wc = await world('A', { amount: 13, unit: 'minutes' }); const cc = await contact(wc); await send(wc, cc); await makeDue((await run(cc)).id)
    sent.failNext = true; const sc = await engine.resumeDueFlowWaits({ accountIds: [acctA] })
    expect(await run(cc)).toMatchObject({ status: 'failed', end_reason: 'send_text_failed' }); expect(textsFor(cc)).toEqual(['Info del producto']); expect(sc.claimed).toBe(1)
    expect(await engine.resumeDueFlowWaits({ accountIds: [acctA] })).toMatchObject({ claimed: 0 })
    pass('E09', 'claim-then-crash: intact, resumed once after the lease; consume-then-crash: follow-up LOST (documented window), never duplicated, never resumed twice; send failure after consume: one attempt, run failed, no retry. Exactly-once delivery is NOT claimed')
  })

  it('E10: recovery after a server restart (a fresh engine instance resumes what the previous one parked)', async () => {
    const w = await world('A', { amount: 13, unit: 'minutes' }); const c = await contact(w); await send(w, c)
    vi.resetModules(); const restarted = await import('./engine')                          // a new process: no module state survives
    expect(restarted).not.toBe(engine)
    await makeDue((await run(c)).id)
    expect(await restarted.resumeDueFlowWaits({ accountIds: [acctA] })).toMatchObject({ resumed: 1 }); expect(textsFor(c)).toEqual(['Info del producto', 'Seguimos con tu consulta'])
    pass('E10', 'after discarding every in-memory module (simulated restart) a brand-new engine instance finds the parked wait in the database and resumes it once (database restart: W12 in run-db-qa.sh)')
  })

  it('E11: seconds, hours and days are scheduled for the right moment; the legacy short delay still sleeps in-process', async () => {
    const cases: Array<[Record<string, unknown>, number]> = [[{ amount: 30, unit: 'seconds' }, 30], [{ amount: 90, unit: 'minutes' }, 5400], [{ amount: 2, unit: 'hours' }, 7200], [{ amount: 3, unit: 'days' }, 259200]]
    const got: string[] = []
    for (const [cfg, seconds] of cases) {
      const w = await world('A', cfg); const c = await contact(w); const t0 = Date.now(); await send(w, c); const r = await run(c)
      const delta = (new Date(r.wait_until).getTime() - t0) / 1000; expect(delta).toBeGreaterThan(seconds - 5); expect(delta).toBeLessThan(seconds + 10); expect(textsFor(c)).toEqual(['Info del producto']); got.push(`${cfg.amount} ${cfg.unit}`)
    }
    const wl = await world('A', { seconds: 1 }, { activate: true }); const cl = await contact(wl); const t1 = Date.now(); await send(wl, cl)
    expect(Date.now() - t1).toBeGreaterThanOrEqual(900); expect(textsFor(cl)).toEqual(['Info del producto', 'Seguimos con tu consulta']); expect((await run(cl)).wait_until).toBeNull()
    pass('E11', `${got.join(', ')} are parked for the exact duration; a legacy { seconds: 1 } delay is unchanged: it slept in-process and finished the flow in the same call, no wait stored`)
  })

  it('E12: nothing is resumed while execution is disabled for every account (the production setting)', async () => {
    const w = await world('A', { amount: 13, unit: 'minutes' }); const c = await contact(w); await send(w, c); await makeDue((await run(c)).id)
    const saved = process.env.FLOW_DURABLE_WAIT_EXECUTION_ACCOUNT_IDS; delete process.env.FLOW_DURABLE_WAIT_EXECUTION_ACCOUNT_IDS
    try {
      const { durableWaitExecutionAccountIds } = await import('./durable-wait-capability'); expect(durableWaitExecutionAccountIds()).toEqual([])
      expect(await engine.resumeDueFlowWaits({ accountIds: durableWaitExecutionAccountIds() })).toMatchObject({ claimed: 0, resumed: 0 })
      const w2 = await world('A', { amount: 13, unit: 'minutes' }); const c2 = await contact(w2); await send(w2, c2)
      expect(await run(c2)).toMatchObject({ status: 'failed', end_reason: 'durable_wait_not_enabled' })
    } finally { process.env.FLOW_DURABLE_WAIT_EXECUTION_ACCOUNT_IDS = saved }
    expect(textsFor(c)).toEqual(['Info del producto'])
    pass('E12', 'with the execution list empty (production): the scheduler claims nothing, and a flow that reaches a durable wait fails closed instead of running its follow-up early')
  })
})
