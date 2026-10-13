import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createPsql } from './test-support/psql-client'
import { raw, REST_URL, tokenFor } from './test-support/http-gate'

/**
 * F06 SECURITY GATE, regression tests for the permission defects it found (real PostgREST over HTTP + catalog/SQL probes).
 * Ids G01.. . Skipped unless QA_REST_URL is set (scripts/sql/run-security-gate.sh).
 */
const container = process.env.QA_PG_CONTAINER ?? ''
vi.setConfig({ testTimeout: 240_000 })
const pass = (id: string, detail: string) => console.log(`QA-RESULT ${id} PASS ${detail}`)
const UA = '10000000-0000-4000-8000-000000000001'
const UB = '10000000-0000-4000-8000-000000000002'
const FLOW_A = '50000000-0000-4000-8000-000000000001'

describe.skipIf(!REST_URL || !container)('F06 security gate: permission defects (regressions)', () => {
  const psql = createPsql(container)
  const sql = (q: string) => psql.sql(q)
  const userA = tokenFor('authenticated', UA); const userB = tokenFor('authenticated', UB); const svc = tokenFor('service_role'); const anon = tokenFor('anon')
  const definition = (flow: string) => sql(`select jsonb_build_object('flow', jsonb_build_object('id', f.id, 'name', f.name, 'description', f.description, 'trigger_type', f.trigger_type,
    'trigger_config', f.trigger_config, 'entry_node_id', f.entry_node_id, 'fallback_policy', f.fallback_policy),
    'nodes', coalesce((select jsonb_agg(jsonb_build_object('node_key', n.node_key, 'node_type', n.node_type, 'config', n.config, 'position_x', n.position_x, 'position_y', n.position_y) order by n.node_key)
      from public.flow_nodes n where n.flow_id = f.id), '[]'::jsonb)) from public.flows f where f.id = '${flow}'`)
  const versions = (flow: string) => sql(`select count(*) from public.flow_versions where flow_id='${flow}'`)

  it('G01: a logged-in user cannot publish a flow through PostgREST (publish_flow_version is service_role only), whoever they claim to be', async () => {
    const before = await versions(FLOW_A)
    const args = async (publishedBy: string) => ({
      p_flow_id: FLOW_A, p_expected_updated_at: await sql(`select updated_at from public.flows where id='${FLOW_A}'`),
      p_published_by: publishedBy, p_expected_definition: JSON.parse(await definition(FLOW_A)) })
    // B (another account) with ALL the inputs right, naming A's owner as the publisher; A itself; anon
    const attempts: Array<[string, string, string]> = [['B posing as A', userB, UA], ['B as itself', userB, UB], ['A as itself', userA, UA], ['anon', anon, UA]]
    const seen: number[] = []
    for (const [label, tk, by] of attempts) {
      const r = await raw('POST', '/rpc/publish_flow_version', { token: tk, body: await args(by) })
      seen.push(r.status); expect(r.status, label).toBeGreaterThanOrEqual(400)
    }
    expect(await versions(FLOW_A)).toBe(before)
    expect(await sql(`select has_function_privilege('authenticated','public.publish_flow_version(uuid,timestamptz,uuid,jsonb)','EXECUTE')`)).toBe('f')
    // the one legitimate caller (the activate route uses supabaseAdmin) keeps working
    const ok = await raw('POST', '/rpc/publish_flow_version', { token: svc, body: await args(UA) })
    expect(ok.status).toBe(200); expect(await versions(FLOW_A)).toBe(String(Number(before) + 1))
    pass('G01', `publish_flow_version over HTTP with every input correct: B posing as A's owner, B, A and anon are all refused (HTTP ${seen.join('/')}), no version is created; service_role (what the activate route uses) still publishes (HTTP 200)`)
  })

  it('G02: internal engine helpers are not callable through PostgREST by anon or authenticated users', async () => {
    const before = await sql(`select count(*) from public.flow_run_events`)
    const calls: Array<[string, Record<string, unknown>]> = [
      ['lock_versioned_run', { p_account_id: randomUUID(), p_run_id: randomUUID() }],
      ['versioned_run_gate', { p_run: { id: randomUUID() }, p_owner: 'x', p_token: 1 }],
    ]
    const seen: number[] = []
    for (const [fn, a] of calls) for (const tk of [anon, userA, userB]) { const r = await raw('POST', `/rpc/${fn}`, { token: tk, body: a }); seen.push(r.status); expect(r.status, fn).toBeGreaterThanOrEqual(400); expect(r.json?.code, fn).not.toBe('P0002') }
    expect(await sql(`select count(*) from public.flow_run_events`)).toBe(before)
    for (const sig of ['lock_versioned_run(uuid,uuid)', 'versioned_run_gate(flow_runs,text,integer)'])
      for (const role of ['anon', 'authenticated']) expect(await sql(`select has_function_privilege('${role}','public.${sig}','EXECUTE')`), `${role} ${sig}`).toBe('f')
    expect(await sql(`select has_function_privilege('service_role','public.lock_versioned_run(uuid,uuid)','EXECUTE')`)).toBe('t')
    pass('G02', `lock_versioned_run and versioned_run_gate: anon / A / B rejected over HTTP (${[...new Set(seen)].join('/')}), no EXECUTE for anon or authenticated, service_role keeps it`)
  })

  it('G03: users keep READ access to the engine tables they need and nothing else (no write, TRUNCATE, TRIGGER or REFERENCES privilege)', async () => {
    const privs = async (table: string, role: string) => (await sql(`select coalesce(string_agg(p, ',' order by p), '') from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p where has_table_privilege('${role}','public.${table}',p)`))
    const expected: Record<string, Record<string, string>> = {
      flow_runs: { anon: '', authenticated: 'SELECT' }, flow_versions: { anon: '', authenticated: 'SELECT' }, flow_run_call_frames: { anon: '', authenticated: 'SELECT' },
      flow_run_effects: { anon: '', authenticated: '' }, flow_run_effect_messages: { anon: '', authenticated: '' } }
    const got: string[] = []
    for (const [table, roles] of Object.entries(expected)) for (const [role, want] of Object.entries(roles)) {
      const have = await privs(table, role); got.push(`${table}/${role}=[${have}]`)
      // anon may keep a read grant on flow_runs from the platform defaults; it can never see a row (auth.uid() is NULL) and may not write
      if (table === 'flow_runs' && role === 'anon') expect(have === '' || have === 'SELECT', `${table}/${role}`).toBe(true)
      else expect(have, `${table}/${role}`).toBe(want)
    }
    // the user can still read their own run and call frames over HTTP
    expect((await raw('GET', '/flow_runs?select=id&limit=1', { token: userA })).status).toBe(200)
    expect((await raw('GET', '/flow_run_call_frames?select=id&limit=1', { token: userA })).status).toBe(200)
    // a role that holds TRUNCATE ignores RLS: prove a real session as `authenticated` cannot wipe the engine tables
    for (const t of ['flow_run_call_frames', 'flow_versions', 'flow_runs']) {
      const r = await psql.run(`begin; set local role authenticated; truncate public.${t}; rollback`)
      expect('error' in r && r.error.code, `TRUNCATE ${t} as authenticated`).toBe('42501')
    }
    pass('G03', `engine table privileges: ${got.join(' ')}; users still read their runs and call frames over HTTP; TRUNCATE as authenticated is denied (42501) on flow_runs, flow_versions, flow_run_call_frames`)
  })
})
