import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (f: string) => readFileSync(resolve(process.cwd(), 'supabase/migrations', f), 'utf8')
const mig = read('20261126000000_operational_role_supervisor_delegation.sql')
const code = mig.replace(/^--.*$/gm, '')
const fn = code.slice(code.indexOf('CREATE OR REPLACE FUNCTION public.set_member_operational_role('), code.indexOf('$$;') + 3)

describe('20261126000000_operational_role_supervisor_delegation', () => {
  it('is a function-only change: no DDL on tables/columns/types/triggers/policies, no data writes other than operational_role', () => {
    expect(code).not.toMatch(/\b(CREATE|ALTER|DROP)\s+(TABLE|TYPE|TRIGGER|POLICY|INDEX)\b/i)
    expect(code).not.toMatch(/\bADD\s+COLUMN\b|\bDROP\s+COLUMN\b/i)
    expect(code).not.toMatch(/\b(INSERT\s+INTO|DELETE\s+FROM)\b/i)
    expect(code.match(/\bUPDATE\s+\w+/gi)).toEqual(['UPDATE profiles'])
    expect(code).not.toMatch(/logistics_mvp_enabled\s*=\s*(TRUE|true)/)
  })

  it('keeps signature, SECURITY DEFINER, owner, pinned search_path, REVOKE and GRANT authenticated', () => {
    expect(code).toMatch(/CREATE OR REPLACE FUNCTION public\.set_member_operational_role\(\s*p_user_id UUID,\s*p_operational_role public\.operational_role_enum\s*\) RETURNS VOID/)
    expect(fn).toMatch(/SECURITY DEFINER\s+SET search_path = public/)
    expect(code).toMatch(/OWNER TO postgres/)
    expect(code).toMatch(/REVOKE ALL ON FUNCTION public\.set_member_operational_role\(UUID, public\.operational_role_enum\) FROM PUBLIC, anon/)
    expect(code).toMatch(/GRANT EXECUTE ON FUNCTION public\.set_member_operational_role\(UUID, public\.operational_role_enum\) TO authenticated/)
  })

  it('takes the caller from auth.uid() and never from an argument or the browser', () => {
    expect(fn).toMatch(/v_caller_id UUID := auth\.uid\(\)/)
    expect(fn).not.toMatch(/p_account|p_caller/)
  })

  it('serializes the two profiles (caller + target) with ordered row locks and reads the facts AFTER the lock', () => {
    const lock = fn.indexOf('FOR UPDATE')
    expect(lock).toBeGreaterThan(0)
    expect(fn).toMatch(/WHERE user_id IN \(v_caller_id, p_user_id\) ORDER BY user_id FOR UPDATE/)
    expect(fn.indexOf('SELECT account_id, account_role, operational_role')).toBeGreaterThan(lock)
    expect(fn.indexOf('SELECT account_id, account_role, operational_role\n    INTO v_target_account_id')).toBeGreaterThan(lock)
    expect(fn.indexOf('UPDATE profiles')).toBeGreaterThan(lock)
  })

  it('enforces same account, the feature flag and the supervisor limits; admin rules are not conditioned on the supervisor area', () => {
    expect(fn).toMatch(/v_target_account_id <> v_caller_account_id/)
    expect(fn).toMatch(/logistics_mvp_enabled/)
    expect(fn).toMatch(/v_is_admin := v_caller_role IN \('owner', 'admin'\)/)
    expect(fn).toMatch(/IF NOT v_is_admin THEN/)
    expect(fn).toMatch(/v_caller_op IS DISTINCT FROM 'supervisor'/)
    expect(fn).toMatch(/p_operational_role IS NOT DISTINCT FROM 'supervisor'/)
    expect(fn).toMatch(/v_target_op IS NOT DISTINCT FROM 'supervisor'/)
    expect(fn).toMatch(/IF v_target_role IN \('owner', 'admin'\) THEN/)
    expect(fn.indexOf('IF v_target_role IN')).toBeGreaterThan(fn.indexOf('IF NOT v_is_admin THEN'))
  })

  it('writes only operational_role, scoped to the caller account (account_role / account_id are never assigned)', () => {
    expect(fn).toMatch(/UPDATE profiles SET operational_role = p_operational_role\s+WHERE user_id = p_user_id AND account_id = v_caller_account_id/)
    expect(fn).not.toMatch(/SET\s+account_role|SET\s+account_id|,\s*account_role\s*=|,\s*account_id\s*=/)
  })

  it('does not edit the foundation migration (its admin-only body stays as shipped)', () => {
    const foundation = read('20261121000000_order_logistics_foundation.sql')
    expect(foundation).toMatch(/IF v_caller_role NOT IN \('owner', 'admin'\) THEN/) // original, admin-only body is untouched
    expect(foundation).toMatch(/Deploy order: apply this migration BEFORE the application code/)
  })
})
