import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (f: string) => readFileSync(resolve(process.cwd(), 'supabase/migrations', f), 'utf8').replace(/\r\n/g, '\n')
const mig = read('20261205000000_operational_role_assign_without_flag.sql')
const prev = read('20261204000000_operational_role_supervisor_delegation.sql')
const strip = (s: string) => s.replace(/^--.*$/gm, '')
const code = strip(mig)
const fnOf = (s: string) => s.slice(s.indexOf('CREATE OR REPLACE FUNCTION public.set_member_operational_role('))

describe('20261205000000_operational_role_assign_without_flag', () => {
  it('is function-only: no table/column/type/trigger/policy DDL, no data writes other than operational_role', () => {
    expect(code).not.toMatch(/\b(CREATE|ALTER|DROP)\s+(TABLE|TYPE|TRIGGER|POLICY|INDEX)\b/i)
    expect(code).not.toMatch(/\bADD\s+COLUMN\b|\bDROP\s+COLUMN\b/i)
    expect(code).not.toMatch(/\b(INSERT\s+INTO|DELETE\s+FROM)\b/i)
    expect(code.match(/\bUPDATE\s+\w+/gi)).toEqual(['UPDATE profiles'])
  })

  it('never activates or even reads the logistics flag, and keeps the authority matrix', () => {
    expect(code).not.toMatch(/logistics_mvp_enabled|operational_roles_disabled|order_integration_settings/)
    expect(code).toMatch(/v_caller_id UUID := auth\.uid\(\)/)
    expect(code).toMatch(/Target user is not a member of your account/)
    expect(code).toMatch(/v_is_admin := v_caller_role IN \('owner', 'admin'\)/)
    expect(code).toMatch(/SECURITY DEFINER\s+SET search_path = public/)
    expect(code).toMatch(/REVOKE ALL ON FUNCTION public\.set_member_operational_role\(UUID, public\.operational_role_enum\) FROM PUBLIC, anon/)
    expect(code).toMatch(/GRANT EXECUTE ON FUNCTION public\.set_member_operational_role\(UUID, public\.operational_role_enum\) TO authenticated/)
  })

  it('differs from the previous definition ONLY by the removed flag gate', () => {
    const a = fnOf(strip(prev))
    const b = fnOf(code)
    const gate = /\n  SELECT COALESCE\(s\.logistics_mvp_enabled[\s\S]*?END IF;\n/
    expect(a).toMatch(gate)
    expect(a.replace(gate, '').replace('  v_enabled BOOLEAN;\n', '')).toBe(b)
  })

  it('only profiles.operational_role is written; account_role and account_id never', () => {
    expect(code).toMatch(/UPDATE profiles SET operational_role = p_operational_role/)
    expect(code).not.toMatch(/SET\s+account_role|SET\s+account_id/)
  })
})
