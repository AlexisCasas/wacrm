// Isolated QA of public.apply_whatsapp_message_status (migration 20261108000000): transition table, atomicity under concurrency, tenant scope,
// argument validation and privileges. Real Postgres + PostgREST of the throwaway QA stack; SYNTHETIC data only.
// Skipped unless QA_E2E=1; refuses to run unless NEXT_PUBLIC_SUPABASE_URL is a loopback address.
import { execFileSync } from 'node:child_process'
import { createClient } from '@supabase/supabase-js'
import { beforeAll, describe, expect, it } from 'vitest'

const E2E = process.env.QA_E2E === '1'
const sql = (query: string): string =>
  execFileSync('docker', ['exec', '-i', 'qa-pg', 'psql', '-U', 'supabase_admin', '-d', 'wacrm', '-At', '-v', 'ON_ERROR_STOP=1', '-c', query], { encoding: 'utf8' }).trim()
const sqlErr = (query: string): string => {
  try { sql(query); return 'NO_ERROR' } catch (e) { return String((e as { stderr?: string }).stderr ?? e).split('\n')[0] }
}
const one = (query: string) => sql(query).split('\n')[0]

interface Tenant { account: string; user: string; contact: string; conv: string }
let A: Tenant
let B: Tenant
let seq = 0
const wamid = (tag: string) => `wamid.QASQL${tag}${Date.now().toString(36)}${++seq}`

function tenant(tag: string): Tenant {
  const user = one(`insert into auth.users (id, email) values (gen_random_uuid(), '${tag}-'||substr(gen_random_uuid()::text,1,8)||'@example.invalid') returning id`)
  const account = one(`select account_id from profiles where user_id='${user}'`)
  const contact = one(`insert into contacts (user_id, account_id, phone, name) values ('${user}','${account}','519000'||floor(random()*900000+100000)::int,'Cliente Sintetico') returning id`)
  const conv = one(`insert into conversations (user_id, account_id, contact_id) values ('${user}','${account}','${contact}') returning id`)
  return { account, user, contact, conv }
}
const msg = (t: Tenant, id: string, status: string, sender = 'agent') =>
  one(`insert into messages (conversation_id, sender_type, content_type, content_text, message_id, status) values ('${t.conv}','${sender}','text','x','${id}','${status}') returning id`)
const apply = (t: Tenant, id: string, status: string) =>
  sql(`select r_previous_status||'>'||r_new_status from public.apply_whatsapp_message_status('${t.account}','${id}','${status}', null)`)
const current = (t: Tenant, id: string) => one(`select m.status from messages m join conversations c on c.id=m.conversation_id where c.account_id='${t.account}' and m.message_id='${id}'`)

describe.skipIf(!E2E)('apply_whatsapp_message_status (isolated SQL QA)', () => {
  beforeAll(() => {
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '')) throw new Error('QA_E2E must point at the isolated loopback stack')
    A = tenant('sql-a'); B = tenant('sql-b')
  })

  it('Q1 transition table: every (current, incoming) pair behaves exactly as specified', () => {
    const currents = ['pending', 'sending', 'sent', 'delivered', 'read', 'failed', 'replied']
    const incomings = ['sent', 'delivered', 'read', 'failed']
    const rank: Record<string, number> = { pending: 0, sending: 0, sent: 1, delivered: 2, read: 3, replied: 4 }
    const expected = (cur: string, inc: string) => (inc === 'failed' ? ['pending', 'sending', 'sent'].includes(cur) : cur === 'failed' ? false : rank[inc] > rank[cur])
    const rows = sql(`select c||'>'||i||'='||public.whatsapp_status_can_advance(c, i) from unnest(array[${currents.map((c) => `'${c}'`).join(',')}]) c, unnest(array[${incomings.map((i) => `'${i}'`).join(',')}]) i`).split('\n')
    expect(rows).toHaveLength(currents.length * incomings.length)
    for (const row of rows) {
      const [pair, value] = row.split('='); const [cur, inc] = pair.split('>')
      expect(value === 'true', `${cur} -> ${inc}`).toBe(expected(cur, inc))
    }
  })

  it('Q2 edge inputs of the predicate: NULL and unknown values never advance a status they cannot name', () => {
    expect(one(`select public.whatsapp_status_can_advance('sent', null)`)).toBe('f')
    expect(one(`select public.whatsapp_status_can_advance('sent', 'played')`)).toBe('f')      // `played` is mapped BEFORE this predicate
    expect(one(`select public.whatsapp_status_can_advance('sent', 'deleted')`)).toBe('f')
    expect(one(`select public.whatsapp_status_can_advance(null, 'delivered')`)).toBe('t')       // unknown current: accept ladder moves
    expect(one(`select public.whatsapp_status_can_advance(null, 'failed')`)).toBe('f')
    expect(one(`select public.whatsapp_status_can_advance('weird', 'read')`)).toBe('t')
  })

  it('Q3 the function reports exactly the effective change, and nothing for a no-op', () => {
    const w = wamid('eff'); msg(A, w, 'sending')
    expect(apply(A, w, 'sent')).toBe('sending>sent')
    expect(apply(A, w, 'sent')).toBe('')                 // replay: no row => no notification
    expect(apply(A, w, 'read')).toBe('sent>read')
    expect(apply(A, w, 'delivered')).toBe('')            // late event: nothing
    expect(apply(A, w, 'played')).toBe('')               // played == read: already read
    expect(current(A, w)).toBe('read')
  })

  it('Q4 `played` is stored as read; unsupported statuses and bad arguments are rejected with 22023 and write nothing', () => {
    const w = wamid('ply'); msg(A, w, 'delivered', 'bot')
    expect(apply(A, w, 'played')).toBe('delivered>read')
    expect(sqlErr(`select * from public.apply_whatsapp_message_status('${A.account}','${w}','deleted',null)`)).toMatch(/unsupported_status/)
    expect(sqlErr(`select * from public.apply_whatsapp_message_status('${A.account}','${w}',null,null)`)).toMatch(/unsupported_status/)
    expect(sqlErr(`select * from public.apply_whatsapp_message_status(null,'${w}','sent',null)`)).toMatch(/invalid_arguments/)
    expect(sqlErr(`select * from public.apply_whatsapp_message_status('${A.account}','   ','sent',null)`)).toMatch(/invalid_arguments/)
    expect(current(A, w)).toBe('read')
  })

  it('Q5 tenant scope: a colliding id is only touched through its own account, and an unknown account touches nothing', () => {
    const w = wamid('scope'); msg(A, w, 'sent'); msg(B, w, 'sent')
    expect(apply(B, w, 'delivered')).toBe('sent>delivered')
    expect(current(B, w)).toBe('delivered'); expect(current(A, w)).toBe('sent')
    expect(sql(`select * from public.apply_whatsapp_message_status(gen_random_uuid(),'${w}','read',null)`)).toBe('')
    expect(current(A, w)).toBe('sent'); expect(current(B, w)).toBe('delivered')
  })

  it('Q6 a customer (inbound) row is never modified, even in its own account', () => {
    const w = wamid('inb'); msg(A, w, 'delivered', 'customer')
    expect(apply(A, w, 'read')).toBe(''); expect(current(A, w)).toBe('delivered')
  })

  it('Q7 several rows of the SAME account sharing one id (distinct conversations) are all advanced, none regressed', () => {
    const w = wamid('multi')
    const contact2 = one(`insert into contacts (user_id, account_id, phone, name) values ('${A.user}','${A.account}','519100'||floor(random()*900000+100000)::int,'Cliente Sintetico 2') returning id`)
    const conv2 = one(`insert into conversations (user_id, account_id, contact_id) values ('${A.user}','${A.account}','${contact2}') returning id`)
    msg(A, w, 'sent'); one(`insert into messages (conversation_id, sender_type, content_type, content_text, message_id, status) values ('${conv2}','agent','text','x','${w}','read') returning id`)
    const out = sql(`select r_previous_status||'>'||r_new_status from public.apply_whatsapp_message_status('${A.account}','${w}','delivered',null)`)
    expect(out).toBe('sent>delivered')                     // the row already at `read` is skipped
    expect(sql(`select status from messages where message_id='${w}' order by status`)).toBe('delivered\nread')
  })

  it('Q8 ATOMICITY: ~200 concurrent, shuffled deliveries never regress a status and leave a consistent chain of effective changes', async () => {
    const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
    const trials = 10
    const ids = Array.from({ length: trials }, (_, i) => wamid('race' + i))
    ids.forEach((id) => msg(A, id, 'sending'))
    const calls: { id: string; status: string }[] = []
    for (const id of ids) for (const s of ['sent', 'delivered', 'read']) for (let k = 0; k < 7; k++) calls.push({ id, status: s })
    for (let i = calls.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [calls[i], calls[j]] = [calls[j], calls[i]] }
    const results = await Promise.all(calls.map(async (c) => {
      const { data, error } = await admin.rpc('apply_whatsapp_message_status', { p_account_id: A.account, p_wamid: c.id, p_status: c.status, p_event_at: null })
      expect(error).toBeNull()
      return { ...c, rows: (data ?? []) as { r_previous_status: string; r_new_status: string }[] }
    }))
    const rank: Record<string, number> = { sending: 0, sent: 1, delivered: 2, read: 3 }
    for (const id of ids) {
      expect(current(A, id)).toBe('read')
      const edges = results.filter((r) => r.id === id).flatMap((r) => r.rows.map((x) => [x.r_previous_status, x.r_new_status] as const))
      expect(edges.length).toBeGreaterThanOrEqual(1); expect(edges.length).toBeLessThanOrEqual(3)
      for (const [from, to] of edges) expect(rank[to], `${from}->${to}`).toBeGreaterThan(rank[from])           // strictly forward
      expect(new Set(edges.map((e) => e[0])).size).toBe(edges.length)                                          // each state left at most once
      expect(new Set(edges.map((e) => e[1])).size).toBe(edges.length)                                          // each state entered at most once
      const path = [...edges].sort((a, b) => rank[a[0]] - rank[b[0]])
      expect(path[0][0]).toBe('sending'); expect(path[path.length - 1][1]).toBe('read')
      for (let k = 1; k < path.length; k++) expect(path[k][0]).toBe(path[k - 1][1])                            // a real chain: no lost or double update
    }
  }, 60_000)

  it('Q9 failed vs forward events racing from `sent`: never ends at `sent`, and `failed` and delivered/read are mutually exclusive', async () => {
    const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
    const outcomes = new Set<string>()
    for (let trial = 0; trial < 12; trial++) {
      const id = wamid('fr' + trial); msg(A, id, 'sent')
      const seqs = ['failed', 'delivered', 'read', 'failed', 'delivered', 'read'].sort(() => Math.random() - 0.5)
      const res = await Promise.all(seqs.map((s) => admin.rpc('apply_whatsapp_message_status', { p_account_id: A.account, p_wamid: id, p_status: s, p_event_at: null })))
      res.forEach((r) => expect(r.error).toBeNull())
      const finalStatus = current(A, id); outcomes.add(finalStatus)
      expect(['failed', 'delivered', 'read']).toContain(finalStatus)
      const applied = res.flatMap((r) => (r.data ?? []) as { r_new_status: string }[]).map((r) => r.r_new_status)
      if (finalStatus === 'failed') expect(applied).toEqual(['failed'])                  // failed won: nothing else was ever applied
      else expect(applied).not.toContain('failed')                                       // forward won: failed was refused
    }
    expect(outcomes.size).toBeGreaterThanOrEqual(1)
  }, 60_000)

  it('Q10 broadcast recipients: tenant-scoped through the broadcast, forward-only, replied preserved; timestamps follow the event', () => {
    const w = wamid('bc'); const bA = one(`insert into broadcasts (user_id, account_id, name, template_name) values ('${A.user}','${A.account}','qa','t') returning id`)
    const r = one(`insert into broadcast_recipients (broadcast_id, contact_id, status, whatsapp_message_id) values ('${bA}','${A.contact}','pending','${w}') returning id`)
    const st = () => sql(`select status||'|'||coalesce(to_char(sent_at at time zone 'UTC','HH24:MI:SS'),'-')||'|'||coalesce(to_char(delivered_at at time zone 'UTC','HH24:MI:SS'),'-')||'|'||coalesce(to_char(read_at at time zone 'UTC','HH24:MI:SS'),'-') from broadcast_recipients where id='${r}'`)
    sql(`select * from public.apply_whatsapp_message_status('${B.account}','${w}','read','2026-01-01 10:00:00+00')`)       // other account: nothing
    expect(st()).toBe('pending|-|-|-')
    sql(`select * from public.apply_whatsapp_message_status('${A.account}','${w}','sent','2026-01-01 10:00:01+00')`); expect(st()).toBe('sent|10:00:01|-|-')
    sql(`select * from public.apply_whatsapp_message_status('${A.account}','${w}','read','2026-01-01 10:00:09+00')`); expect(st()).toBe('read|10:00:01|-|10:00:09')
    sql(`select * from public.apply_whatsapp_message_status('${A.account}','${w}','delivered','2026-01-01 10:00:05+00')`); expect(st()).toBe('read|10:00:01|-|10:00:09')
    sql(`update broadcast_recipients set status='replied' where id='${r}'`)
    sql(`select * from public.apply_whatsapp_message_status('${A.account}','${w}','read','2026-01-01 10:00:20+00')`); expect(st().startsWith('replied|')).toBe(true)
    const f = wamid('bcf'); const r2 = one(`insert into broadcast_recipients (broadcast_id, contact_id, status, whatsapp_message_id) values ('${bA}','${A.contact}','sent','${f}') returning id`)
    sql(`select * from public.apply_whatsapp_message_status('${A.account}','${f}','failed',null)`); expect(one(`select status from broadcast_recipients where id='${r2}'`)).toBe('failed')
    sql(`select * from public.apply_whatsapp_message_status('${A.account}','${f}','delivered',null)`); expect(one(`select status from broadcast_recipients where id='${r2}'`)).toBe('failed')
  }, 60_000)

  it('Q11 privileges: only service_role can execute; anon, authenticated and PUBLIC cannot; the functions are not SECURITY DEFINER', () => {
    const w = wamid('priv'); msg(A, w, 'sent')
    for (const role of ['anon', 'authenticated']) {
      expect(sqlErr(`set role ${role}; select * from public.apply_whatsapp_message_status('${A.account}','${w}','read',null)`), role).toMatch(/permission denied for function apply_whatsapp_message_status/)
      expect(sqlErr(`set role ${role}; select public.whatsapp_status_can_advance('sent','read')`), role).toMatch(/permission denied/)
    }
    expect(current(A, w)).toBe('sent')
    expect(one(`select has_function_privilege('service_role','public.apply_whatsapp_message_status(uuid,text,text,timestamptz)','execute')`)).toBe('t')
    expect(sql(`select proname||'='||prosecdef from pg_proc where proname in ('apply_whatsapp_message_status','whatsapp_status_can_advance','whatsapp_status_rank') order by 1`)).toBe('apply_whatsapp_message_status=false\nwhatsapp_status_can_advance=false\nwhatsapp_status_rank=false')
    expect(one(`select count(*) from information_schema.routine_privileges where routine_name='apply_whatsapp_message_status' and grantee in ('PUBLIC','anon','authenticated')`)).toBe('0')
  })
})
