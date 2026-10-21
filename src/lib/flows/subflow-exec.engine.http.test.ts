import { createHmac, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createClient } from '@supabase/supabase-js'

/**
 * P8 subflow execution (A -> B -> A -> C -> A), engine integration: the REAL engine against a disposable PostgreSQL 17
 * (every migration in supabase/migrations) behind a real PostgREST on an isolated Docker network. Sends are SIMULATED: the fake sender
 * writes the same outbound `messages` row the real one writes (sender_type 'bot', DB clock) and nothing else; nothing reaches Meta or a
 * real customer. Skipped unless QA_REST_URL is set (qa/subflow-exec/run-engine-qa.sh). Ids S01...
 */
const REST = process.env.QA_REST_URL ?? ''
const CONTAINER = process.env.QA_PG_CONTAINER ?? ''
vi.setConfig({ testTimeout: 180_000 })
const pass = (id: string, detail: string) => console.log(`QA-RESULT ${id} PASS ${detail}`)

const sent = vi.hoisted(() => ({
  texts: [] as Array<{ conversationId: string; text: string }>,
  psql: null as null | ((sql: string) => Promise<string>),
  /** Runs right after the outbound row is stored (the customer can answer at any instant after that). */
  afterStore: null as null | ((a: { conversationId: string; text: string }) => Promise<void>),
  /** Runs BEFORE the outbound row is stored, i.e. while the (simulated) Meta call is in flight. */
  duringCall: null as null | ((a: { conversationId: string; text: string }) => Promise<void>),
  blockedFetches: 0,
  /** The next send throws as if the contact had just been blocked. */
  blockNext: false,
  buttons: 0,
}))
vi.mock('./meta-send', () => ({
  engineSendText: async (a: { conversationId: string; text: string }) => {
    if (sent.blockNext) { sent.blockNext = false; const { ContactBlockedError } = await import('@/lib/contacts/blocking'); throw new ContactBlockedError() }
    await sent.duringCall?.(a)
    sent.texts.push({ conversationId: a.conversationId, text: a.text }); const wamid = `wamid.sim.${randomUUID()}`
    await sent.psql!(`insert into public.messages (conversation_id, sender_type, content_type, content_text, message_id, status) values ('${a.conversationId}','bot','text','${a.text.replace(/'/g, "''")}','${wamid}','sent')`)
    await sent.afterStore?.(a)
    return { whatsapp_message_id: wamid }
  },
  engineSendMedia: async () => { throw new Error('media is not simulated in this suite') },
  engineSendInteractiveButtons: async () => { sent.buttons += 1; return { whatsapp_message_id: `wamid.sim.btn.${sent.buttons}` } },
  engineSendInteractiveList: async () => ({ whatsapp_message_id: 'wamid.sim.list' }),
}))
vi.mock('./admin-client', () => {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
  const head = b64({ alg: 'HS256', typ: 'JWT' }); const body = b64({ role: 'service_role', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 })
  const token = `${head}.${body}.${createHmac('sha256', process.env.QA_JWT_SECRET ?? '').update(`${head}.${body}`).digest('base64url')}`
  const url = process.env.QA_REST_URL ?? ''
  const client = createClient(url || 'http://invalid.local', token, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => { const u = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url; if (!u.startsWith(url)) { sent.blockedFetches += 1; throw new Error(`blocked: ${u}`) } return fetch(u.replace('/rest/v1', ''), init) } },
  })
  return { supabaseAdmin: () => client }
})

const psql = (sql: string) => new Promise<string>((resolve, reject) => execFile('docker', ['exec', '-i', CONTAINER, 'psql', '-U', 'supabase_admin', '-h', '/var/run/postgresql', '-d', 'postgres', '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', '-c', sql], { maxBuffer: 8 << 20 }, (e, out, err) => (e ? reject(new Error(err || String(e))) : resolve(out.trim()))))
sent.psql = psql
const rows = async <T = Record<string, any>>(q: string) => JSON.parse(await psql(`select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (${q}) t`)) as T[] // eslint-disable-line @typescript-eslint/no-explicit-any

const UA = 'a1000000-0000-4000-8000-000000000001'; const UB = 'b2000000-0000-4000-8000-000000000002'
let acctA = ''; let acctB = ''
let seq = 700
type World = { a: string; b: string; c: string; keyword: string; user: string; acct: string }
type Contact = { contactId: string; conversationId: string }
const j = (v: unknown) => JSON.stringify(v).replace(/'/g, "''")
const node = (flow: string, k: string, t: string, c: Record<string, unknown>) => psql(`insert into public.flow_nodes (flow_id, node_key, node_type, config) values ('${flow}','${k}','${t}','${j(c)}')`)
const newFlow = async (user: string, acct: string, name: string, trigger: 'keyword' | 'manual', keyword = '') =>
  (await psql(`insert into public.flows (user_id, account_id, name, trigger_type, trigger_config, entry_node_id) values ('${user}','${acct}','${name}','${trigger}','${trigger === 'keyword' ? `{"keywords":["${keyword}"]}` : '{}'}','start') returning id`)).split('\n')[0]
const activate = (...flows: string[]) => psql(`select set_config('app.allow_durable_wait_activation','on',true), set_config('app.flow_publication','on',true); update public.flows set status='active' where id in (${flows.map((f) => `'${f}'`).join(',')})`)
const enable = (acct: string, sub = true, wait = true) => psql(`insert into public.flow_execution_enablement (account_id, subflow_execution, durable_wait_execution) values ('${acct}', ${sub}, ${wait}) on conflict (account_id) do update set subflow_execution=excluded.subflow_execution, durable_wait_execution=excluded.durable_wait_execution`)

/**
 * A (keyword) : start -> info (send) -> call1 (run B, reference = info) -> call2 (run C) -> close (send) -> end
 * B           : start -> pause (13 min) -> check (customer activity, inherited reference) -> YES: endYes (whole execution)
 *                                                                                         -> NO : follow (send) -> endNo (return)
 *   kind 'plain'   : start -> pause -> follow -> endNo        (no condition: relies on the on_customer_reply policy)
 *   kind 'buttons' : start -> ask (buttons) -> follow -> endNo (a legitimate interactive reply inside B)
 * C           : start -> sendC -> endC (return)
 */
async function world(opts: { owner?: 'A' | 'B'; tenant?: { user: string; acct: string }; kind?: 'cond' | 'plain' | 'buttons'; policy?: 'stop' | 'continue'; yesScope?: 'run' | 'subflow' } = {}): Promise<World> {
  const owner = opts.owner ?? 'A'; const user = opts.tenant?.user ?? (owner === 'A' ? UA : UB); const acct = opts.tenant?.acct ?? (owner === 'A' ? acctA : acctB); const keyword = `hidro${++seq}${Math.floor(Math.random() * 1e6)}`
  const kind = opts.kind ?? 'cond'
  const b = await newFlow(user, acct, `B ${keyword}`, 'manual'); const c = await newFlow(user, acct, `C ${keyword}`, 'manual'); const a = await newFlow(user, acct, `A ${keyword}`, 'keyword', keyword)
  await node(b, 'start', 'start', { next_node_key: kind === 'buttons' ? 'ask' : 'pause' })
  if (kind === 'buttons') {
    await node(b, 'ask', 'send_buttons', { text: '¿Te interesa?', buttons: [{ reply_id: 'yes', title: 'Sí', next_node_key: 'follow' }, { reply_id: 'no', title: 'No', next_node_key: 'endYes' }] })
  } else {
    await node(b, 'pause', 'delay', { amount: 13, unit: 'minutes', next_node_key: kind === 'cond' ? 'check' : 'follow' })
  }
  if (kind === 'cond') await node(b, 'check', 'condition', { subject: 'customer_activity', subject_key: '$inherited', operator: 'replied_after_reference', true_next: 'endYes', false_next: 'follow' })
  await node(b, 'follow', 'send_message', { text: 'Seguimiento B', next_node_key: 'endNo' })
  await node(b, 'endNo', 'end', { scope: 'subflow' }); await node(b, 'endYes', 'end', { scope: opts.yesScope ?? 'run' })
  await node(c, 'start', 'start', { next_node_key: 'sendC' }); await node(c, 'sendC', 'send_message', { text: 'Mensaje de C', next_node_key: 'endC' }); await node(c, 'endC', 'end', { scope: 'subflow' })
  await node(a, 'start', 'start', { next_node_key: 'info' }); await node(a, 'info', 'send_message', { text: 'Información de la hidrolavadora', next_node_key: 'call1' })
  await node(a, 'call1', 'execute_flow', { target_flow_id: b, next_node_key: 'call2', reference_node_key: 'info', on_customer_reply: opts.policy ?? 'stop' })
  await node(a, 'call2', 'execute_flow', { target_flow_id: c, next_node_key: 'close' })
  await node(a, 'close', 'send_message', { text: 'Cierre de A', next_node_key: 'end' }); await node(a, 'end', 'end', {})
  await activate(b, c, a)
  return { a, b, c, keyword, user, acct }
}
async function contact(w: { user: string; acct: string }): Promise<Contact> {
  const id = randomUUID(); const conv = randomUUID(); seq += 1
  await psql(`insert into public.contacts (id,user_id,account_id,phone,name) values ('${id}','${w.user}','${w.acct}','+1562${String(seq).padStart(7, '0')}','sim ${seq}'); insert into public.conversations (id,user_id,account_id,contact_id) values ('${conv}','${w.user}','${w.acct}','${id}')`)
  return { contactId: id, conversationId: conv }
}
let engine: typeof import('./engine')
const send = (w: World, c: Contact, text?: string) =>
  engine.dispatchInboundToFlows({ accountId: w.acct, userId: w.user, contactId: c.contactId, conversationId: c.conversationId, message: { kind: 'text', text: text ?? w.keyword, meta_message_id: `wamid.in.${randomUUID()}` }, isFirstInboundMessage: false })
const tap = (w: World, c: Contact, replyId: string) =>
  engine.dispatchInboundToFlows({ accountId: w.acct, userId: w.user, contactId: c.contactId, conversationId: c.conversationId, message: { kind: 'interactive_reply', reply_id: replyId, reply_title: replyId, meta_message_id: `wamid.in.${randomUUID()}` } as never, isFirstInboundMessage: false })
const run = async (c: { contactId: string }) => (await rows(`select * from public.flow_runs where contact_id='${c.contactId}' order by started_at desc limit 1`))[0]
const runCount = async (c: { contactId: string }) => Number(await psql(`select count(*) from public.flow_runs where contact_id='${c.contactId}'`))
const frames = (runId: string) => rows(`select * from public.flow_run_subflow_frames where flow_run_id='${runId}' order by depth`)
const events = (runId: string) => rows(`select event_type, node_key, payload from public.flow_run_events where flow_run_id='${runId}' order by created_at, id`)
const reasons = async (runId: string) => (await events(runId)).map((e) => e.payload?.reason).filter(Boolean) as string[]
const makeDue = (runId: string) => psql(`update public.flow_runs set wait_until = clock_timestamp() - interval '1 second' where id='${runId}'`)
const textsFor = (c: { conversationId: string }) => sent.texts.filter((t) => t.conversationId === c.conversationId).map((t) => t.text)
const resume = () => engine.resumeDueFlowWaits({ accountIds: [acctA] })
/** A message stored the way the webhook stores it, `offsetSeconds` after the FIRST outbound message of the conversation. */
async function msg(opts: { conv: string; offsetSeconds: number; sender?: 'customer' | 'agent' | 'bot'; contentType?: string; interactiveReplyId?: string }) {
  const sender = opts.sender ?? 'customer'
  await psql(`insert into public.messages (conversation_id, sender_type, content_type, content_text, message_id, status, created_at, interactive_reply_id)
              select '${opts.conv}','${sender}','${opts.contentType ?? 'text'}','x','wamid.in.${randomUUID()}','delivered', created_at + interval '${opts.offsetSeconds} seconds', ${opts.interactiveReplyId ? `'${opts.interactiveReplyId}'` : 'null'}
              from public.messages where conversation_id='${opts.conv}' and sender_type='bot' order by created_at limit 1`)
}
const INFO = 'Información de la hidrolavadora'; const FOLLOW = 'Seguimiento B'; const MSG_C = 'Mensaje de C'; const CLOSE = 'Cierre de A'

describe.skipIf(!REST || !CONTAINER)('P8 subflow execution with return (disposable database, simulated sends)', () => {
  beforeAll(async () => {
    acctA = await psql(`select account_id from public.profiles where user_id='${UA}'`); acctB = await psql(`select account_id from public.profiles where user_id='${UB}'`)
    await enable(acctA)                                                                                                       // the backend-controlled table: account A only
    process.env.FLOW_DURABLE_WAIT_EXECUTION_ACCOUNT_IDS = acctA; process.env.FLOW_CUSTOMER_REPLY_CONDITION_ACCOUNT_IDS = acctA; process.env.FLOW_SUBFLOW_EXECUTION_ACCOUNT_IDS = acctA   // the environment flag: second, independent condition
    engine = await import('./engine')
  })
  afterAll(() => { for (const k of ['FLOW_DURABLE_WAIT_EXECUTION_ACCOUNT_IDS', 'FLOW_CUSTOMER_REPLY_CONDITION_ACCOUNT_IDS', 'FLOW_SUBFLOW_EXECUTION_ACCOUNT_IDS']) delete process.env[k]; sent.afterStore = null; sent.duringCall = null })

  it('S01: A -> B -> A -> C -> A on ONE run: B waits 13 minutes, nobody replied, follow-up, return, C, return, close, end', async () => {
    const w = await world(); const c = await contact(w); await send(w, c)
    let r = await run(c)
    expect(textsFor(c)).toEqual([INFO]); expect(r).toMatchObject({ status: 'active', current_flow_id: w.b, flow_id: w.a, current_node_key: 'pause' }); expect(r.wait_until).not.toBeNull()
    expect(await frames(r.id)).toHaveLength(1); expect((await frames(r.id))[0]).toMatchObject({ caller_flow_id: w.a, callee_flow_id: w.b, return_node_key: 'call2', depth: 1, on_customer_reply: 'stop' })
    expect(r.vars['$refs']['$inherited']).toBeTruthy(); expect(r.vars['$refs'][`${w.a}#info`]).toBeTruthy()                 // the reference travelled with the call (and is qualified by flow)
    await makeDue(r.id); expect(await resume()).toMatchObject({ claimed: 1, resumed: 1, failed: 0 })
    r = await run(c)
    expect(textsFor(c)).toEqual([INFO, FOLLOW, MSG_C, CLOSE]); expect(r).toMatchObject({ status: 'completed', end_reason: 'end_node', current_flow_id: null }); expect(await frames(r.id)).toHaveLength(0)
    expect(await runCount(c)).toBe(1)                                                                                           // one logical run for the contact, always
    const rs = await reasons(r.id); expect(rs.filter((x) => x === 'subflow_called')).toHaveLength(2); expect(rs.filter((x) => x === 'subflow_returned')).toHaveLength(2)
    expect((await events(r.id)).filter((e) => e.payload?.reason === 'subflow_called').map((e) => e.payload.depth)).toEqual([1, 1])   // sequential, never nested
    expect(await resume()).toMatchObject({ claimed: 0 }); expect(textsFor(c)).toHaveLength(4)
    pass('S01', 'A info -> B (13 min wait, condition NO, follow-up) -> back in A -> C -> back in A -> close -> end: 4 messages in order, ONE run, depth 1 each call, no frame left, no duplicate on a second pass')
  })

  it('S02/S05: the customer replied at minute 5: B ends the WHOLE execution; C and the close of A never run; the reply stays available to Inbox / automations', async () => {
    const w = await world(); const c = await contact(w); await send(w, c)
    await msg({ conv: c.conversationId, offsetSeconds: 300 })
    const during = await send(w, c, 'me interesa el precio'); expect(during).toMatchObject({ consumed: false, outcome: 'waiting' })
    await makeDue((await run(c)).id); await resume()
    const r = await run(c); expect(textsFor(c)).toEqual([INFO]); expect(r).toMatchObject({ status: 'completed', end_reason: 'end_node', current_flow_id: w.b }); expect(await frames(r.id)).toHaveLength(0)                                                                                // migration 072 closes the frame of a run that ended inside B (before it stayed as a residue: pilot incident)
    expect((await reasons(r.id)).filter((x) => x === 'stack_closed_on_end')).toHaveLength(1)
    expect((await reasons(r.id)).filter((x) => x === 'subflow_called')).toHaveLength(1)                                         // C was never called
    pass('S02', 'reply at +5 min: condition YES, B\'s End is "whole execution": no follow-up, C never called, A never resumes; the in-wait message returned consumed:false (Inbox / automations still see it)')
  })

  it('S03: the customer answered right after the first message and BEFORE the wait was scheduled: no follow-up', async () => {
    const w = await world(); const c = await contact(w)
    sent.afterStore = async (a) => { if (a.text === INFO) { sent.afterStore = null; await msg({ conv: a.conversationId, offsetSeconds: 1 }) } }
    await send(w, c); sent.afterStore = null
    await makeDue((await run(c)).id); await resume(); expect(textsFor(c)).toEqual([INFO])
    pass('S03', 'a reply stored 1 s after the reference and before the call / wait existed is found: YES, nothing else is sent')
  })

  it.each([['text', 'text', undefined], ['button tap', 'interactive', 'btn_si'], ['list row', 'interactive', 'row_1'], ['image', 'image', undefined], ['audio', 'audio', undefined]])('S04: a %s from the customer counts as the reply', async (label, contentType, replyId) => {
    const w = await world(); const c = await contact(w); await send(w, c)
    await msg({ conv: c.conversationId, offsetSeconds: 60, contentType, interactiveReplyId: replyId }); await makeDue((await run(c)).id); await resume()
    expect(textsFor(c)).toEqual([INFO])
    if (label === 'audio') pass('S04', 'text, button tap, list row, image and audio from the customer all stop the follow-up (YES)')
  })

  it('S06: B ends normally ("return") and A continues to C: also when B\'s YES branch is configured to return', async () => {
    const w = await world({ yesScope: 'subflow' }); const c = await contact(w); await send(w, c); await msg({ conv: c.conversationId, offsetSeconds: 30 })
    await makeDue((await run(c)).id); await resume()
    expect(textsFor(c)).toEqual([INFO, MSG_C, CLOSE])                                                                          // no follow-up (replied) but the flow went on: B returned normally
    pass('S06', 'a "return" End on the YES branch hands control back: A goes on to C and to its close; only the follow-up was skipped')
  })

  it('S07: A is modified while B is suspended: the resume is refused BEFORE anything else is sent', async () => {
    const w = await world(); const c = await contact(w); await send(w, c)
    await psql(`update public.flow_nodes set config = jsonb_set(config,'{text}','"Cierre NUEVO"') where flow_id='${w.a}' and node_key='close'`)
    await makeDue((await run(c)).id); const s = await resume()
    expect(textsFor(c)).toEqual([INFO]); expect(await run(c)).toMatchObject({ status: 'failed', end_reason: 'subflow_stack_invalid' }); expect(s.skipped).toBe(1)
    expect((await events((await run(c)).id)).find((e) => e.payload?.reason === 'subflow_stack_invalid')?.payload.code).toBe('caller_graph_changed')
    // ... and when A changes in the middle of B's remaining steps, the RETURN is refused and A's new nodes never run
    const w2 = await world(); const c2 = await contact(w2); await send(w2, c2); await makeDue((await run(c2)).id)
    sent.duringCall = async (a) => { if (a.text === FOLLOW) { sent.duringCall = null; await psql(`update public.flow_nodes set config = jsonb_set(config,'{text}','"Cierre NUEVO"') where flow_id='${w2.a}' and node_key='close'`) } }
    await resume(); sent.duringCall = null
    expect(textsFor(c2)).toEqual([INFO, FOLLOW]); expect(await run(c2)).toMatchObject({ status: 'failed', end_reason: 'subflow_return_refused:caller_graph_changed' })
    pass('S07', 'A edited while B waits: resume refused (caller_graph_changed), nothing sent; A edited while B is running its last steps: B\'s own message already left, the RETURN is refused and A\'s changed nodes never execute')
  })

  it('S08: B is modified while it is suspended (or deactivated): nothing continues', async () => {
    const w = await world(); const c = await contact(w); await send(w, c)
    await psql(`update public.flow_nodes set config = jsonb_set(config,'{text}','"Otro seguimiento"') where flow_id='${w.b}' and node_key='follow'`)
    await makeDue((await run(c)).id); await resume(); expect(textsFor(c)).toEqual([INFO])
    expect((await events((await run(c)).id)).find((e) => e.payload?.reason === 'subflow_stack_invalid')?.payload.code).toBe('callee_graph_changed')
    const w2 = await world(); const c2 = await contact(w2); await send(w2, c2); await psql(`update public.flows set status='draft' where id='${w2.b}'`); await makeDue((await run(c2)).id); await resume()
    expect(textsFor(c2)).toEqual([INFO]); expect(await run(c2)).toMatchObject({ status: 'failed', end_reason: 'subflow_stack_invalid' })
    pass('S08', 'B edited (callee_graph_changed) or switched back to draft during the wait: the run ends failed and nothing is sent; no silent continuation with different logic')
  })

  it('S09: a legitimate answer to a button INSIDE B is processed normally and is not mistaken for a spontaneous reply', async () => {
    const w = await world({ kind: 'buttons' }); const c = await contact(w); await send(w, c)
    let r = await run(c); expect(r).toMatchObject({ current_flow_id: w.b, current_node_key: 'ask', wait_until: null }); expect(sent.buttons).toBeGreaterThan(0)
    expect(await tap(w, c, 'yes')).toMatchObject({ consumed: true })
    r = await run(c)
    expect(textsFor(c)).toEqual([INFO, FOLLOW, MSG_C, CLOSE]); expect(r).toMatchObject({ status: 'completed', current_flow_id: null })
    expect((await events(r.id)).some((e) => e.event_type === 'reply_received' && e.payload?.during_wait === true)).toBe(false)
    pass('S09', 'button tap inside B (policy stop): handled by the node, B continues, returns to A, C runs, A closes; no during_wait event, no suppression')
  })

  it('S10: a spontaneous reply while B waits, B has NO condition: policy stop prevents the follow-up and the rest; policy continue does not', async () => {
    const w = await world({ kind: 'plain', policy: 'stop' }); const c = await contact(w); await send(w, c)
    expect(await send(w, c, 'hola, ¿tienen stock?')).toMatchObject({ consumed: false, outcome: 'waiting' })
    await makeDue((await run(c)).id); await resume()
    expect(textsFor(c)).toEqual([INFO]); expect(await run(c)).toMatchObject({ status: 'completed', end_reason: 'customer_replied_in_subflow' }); expect((await reasons((await run(c)).id))).toContain('send_suppressed_spontaneous_reply')
    const w2 = await world({ kind: 'plain', policy: 'continue' }); const c2 = await contact(w2); await send(w2, c2); await send(w2, c2, 'hola'); await makeDue((await run(c2)).id); await resume()
    expect(textsFor(c2)).toEqual([INFO, FOLLOW, MSG_C, CLOSE])
    // a reply BEFORE the call (during A's own steps) does not stop the later subflow: only replies since the call count
    pass('S10', 'spontaneous reply while parked: with stop the follow-up (and everything after) is suppressed right before the send, the run ends cleanly; with continue the flow goes on; the message itself was kept for Inbox either way')
  })

  it('S11: same-second timestamps: a reply inside the reference second COUNTS; a message already stored inside that second does NOT', async () => {
    // (a) the message that started the flow is stored in the same second, BEFORE our send: it must never count as a reply
    const w = await world(); const c = await contact(w)
    sent.duringCall = async (a) => {
      if (a.text !== INFO) return; sent.duringCall = null
      await psql(`select pg_sleep(case when extract(milliseconds from clock_timestamp())::int % 1000 > 700 then 0.35 else 0 end)`)
      await psql(`insert into public.messages (conversation_id, sender_type, content_type, content_text, message_id, status, created_at) values ('${a.conversationId}','customer','text','hola','wamid.in.${randomUUID()}','delivered', date_trunc('second', clock_timestamp()))`)
    }
    await send(w, c); sent.duringCall = null
    const r1 = await run(c); expect(r1.vars['$refs']['$inherited'].pre_ids).toHaveLength(1)                                    // it was in the reference second and is excluded by identity
    await makeDue(r1.id); await resume(); expect(textsFor(c)).toEqual([INFO, FOLLOW, MSG_C, CLOSE])                              // NO reply -> follow-up
    // (b) a REAL reply that Meta stamps with the whole second of our message (earlier than our DB timestamp) is a reply
    const w2 = await world(); const c2 = await contact(w2); await send(w2, c2)
    await psql(`insert into public.messages (conversation_id, sender_type, content_type, content_text, message_id, status, created_at) select '${c2.conversationId}','customer','text','si','wamid.in.${randomUUID()}','delivered', date_trunc('second', created_at) from public.messages where conversation_id='${c2.conversationId}' and sender_type='bot' order by created_at limit 1`)
    const r2 = await run(c2); expect(r2.vars['$refs']['$inherited'].pre_ids).toHaveLength(0)
    await makeDue(r2.id); await resume(); expect(textsFor(c2)).toEqual([INFO])
    pass('S11', 'inside the reference second: an already-stored customer message is excluded by id (no false positive: the follow-up goes out); a reply that arrives after the reference is recorded counts even when Meta\'s whole-second stamp is earlier than our own timestamp (no false negative)')
  })

  it('S12: when "did they reply?" cannot be determined reliably, the follow-up is NOT sent (too many messages in the reference second; corrupt or foreign reference)', async () => {
    const w = await world(); const c = await contact(w)
    sent.duringCall = async (a) => { if (a.text !== INFO) return; sent.duringCall = null
      await psql(`select pg_sleep(case when extract(milliseconds from clock_timestamp())::int % 1000 > 700 then 0.35 else 0 end)`)
      await psql(`insert into public.messages (conversation_id, sender_type, content_type, content_text, message_id, status, created_at) select '${a.conversationId}','customer','text','m','wamid.in.' || gen_random_uuid()::text,'delivered', date_trunc('second', clock_timestamp()) from generate_series(1,25)`) }
    await send(w, c); sent.duringCall = null
    const r = await run(c); expect(r.vars['$refs']?.['$inherited']).toBeUndefined()                                              // could not be recorded: the call itself refuses
    expect(r).toMatchObject({ status: 'failed', end_reason: 'subflow_reference_missing' }); expect(textsFor(c)).toEqual([INFO])
    const w2 = await world(); const c2 = await contact(w2); await send(w2, c2); const r2 = await run(c2)
    await psql(`update public.flow_runs set vars = jsonb_set(vars, '{$refs,$inherited,conversation_id}', to_jsonb('${randomUUID()}'::text)) where id='${r2.id}'`); await makeDue(r2.id); await resume()
    expect(textsFor(c2)).toEqual([INFO]); expect(await run(c2)).toMatchObject({ status: 'failed', end_reason: 'condition_evaluation_failed' })
    pass('S12', '25 customer messages inside the reference second: no reliable reference, the call is refused and nothing else is sent; a tampered inherited reference: the condition fails closed (no follow-up)')
  })

  it('S13: the whole thing survives an application restart during the wait', async () => {
    const w = await world(); const c = await contact(w); await send(w, c)
    vi.resetModules(); const restarted = await import('./engine'); expect(restarted).not.toBe(engine)
    await makeDue((await run(c)).id); expect(await restarted.resumeDueFlowWaits({ accountIds: [acctA] })).toMatchObject({ resumed: 1 })
    expect(textsFor(c)).toEqual([INFO, FOLLOW, MSG_C, CLOSE]); expect(await run(c)).toMatchObject({ status: 'completed' })
    engine = restarted
    pass('S13', 'modules discarded (restart) while B waits: a brand-new engine resumes from flow_runs + frames, B continues, returns to A, C runs, A closes; all state came from the database')
  })

  it('S14: two workers racing for the same due runs resume each exactly once (no duplicated follow-up, no double return)', async () => {
    const w = await world(); const cs: Contact[] = []
    for (let i = 0; i < 8; i++) { const c = await contact(w); await send(w, c); cs.push(c) }
    await psql(`update public.flow_runs set wait_until = clock_timestamp() - interval '1 second' where flow_id='${w.a}' and wait_until is not null`)
    const [x, y] = await Promise.all([engine.resumeDueFlowWaits({ accountIds: [acctA], limit: 50 }), engine.resumeDueFlowWaits({ accountIds: [acctA], limit: 50 })])
    expect(x.resumed + y.resumed).toBe(8); expect(x.failed + y.failed).toBe(0)
    for (const c of cs) { expect(textsFor(c)).toEqual([INFO, FOLLOW, MSG_C, CLOSE]); expect(await frames((await run(c)).id)).toHaveLength(0) }
    pass('S14', `8 nested waits due at once, two concurrent workers (${x.resumed} + ${y.resumed}): every contact got each message exactly once, every frame popped exactly once`)
  })

  it('S15: recovery: a run stranded between "wait consumed" and the first send is resumed; an intent without confirmation is NEVER resent', async () => {
    const admin = (await import('./admin-client')).supabaseAdmin()
    const strand = async () => {   // crash right after CONSUME: the cursor moved to the next node, nothing else happened
      const w = await world(); const c = await contact(w); await send(w, c); const r = await run(c); await makeDue(r.id)
      const cl = await admin.rpc('claim_due_flow_waits', { p_account_ids: [acctA], p_limit: 50, p_lease_seconds: 300 }); const mine = (cl.data as { run_id: string; claim_token: string }[]).find((x) => x.run_id === r.id)!
      expect((await admin.rpc('consume_flow_wait', { p_account_id: acctA, p_run_id: r.id, p_claim_token: mine.claim_token, p_next_node_key: 'check' })).data).toBe(true)
      await psql(`update public.flow_run_events set created_at = created_at - interval '20 minutes' where flow_run_id='${r.id}'; update public.flow_runs set last_advanced_at = clock_timestamp() - interval '10 minutes' where id='${r.id}'`); return { w, c, r }
    }
    // (a) nothing happened after the cursor: safe to resume, the follow-up goes out once
    const a = await strand(); const sa = await engine.recoverStrandedRuns({ accountIds: [acctA], minAgeSeconds: 60 }); expect(sa.resumed).toBeGreaterThanOrEqual(1)
    expect(textsFor(a.c)).toEqual([INFO, FOLLOW, MSG_C, CLOSE]); expect(await run(a.c)).toMatchObject({ status: 'completed' })
    expect((await engine.recoverStrandedRuns({ accountIds: [acctA], minAgeSeconds: 60 })).resumed).toBe(0); expect(textsFor(a.c)).toHaveLength(4)
    // (b) an intent was written, the process died, no confirmation: outcome UNKNOWN -> not resent, incident on record
    const b = await strand(); await psql(`insert into public.flow_run_events (flow_run_id, event_type, node_key, payload) values ('${b.r.id}','node_entered','follow','{"reason":"send_intent","node_type":"send_message"}')`)
    const sb = await engine.recoverStrandedRuns({ accountIds: [acctA], minAgeSeconds: 60 }); expect(sb.ambiguous).toBeGreaterThanOrEqual(1)
    expect(textsFor(b.c)).toEqual([INFO]); expect(await run(b.c)).toMatchObject({ status: 'failed', end_reason: 'send_outcome_unknown' }); expect((await reasons(b.r.id))).toContain('send_outcome_unknown')
    // (c) a message left after the cursor and the process died later: progress in memory is unknown -> not replayed
    const c3 = await strand(); await psql(`insert into public.flow_run_events (flow_run_id, event_type, node_key, payload, created_at) values ('${c3.r.id}','node_entered','follow','{"reason":"send_intent"}', clock_timestamp()), ('${c3.r.id}','message_sent','follow','{"node_type":"send_message"}', clock_timestamp() + interval '1 millisecond')`)
    expect((await engine.recoverStrandedRuns({ accountIds: [acctA], minAgeSeconds: 60 })).unsafe).toBeGreaterThanOrEqual(1); expect(await run(c3.c)).toMatchObject({ status: 'failed', end_reason: 'recovery_not_safe' }); expect(textsFor(c3.c)).toEqual([INFO])
    // (d) runs that legitimately wait for the customer (buttons) are never "recovered"; a recent cursor is left alone
    const wb = await world({ kind: 'buttons' }); const cb = await contact(wb); await send(wb, cb); await psql(`update public.flow_runs set last_advanced_at = clock_timestamp() - interval '3 hours' where id='${(await run(cb)).id}'`)
    await engine.recoverStrandedRuns({ accountIds: [acctA], minAgeSeconds: 60 }); expect(await run(cb)).toMatchObject({ status: 'active', current_node_key: 'ask' })
    pass('S15', 'recovery: consume-then-crash with no evidence of a send is resumed and delivers once (a second pass does nothing); an intent without confirmation ends as send_outcome_unknown and is NOT resent; a confirmed send after the cursor is not replayed; a run waiting for a button tap is left alone')
  })

  it('S16: two recovery workers racing over the same stranded run resume it exactly once', async () => {
    const admin = (await import('./admin-client')).supabaseAdmin(); const w = await world(); const c = await contact(w); await send(w, c); const r = await run(c); await makeDue(r.id)
    const cl = await admin.rpc('claim_due_flow_waits', { p_account_ids: [acctA], p_limit: 50, p_lease_seconds: 300 }); const mine = (cl.data as { run_id: string; claim_token: string }[]).find((x) => x.run_id === r.id)!
    await admin.rpc('consume_flow_wait', { p_account_id: acctA, p_run_id: r.id, p_claim_token: mine.claim_token, p_next_node_key: 'check' }); await psql(`update public.flow_run_events set created_at = created_at - interval '20 minutes' where flow_run_id='${r.id}'; update public.flow_runs set last_advanced_at = clock_timestamp() - interval '10 minutes' where id='${r.id}'`)
    const [p, q] = await Promise.all([engine.recoverStrandedRuns({ accountIds: [acctA], minAgeSeconds: 60 }), engine.recoverStrandedRuns({ accountIds: [acctA], minAgeSeconds: 60 })])
    expect(p.resumed + q.resumed).toBe(1); expect(textsFor(c)).toEqual([INFO, FOLLOW, MSG_C, CLOSE])
    pass('S16', 'two recovery passes at the same instant: one takes the run (compare-and-set on the cursor), the other skips it; each message delivered once')
  })

  it('S17: an agent takes over / the contact is blocked / the flow is switched off while B waits: no follow-up, no return, no C', async () => {
    const w = await world(); const agent = await contact(w); const blocked = await contact(w); const midSend = await contact(w)
    for (const c of [agent, blocked, midSend]) await send(w, c)
    await psql(`update public.flow_runs set status='paused_by_agent', end_reason='agent_reply' where id='${(await run(agent)).id}'`)
    await psql(`update public.flow_runs set status='paused_by_agent', end_reason='contact_blocked' where id='${(await run(blocked)).id}'`)
    await psql(`update public.flow_runs set wait_until = clock_timestamp() - interval '1 second' where flow_id='${w.a}' and status='active'`)
    sent.blockNext = true; await resume()                                                                                       // the only still-active run: the contact gets blocked right at the follow-up
    for (const c of [agent, blocked, midSend]) expect(textsFor(c)).toEqual([INFO])
    expect((await run(agent)).status).toBe('paused_by_agent'); expect((await run(blocked)).end_reason).toBe('contact_blocked'); expect(await run(midSend)).toMatchObject({ status: 'paused_by_agent', end_reason: 'contact_blocked' })
    pass('S17', 'agent takeover and blocked contact while parked: never claimed; the contact blocked at the very send: run paused with contact_blocked; nothing else of B, C or A executes')
  })

  it('S18: tenancy and gates: no cross-company call, an account without BOTH switches never runs a subflow', async () => {
    // (a) a call node forged to point at another company\'s flow (written with triggers off): the database refuses the call
    const w = await world(); const foreign = await newFlow(UB, acctB, 'foreign', 'manual'); await node(foreign, 'start', 'start', { next_node_key: 'e' }); await node(foreign, 'e', 'end', {}); await activate(foreign)
    await psql(`set session_replication_role = replica; update public.flow_nodes set config = jsonb_set(config,'{target_flow_id}','"${foreign}"') where flow_id='${w.a}' and node_key='call1'`)
    const c = await contact(w); await send(w, c); expect(await run(c)).toMatchObject({ status: 'failed', end_reason: 'subflow_call_refused:callee_unavailable' }); expect(textsFor(c)).toEqual([INFO])
    // (b) environment flag present, no row in the backend table: refused by the database
    const w2 = await world(); const c2 = await contact(w2); await psql(`delete from public.flow_execution_enablement where account_id='${acctA}'`)
    try { await send(w2, c2) } finally { await enable(acctA) }
    expect(await run(c2)).toMatchObject({ status: 'failed', end_reason: 'subflow_call_refused:subflow_execution_not_enabled' })
    // (c) row present, environment flag absent: refused by the engine before any RPC
    const w3 = await world(); const c3 = await contact(w3); const saved = process.env.FLOW_SUBFLOW_EXECUTION_ACCOUNT_IDS; delete process.env.FLOW_SUBFLOW_EXECUTION_ACCOUNT_IDS
    try { await send(w3, c3) } finally { process.env.FLOW_SUBFLOW_EXECUTION_ACCOUNT_IDS = saved }
    expect(await run(c3)).toMatchObject({ status: 'failed', end_reason: 'subflow_execution_not_enabled' }); expect(textsFor(c3)).toEqual([INFO])
    // (d) another company never gets into this machinery at all (its activation is blocked by the database)
    await expect(enable(acctB, false, false).then(() => world({ owner: 'B' }))).rejects.toThrow(/execute_flow|durable|cannot be activated/i)
    pass('S18', 'forged cross-company target refused by the database; table row without the env flag refused by the engine; env flag without the table row refused by the database; an account with both switches off cannot even activate such a flow')
  })

  it('S19: depth 4 and cycles are refused at run time; a looping caller is bounded by the call budget', async () => {
    const mk = async (name: string, target?: string) => { const f = await newFlow(UA, acctA, name, 'manual'); await node(f, 'start', 'start', { next_node_key: target ? 'call' : 'e' }); if (target) { await node(f, 'call', 'execute_flow', { target_flow_id: target, next_node_key: 'e' }); } await node(f, 'e', 'end', { scope: 'subflow' }); return f }
    const d4 = await mk('d4'); const d3 = await mk('d3', d4); const d2 = await mk('d2', d3); const d1 = await mk('d1', d2)
    await activate(d4, d3, d2, d1)
    const root = await newFlow(UA, acctA, 'root', 'keyword', `deep${++seq}`); await node(root, 'start', 'start', { next_node_key: 'call' }); await node(root, 'call', 'execute_flow', { target_flow_id: d1, next_node_key: 'e' }); await node(root, 'e', 'end', {}); await activate(root)
    const kw = (await rows(`select trigger_config->'keywords'->>0 as k from public.flows where id='${root}'`))[0].k as string
    const c = await contact({ user: UA, acct: acctA }); await engine.dispatchInboundToFlows({ accountId: acctA, userId: UA, contactId: c.contactId, conversationId: c.conversationId, message: { kind: 'text', text: kw, meta_message_id: `wamid.in.${randomUUID()}` }, isFirstInboundMessage: false })
    const r = await run(c); expect(r).toMatchObject({ status: 'failed' }); expect(r.end_reason).toBe('subflow_call_refused:max_depth')
    // cycle: X -> Y -> X
    const y = await newFlow(UA, acctA, 'y', 'manual'); await node(y, 'start', 'start', { next_node_key: 'e' }); await node(y, 'e', 'end', { scope: 'subflow' })
    const x = await newFlow(UA, acctA, 'x', 'keyword', `cyc${++seq}`); await node(x, 'start', 'start', { next_node_key: 'call' }); await node(x, 'call', 'execute_flow', { target_flow_id: y, next_node_key: 'e' }); await node(x, 'e', 'end', {})
    await activate(y, x); await psql(`update public.flows set status='draft' where id='${y}'`); await node(y, 'call', 'execute_flow', { target_flow_id: x, next_node_key: 'e' }); await psql(`update public.flow_nodes set config='{"next_node_key":"call"}' where flow_id='${y}' and node_key='start'`); await activate(y)
    const kx = (await rows(`select trigger_config->'keywords'->>0 as k from public.flows where id='${x}'`))[0].k as string; const c2 = await contact({ user: UA, acct: acctA })
    await engine.dispatchInboundToFlows({ accountId: acctA, userId: UA, contactId: c2.contactId, conversationId: c2.conversationId, message: { kind: 'text', text: kx, meta_message_id: `wamid.in.${randomUUID()}` }, isFirstInboundMessage: false })
    expect(await run(c2)).toMatchObject({ status: 'failed', end_reason: 'subflow_call_refused:cycle' })
    pass('S19', 'a 4th nesting level and a cycle X -> Y -> X are refused by the database at run time and end the run failed without sending anything')
  })

  it('S20: no impact on existing flows: a plain flow, a P6 wait flow and a button flow behave exactly as before and leave no frames', async () => {
    const plain = await newFlow(UA, acctA, 'plain', 'keyword', `plain${++seq}`); await node(plain, 'start', 'start', { next_node_key: 'm' }); await node(plain, 'm', 'send_message', { text: 'Hola plano', next_node_key: 'e' }); await node(plain, 'e', 'end', {})
    const waitf = await newFlow(UA, acctA, 'waiter', 'keyword', `wait${++seq}`); await node(waitf, 'start', 'start', { next_node_key: 'm' }); await node(waitf, 'm', 'send_message', { text: 'Antes', next_node_key: 'p' }); await node(waitf, 'p', 'delay', { amount: 13, unit: 'minutes', next_node_key: 'f' }); await node(waitf, 'f', 'send_message', { text: 'Después', next_node_key: 'e' }); await node(waitf, 'e', 'end', {})
    await activate(plain, waitf)
    const kp = (await rows(`select trigger_config->'keywords'->>0 as k from public.flows where id='${plain}'`))[0].k as string; const kw = (await rows(`select trigger_config->'keywords'->>0 as k from public.flows where id='${waitf}'`))[0].k as string
    const dispatch = (c: Contact, text: string) => engine.dispatchInboundToFlows({ accountId: acctA, userId: UA, contactId: c.contactId, conversationId: c.conversationId, message: { kind: 'text', text, meta_message_id: `wamid.in.${randomUUID()}` }, isFirstInboundMessage: false })
    const cp = await contact({ user: UA, acct: acctA }); await dispatch(cp, kp); expect(textsFor(cp)).toEqual(['Hola plano']); const rp = await run(cp); expect(rp).toMatchObject({ status: 'completed', current_flow_id: null }); expect(Object.keys(rp.vars).filter((k) => k !== 'contact_name')).toEqual([])
    const cw = await contact({ user: UA, acct: acctA }); await dispatch(cw, kw); await makeDue((await run(cw)).id); await resume(); expect(textsFor(cw)).toEqual(['Antes', 'Después']); expect(await run(cw)).toMatchObject({ status: 'completed', current_flow_id: null })
    expect(Number(await psql(`select count(*) from public.flow_run_subflow_frames where flow_run_id in ('${rp.id}','${(await run(cw)).id}')`))).toBe(0)
    // an account WITHOUT the execution switches keeps the exact historic send path: no intent record, no extra event, same result
    const other = await newFlow(UB, acctB, 'plain-b', 'keyword', `plainb${++seq}`); await node(other, 'start', 'start', { next_node_key: 'm' }); await node(other, 'm', 'send_message', { text: 'Hola B', next_node_key: 'e' }); await node(other, 'e', 'end', {}); await activate(other)
    const kb = (await rows(`select trigger_config->'keywords'->>0 as k from public.flows where id='${other}'`))[0].k as string; const cb2 = await contact({ user: UB, acct: acctB })
    await engine.dispatchInboundToFlows({ accountId: acctB, userId: UB, contactId: cb2.contactId, conversationId: cb2.conversationId, message: { kind: 'text', text: kb, meta_message_id: `wamid.in.${randomUUID()}` }, isFirstInboundMessage: false })
    expect(textsFor(cb2)).toEqual(['Hola B']); const rb2 = await run(cb2); expect(rb2).toMatchObject({ status: 'completed', end_reason: 'end_node', current_flow_id: null })
    expect((await events(rb2.id)).filter((e) => e.payload?.reason === 'send_intent')).toHaveLength(0)
    pass('S20', 'flows without execute_flow: same messages, same end reasons, run vars untouched (only the usual contact_name seed), current_flow_id NULL, zero frames; the P6 durable wait is unchanged; an account without the switches gets the historic path (no send_intent event)')
  })

  it('S21: the intent to send is written BEFORE every send, and when it cannot be written nothing is sent', async () => {
    const w = await world(); const c = await contact(w); await send(w, c)
    const ev = await events((await run(c)).id); const i = ev.findIndex((e) => e.payload?.reason === 'send_intent'); const m = ev.findIndex((e) => e.event_type === 'message_sent')
    expect(i).toBeGreaterThanOrEqual(0); expect(i).toBeLessThan(m)
    await makeDue((await run(c)).id); await resume(); const all = await events((await run(c)).id)
    expect(all.filter((e) => e.payload?.reason === 'send_intent')).toHaveLength(all.filter((e) => e.event_type === 'message_sent').length)   // every send had its intent
    const w2 = await world(); const c2 = await contact(w2); await psql(`revoke insert on public.flow_run_events from service_role`)
    try { await send(w2, c2) } finally { await psql(`grant insert on public.flow_run_events to service_role`) }
    expect(textsFor(c2)).toEqual([]); expect(await run(c2)).toMatchObject({ status: 'failed', end_reason: 'send_intent_not_recorded' })
    pass('S21', 'every message_sent was preceded by its send_intent event; with the event log unwritable the very first send is not attempted (fail closed)')
  })

  it('S22: a spontaneous reply that cannot be recorded fails closed (no follow-up later) while the message stays available', async () => {
    const w = await world(); const c = await contact(w); await send(w, c)
    await psql(`revoke insert on public.flow_run_events from service_role`)
    let res; try { res = await send(w, c, 'oye') } finally { await psql(`grant insert on public.flow_run_events to service_role`) }
    expect(res).toMatchObject({ consumed: false }); expect(await run(c)).toMatchObject({ status: 'failed', end_reason: 'reply_not_recorded' }); await makeDue((await run(c)).id); await resume(); expect(textsFor(c)).toEqual([INFO])
    pass('S22', 'reply received while parked but not recordable: the run is ended failed (no later follow-up), the dispatcher reports consumed:false so Inbox / automations still get the message')
  })

  it('S23: the shared 5-minute stale-run sweep still works with migration 070 applied (flow_runs has two foreign keys to flows now)', async () => {
    const admin = (await import('./admin-client')).supabaseAdmin()
    const ambiguous = await admin.from('flow_runs').select('id, flows ( fallback_policy )').limit(1)
    expect(ambiguous.error?.code).toBe('PGRST201')                                                                          // the plain embed is ambiguous: this is why the sweep names its key
    const w = await world(); const c = await contact(w); await send(w, c)                                                 // an ACTIVE run exists, so the sweep must read it
    process.env.AUTOMATION_CRON_SECRET = 'sweep-secret-for-tests'
    const { GET } = await import('@/app/api/flows/cron/route')
    const response = await GET(new Request('http://localhost/api/flows/cron', { headers: { 'x-cron-secret': 'sweep-secret-for-tests' } }))
    delete process.env.AUTOMATION_CRON_SECRET
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ swept: 0 })                           // nothing is stale, but the scan itself ran (a 500 here was the incident)
    expect(await run(c)).toMatchObject({ status: 'active' })
    pass('S23', 'the shared stale-run sweep (/api/flows/cron) reads active runs with their flow policy and answers 200 on a database with 070; the unqualified embed is PGRST201, so it names flows!flow_id')
  })

  // ---------------- global enablement (migration 071 + FLOW_AUTHORING_SCOPE / FLOW_EXECUTION_SCOPE) ----------------
  const setDefaults = (sub: boolean, wait: boolean) => psql(`update public.flow_execution_defaults set subflow_execution=${sub}, durable_wait_execution=${wait}`)
  const newCompany = async (n: string) => {                                    // a company that registers LATER: the signup trigger provisions its account
    const user = randomUUID(); await psql(`insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values ('${user}','00000000-0000-0000-0000-000000000000','authenticated','authenticated','new-${n}-${seq}@example.test','{"full_name":"New ${n}"}'::jsonb, now(), now())`)
    return { user, acct: await psql(`select account_id from public.profiles where user_id='${user}'`) }
  }
  const globalOn = async () => { process.env.FLOW_AUTHORING_SCOPE = 'all'; process.env.FLOW_EXECUTION_SCOPE = 'all'; delete process.env.FLOW_SUBFLOW_EXECUTION_ACCOUNT_IDS; delete process.env.FLOW_DURABLE_WAIT_EXECUTION_ACCOUNT_IDS; delete process.env.FLOW_CUSTOMER_REPLY_CONDITION_ACCOUNT_IDS; await psql(`delete from public.flow_execution_enablement`); await setDefaults(true, true) }
  const globalOff = async () => { delete process.env.FLOW_AUTHORING_SCOPE; delete process.env.FLOW_EXECUTION_SCOPE; process.env.FLOW_SUBFLOW_EXECUTION_ACCOUNT_IDS = acctA; process.env.FLOW_DURABLE_WAIT_EXECUTION_ACCOUNT_IDS = acctA; process.env.FLOW_CUSTOMER_REPLY_CONDITION_ACCOUNT_IDS = acctA; await setDefaults(false, false); await enable(acctA) }
  const resumeEnabled = async () => { const admin = (await import('./admin-client')).supabaseAdmin(); const { schedulerAccountIds } = await import('./execution-gates'); return engine.resumeDueFlowWaits({ accountIds: await schedulerAccountIds(() => admin, ['durable_wait']) }) }

  it('S24: with the global switches ON, a third company and a company that registers LATER run A -> B -> A -> C -> A with no per-account row and no UUID list', async () => {
    const third = await newCompany('third'); const later = await newCompany('later'); await globalOn()
    try {
      const worlds = [await world({ tenant: { user: UA, acct: acctA } }), await world({ tenant: { user: UB, acct: acctB } }), await world({ tenant: third }), await world({ tenant: later })]
      const cs: Contact[] = []
      for (const w of worlds) { const c = await contact(w); await send(w, c); cs.push(c) }
      await psql(`update public.flow_runs set wait_until = clock_timestamp() - interval '1 second' where wait_until is not null`)
      const s = await resumeEnabled(); expect(s.resumed).toBeGreaterThanOrEqual(4)             // (other runs left parked by earlier tests may be served too)
      for (const c of cs) { expect(textsFor(c)).toEqual([INFO, FOLLOW, MSG_C, CLOSE]); expect(await run(c)).toMatchObject({ status: 'completed', current_flow_id: null }) }
      expect(Number(await psql(`select count(*) from public.flow_execution_enablement`))).toBe(0)                        // nothing was written per account
      pass('S24', 'FLOW_AUTHORING_SCOPE=all + FLOW_EXECUTION_SCOPE=all + the database default ON: accounts A, B, a third one and one created afterwards each completed A -> B -> A -> C -> A (4 messages, ONE run each); flow_execution_enablement stayed empty, no UUID list was set')
    } finally { await globalOff() }
  })

  it('S25: the two keys still both count under the global mode, and an account can be switched off individually', async () => {
    const co = await newCompany('keys')
    try {
      await globalOn(); await psql(`insert into public.flow_execution_enablement (account_id, subflow_execution, durable_wait_execution) values ('${co.acct}', false, false)`)   // this company opts OUT
      await expect(world({ tenant: co })).rejects.toThrow(/cannot be activated/i)                                         // the database refuses to activate for it
      const w = await world({ tenant: { user: UA, acct: acctA } }); const c = await contact(w)                           // everybody else is on
      process.env.FLOW_EXECUTION_SCOPE = 'off'; await send(w, c); expect(await run(c)).toMatchObject({ status: 'failed', end_reason: 'subflow_execution_not_enabled' }); expect(textsFor(c)).toEqual([INFO])   // environment says no: the call is refused although the database says yes
      process.env.FLOW_EXECUTION_SCOPE = 'all'; await setDefaults(false, false)
      const w2 = await world({ tenant: { user: UA, acct: acctA } }).catch((e: Error) => e)
      expect(w2 instanceof Error && /cannot be activated/i.test(w2.message)).toBe(true)                                  // the database says no: not even activation
      for (const bad of ['true', '*', 'ALL!', 'yes']) { process.env.FLOW_EXECUTION_SCOPE = bad; expect((await import('./flow-scope')).readScope('FLOW_EXECUTION_SCOPE')).toBe('off') }
      pass('S25', 'environment off + database on: the call fails closed; environment on + database off: activation refused; a company row set to false overrides the global default; junk values of the scope switch mean OFF')
    } finally { await globalOff() }
  })

  it('S26: the scheduler resolves its accounts from the database under "all", and from nothing under the default (no database call)', async () => {
    const admin = (await import('./admin-client')).supabaseAdmin(); const { schedulerAccountIds } = await import('./execution-gates'); const co = await newCompany('sched')
    const calls: string[] = []; const spy = { from: admin.from.bind(admin), rpc: (fn: string, args: Record<string, unknown>) => { calls.push(fn); return admin.rpc(fn, args) } }
    delete process.env.FLOW_EXECUTION_SCOPE; delete process.env.FLOW_DURABLE_WAIT_EXECUTION_ACCOUNT_IDS; delete process.env.FLOW_SUBFLOW_EXECUTION_ACCOUNT_IDS
    try {
      expect(await schedulerAccountIds(() => spy as never, ['durable_wait', 'subflow'])).toEqual([]); expect(calls).toEqual([])            // production today: nothing, and no database call
      process.env.FLOW_DURABLE_WAIT_EXECUTION_ACCOUNT_IDS = acctB; expect(await schedulerAccountIds(() => spy as never, ['durable_wait'])).toEqual([acctB]); expect(calls).toEqual([]); delete process.env.FLOW_DURABLE_WAIT_EXECUTION_ACCOUNT_IDS
      process.env.FLOW_EXECUTION_SCOPE = 'all'; await psql(`delete from public.flow_execution_enablement`)
      expect(await schedulerAccountIds(() => spy as never, ['durable_wait'])).toEqual([]); expect(calls).toEqual(['enabled_execution_account_ids'])   // database default OFF: nobody
      await setDefaults(true, true); await psql(`insert into public.flow_execution_enablement (account_id, subflow_execution, durable_wait_execution) values ('${co.acct}', false, false)`)
      const ids = await schedulerAccountIds(() => spy as never, ['durable_wait']); expect(ids).toContain(acctA); expect(ids).toContain(acctB); expect(ids).not.toContain(co.acct)
      process.env.FLOW_EXECUTION_SCOPE = 'off'; expect(await schedulerAccountIds(() => spy as never, ['durable_wait', 'subflow'])).toEqual([])
      pass('S26', 'scheduler account list: default / off = [] with ZERO database calls; allowlist = the listed ids; all = what the database has enabled (default ON minus accounts switched off)')
    } finally { await globalOff() }
  })

  it('S27: under the global switches the legacy flows of every company behave exactly as before (no intent record, no frames, same messages)', async () => {
    await globalOn()
    try {
      for (const tenant of [{ user: UA, acct: acctA }, { user: UB, acct: acctB }]) {
        const plain = await newFlow(tenant.user, tenant.acct, 'legacy', 'keyword', `legacy${++seq}`); await node(plain, 'start', 'start', { next_node_key: 'm' }); await node(plain, 'm', 'send_message', { text: 'Hola legacy', next_node_key: 'b' })
        await node(plain, 'b', 'send_buttons', { text: '¿Seguimos?', buttons: [{ reply_id: 'si', title: 'Sí', next_node_key: 'e' }] }); await node(plain, 'e', 'end', {}); await activate(plain)
        const kw = (await rows(`select trigger_config->'keywords'->>0 as k from public.flows where id='${plain}'`))[0].k as string; const c = await contact(tenant)
        const d = (text: string) => engine.dispatchInboundToFlows({ accountId: tenant.acct, userId: tenant.user, contactId: c.contactId, conversationId: c.conversationId, message: { kind: 'text', text, meta_message_id: `wamid.in.${randomUUID()}` }, isFirstInboundMessage: false })
        await d(kw); expect(textsFor(c)).toEqual(['Hola legacy']); const r = await run(c); expect(r).toMatchObject({ status: 'active', current_node_key: 'b', current_flow_id: null })
        expect((await events(r.id)).filter((e) => e.payload?.reason === 'send_intent')).toHaveLength(0)
        await engine.dispatchInboundToFlows({ accountId: tenant.acct, userId: tenant.user, contactId: c.contactId, conversationId: c.conversationId, message: { kind: 'interactive_reply', reply_id: 'si', reply_title: 'Sí', meta_message_id: `wamid.in.${randomUUID()}` } as never, isFirstInboundMessage: false })
        expect(await run(c)).toMatchObject({ status: 'completed', end_reason: 'end_node' }); expect(Number(await psql(`select count(*) from public.flow_run_subflow_frames where flow_run_id='${r.id}'`))).toBe(0)
      }
      pass('S27', 'with everything global ON, a plain message + buttons flow of two different companies runs exactly as before: same messages, same end reason, zero send_intent events, zero frames')
    } finally { await globalOff() }
  })

  it('S28: the pilot-only procedure (authoring global as in production; execution = ONE company by the two keys; the global default stays OFF)', async () => {
    const admin = (await import('./admin-client')).supabaseAdmin(); const { schedulerAccountIds } = await import('./execution-gates'); const later = await newCompany('pilot-only')
    const callerDraft = async (tenant: { user: string; acct: string }) => {                                              // a draft that runs another flow (authoring is global, so this must be possible for everybody)
      const target = await newFlow(tenant.user, tenant.acct, 'target', 'manual'); await node(target, 'start', 'start', { next_node_key: 'e' }); await node(target, 'e', 'end', { scope: 'subflow' }); await activate(target)
      const caller = await newFlow(tenant.user, tenant.acct, 'caller', 'manual'); await node(caller, 'start', 'start', { next_node_key: 'c' }); await node(caller, 'c', 'execute_flow', { target_flow_id: target, next_node_key: 'e' }); await node(caller, 'e', 'end', {}); return caller
    }
    const waitDraft = async (tenant: { user: string; acct: string }) => { const f = await newFlow(tenant.user, tenant.acct, 'waiter', 'manual'); await node(f, 'start', 'start', { next_node_key: 'w' }); await node(f, 'w', 'delay', { amount: 13, unit: 'minutes', next_node_key: 'e' }); await node(f, 'e', 'end', {}); return f }
    // activation exactly as the API does it: no operator switch (the harness `activate` sets app.allow_durable_wait_activation, which is NOT available to the API)
    const strict = (flow: string) => psql(`select set_config('app.flow_publication','on',true); update public.flows set status='active' where id='${flow}'`)
    const refused = (flow: string) => expect(strict(flow)).rejects.toThrow(/cannot be activated/i)
    try {
      process.env.FLOW_AUTHORING_SCOPE = 'all'; delete process.env.FLOW_EXECUTION_SCOPE                                  // production as of P9
      process.env.FLOW_SUBFLOW_EXECUTION_ACCOUNT_IDS = acctA; process.env.FLOW_DURABLE_WAIT_EXECUTION_ACCOUNT_IDS = acctA; process.env.FLOW_CUSTOMER_REPLY_CONDITION_ACCOUNT_IDS = acctA
      await setDefaults(false, false); await psql(`delete from public.flow_execution_enablement`)
      // 1. nobody is enabled yet: even the pilot cannot activate (the database says no), everybody can still author drafts
      const pilotCaller = await callerDraft({ user: UA, acct: acctA }); await refused(pilotCaller); await refused(await waitDraft({ user: UA, acct: acctA }))
      // 2. enable ONE company with the existing controls: its row in flow_execution_enablement (+ the environment lists above)
      await enable(acctA); await strict(pilotCaller); const pilotWait = await waitDraft({ user: UA, acct: acctA }); await strict(pilotWait)
      const w = await world({ tenant: { user: UA, acct: acctA } }); const c = await contact(w); await send(w, c); await makeDue((await run(c)).id); await resume()
      expect(textsFor(c)).toEqual([INFO, FOLLOW, MSG_C, CLOSE]); expect(await run(c)).toMatchObject({ status: 'completed' })           // A -> B -> A -> C -> A for the pilot
      // 3. nobody else can activate subflows or durable waits: company B, a company that registers later, a company listed in the environment but without its row
      for (const t of [{ user: UB, acct: acctB }, later]) { await refused(await callerDraft(t)); await refused(await waitDraft(t)) }
      process.env.FLOW_SUBFLOW_EXECUTION_ACCOUNT_IDS = `${acctA},${acctB}`; process.env.FLOW_DURABLE_WAIT_EXECUTION_ACCOUNT_IDS = `${acctA},${acctB}`
      await refused(await callerDraft({ user: UB, acct: acctB })); await refused(await waitDraft({ user: UB, acct: acctB }))              // environment alone is not enough: the database has the last word
      process.env.FLOW_SUBFLOW_EXECUTION_ACCOUNT_IDS = acctA; process.env.FLOW_DURABLE_WAIT_EXECUTION_ACCOUNT_IDS = acctA
      // 4. the schedulers serve only the pilot
      expect(await schedulerAccountIds(() => admin as never, ['durable_wait', 'subflow'])).toEqual([acctA])
      // 5. rollback of the pilot: remove its row and calls stop at once (the database refuses a new call)
      const w2 = await world({ tenant: { user: UA, acct: acctA } }); const c2 = await contact(w2); await psql(`delete from public.flow_execution_enablement where account_id='${acctA}'`); await send(w2, c2)
      expect(await run(c2)).toMatchObject({ status: 'failed', end_reason: 'subflow_call_refused:subflow_execution_not_enabled' }); expect(textsFor(c2)).toEqual([INFO])
      pass('S28', 'with the global default OFF and ONE company enabled (row + environment list): the pilot runs A -> B -> A -> C -> A and can activate; company B, a later company, and a company listed only in the environment cannot activate subflows or durable waits (the database refuses); the schedulers serve only the pilot; deleting its row stops new calls at once')
    } finally { await globalOff() }
  })

  it('S29: (migration 072) a run that ends inside a called flow, by the engine, an agent or a blocked contact, leaves no frame and keeps the evidence', async () => {
    const framesLeft = async (runId: string) => Number(await psql(`select count(*) from public.flow_run_subflow_frames where flow_run_id='${runId}'`))
    const archived = async (runId: string) => (await rows(`select payload from public.flow_run_events where flow_run_id='${runId}' and payload->>'reason'='stack_closed_on_end'`))
    // (a) the pilot's second scenario: the customer answers during B's wait, B ends the WHOLE execution
    const w = await world(); const c = await contact(w); await send(w, c); await msg({ conv: c.conversationId, offsetSeconds: 120 }); await send(w, c, 'respuesta-p8-control')
    const r = await run(c); expect(await framesLeft(r.id)).toBe(1); await makeDue(r.id); await resume()
    expect(await run(c)).toMatchObject({ status: 'completed', end_reason: 'end_node' }); expect(await framesLeft(r.id)).toBe(0); const a = await archived(r.id)
    expect(a).toHaveLength(1); expect(a[0].payload.frames[0]).toMatchObject({ depth: 1, return_node_key: 'call2', on_customer_reply: 'stop' }); expect(a[0].payload.end_reason).toBe('end_node')
    // (b) an agent takes over while the run waits inside B (the real path updates the row directly)
    const w2 = await world(); const c2 = await contact(w2); await send(w2, c2); const r2 = await run(c2)
    await psql(`update public.flow_runs set status='paused_by_agent', ended_at=now(), end_reason='agent_replied' where id='${r2.id}'`); expect(await framesLeft(r2.id)).toBe(0); expect(await archived(r2.id)).toHaveLength(1)
    // (c) the contact is blocked right at the follow-up send (B sends inside the called flow)
    const w3 = await world(); const c3 = await contact(w3); await send(w3, c3); const r3 = await run(c3); await makeDue(r3.id); sent.blockNext = true; await resume()
    expect(await run(c3)).toMatchObject({ status: 'paused_by_agent', end_reason: 'contact_blocked' }); expect(await framesLeft(r3.id)).toBe(0); expect(await archived(r3.id)).toHaveLength(1)
    // (d) a normal A -> B -> A -> C -> A needs no archive at all, and nothing else changed
    const w4 = await world(); const c4 = await contact(w4); await send(w4, c4); const r4 = await run(c4); await makeDue(r4.id); await resume()
    expect(textsFor(c4)).toEqual([INFO, FOLLOW, MSG_C, CLOSE]); expect(await framesLeft(r4.id)).toBe(0); expect(await archived(r4.id)).toHaveLength(0)
    // (e) an engine failure inside the called flow (the send is refused) also closes the stack
    const w5 = await world(); const c5 = await contact(w5); await send(w5, c5); const r5 = await run(c5); await makeDue(r5.id)
    sent.duringCall = async (x) => { if (x.text === FOLLOW) { sent.duringCall = null; throw new Error('simulated Meta outage') } }; await resume(); sent.duringCall = null
    expect(await run(c5)).toMatchObject({ status: 'failed', end_reason: 'send_text_failed' }); expect(await framesLeft(r5.id)).toBe(0); expect(await archived(r5.id)).toHaveLength(1)
    pass('S29', 'engine end inside B (the real pilot case), agent takeover, blocked contact and an engine failure each leave 0 frames and one archive event with depth / return node / policy / end reason; a normal return writes no archive')
  })
})
