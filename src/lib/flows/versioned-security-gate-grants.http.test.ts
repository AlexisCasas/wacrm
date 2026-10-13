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
})
