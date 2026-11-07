// Isolated QA of public.record_whatsapp_message_pricing + whatsapp_message_pricing (migration 20261107004404): merge of sent / delivered / read, idempotent
// replay, tenant scope and constraints. Real Postgres of the throwaway QA stack; SYNTHETIC data only.
// Skipped unless QA_E2E=1; refuses to run unless NEXT_PUBLIC_SUPABASE_URL is a loopback address.
import { execFileSync } from 'node:child_process'
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
const wamid = (tag: string) => `wamid.QAFEP${tag}${Date.now().toString(36)}${++seq}`

function tenant(tag: string): Tenant {
  const user = one(`insert into auth.users (id, email) values (gen_random_uuid(), '${tag}-'||substr(gen_random_uuid()::text,1,8)||'@example.invalid') returning id`)
  const account = one(`select account_id from profiles where user_id='${user}'`)
  const contact = one(`insert into contacts (user_id, account_id, phone, name) values ('${user}','${account}','519000'||floor(random()*900000+100000)::int,'Cliente Sintetico') returning id`)
  const conv = one(`insert into conversations (user_id, account_id, contact_id) values ('${user}','${account}','${contact}') returning id`)
  return { account, user, contact, conv }
}
const msg = (t: Tenant, id: string, sender = 'bot') =>
  one(`insert into messages (conversation_id, sender_type, content_type, content_text, message_id, status) values ('${t.conv}','${sender}','text','x','${id}','sent') returning id`)
const record = (t: Tenant, id: string, type: string | null, category: string | null, exp: string | null) =>
  one(`select public.record_whatsapp_message_pricing('${t.account}','${id}',${type ? `'${type}'` : 'null'},${category ? `'${category}'` : 'null'},${exp ? `'${exp}'::timestamptz` : 'null'})`)
const row = (t: Tenant, id: string) =>
  one(`select coalesce(pricing_type,'-')||'|'||coalesce(pricing_category,'-')||'|'||coalesce(expiration_at::text,'-') from whatsapp_message_pricing where account_id='${t.account}' and wamid='${id}'`)
const count = (t: Tenant, id: string) => one(`select count(*) from whatsapp_message_pricing where account_id='${t.account}' and wamid='${id}'`)

describe.skipIf(!E2E)('record_whatsapp_message_pricing (isolated SQL QA)', () => {
  beforeAll(() => {
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '')) throw new Error('QA_E2E must point at the isolated loopback stack')
    A = tenant('fep-a'); B = tenant('fep-b')
  })

  it('P1 sent (expiration) then delivered (type, no conversation) then read (nothing): one row, nothing erased', () => {
    const id = wamid('p1'); msg(A, id)
    expect(record(A, id, null, null, '2026-11-10T12:00:00Z')).toBe('t')
    expect(record(A, id, 'free_entry_point', 'service', null)).toBe('t')
    expect(record(A, id, null, null, null)).toBe('f')            // nothing to store
    expect(count(A, id)).toBe('1')
    expect(row(A, id)).toBe('free_entry_point|service|2026-11-10 12:00:00+00')
  })

  it('P2 replaying the same evidence is idempotent', () => {
    const id = wamid('p2'); msg(A, id)
    for (let i = 0; i < 3; i++) record(A, id, 'free_entry_point', 'service', '2026-11-10T12:00:00Z')
    expect(count(A, id)).toBe('1')
    expect(row(A, id)).toBe('free_entry_point|service|2026-11-10 12:00:00+00')
  })

  it('P3 a later expiration from Meta replaces the earlier one; a later event without one keeps it', () => {
    const id = wamid('p3'); msg(A, id)
    record(A, id, 'free_entry_point', null, '2026-11-10T12:00:00Z')
    record(A, id, null, null, '2026-11-11T12:00:00Z')
    record(A, id, 'free_entry_point', null, null)
    expect(row(A, id)).toBe('free_entry_point|-|2026-11-11 12:00:00+00')
  })

  it('P4 tenant scope: another account (same wamid or not) can neither write nor see this message', () => {
    const id = wamid('p4'); msg(A, id)
    expect(record(B, id, 'free_entry_point', null, null)).toBe('f')
    expect(count(B, id)).toBe('0'); expect(count(A, id)).toBe('0')
    const same = wamid('p4b'); msg(A, same); msg(B, same)
    record(B, same, 'free_entry_point', null, '2026-11-12T00:00:00Z')
    expect(count(A, same)).toBe('0'); expect(count(B, same)).toBe('1')
  })

  it('P5 customer messages and unknown messages are never recorded', () => {
    const id = wamid('p5'); msg(A, id, 'customer')
    expect(record(A, id, 'free_entry_point', null, null)).toBe('f')
    expect(record(A, wamid('nope'), 'free_entry_point', null, null)).toBe('f')
  })

  it('P6 constraints: invalid arguments raise; a row cannot carry another account for its contact', () => {
    expect(sqlErr(`select public.record_whatsapp_message_pricing('${A.account}','  ','free_entry_point',null,null)`)).toMatch(/invalid_arguments/)
    expect(sqlErr(`insert into whatsapp_message_pricing (account_id, wamid, contact_id, conversation_id, pricing_type) values ('${B.account}','x','${A.contact}','${A.conv}','free_entry_point')`)).toMatch(/violates foreign key/)
    expect(sqlErr(`insert into whatsapp_message_pricing (account_id, wamid, contact_id, conversation_id) values ('${A.account}','y','${A.contact}','${A.conv}')`)).toMatch(/whatsapp_message_pricing_evidence/)
  })

  it('P7 the contact\'s window is the latest real expiration, rows without one come last', () => {
    const ids = [wamid('p7a'), wamid('p7b'), wamid('p7c')]; ids.forEach((i) => msg(A, i))
    record(A, ids[0], 'free_entry_point', null, '2026-11-10T00:00:00Z')
    record(A, ids[1], 'free_entry_point', null, '2026-11-14T00:00:00Z')
    record(A, ids[2], 'free_entry_point', null, null)
    expect(one(`select expiration_at::text from whatsapp_message_pricing where contact_id='${A.contact}' and pricing_type='free_entry_point' and wamid = any(array['${ids.join("','")}']) order by expiration_at desc nulls last limit 1`)).toBe('2026-11-14 00:00:00+00')
  })

  it('P8 privileges: only service_role may execute; deleting the contact removes the rows', () => {
    expect(one(`select has_function_privilege('anon','public.record_whatsapp_message_pricing(uuid,text,text,text,timestamptz)','execute')`)).toBe('f')
    expect(one(`select has_function_privilege('authenticated','public.record_whatsapp_message_pricing(uuid,text,text,text,timestamptz)','execute')`)).toBe('f')
    expect(one(`select has_function_privilege('service_role','public.record_whatsapp_message_pricing(uuid,text,text,text,timestamptz)','execute')`)).toBe('t')
  })
})
