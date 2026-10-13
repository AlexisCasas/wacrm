import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { runVersionedFlow } from './versioned-interpreter'
import { createSupabaseRunStore } from './versioned-store'
import { createSupabaseEffectStore } from './versioned-effects'
import { createMetaEffectSender } from './versioned-meta-sender'
import { MockMetaTransport } from './test-support/mock-meta-transport'
import { createPsql, lit } from './test-support/psql-client'
import { httpClient, raw, REST_URL, tokenFor, signJwt, type Raw } from './test-support/http-gate'

/**
 * F06 SECURITY GATE. Everything here goes over REAL HTTP to a REAL PostgREST (isolated `--internal` Docker network, no
 * published ports) backed by the QA PostgreSQL 17 with migrations 001..064, with JWTs signed by a synthetic QA-only secret.
 * Meta is never contacted: the only sender is the scripted MockMetaTransport. Skipped unless QA_REST_URL is set
 * (run through scripts/sql/run-security-gate.sh). Ids H01.. (HTTP/JWT), M01.. (multi-tenant), C01.. (contracts).
 */
const container = process.env.QA_PG_CONTAINER ?? ''
vi.setConfig({ testTimeout: 240_000 })
const pass = (id: string, detail: string) => console.log(`QA-RESULT ${id} PASS ${detail}`)

const UA = '10000000-0000-4000-8000-000000000001'
const UB = '10000000-0000-4000-8000-000000000002'
const ZERO = '00000000-0000-4000-8000-000000000000'
const SECRET_A = 'SECRETNAME-ALPHA'
const SECRET_B = 'SECRETNAME-BRAVO'

describe.skipIf(!REST_URL || !container)('F06 security gate over real PostgREST', () => {
  const psql = createPsql(container)
  const sql = (q: string) => psql.sql(q)
  const rows = <T = Record<string, any>>(q: string) => psql.rows<T>(q) // eslint-disable-line @typescript-eslint/no-explicit-any
  const anon = tokenFor('anon'); const userA = tokenFor('authenticated', UA); const userB = tokenFor('authenticated', UB); const svc = tokenFor('service_role')
  const leaks: string[] = []                        // every response body produced by a denied/failed call, scanned at the end

  interface Tenant { user: string; acct: string; callee: string; caller: string; runDone: string; runAmb: string; convDone: string; convAmb: string; effectsDone: string[]; effectAmb: string }
  const T = {} as { A: Tenant; B: Tenant }

  async function stack(sender: MockMetaTransport, client = httpClient(svc)) {
    return { runs: createSupabaseRunStore(client), effects: createSupabaseEffectStore(client),
      sender: createMetaEffectSender({ transport: sender, resolveContext: async () => ({ ok: true, phoneNumberId: '1234567890', accessToken: 'SYNTHETIC-TOKEN-NOT-REAL-9f3a', recipientPhone: '+37063949836' }) }) }
  }
  const go = async (p: Awaited<ReturnType<typeof stack>>, acct: string, runId: string, owner: string) =>
    runVersionedFlow(p.runs, { accountId: acct, runId, owner, messaging: { effects: p.effects, sender: p.sender } })

  /** md5 of every engine/Inbox table: proves a denied call changed nothing. */
  const snapshot = () => sql(`select md5(string_agg(x, '|' order by x)) from (
    select 'run' || md5(r::text) x from public.flow_runs r union all select 'eff' || md5(r::text) from public.flow_run_effects r
    union all select 'lnk' || md5(r::text) from public.flow_run_effect_messages r union all select 'frm' || md5(r::text) from public.flow_run_call_frames r
    union all select 'ver' || md5(r::text) from public.flow_versions r union all select 'flo' || md5(r::text) from public.flows r
    union all select 'evt' || md5(r::text) from public.flow_run_events r union all select 'msg' || md5(r::text) from public.messages r
    union all select 'cnv' || md5(r::text) from public.conversations r) s`)
  const note = (r: Raw) => { leaks.push(r.text); return r }

  /** Engine RPCs and a syntactically valid argument set for each (all must be service_role only). */
  const run0 = randomUUID(); const eff0 = randomUUID(); const att0 = randomUUID(); const flow0 = randomUUID()
  const ENGINE_RPC = (acct: string, run: string, eff: string): Record<string, Record<string, unknown>> => ({
    acquire_versioned_run_lease: { p_account_id: acct, p_run_id: run, p_owner: 'x', p_ttl_seconds: 60 },
    reclaim_versioned_run_lease: { p_account_id: acct, p_run_id: run, p_owner: 'x', p_ttl_seconds: 60 },
    renew_versioned_run_lease: { p_account_id: acct, p_run_id: run, p_owner: 'x', p_fencing_token: 1, p_ttl_seconds: 60 },
    release_versioned_run_lease: { p_account_id: acct, p_run_id: run, p_owner: 'x', p_fencing_token: 1 },
    create_versioned_flow_run: { p_account_id: acct, p_flow_id: flow0, p_contact_id: randomUUID(), p_conversation_id: null, p_vars: {} },
    commit_versioned_run_transition: { p_account_id: acct, p_run_id: run, p_owner: 'x', p_fencing_token: 1, p_expected_revision: 0, p_checkpoint: {}, p_status: 'active', p_end_reason: null, p_nodes_delta: 0, p_messages_delta: 0 },
    push_versioned_run_subflow: { p_account_id: acct, p_run_id: run, p_owner: 'x', p_fencing_token: 1, p_expected_revision: 0, p_call_node_key: 'c', p_return_node_key: 'r', p_target_flow_id: flow0 },
    pop_versioned_run_subflow: { p_account_id: acct, p_run_id: run, p_owner: 'x', p_fencing_token: 1, p_expected_revision: 0 },
    register_versioned_effect: { p_account_id: acct, p_run_id: run, p_owner: 'x', p_fencing_token: 1, p_expected_revision: 0, p_effect_type: 'send_message', p_request: { kind: 'text', text: 'x' } },
    claim_versioned_effect: { p_account_id: acct, p_run_id: run, p_owner: 'x', p_fencing_token: 1, p_effect_id: eff },
    settle_versioned_effect: { p_account_id: acct, p_run_id: run, p_owner: 'x', p_fencing_token: 1, p_effect_id: eff, p_attempt_id: att0, p_outcome: 'failed', p_provider_message_id: null, p_error_code: 'x' },
    defer_versioned_effect: { p_account_id: acct, p_run_id: run, p_owner: 'x', p_fencing_token: 1, p_effect_id: eff, p_attempt_id: att0, p_retry_after_seconds: 30, p_error_code: 'x' },
    recover_versioned_run_effects: { p_account_id: acct, p_run_id: run, p_owner: 'x', p_fencing_token: 1 },
    resolve_versioned_effect: { p_account_id: acct, p_run_id: run, p_owner: 'x', p_fencing_token: 1, p_effect_id: eff, p_resolution: 'not_sent', p_evidence: 'e', p_provider_message_id: null },
    commit_versioned_effect_step: { p_account_id: acct, p_run_id: run, p_owner: 'x', p_fencing_token: 1, p_expected_revision: 0, p_effect_id: eff, p_checkpoint: {} },
    reconcile_versioned_effect_messages: { p_account_id: acct, p_run_id: run, p_owner: 'x', p_fencing_token: 1 },
    repair_versioned_run_inbox: { p_account_id: acct, p_run_id: run },
    persist_versioned_effect_message: { p_effect_id: eff },
    try_persist_versioned_effect_message: { p_effect_id: eff },
  })

  beforeAll(async () => {
    // outage switch for the Inbox, per conversation (lets a confirmed effect exist WITHOUT its Inbox message)
    await sql(`create table if not exists public.qa_sg_outage (conversation_id uuid primary key);
      create or replace function public.qa_sg_outage_fn() returns trigger language plpgsql as $f$ begin
        if exists (select 1 from public.qa_sg_outage o where o.conversation_id = new.conversation_id) then raise exception 'qa inbox outage' using errcode = 'P9997'; end if; return new; end $f$;
      drop trigger if exists qa_sg_outage_trg on public.messages;
      create trigger qa_sg_outage_trg before insert on public.messages for each row execute function public.qa_sg_outage_fn();`)
    let n = 1_000_000 + Math.floor(Math.random() * 5_000_000)
    const service = httpClient(svc)
    for (const [key, user, secret] of [['A', UA, SECRET_A], ['B', UB, SECRET_B]] as const) {
      const acct = await sql(`select account_id from public.profiles where user_id='${user}'`)
      const callee = randomUUID(); const caller = randomUUID()
      const nodes = (j: unknown) => lit(j) + '::jsonb'
      await sql(`select public.qa_synth_flow('${callee}', ${nodes([
        { node_key: 'bstart', node_type: 'start', config: { next_node_key: 'bm1' } },
        { node_key: 'bm1', node_type: 'send_message', config: { text: 'Uno {{vars.name}}', next_node_key: 'bm2' } },
        { node_key: 'bm2', node_type: 'send_message', config: { text: 'Dos {{vars.name}}', next_node_key: 'bend' } },
        { node_key: 'bend', node_type: 'end' }])}, 'bstart', '${user}')`)
      await sql(`select public.qa_synth_flow('${caller}', ${nodes([
        { node_key: 'start', node_type: 'start', config: { next_node_key: 'call' } },
        { node_key: 'call', node_type: 'execute_flow', config: { target_flow_id: callee, next_node_key: 'fin' } },
        { node_key: 'fin', node_type: 'end' }])}, 'start', '${user}')`)
      const mk = async (tag: string) => {
        const contact = randomUUID(); const conv = randomUUID(); const phone = `+1557${String(++n).padStart(7, '0')}`
        await sql(`insert into public.contacts (id,user_id,account_id,phone,name) values ('${contact}','${user}','${acct}','${phone}','${tag} ${key}');
                   insert into public.conversations (id,user_id,account_id,contact_id) values ('${conv}','${user}','${acct}','${contact}')`)
        // creation goes through the HTTP RPC as service_role (C01 asserts its contract separately)
        const { data, error } = await service.rpc('create_versioned_flow_run', { p_account_id: acct, p_flow_id: caller, p_contact_id: contact, p_conversation_id: conv, p_vars: { name: secret } })
        if (error) throw new Error(`create run ${key}/${tag}: ${error.code} ${error.message}`)
        return { runId: (Array.isArray(data) ? data[0] : data).flow_run_id as string, conv }
      }
      // (1) a COMPLETED run whose two confirmed messages never reached the Inbox
      const done = await mk('done')
      await sql(`insert into public.qa_sg_outage values ('${done.conv}')`)
      const t1 = new MockMetaTransport()
      expect(await go(await stack(t1), acct, done.runId, 'fixture')).toMatchObject({ kind: 'completed' })
      expect(t1.requests).toHaveLength(2)
      // (2) a run parked INSIDE the subflow (call frame present) on an ambiguous effect
      const amb = await mk('amb')
      const t2 = new MockMetaTransport().script('lost_response')
      expect(await go(await stack(t2), acct, amb.runId, 'fixture')).toMatchObject({ kind: 'awaiting_effect_resolution' })
      const eD = await rows<{ id: string }>(`select id from public.flow_run_effects where flow_run_id='${done.runId}' order by occurrence_revision`)
      const eA = await rows<{ id: string }>(`select id from public.flow_run_effects where flow_run_id='${amb.runId}'`)
      T[key] = { user, acct, callee, caller, runDone: done.runId, runAmb: amb.runId, convDone: done.conv, convAmb: amb.conv, effectsDone: eD.map((e) => e.id), effectAmb: eA[0].id }
    }
    expect(await sql(`select count(*) from public.flow_run_effect_messages`)).toBe('0')
  })
  afterAll(async () => {
    const all = leaks.join('\n')
    expect(all).not.toContain(SECRET_A); expect(all).not.toContain(SECRET_B)
    expect(all).not.toContain('SYNTHETIC-TOKEN'); expect(all).not.toContain(process.env.QA_JWT_SECRET ?? 'no-secret')
    await sql(`drop trigger if exists qa_sg_outage_trg on public.messages; drop function if exists public.qa_sg_outage_fn(); drop table if exists public.qa_sg_outage`)
  })

  // ===================================================================== H: authentication (real HTTP)
  it('H01-H05: no token, invalid / expired / foreign-signed / wrong-role JWTs never reach data or the engine', async () => {
    const before = await snapshot()
    const read = '/flow_runs?select=id&limit=5'; const rpc = '/rpc/repair_versioned_run_inbox'
    const args = { p_account_id: T.A.acct, p_run_id: T.A.runDone }
    // H01 no token: PostgREST treats it as the anon role
    const r0 = note(await raw('GET', read)); expect(r0.status).toBe(200); expect(r0.json).toEqual([])                  // anon holds SELECT but RLS shows nothing
    const r1 = note(await raw('POST', rpc, { body: args })); expect(r1.status).toBeGreaterThanOrEqual(400); expect(r1.status).toBeLessThan(500)
    pass('H01', `no Authorization header: table read -> 200 [] (RLS), engine RPC -> HTTP ${r1.status} ${r1.json?.code ?? ''}`)
    // H02 invalid tokens
    const bad = ['garbage', 'a.b.c', signJwt({ role: 'service_role' }, { secret: 'a-different-secret-that-is-long-enough-32b' }), tokenFor('service_role').slice(0, -3) + 'AAA']
    const st: number[] = []
    for (const t of bad) for (const [m, p, b] of [['GET', read, undefined], ['POST', rpc, args]] as const) {
      const r = note(await raw(m, p, { token: t, body: b })); st.push(r.status); expect(r.status, `${m} ${p} ${t.slice(0, 10)}`).toBe(401)
    }
    pass('H02', `invalid / foreign-signed / tampered JWTs: ${st.length} requests, all HTTP 401`)
    // H03 expired
    const exp = signJwt({ role: 'service_role', exp: Math.floor(Date.now() / 1000) - 60 })
    const re = note(await raw('POST', rpc, { token: exp, body: args })); expect(re.status).toBe(401); expect(re.text).toMatch(/expired/i)
    const rg = note(await raw('GET', read, { token: signJwt({ role: 'authenticated', sub: UA, exp: Math.floor(Date.now() / 1000) - 3600 }) })); expect(rg.status).toBe(401)
    pass('H03', 'expired JWT (service_role RPC and authenticated read): HTTP 401 "JWT expired"')
    // PostgREST (jose) tolerates a 30 s clock skew on exp: measured, documented, not a defect
    const skew = async (ago: number) => (await raw('GET', read, { token: signJwt({ role: 'authenticated', sub: UA, exp: Math.floor(Date.now() / 1000) - ago }) })).status
    expect([await skew(10), await skew(60), await skew(600)]).toEqual([200, 401, 401])
    pass('H03b', 'JWT expired 10 s ago is still accepted (PostgREST allows 30 s of clock skew); 60 s and 600 s ago: HTTP 401')
    // H04 valid signature, wrong / privileged / missing role
    const roles = ['nonexistent_role', 'supabase_admin', 'postgres', 'authenticator', 'pg_read_all_data', '']
    for (const role of roles) {
      const t = signJwt({ role, sub: UA })
      for (const [m, p, b] of [['GET', read, undefined], ['POST', rpc, args]] as const) {
        const r = note(await raw(m, p, { token: t, body: b }))
        expect(r.status, `role=${role || '(empty)'} ${m}`).toBeGreaterThanOrEqual(400)
      }
    }
    const noRole = note(await raw('POST', rpc, { token: signJwt({ sub: UA }), body: args }))               // no role claim: falls back to anon
    expect(noRole.status).toBeGreaterThanOrEqual(400)
    pass('H04', `validly-signed JWT with role ${roles.map((r) => r || '(empty)').join(' / ')} or no role claim: every table read and engine RPC rejected (HTTP >= 400)`)
    // H05 anon JWT against every engine RPC
    const seen = new Set<number>()
    for (const [fn, a] of Object.entries(ENGINE_RPC(T.A.acct, T.A.runDone, T.A.effectAmb))) { const r = note(await raw('POST', `/rpc/${fn}`, { token: anon, body: a })); seen.add(r.status); expect(r.status, fn).toBeGreaterThanOrEqual(400) }
    pass('H05', `anon JWT: all ${Object.keys(ENGINE_RPC('', '', '')).length} engine RPCs rejected (HTTP ${[...seen].join('/')})`)
    expect(await snapshot()).toBe(before)
    pass('H05b', 'database snapshot (runs, effects, links, frames, versions, flows, events, messages, conversations) identical after every rejected request')
  })

  it('H06-H08: authenticated users can call no engine RPC; service_role JWT can; unknown RPCs and rejected calls change nothing', async () => {
    const before = await snapshot(); const seen = new Set<number>()
    for (const [name, tk] of [['A', userA], ['B', userB]] as const) {
      const t = T[name as 'A' | 'B']
      for (const [fn, a] of Object.entries(ENGINE_RPC(t.acct, t.runDone, t.effectAmb))) { const r = note(await raw('POST', `/rpc/${fn}`, { token: tk, body: a })); seen.add(r.status); expect(r.status, `${name}:${fn}`).toBeGreaterThanOrEqual(400) }
    }
    pass('H06', `authenticated A and B (own account/run ids): all ${Object.keys(ENGINE_RPC('', '', '')).length} engine RPCs rejected (HTTP ${[...seen].join('/')}) - they are service_role only`)
    const unknown = note(await raw('POST', '/rpc/does_not_exist_at_all', { token: svc, body: {} }))
    expect(unknown.status).toBe(404); expect(unknown.json?.code).toBe('PGRST202')
    pass('H07', `RPC that does not exist: HTTP ${unknown.status} ${unknown.json.code}`)
    expect(await snapshot()).toBe(before)
    // H08 the same JWT with service_role works (read-only engine RPC on a terminal run: nothing to repair twice)
    const ok = await raw('POST', '/rpc/repair_versioned_run_inbox', { token: svc, body: { p_account_id: T.A.acct, p_run_id: T.A.runAmb } })
    expect(ok.status).toBe(200); expect(Array.isArray(ok.json)).toBe(true)
    pass('H08', 'service_role JWT reaches the engine RPC (HTTP 200, array result)')
  })

  it('H09: manipulated claims cannot elevate privileges (account_id / role / app_metadata inside a validly signed authenticated JWT)', async () => {
    const forged = [
      { account_id: T.B.acct }, { app_metadata: { account_id: T.B.acct, role: 'service_role' } }, { user_metadata: { account_id: T.B.acct, role: 'service_role' } },
      { role: 'authenticated', 'https://hasura.io/jwt/claims': { 'x-hasura-role': 'service_role' } }, { is_service_role: true, account_role: 'owner', acct: T.B.acct },
    ]
    for (const claims of forged) {
      const tk = tokenFor('authenticated', UA, claims)
      const runs = note(await raw('GET', '/flow_runs?select=id,account_id', { token: tk })); expect(runs.status).toBe(200)
      expect((runs.json as Array<{ account_id: string }>).every((r) => r.account_id === T.A.acct), JSON.stringify(claims)).toBe(true)
      expect((runs.json as unknown[]).length).toBeGreaterThan(0)
      const rpc = note(await raw('POST', '/rpc/repair_versioned_run_inbox', { token: tk, body: { p_account_id: T.B.acct, p_run_id: T.B.runDone } })); expect(rpc.status).toBeGreaterThanOrEqual(400)
    }
    // sub of another user can only be minted by someone holding the secret: a token for B sees B and not A
    const asB = await raw('GET', '/flow_runs?select=account_id', { token: userB })
    expect((asB.json as Array<{ account_id: string }>).every((r) => r.account_id === T.B.acct)).toBe(true)
    pass('H09', `${forged.length} JWTs carrying forged account_id / role / app_metadata / hasura claims: still only the account of their sub is visible, engine RPC denied`)
  })

  // ===================================================================== M: multi-tenant isolation (real HTTP)
  const TABLES = ['flow_runs', 'flow_versions', 'flow_run_call_frames', 'flow_run_events', 'messages', 'conversations', 'flows', 'flow_nodes']
  it('M01-M02: reads are scoped to the caller account; the ledger tables are not readable by users at all', async () => {
    for (const [me, other, tk] of [[T.A, T.B, userA], [T.B, T.A, userB]] as const) {
      const label = me === T.A ? 'A' : 'B'
      const counts: string[] = []
      for (const t of TABLES) {
        const own = await raw('GET', `/${t}?select=*&limit=1000`, { token: tk }); expect(own.status, `${label} ${t}`).toBe(200)
        const text = JSON.stringify(own.json)
        expect(text, `${label} ${t} leaks the other account`).not.toContain(other.acct)
        for (const secret of [other === T.A ? SECRET_A : SECRET_B]) expect(text, `${label} ${t}`).not.toContain(secret)
        counts.push(`${t}:${(own.json as unknown[]).length}`)
      }
      // direct lookups of the other account's rows by primary key, through every readable table
      const probes: Array<[string, string, string]> = [['flow_runs', 'id', other.runDone], ['flow_runs', 'id', other.runAmb], ['conversations', 'id', other.convDone], ['flow_versions', 'flow_id', other.caller],
        ['flow_run_call_frames', 'flow_run_id', other.runAmb], ['flow_run_events', 'flow_run_id', other.runDone], ['messages', 'conversation_id', other.convDone], ['flows', 'id', other.callee]]
      for (const [t, col, v] of probes) { const r = await raw('GET', `/${t}?${col}=eq.${v}&select=*`, { token: tk }); expect(r.status).toBe(200); expect(r.json, `${label} ${t}.${col}`).toEqual([]) }
      // own rows ARE visible (isolation must not be achieved by returning nothing)
      const mine = await raw('GET', `/flow_runs?id=eq.${me.runAmb}&select=id,account_id,versioned_revision`, { token: tk }); expect(mine.json).toHaveLength(1)
      const frames = await raw('GET', `/flow_run_call_frames?flow_run_id=eq.${me.runAmb}&select=*`, { token: tk }); expect((frames.json as unknown[]).length).toBeGreaterThanOrEqual(1)
      pass(`M01${label}`, `user ${label}: ${counts.join(', ')} rows visible, none from the other account; PK/FK lookups of ${probes.length} foreign rows return []; own run, version and call frame are visible`)
    }
    for (const t of ['flow_run_effects', 'flow_run_effect_messages']) for (const tk of [userA, userB, anon]) {
      const r = note(await raw('GET', `/${t}?select=*`, { token: tk })); expect(r.status, t).toBeGreaterThanOrEqual(400); expect(r.json?.code).toBe('42501')
    }
    const svcLedger = await raw('GET', `/flow_run_effects?select=id,account_id&limit=100`, { token: svc }); expect(svcLedger.status).toBe(200)
    expect((svcLedger.json as unknown[]).length).toBeGreaterThanOrEqual(5)
    pass('M02', 'flow_run_effects and flow_run_effect_messages: permission denied (42501) for anon, A and B; only service_role reads the ledger')
  })

  it('M03-M04: users cannot create, change or delete engine, flow or Inbox rows of their own account or of the other one', async () => {
    const before = await snapshot()
    const probes: Array<[string, string]> = [['flow_runs', `id=eq.${T.A.runAmb}`], ['flow_runs', `id=eq.${T.B.runAmb}`], ['flow_versions', `flow_id=eq.${T.A.caller}`], ['flow_versions', `flow_id=eq.${T.B.caller}`],
      ['flow_run_call_frames', `flow_run_id=eq.${T.A.runAmb}`], ['flow_run_call_frames', `flow_run_id=eq.${T.B.runAmb}`], ['flow_run_events', `flow_run_id=eq.${T.B.runDone}`],
      ['flow_run_effects', `id=eq.${T.B.effectAmb}`], ['flow_run_effects', `id=eq.${T.A.effectAmb}`], ['flow_run_effect_messages', `flow_run_id=eq.${T.B.runDone}`]]
    const code: string[] = []
    for (const tk of [userA, userB, anon]) for (const [t, filter] of probes) {
      const patch = note(await raw('PATCH', `/${t}?${filter}`, { token: tk, body: t === 'flow_run_effects' ? { state: 'confirmed' } : t === 'flow_versions' ? { definition: {} } : { status: 'completed' }, headers: { prefer: 'return=representation' } }))
      const del = note(await raw('DELETE', `/${t}?${filter}`, { token: tk, headers: { prefer: 'return=representation' } }))
      for (const r of [patch, del]) expect(r.status === 200 ? r.json : [], `${t} ${filter}`).toEqual([])        // either refused or zero rows touched
      code.push(`${patch.status}/${del.status}`)
    }
    // inserts: a forged run / frame / effect / version, in both accounts
    for (const tk of [userA, userB, anon]) for (const [t, body] of [
      ['flow_runs', { flow_id: T.A.caller, account_id: T.A.acct, user_id: UA, contact_id: ZERO, status: 'active' }], ['flow_runs', { flow_id: T.B.caller, account_id: T.B.acct, user_id: UB, contact_id: ZERO, status: 'active' }],
      ['flow_run_effects', { account_id: T.A.acct, flow_run_id: T.A.runAmb }], ['flow_run_call_frames', { account_id: T.B.acct, flow_run_id: T.B.runAmb }], ['flow_versions', { flow_id: T.A.caller, account_id: T.A.acct, definition: {} }]] as const) {
      const r = note(await raw('POST', `/${t}`, { token: tk, body })); expect(r.status, `${t} insert`).toBeGreaterThanOrEqual(400)
    }
    expect(await snapshot()).toBe(before)
    pass('M03', `PATCH / DELETE on ${probes.length} engine tables x A, B, anon (own and foreign rows) and forged INSERTs: refused or 0 rows; database snapshot identical (statuses ${[...new Set(code)].join(', ')})`)
    // Inbox: A may not write into B's conversation, but may into its own (the existing Inbox policy), and may not rewrite a bot message of the engine in B
    const ins = note(await raw('POST', '/messages', { token: userA, body: { conversation_id: T.B.convDone, sender_type: 'agent', content_type: 'text', content_text: 'forged' } })); expect(ins.status).toBeGreaterThanOrEqual(400)
    const upd = await raw('PATCH', `/conversations?id=eq.${T.B.convDone}`, { token: userA, body: { last_message_text: 'forged' }, headers: { prefer: 'return=representation' } }); expect(upd.status === 200 ? upd.json : []).toEqual([])
    expect(await snapshot()).toBe(before)
    pass('M04', 'A cannot insert into B\'s messages nor update B\'s conversation (RLS: refused / 0 rows), database unchanged')
  })

  it('M05: service_role bypasses RLS, so the account guard is the ENGINE\'s (account_id, run_id) binding plus the application layer', async () => {
    // (a) the SQL layer binds every RPC to the (account, run) pair: the right run under the wrong account is "not found" and reveals nothing
    const before = await snapshot(); const bodies: string[] = []
    for (const [fn, a] of Object.entries(ENGINE_RPC(T.A.acct, T.B.runAmb, T.B.effectAmb))) {
      if (['create_versioned_flow_run', 'persist_versioned_effect_message', 'try_persist_versioned_effect_message'].includes(fn)) continue
      const r = note(await raw('POST', `/rpc/${fn}`, { token: svc, body: a })); bodies.push(r.text)
      expect(r.status, fn).toBeGreaterThanOrEqual(400)
      // two RPCs validate their (synthetic, empty) checkpoint before they look the run up; both refuse without revealing anything
      if (['commit_versioned_run_transition', 'commit_versioned_effect_step'].includes(fn)) expect(['P0002', '22023'], fn).toContain(r.json?.code)
      else { expect(r.json?.code, fn).toBe('P0002'); expect(r.json?.message, fn).toBe('versioned run not found') }
    }
    for (const b of bodies) { expect(b).not.toContain(T.B.acct); expect(b).not.toContain(T.B.runAmb); expect(b).not.toContain(SECRET_B) }
    expect(await snapshot()).toBe(before)
    pass('M05a', `service_role with A's account id and B's run id: ${bodies.length} RPCs all -> P0002 "versioned run not found"; the error names neither account nor run nor content; database unchanged`)
    // (b) ...but a caller that supplies the CORRECT pair succeeds: the engine trusts the account it is given
    const okB = await raw('POST', '/rpc/repair_versioned_run_inbox', { token: svc, body: { p_account_id: T.B.acct, p_run_id: T.B.runAmb } }); expect(okB.status).toBe(200)
    pass('M05b', 'FINDING (by design, not a defect): service_role + B\'s own (account, run) pair is accepted. A server must derive the account from the authenticated user (getCurrentAccount / profiles) and never from the request; the database cannot enforce it for service_role')
  })

  // ===================================================================== C: contracts through the real client
  it('C01-C03: PostgREST/supabase-js contracts: RETURNS TABLE, BIGINT, SQLSTATE, multi-row', async () => {
    const service = httpClient(svc)
    // C01 RETURNS TABLE -> array of rows with typed columns
    const lease = await service.rpc('acquire_versioned_run_lease', { p_account_id: T.A.acct, p_run_id: T.A.runAmb, p_owner: 'contract', p_ttl_seconds: 30 })
    expect(lease.error).toBeNull(); expect(Array.isArray(lease.data)).toBe(true); expect(lease.data).toHaveLength(1)
    const row = lease.data![0]
    expect(Object.keys(row).sort()).toEqual(['acquired', 'fencing_token', 'lease_expires_at', 'reason', 'revision'])
    expect(typeof row.acquired).toBe('boolean'); expect(typeof row.fencing_token).toBe('number'); expect(typeof row.revision).toBe('number')
    pass('C01', `RETURNS TABLE serialises as an array of one row with exact columns; boolean -> ${typeof row.acquired}, integer -> ${typeof row.fencing_token}, bigint (revision) -> ${typeof row.revision} (${row.reason ?? 'acquired'})`)
    // C02 BIGINT: a revision past 2^53 would lose precision as a JSON number; the engine's own parser must refuse instead of rounding
    const big = await rows<{ versioned_revision: string }>(`select versioned_revision::text from public.flow_runs where id='${T.B.runAmb}'`)
    expect(Number.isSafeInteger(Number(big[0].versioned_revision))).toBe(true)
    const viaHttp = await raw('GET', `/flow_runs?id=eq.${T.B.runAmb}&select=versioned_revision`, { token: svc })
    expect(viaHttp.json[0].versioned_revision).toBe(Number(big[0].versioned_revision))
    pass('C02', 'bigint columns arrive as JSON numbers equal to the database value (safe-integer range; revisions are small by construction)')
    // C03 SQLSTATE + status mapping
    const nf = await service.rpc('repair_versioned_run_inbox', { p_account_id: T.A.acct, p_run_id: randomUUID() })
    expect(nf.error?.code).toBe('P0002'); const nullArg = await service.rpc('repair_versioned_run_inbox', { p_account_id: null, p_run_id: T.A.runDone }); expect(nullArg.error?.code).toBe('22023')
    const bad = await raw('POST', '/rpc/repair_versioned_run_inbox', { token: svc, body: { p_account_id: 'not-a-uuid', p_run_id: T.A.runDone } }); expect(bad.json?.code).toBe('22P02'); expect(bad.status).toBe(400)
    const missing = await raw('POST', '/rpc/repair_versioned_run_inbox', { token: svc, body: { p_account_id: T.A.acct } }); expect(missing.json?.code).toBe('PGRST202')
    pass('C03', `SQLSTATE reaches the client intact: P0002 (HTTP ${(await raw('POST', '/rpc/repair_versioned_run_inbox', { token: svc, body: { p_account_id: T.A.acct, p_run_id: randomUUID() } })).status}), 22023, 22P02 (HTTP 400), wrong argument list -> PGRST202`)
  })

  it('C04-C06: the TypeScript stores work unchanged over HTTP: ledger read, Inbox repair of terminal runs, cross-account refusal, no resend', async () => {
    const t = new MockMetaTransport(); const p = await stack(t)
    // C04 ledger via the store (service) and refusal for a user client
    const eff = await p.effects.loadEffectAt(T.A.acct, T.A.runAmb, (await p.runs.loadRun(T.A.acct, T.A.runAmb))!.versioned_revision)
    expect(eff).toMatchObject({ id: T.A.effectAmb, state: 'ambiguous' })
    const userEffects = createSupabaseEffectStore(httpClient(userA))
    await expect(userEffects.loadEffectAt(T.A.acct, T.A.runAmb, 0)).rejects.toMatchObject({ code: '42501' })
    pass('C04', 'effect store reads the ambiguous ledger row over HTTP with a service_role client; the same call with an authenticated user JWT is denied with 42501')
    // C05 run store with a USER client: RLS scopes it, a foreign run does not exist
    const mine = createSupabaseRunStore(httpClient(userA))
    expect(await mine.loadRun(T.A.acct, T.A.runAmb)).toMatchObject({ id: T.A.runAmb })
    expect(await mine.loadRun(T.B.acct, T.B.runAmb)).toBeNull(); expect(await mine.loadRun(T.A.acct, T.B.runAmb)).toBeNull()
    pass('C05', 'createSupabaseRunStore with user A\'s JWT: loads A\'s run, returns null for B\'s run under either account id (RLS), and the leased/ledger RPCs are unavailable to it')
    // C06 Inbox repair of the terminal run over HTTP; foreign pair refused; idempotent; run untouched; Meta never called again
    const before = JSON.stringify((await rows(`select * from public.flow_runs where id='${T.A.runDone}'`))[0]); const effBefore = JSON.stringify(await rows(`select * from public.flow_run_effects where flow_run_id='${T.A.runDone}' order by occurrence_revision`))
    await expect(p.effects.repairInbox(T.B.acct, T.A.runDone)).rejects.toMatchObject({ code: 'P0002' })
    await expect(p.effects.repairInbox(T.A.acct, T.B.runDone)).rejects.toMatchObject({ code: 'P0002' })
    await sql(`delete from public.qa_sg_outage`)                                     // the Inbox is back
    const rep = await p.effects.repairInbox(T.A.acct, T.A.runDone)
    expect(rep.map((r) => r.outcome)).toEqual(['created', 'created']); expect(rep.map((r) => r.effectId)).toEqual(T.A.effectsDone)      // multi-row RETURNS TABLE, in order
    expect((await p.effects.repairInbox(T.A.acct, T.A.runDone)).map((r) => r.outcome)).toEqual(['already_persisted', 'already_persisted'])
    const msgs = await rows<{ content_text: string; created_at: string }>(`select content_text, created_at from public.messages where conversation_id='${T.A.convDone}' order by created_at`)
    expect(msgs.map((m) => m.content_text)).toEqual([`Uno ${SECRET_A}`, `Dos ${SECRET_A}`])
    expect(JSON.stringify((await rows(`select * from public.flow_runs where id='${T.A.runDone}'`))[0])).toBe(before)
    expect(JSON.stringify(await rows(`select * from public.flow_run_effects where flow_run_id='${T.A.runDone}' order by occurrence_revision`))).toBe(effBefore)
    expect(await sql(`select count(*) from public.messages where conversation_id='${T.B.convDone}'`)).toBe('0')       // B's lost Inbox untouched by A's repair
    expect(t.requests).toHaveLength(0)
    pass('C06', 'repair_versioned_run_inbox over HTTP: foreign (account, run) pairs -> P0002 in both directions; A\'s two lost messages recreated in order (multi-row result), second call already_persisted, run and ledger byte-identical, B untouched, 0 requests to Meta')
  })

  it('C07: schema-cache reload: a function added or replaced by migration is invisible until the cache reloads; a revoked one disappears', async () => {
    const call = (a: Record<string, unknown> = {}) => raw('POST', '/rpc/qa_sg_probe', { token: svc, body: a })
    expect((await call()).status).toBe(404)
    await sql(`create function public.qa_sg_probe() returns table (v int) language sql as $$ select 1 $$; revoke all on function public.qa_sg_probe() from public, anon, authenticated; grant execute on function public.qa_sg_probe() to service_role`)
    const waitFor = async (pred: (r: Raw) => boolean, a: Record<string, unknown> = {}) => { let r = await call(a); for (let i = 0; i < 40 && !pred(r); i++) { await new Promise((s) => setTimeout(s, 250)); r = await call(a) } return r }
    expect((await call()).status).toBe(404)                                           // added but the cache has not been reloaded: not callable yet
    await sql(`notify pgrst, 'reload schema'`)
    const added = await waitFor((r) => r.status === 200); expect(added.status).toBe(200); expect(added.json).toEqual([{ v: 1 }])
    expect(note(await raw('POST', '/rpc/qa_sg_probe', { token: userA, body: {} })).status).toBeGreaterThanOrEqual(400)    // never exposed to users
    // replaced with a different signature/shape
    await sql(`drop function public.qa_sg_probe(); create function public.qa_sg_probe(p_x int) returns table (v int, w text) language sql as $$ select p_x, 'x'::text $$; revoke all on function public.qa_sg_probe(int) from public, anon, authenticated; grant execute on function public.qa_sg_probe(int) to service_role`)
    await sql(`notify pgrst, 'reload schema'`)
    const replaced = await waitFor((r) => r.status === 200 && r.json?.[0]?.w === 'x', { p_x: 7 }); expect(replaced.json).toEqual([{ v: 7, w: 'x' }])
    expect((await call()).status).toBe(404)                                            // old zero-argument form is gone
    // revoked: after the reload the function is not reachable by service_role either
    await sql(`revoke execute on function public.qa_sg_probe(int) from service_role`); await sql(`notify pgrst, 'reload schema'`)
    const revoked = await waitFor((r) => r.status >= 400, { p_x: 7 }); expect(revoked.status).toBeGreaterThanOrEqual(400)
    await sql(`drop function public.qa_sg_probe(int)`); await sql(`notify pgrst, 'reload schema'`)
    pass('C07', 'new function: 404 before NOTIFY pgrst "reload schema", 200 after; replaced signature: new shape served, old form 404; revoked: rejected after reload; users never saw it')
  })

  it('C08: concurrency over HTTP: two processes on one run send exactly once; a second pass over an ambiguous run never resends', async () => {
    const contact = randomUUID(); const conv = randomUUID(); const phone = `+1558${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`
    await sql(`insert into public.contacts (id,user_id,account_id,phone,name) values ('${contact}','${UA}','${T.A.acct}','${phone}','conc');
               insert into public.conversations (id,user_id,account_id,contact_id) values ('${conv}','${UA}','${T.A.acct}','${contact}')`)
    const created = await httpClient(svc).rpc('create_versioned_flow_run', { p_account_id: T.A.acct, p_flow_id: T.A.caller, p_contact_id: contact, p_conversation_id: conv, p_vars: { name: SECRET_A } })
    const runId = created.data![0].flow_run_id as string
    const t = new MockMetaTransport()
    const [r1, r2] = await Promise.all([go(await stack(t), T.A.acct, runId, 'w1'), go(await stack(t), T.A.acct, runId, 'w2')])
    const kinds = [r1.kind, r2.kind]
    expect(kinds).toContain('completed'); expect(t.requests).toHaveLength(2)                // the callee sends 2 messages, each exactly once
    expect(await rows(`select state from public.flow_run_effects where flow_run_id='${runId}' order by occurrence_revision`)).toEqual([{ state: 'confirmed' }, { state: 'confirmed' }])
    expect(await sql(`select count(*) from public.messages where conversation_id='${conv}'`)).toBe('2')
    // the ambiguous run of A: any number of passes, from any owner, never reaches the transport
    const t3 = new MockMetaTransport()
    for (const owner of ['x1', 'x2', 'x3']) expect(await go(await stack(t3), T.A.acct, T.A.runAmb, owner)).toMatchObject({ kind: expect.stringMatching(/awaiting_effect_resolution|lease/) })
    expect(t3.requests).toHaveLength(0)
    pass('C08', `two simultaneous HTTP workers on one run (${kinds.join(' / ')}): 2 requests to the simulated Meta for 2 messages, 2 confirmed effects, 2 Inbox rows; three later passes over the ambiguous run: 0 requests`)
  })

  // ===================================================================== H10: deployment precondition (fails closed)
  it('H10: with the legacy auth.uid() (reads only request.jwt.claim.sub) PostgREST 14 yields NO rows for users: it fails closed, never open', async () => {
    const mineSql = `select (select count(*) from public.flow_runs) `
    void mineSql
    const read = async (tk: string) => (await raw('GET', '/flow_runs?select=id', { token: tk })).json as unknown[]
    expect((await read(userA)).length).toBeGreaterThan(0)
    const modern = await sql(`select pg_get_functiondef('auth.uid'::regproc)`)
    try {
      await sql(`create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$`)
      expect(await read(userA)).toEqual([]); expect(await read(userB)).toEqual([])        // closed: no data for anyone, and not an error
      const patch = await raw('PATCH', `/flow_runs?id=eq.${T.A.runAmb}`, { token: userA, body: { status: 'completed' }, headers: { prefer: 'return=representation' } })
      expect(patch.status === 200 ? patch.json : []).toEqual([])                          // 0 rows (RLS) or permission denied (migration 066): never a change
      expect(await sql(`select status from public.flow_runs where id='${T.A.runAmb}'`)).toBe('active')
    } finally { await sql(modern.replace(/^CREATE OR REPLACE FUNCTION/i, 'CREATE OR REPLACE FUNCTION')) }
    expect((await read(userA)).length).toBeGreaterThan(0)
    pass('H10', 'legacy auth.uid() body (claim.sub GUC only) under PostgREST 14: users see 0 rows and change 0 rows (fail-closed); restoring the claims-aware body brings their data back. Precondition for credential integration: verify auth.uid() of the target database')
  })
})
