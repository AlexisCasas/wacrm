import { createHmac, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createClient } from '@supabase/supabase-js'

/**
 * P7 «Cliente respondió después del mensaje de referencia», engine integration: the REAL engine against a disposable PostgreSQL 17
 * (every migration in supabase/migrations) behind a real PostgREST on an isolated Docker network. Sends are SIMULATED: the fake sender
 * writes the same outbound `messages` row the real one writes (sender_type 'bot', DB clock) and nothing else; nothing reaches Meta or a
 * real customer. Skipped unless QA_REST_URL is set (qa/customer-reply/run-engine-qa.sh). Ids R01...
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
}))
vi.mock('./meta-send', () => ({
  engineSendText: async (a: { conversationId: string; text: string }) => {
    await sent.duringCall?.(a)
    sent.texts.push({ conversationId: a.conversationId, text: a.text }); const wamid = `wamid.sim.${randomUUID()}`
    await sent.psql!(`insert into public.messages (conversation_id, sender_type, content_type, content_text, message_id, status) values ('${a.conversationId}','bot','text','${a.text.replace(/'/g, "''")}','${wamid}','sent')`)
    await sent.afterStore?.(a)
    return { whatsapp_message_id: wamid }
  },
  engineSendMedia: async () => { throw new Error('media is not simulated in this suite') },
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
    global: { fetch: (input, init) => { const u = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url; if (!u.startsWith(url)) { sent.blockedFetches += 1; throw new Error(`blocked: ${u}`) } return fetch(u.replace('/rest/v1', ''), init) } },
  })
  return { supabaseAdmin: () => client }
})

const psql = (sql: string) => new Promise<string>((resolve, reject) => execFile('docker', ['exec', '-i', CONTAINER, 'psql', '-U', 'supabase_admin', '-h', '/var/run/postgresql', '-d', 'postgres', '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', '-c', sql], { maxBuffer: 8 << 20 }, (e, out, err) => (e ? reject(new Error(err || String(e))) : resolve(out.trim()))))
sent.psql = psql
const rows = async <T = Record<string, any>>(q: string) => JSON.parse(await psql(`select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (${q}) t`)) as T[] // eslint-disable-line @typescript-eslint/no-explicit-any

const UA = 'a1000000-0000-4000-8000-000000000001'; const UB = 'b2000000-0000-4000-8000-000000000002'
let acctA = ''; let acctB = ''
let seq = 300
type World = { flow: string; keyword: string; user: string; acct: string }
type Contact = { contactId: string; conversationId: string }
/**
 * start -> info (send, the REFERENCE) [-> info2] -> pause (13 min durable wait) [-> gap (1 s in-process delay)] -> check (customer activity)
 *   YES -> replied_end        NO -> follow (send) -> done
 */
async function world(opts: { owner?: 'A' | 'B'; two?: boolean; refKey?: string; gap?: boolean; condition?: Record<string, unknown> } = {}): Promise<World> {
  const owner = opts.owner ?? 'A'; const user = owner === 'A' ? UA : UB; const acct = owner === 'A' ? acctA : acctB; const keyword = `reply${++seq}${Math.floor(Math.random() * 1e6)}`
  const flow = (await psql(`insert into public.flows (user_id, account_id, name, trigger_type, trigger_config, entry_node_id) values ('${user}','${acct}','reply ${keyword}','keyword','{"keywords":["${keyword}"]}','start') returning id`)).split('\n')[0]
  const afterInfo = opts.two ? 'info2' : 'pause'; const afterPause = opts.gap ? 'gap' : 'check'
  const condition = { subject: 'customer_activity', subject_key: opts.refKey ?? 'info', operator: 'replied_after_reference', true_next: 'replied_end', false_next: 'follow', ...(opts.condition ?? {}) }
  const nodes: Array<{ k: string; t: string; c: Record<string, unknown> }> = [
    { k: 'start', t: 'start', c: { next_node_key: 'info' } }, { k: 'info', t: 'send_message', c: { text: 'Hidrolavadora: ficha y precio', next_node_key: afterInfo } },
    ...(opts.two ? [{ k: 'info2', t: 'send_message', c: { text: 'Hidrolavadora: garantía', next_node_key: 'pause' } }] : []),
    { k: 'pause', t: 'delay', c: { amount: 13, unit: 'minutes', next_node_key: afterPause } },
    ...(opts.gap ? [{ k: 'gap', t: 'delay', c: { seconds: 1, next_node_key: 'check' } }] : []),
    { k: 'check', t: 'condition', c: condition }, { k: 'follow', t: 'send_message', c: { text: 'Seguimos con tu consulta', next_node_key: 'done' } },
    { k: 'done', t: 'end', c: {} }, { k: 'replied_end', t: 'end', c: {} },
  ]
  for (const n of nodes) await psql(`insert into public.flow_nodes (flow_id, node_key, node_type, config) values ('${flow}','${n.k}','${n.t}','${JSON.stringify(n.c)}')`)
  await psql(`select set_config('app.allow_durable_wait_activation','on',true), set_config('app.flow_publication','on',true); update public.flows set status='active' where id='${flow}'`)
  return { flow, keyword, user, acct }
}
async function contact(w: { user: string; acct: string }): Promise<Contact> {
  const id = randomUUID(); const conv = randomUUID(); seq += 1
  await psql(`insert into public.contacts (id,user_id,account_id,phone,name) values ('${id}','${w.user}','${w.acct}','+1561${String(seq).padStart(7, '0')}','sim ${seq}'); insert into public.conversations (id,user_id,account_id,contact_id) values ('${conv}','${w.user}','${w.acct}','${id}')`)
  return { contactId: id, conversationId: conv }
}
let engine: typeof import('./engine')
const send = (w: World, c: Contact, text?: string) =>
  engine.dispatchInboundToFlows({ accountId: w.acct, userId: w.user, contactId: c.contactId, conversationId: c.conversationId, message: { kind: 'text', text: text ?? w.keyword, meta_message_id: `wamid.in.${randomUUID()}` }, isFirstInboundMessage: false })
const run = async (c: { contactId: string }) => (await rows(`select * from public.flow_runs where contact_id='${c.contactId}' order by started_at desc limit 1`))[0]
const events = (runId: string) => rows(`select event_type, node_key, payload from public.flow_run_events where flow_run_id='${runId}' order by created_at, id`)
const makeDue = (runId: string) => psql(`update public.flow_runs set wait_until = clock_timestamp() - interval '1 second' where id='${runId}'`)
const textsFor = (c: { conversationId: string }) => sent.texts.filter((t) => t.conversationId === c.conversationId).map((t) => t.text)
const resume = () => engine.resumeDueFlowWaits({ accountIds: [acctA] })
/** A message stored the way the webhook stores it, `offsetSeconds` after the FIRST outbound message of `ref`'s conversation (negative = before it). */
async function msg(opts: { target: string; ref: string; offsetSeconds: number; sender?: 'customer' | 'agent' | 'bot'; contentType?: string; interactiveReplyId?: string }) {
  const sender = opts.sender ?? 'customer'; const ct = opts.contentType ?? 'text'
  await psql(`insert into public.messages (conversation_id, sender_type, content_type, content_text, message_id, status, created_at, interactive_reply_id)
              select '${opts.target}','${sender}','${ct}','x','wamid.in.${randomUUID()}','${sender === 'customer' ? 'delivered' : 'sent'}', created_at + interval '${opts.offsetSeconds} seconds', ${opts.interactiveReplyId ? `'${opts.interactiveReplyId}'` : 'null'}
              from public.messages where conversation_id='${opts.ref}' and sender_type='bot' order by created_at limit 1`)
}

describe.skipIf(!REST || !CONTAINER)('customer-reply condition: engine integration (disposable database, simulated sends)', () => {
  beforeAll(async () => {
    acctA = await psql(`select account_id from public.profiles where user_id='${UA}'`); acctB = await psql(`select account_id from public.profiles where user_id='${UB}'`)
    process.env.FLOW_DURABLE_WAIT_EXECUTION_ACCOUNT_IDS = acctA; process.env.FLOW_CUSTOMER_REPLY_CONDITION_ACCOUNT_IDS = acctA
    engine = await import('./engine')
  })
  afterAll(() => { delete process.env.FLOW_DURABLE_WAIT_EXECUTION_ACCOUNT_IDS; delete process.env.FLOW_CUSTOMER_REPLY_CONDITION_ACCOUNT_IDS; sent.afterStore = null; sent.duringCall = null })

  it('R01: the customer did not answer during the 13 minutes: NO branch, follow-up sent once, reference stored from the first send', async () => {
    const w = await world(); const c = await contact(w); await send(w, c)
    const r1 = await run(c); expect(textsFor(c)).toEqual(['Hidrolavadora: ficha y precio']); expect(r1.wait_until).not.toBeNull()
    const ref = r1.vars['$refs'].info; expect(ref.conversation_id).toBe(c.conversationId)
    const dbRow = (await rows(`select id, created_at from public.messages where id='${ref.message_id}'`))[0]; expect(dbRow).toBeTruthy()
    expect(new Date(ref.sent_at).getTime()).toBe(new Date(dbRow.created_at).getTime())                                       // reference = the stored outbound row, not "now"
    await makeDue(r1.id); expect(await resume()).toMatchObject({ resumed: 1, failed: 0 })
    expect(textsFor(c)).toEqual(['Hidrolavadora: ficha y precio', 'Seguimos con tu consulta']); expect(await run(c)).toMatchObject({ status: 'completed', end_reason: 'end_node' })
    expect((await events(r1.id)).find((e) => e.node_key === 'check' && e.payload.condition_result)?.payload).toMatchObject({ condition_result: 'false', advancing_to: 'follow' })
    expect(await resume()).toMatchObject({ claimed: 0 }); expect(textsFor(c)).toHaveLength(2)
    pass('R01', 'no reply: reference stored at the first send (message id + DB timestamp), wait resumed, condition = NO, follow-up sent exactly once, no second pass duplicates it')
  })

  it('R02: the customer answered at minute 5: YES branch, nothing is sent, run ends cleanly; the reply itself is still reported as not consumed', async () => {
    const w = await world(); const c = await contact(w); await send(w, c)
    await msg({ target: c.conversationId, ref: c.conversationId, offsetSeconds: 300 })
    const during = await send(w, c, 'quiero el precio'); expect(during).toMatchObject({ consumed: false, outcome: 'waiting' })         // Inbox / automations still see it
    await makeDue((await run(c)).id); expect(await resume()).toMatchObject({ resumed: 1 })
    expect(textsFor(c)).toEqual(['Hidrolavadora: ficha y precio']); expect(await run(c)).toMatchObject({ status: 'completed', end_reason: 'end_node' })
    expect((await events((await run(c)).id)).find((e) => e.node_key === 'check' && e.payload.condition_result)?.payload).toMatchObject({ condition_result: 'true', advancing_to: 'replied_end' })
    pass('R02', 'reply at +5 min: condition = YES, no follow-up; the in-wait webhook call returned consumed:false/waiting (no reprompt, no second commercial answer from the flow)')
  })

  it('R03: the customer answered right after the first message and BEFORE the wait was scheduled: YES', async () => {
    const w = await world(); const c = await contact(w)
    sent.afterStore = async (a) => { sent.afterStore = null; await msg({ target: a.conversationId, ref: a.conversationId, offsetSeconds: 1 }) }   // lands between "stored" and "wait scheduled"
    await send(w, c); sent.afterStore = null
    const r = await run(c); expect(r.wait_until).not.toBeNull(); await makeDue(r.id); await resume()
    expect(textsFor(c)).toEqual(['Hidrolavadora: ficha y precio']); expect((await events(r.id)).find((e) => e.node_key === 'check' && e.payload.condition_result)?.payload.condition_result).toBe('true')
    pass('R03', 'a reply stored 1 s after the reference and before the wait existed is found: YES, no follow-up (the condition never looks at "when the wait started")')
  })

  it.each([['interactive button tap', 'interactive', 'btn_si'], ['list selection', 'interactive', 'row_2'], ['image', 'image', undefined], ['audio', 'audio', undefined], ['location', 'location', undefined], ['document', 'document', undefined]])('R04: %s counts as a reply', async (_label, contentType, replyId) => {
    const w = await world(); const c = await contact(w); await send(w, c)
    await msg({ target: c.conversationId, ref: c.conversationId, offsetSeconds: 30, contentType, interactiveReplyId: replyId })
    await makeDue((await run(c)).id); await resume(); expect(textsFor(c)).toEqual(['Hidrolavadora: ficha y precio'])
    if (_label === 'list selection') pass('R04', 'button tap, list selection, image, audio, location and document from the customer all count: YES, no follow-up')
  })

  it('R05: messages from the agent, the bot or an automation after the reference do NOT count', async () => {
    const w = await world(); const c = await contact(w); await send(w, c)
    await msg({ target: c.conversationId, ref: c.conversationId, offsetSeconds: 20, sender: 'agent' }); await msg({ target: c.conversationId, ref: c.conversationId, offsetSeconds: 25, sender: 'bot' })
    await makeDue((await run(c)).id); await resume()
    expect(textsFor(c)).toEqual(['Hidrolavadora: ficha y precio', 'Seguimos con tu consulta'])
    pass('R05', 'agent and bot rows after the reference are ignored: NO, the follow-up goes out (an agent reply in the real system also pauses the run before this point)')
  })

  it('R06: customer messages from before the first send (including the one that started the flow) do NOT count', async () => {
    const w = await world(); const c = await contact(w)
    await send(w, c)                                                                                                         // the trigger message is not stored by the harness; add old history explicitly
    await msg({ target: c.conversationId, ref: c.conversationId, offsetSeconds: -1 }); await msg({ target: c.conversationId, ref: c.conversationId, offsetSeconds: -3600 })
    await makeDue((await run(c)).id); await resume()
    expect(textsFor(c)).toEqual(['Hidrolavadora: ficha y precio', 'Seguimos con tu consulta'])
    pass('R06', 'customer messages 1 s and 1 hour BEFORE the reference are ignored: no false positive from old history')
  })

  it('R07: a reply from another contact or from another account never counts', async () => {
    const w = await world(); const c = await contact(w); const other = await contact(w); const wb = await world({ owner: 'B' }); const outsider = await contact(wb)
    await send(w, c)
    await send(w, other)                                                                                                     // the other contact has its own run and its own reference
    await msg({ target: other.conversationId, ref: other.conversationId, offsetSeconds: 10 })                               // answers, but it is ANOTHER contact
    await psql(`insert into public.messages (conversation_id, sender_type, content_type, content_text, message_id, status, created_at) values ('${outsider.conversationId}','customer','text','x','wamid.in.${randomUUID()}','delivered', clock_timestamp() + interval '10 seconds')`)   // other account
    await makeDue((await run(c)).id); await resume()
    expect(textsFor(c)).toEqual(['Hidrolavadora: ficha y precio', 'Seguimos con tu consulta'])
    pass('R07', 'a reply from another contact of the same account, and a reply from a contact of another account, are ignored: NO, the follow-up goes out (one conversation per contact and account: unique index idx_conversations_account_contact)')
  })

  it('R08: the reference survives a restart: a brand-new engine instance decides from the stored reference', async () => {
    const w = await world(); const yes = await contact(w); const no = await contact(w); await send(w, yes); await send(w, no)
    await msg({ target: yes.conversationId, ref: yes.conversationId, offsetSeconds: 120 })
    vi.resetModules(); const restarted = await import('./engine'); expect(restarted).not.toBe(engine)
    await makeDue((await run(yes)).id); await makeDue((await run(no)).id)
    expect(await restarted.resumeDueFlowWaits({ accountIds: [acctA] })).toMatchObject({ resumed: 2 })
    expect(textsFor(yes)).toEqual(['Hidrolavadora: ficha y precio']); expect(textsFor(no)).toEqual(['Hidrolavadora: ficha y precio', 'Seguimos con tu consulta'])
    pass('R08', 'after a simulated restart (modules discarded) both contacts are decided from the reference stored in flow_runs.vars: one YES, one NO')
  })

  it('R09: missing, corrupt, foreign or unreadable reference, or a failing query: the follow-up is NOT sent (fail closed)', async () => {
    const outcomes: string[] = []
    const failedAtCheck = async (c: Contact) => { const r = await run(c); expect(textsFor(c)).toEqual(['Hidrolavadora: ficha y precio']); expect(r.status).toBe('failed'); expect(r.end_reason).toBe('condition_evaluation_failed'); return (await events(r.id)).find((e) => e.event_type === 'error')?.payload.code as string }
    const prepared = async (mutate: (r: Record<string, any>, c: Contact) => Promise<void>) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      const w = await world(); const c = await contact(w); await send(w, c); const r = await run(c); await mutate(r, c); await makeDue(r.id); await resume(); return { c, w } }
    const setVars = (id: string, v: unknown) => psql(`update public.flow_runs set vars='${JSON.stringify(v).replace(/'/g, "''")}'::jsonb where id='${id}'`)
    outcomes.push(await failedAtCheck((await prepared(async (r) => { await setVars(r.id, {}) })).c))                                                           // reference never stored
    outcomes.push(await failedAtCheck((await prepared(async (r) => { await setVars(r.id, { $refs: { info: { message_id: 'nope', conversation_id: 'x', sent_at: 'y' } } }) })).c))   // corrupt
    outcomes.push(await failedAtCheck((await prepared(async (r) => { await setVars(r.id, { $refs: { info: { ...r.vars.$refs.info, conversation_id: randomUUID() } } }) })).c))     // not this contact's conversation
    outcomes.push(await failedAtCheck((await prepared(async (r) => { await psql(`delete from public.messages where id='${r.vars.$refs.info.message_id}'`) })).c))      // reference row gone
    outcomes.push(await failedAtCheck((await prepared(async (r, c) => { const stranger = await contact({ user: UB, acct: acctB }); await psql(`update public.messages set conversation_id='${stranger.conversationId}' where id='${r.vars.$refs.info.message_id}'`); void c })).c)) // row moved elsewhere
    outcomes.push(await failedAtCheck((await prepared(async (r) => { await psql(`update public.messages set sender_type='customer' where id='${r.vars.$refs.info.message_id}'`) })).c))   // reference is not an outbound message
    const noRef = await world({ refKey: 'ghost' }); const cg = await contact(noRef); await send(noRef, cg); await makeDue((await run(cg)).id); await resume(); outcomes.push(await failedAtCheck(cg))          // points at a node that never stored anything
    // the query itself fails: revoke read access on messages for the API role during the check
    const w = await world(); const cq = await contact(w); await send(w, cq); await makeDue((await run(cq)).id)
    await psql(`revoke select on public.messages from service_role`)
    try { await resume() } finally { await psql(`grant select on public.messages to service_role`) }
    outcomes.push(await failedAtCheck(cq))
    expect(outcomes).toEqual(['customer_reply_reference_missing', 'customer_reply_reference_missing', 'customer_reply_reference_not_in_contact', 'customer_reply_reference_invalid', 'customer_reply_reference_invalid', 'customer_reply_reference_invalid', 'customer_reply_reference_missing', 'customer_reply_reference_lookup_failed'])
    pass('R09', `8 failure modes end the run WITHOUT any follow-up (codes: ${outcomes.join(', ')})`)
  })

  it('R10: concurrent reply: it arrives while the run is between the condition and the follow-up send -> the send is suppressed by the guard', async () => {
    const w2 = await world(); const c2 = await contact(w2); await send(w2, c2); const r2 = await run(c2)
    // make the node after the condition a 1 s delay, then the send: reply lands inside that second
    await psql(`update public.flow_nodes set config = jsonb_set(config,'{false_next}','"gap2"') where flow_id='${w2.flow}' and node_key='check'`)
    await psql(`insert into public.flow_nodes (flow_id, node_key, node_type, config) values ('${w2.flow}','gap2','delay','{"seconds":1,"next_node_key":"follow"}')`)
    await makeDue(r2.id)
    const resuming = resume(); await new Promise((r) => setTimeout(r, 400))
    await msg({ target: c2.conversationId, ref: c2.conversationId, offsetSeconds: 600 })                                 // reply lands after the condition said NO
    expect(await resuming).toMatchObject({ resumed: 1 })
    expect(textsFor(c2)).toEqual(['Hidrolavadora: ficha y precio'])
    expect(await run(c2)).toMatchObject({ status: 'completed', end_reason: 'customer_replied_before_send' })
    expect((await events(r2.id)).some((e) => e.payload.reason === 'send_suppressed_customer_replied')).toBe(true)
    // the same flow without an answer still sends
    const c3 = await contact(w2); await send(w2, c3); await makeDue((await run(c3)).id); await resume(); expect(textsFor(c3)).toEqual(['Hidrolavadora: ficha y precio', 'Seguimos con tu consulta'])
    pass('R10', 'a reply that lands between the condition (NO) and the follow-up send cancels the send (guard re-check right before the send); without a reply the follow-up still goes out')
  })

  it('R11: the residual race, documented: a reply that lands DURING the Meta call itself cannot be stopped', async () => {
    const w = await world(); const c = await contact(w); await send(w, c); const r = await run(c); await makeDue(r.id)
    sent.duringCall = async (a) => { if (a.text === 'Seguimos con tu consulta') { sent.duringCall = null; await msg({ target: a.conversationId, ref: a.conversationId, offsetSeconds: 700 }) } }
    await resume(); sent.duringCall = null
    expect(textsFor(c)).toEqual(['Hidrolavadora: ficha y precio', 'Seguimos con tu consulta'])                          // sent exactly once; the customer answered at the same instant
    expect(await run(c)).toMatchObject({ status: 'completed' })
    pass('R11', 'LIMITATION CONFIRMED: a reply landing inside the Meta call (tens of ms) after the last check still gets the follow-up. It is sent once, never duplicated; no code can close this gap')
  })

  it('R12: account gates fail closed: no follow-up when the account lacks the condition flag or the wait execution flag', async () => {
    const savedC = process.env.FLOW_CUSTOMER_REPLY_CONDITION_ACCOUNT_IDS
    try {
      process.env.FLOW_CUSTOMER_REPLY_CONDITION_ACCOUNT_IDS = acctB                                                      // A loses the condition flag
      const w = await world(); const c = await contact(w); await send(w, c); await makeDue((await run(c)).id); await resume()
      expect(textsFor(c)).toEqual(['Hidrolavadora: ficha y precio']); expect((await events((await run(c)).id)).find((e) => e.event_type === 'error')?.payload.code).toBe('customer_reply_capability_disabled')
    } finally { process.env.FLOW_CUSTOMER_REPLY_CONDITION_ACCOUNT_IDS = savedC }
    // account B has neither flag: its wait already fails closed before the condition (P6 behaviour, unchanged)
    const wb = await world({ owner: 'B' }); const cb = await contact(wb); await send(wb, cb)
    expect(await run(cb)).toMatchObject({ status: 'failed', end_reason: 'durable_wait_not_enabled' }); expect(textsFor(cb)).toEqual(['Hidrolavadora: ficha y precio'])
    pass('R12', 'without the condition flag the run fails closed at the condition; account B (no flags) fails closed at the wait; neither sends a follow-up')
  })

  it('R13: several initial messages: the explicit reference decides which reply counts, and a loop does not move it', async () => {
    const w = await world({ two: true }); const c = await contact(w); await send(w, c)
    const r = await run(c); expect(Object.keys(r.vars['$refs'])).toEqual(['info'])                                       // only the node a condition points at is recorded
    await psql(`update public.flow_nodes set config = jsonb_set(config,'{subject_key}','"info2"') where flow_id='${w.flow}' and node_key='check'`)
    // reply between message 1 and message 2: with reference = info it counts; with reference = info2 it would not. Here: reference info2 was changed AFTER the run started, so no reference exists for it -> fail closed
    await makeDue(r.id); await resume(); expect(await run(c)).toMatchObject({ status: 'failed', end_reason: 'condition_evaluation_failed' }); expect(textsFor(c)).toHaveLength(2)
    const w2 = await world({ two: true, refKey: 'info2' }); const c2 = await contact(w2); await send(w2, c2)
    await psql(`update public.messages set created_at = created_at - interval '5 seconds' where conversation_id='${c2.conversationId}' and content_text='Hidrolavadora: ficha y precio'`)   // msg 1 happened 5 s before msg 2
    await msg({ target: c2.conversationId, ref: c2.conversationId, offsetSeconds: 2 })                                      // customer wrote between msg 1 and msg 2 (relative to msg 1)
    await makeDue((await run(c2)).id); await resume()
    expect(textsFor(c2)).toEqual(['Hidrolavadora: ficha y precio', 'Hidrolavadora: garantía', 'Seguimos con tu consulta'])  // reference = info2 (the explicit block start): the earlier reply does not count
    pass('R13', 'the reference is the node chosen in the condition (not "the first message of the run"): a reply between message 1 and message 2 is ignored when message 2 is the reference; an unrecorded reference fails closed')
  })

  it('R14: no real sends, no foreign network, no activation through the API path', async () => {
    expect(sent.blockedFetches).toBe(0)
    expect(sent.texts.every((t) => ['Hidrolavadora: ficha y precio', 'Hidrolavadora: garantía', 'Seguimos con tu consulta'].includes(t.text))).toBe(true)
    // a flow holding a durable wait cannot be activated by a normal session (069 guard): the harness needed the operator switch
    const w = await world(); await psql(`update public.flows set status='draft' where id='${w.flow}'`)
    await expect(psql(`update public.flows set status='active' where id='${w.flow}'`)).rejects.toThrow(/durable/i)
    pass('R14', `${sent.texts.length} simulated sends, 0 blocked network calls, 0 real sends; activating a flow with a wait still needs the operator switch (migration 069)`)
  })
})
