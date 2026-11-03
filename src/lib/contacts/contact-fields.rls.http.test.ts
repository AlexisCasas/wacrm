import { createHmac, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * Inbox contact-fields editor, DB integration: the exact queries issued by InboxContactFields, run as real authenticated users (agent, viewer, other
 * account) through PostgREST against a disposable PostgreSQL 17 with every migration. Skipped unless QA_REST_URL is set
 * (run through qa/contact-fields/run-rls-qa.sh). Synthetic data only. Ids CF01...
 */
const REST = process.env.QA_REST_URL ?? ''
const CONTAINER = process.env.QA_PG_CONTAINER ?? ''
const SECRET = process.env.QA_JWT_SECRET ?? ''
const run = REST ? describe : describe.skip
vi.setConfig({ testTimeout: 60_000 })
const pass = (id: string, detail: string) => console.log(`QA-RESULT ${id} PASS ${detail}`)

const psql = (sql: string) => new Promise<string>((resolve, reject) => execFile('docker', ['exec', '-i', CONTAINER, 'psql', '-U', 'supabase_admin', '-h', '/var/run/postgresql', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-Atq', '-c', sql], (err, out, errOut) => (err ? reject(new Error(errOut || String(err))) : resolve(out.trim()))))

function client(userId: string): SupabaseClient {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
  const head = b64({ alg: 'HS256', typ: 'JWT' })
  const now = Math.floor(Date.now() / 1000)
  const body = b64({ role: 'authenticated', sub: userId, aud: 'authenticated', iat: now, exp: now + 3600 })
  const token = `${head}.${body}.${createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`
  // PostgREST here has no /rest/v1 gateway prefix (supabase-js adds it), so strip it.
  const strip: typeof fetch = (input, init) => fetch(String(input instanceof Request ? input.url : input).replace('/rest/v1', ''), init)
  return createClient(REST, token, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: strip } })
}

const UA = 'a1000000-0000-4000-8000-000000000001'
const UB = 'b2000000-0000-4000-8000-000000000002'
const UV = 'c3000000-0000-4000-8000-000000000003'
let acctA = ''
let acctB = ''
let contactA = ''
let contactB = ''
let fProducto = ''
let fDestino = ''
let fOtro = ''
const agent = () => client(UA)

run('InboxContactFields queries (RLS, CAS, isolation)', () => {
  beforeAll(async () => {
    acctA = await psql(`select account_id from public.profiles where user_id='${UA}'`)
    acctB = await psql(`select account_id from public.profiles where user_id='${UB}'`)
    await psql(`insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values ('${UV}','00000000-0000-0000-0000-000000000000','authenticated','authenticated','qa-v@example.test','{}'::jsonb, now(), now())`)
    await psql(`update public.profiles set account_id='${acctA}', account_role='viewer' where user_id='${UV}'`)
    contactA = randomUUID(); contactB = randomUUID()
    await psql(`insert into public.contacts (id,user_id,account_id,phone,name,email,company) values ('${contactA}','${UA}','${acctA}','+15600000001','Ana','ana@example.test','ACME'),('${contactB}','${UB}','${acctB}','+15600000002','Beto','b@example.test','Other')`)
    fProducto = randomUUID(); fDestino = randomUUID(); fOtro = randomUUID()
    await psql(`insert into public.custom_fields (id,user_id,account_id,field_name,field_type) values ('${fProducto}','${UA}','${acctA}','Producto','text'),('${fDestino}','${UA}','${acctA}','Destino','text'),('${fOtro}','${UA}','${acctA}','Otro','text')`)
    await psql(`insert into public.contact_custom_values (contact_id,custom_field_id,value) values ('${contactA}','${fProducto}','Cemento'),('${contactA}','${fDestino}','Lima'),('${contactA}','${fOtro}','x')`)
  })

  it('CF01: agent edits name/email/company with compare-and-set; phone untouched; stale updated_at is a conflict', async () => {
    const db = agent()
    const { data: loaded } = await db.from('contacts').select('id, account_id, name, phone, email, company, updated_at').eq('id', contactA).eq('account_id', acctA).maybeSingle()
    expect(loaded?.phone).toBe('+15600000001')
    const first = await db.from('contacts').update({ name: 'Ana María', company: null, updated_at: new Date().toISOString() }).eq('id', contactA).eq('account_id', acctA).eq('updated_at', loaded!.updated_at).select('id, name, email, company, updated_at').maybeSingle()
    expect(first.error).toBeNull()
    expect(first.data?.name).toBe('Ana María'); expect(first.data?.company).toBeNull(); expect(first.data?.email).toBe('ana@example.test')
    // second save with the original (now stale) updated_at must match nothing
    const stale = await db.from('contacts').update({ name: 'Overwrite', updated_at: new Date().toISOString() }).eq('id', contactA).eq('account_id', acctA).eq('updated_at', loaded!.updated_at).select('id').maybeSingle()
    expect(stale.data).toBeNull()
    expect(await psql(`select name||'|'||phone from public.contacts where id='${contactA}'`)).toBe('Ana María|+15600000001')
    pass('CF01', 'CAS applied, stale write rejected, phone unchanged')
  })

  it('CF02: viewer cannot edit standard or custom values and cannot insert/delete', async () => {
    const db = client(UV)
    const seen = await db.from('contacts').select('id').eq('id', contactA)
    expect(seen.data).toHaveLength(1) // read-only profiles can still read
    const upd = await db.from('contacts').update({ name: 'hack' }).eq('id', contactA).select('id')
    expect(upd.data ?? []).toHaveLength(0)
    const updV = await db.from('contact_custom_values').update({ value: 'hack' }).eq('contact_id', contactA).eq('custom_field_id', fDestino).select('id')
    expect(updV.data ?? []).toHaveLength(0)
    const del = await db.from('contact_custom_values').delete().eq('contact_id', contactA).eq('custom_field_id', fDestino).select('id')
    expect(del.data ?? []).toHaveLength(0)
    const ins = await db.from('contact_custom_values').insert({ contact_id: contactA, custom_field_id: randomUUID(), value: 'x' })
    expect(ins.error).not.toBeNull()
    expect(await psql(`select name||'|'||(select value from public.contact_custom_values where contact_id='${contactA}' and custom_field_id='${fDestino}') from public.contacts where id='${contactA}'`)).toBe('Ana María|Lima')
    pass('CF02', 'viewer reads but every write is blocked')
  })

  it('CF03: another account sees and changes nothing of account A', async () => {
    const db = client(UB)
    expect((await db.from('contacts').select('id').eq('id', contactA)).data).toHaveLength(0)
    expect((await db.from('contact_custom_values').select('id').eq('contact_id', contactA)).data).toHaveLength(0)
    expect((await db.from('custom_fields').select('id').eq('account_id', acctA)).data).toHaveLength(0)
    expect(((await db.from('contacts').update({ name: 'x' }).eq('id', contactA).select('id')).data ?? [])).toHaveLength(0)
    expect(((await db.from('contact_custom_values').update({ value: 'x' }).eq('contact_id', contactA).select('id')).data ?? [])).toHaveLength(0)
    expect(((await db.from('contact_custom_values').delete().eq('contact_id', contactA).select('id')).data ?? [])).toHaveLength(0)
    const ins = await db.from('contact_custom_values').insert({ contact_id: contactA, custom_field_id: fOtro, value: 'x' })
    expect(ins.error).not.toBeNull()
    expect(await psql(`select count(*) from public.contact_custom_values where contact_id='${contactA}'`)).toBe('3')
    pass('CF03', 'cross-account read/update/delete/insert all blocked')
  })

  it('CF04: saving one custom field leaves the others; selective delete; CAS conflict with a flow/another agent', async () => {
    const db = agent()
    const { data: rows } = await db.from('contact_custom_values').select('id, custom_field_id, value').eq('contact_id', contactA)
    const by = Object.fromEntries((rows ?? []).map((r) => [r.custom_field_id, r]))
    // edit Destino
    const upd = await db.from('contact_custom_values').update({ value: 'Cusco' }).eq('id', by[fDestino].id).eq('contact_id', contactA).eq('custom_field_id', fDestino).eq('value', 'Lima').select('id, custom_field_id, value').maybeSingle()
    expect(upd.data?.value).toBe('Cusco')
    // delete Producto only
    const del = await db.from('contact_custom_values').delete().eq('id', by[fProducto].id).eq('contact_id', contactA).eq('custom_field_id', fProducto).eq('value', 'Cemento').select('id').maybeSingle()
    expect(del.data).not.toBeNull()
    expect(await psql(`select string_agg(custom_field_id::text||'='||value, ',' order by value) from public.contact_custom_values where contact_id='${contactA}'`)).toBe(`${fDestino}=Cusco,${fOtro}=x`)
    // a flow changes "Otro" after the panel loaded -> the editor's CAS must not overwrite it
    await psql(`update public.contact_custom_values set value='flow-wrote' where id='${by[fOtro].id}'`)
    const clash = await db.from('contact_custom_values').update({ value: 'agent-wrote' }).eq('id', by[fOtro].id).eq('contact_id', contactA).eq('custom_field_id', fOtro).eq('value', 'x').select('id').maybeSingle()
    expect(clash.data).toBeNull()
    // and a concurrent INSERT of the same (contact, field) fails instead of overwriting
    const dup = await db.from('contact_custom_values').insert({ contact_id: contactA, custom_field_id: fOtro, value: 'dup' }).select('id').single()
    expect(dup.error).not.toBeNull()
    expect(await psql(`select value from public.contact_custom_values where id='${by[fOtro].id}'`)).toBe('flow-wrote')
    pass('CF04', 'selective edit/delete, flow write preserved, duplicate insert rejected')
  })

  it('CF05: re-insert after delete and reload shows persisted values (Producto/Destino)', async () => {
    const db = agent()
    const ins = await db.from('contact_custom_values').insert({ contact_id: contactA, custom_field_id: fProducto, value: 'Fierro' }).select('id, custom_field_id, value').single()
    expect(ins.error).toBeNull()
    const { data } = await agent().from('contact_custom_values').select('custom_field_id, value').eq('contact_id', contactA)
    const m = Object.fromEntries((data ?? []).map((r) => [r.custom_field_id, r.value]))
    expect(m[fProducto]).toBe('Fierro'); expect(m[fDestino]).toBe('Cusco'); expect(m[fOtro]).toBe('flow-wrote')
    pass('CF05', 'values persist across a fresh client')
  })

  it('CF06 (finding): RLS does not pin custom_field_id to the contact account, nor protect phone from a direct API write', async () => {
    const db = agent()
    const foreignField = randomUUID()
    await psql(`insert into public.custom_fields (id,user_id,account_id,field_name,field_type) values ('${foreignField}','${UB}','${acctB}','Foreign','text')`)
    const ins = await db.from('contact_custom_values').insert({ contact_id: contactA, custom_field_id: foreignField, value: 'x' })
    const phone = await db.from('contacts').update({ phone: '+15609999999' }).eq('id', contactA).select('id').maybeSingle()
    console.log(`QA-RESULT CF06 INFO foreign_field_insert_error=${ins.error ? 'blocked' : 'ALLOWED'} direct_phone_update=${phone.data ? 'ALLOWED' : 'blocked'}`)
    await psql(`update public.contacts set phone='+15600000001' where id='${contactA}'`)
    await psql(`delete from public.contact_custom_values where custom_field_id='${foreignField}'`)
    expect(true).toBe(true)
  })

  void contactB
})
