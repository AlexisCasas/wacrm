import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const mig = readFileSync(resolve(process.cwd(), 'supabase/migrations/20261121000000_order_logistics_foundation.sql'), 'utf8')
const code = mig.replace(/^--.*$/gm, '')
const fnOf = (sql: string, start: string) => {
  const a = sql.indexOf(start)
  expect(a, `missing ${start}`).toBeGreaterThanOrEqual(0)
  return sql.slice(a, sql.indexOf('$$;', sql.indexOf('$$', a) + 2) + 3)
}

describe('20261121000000_order_logistics_foundation', () => {
  it('never activates an account: no UPDATE/INSERT of the flag, default FALSE, nothing destructive', () => {
    expect(code).toMatch(/logistics_mvp_enabled BOOLEAN NOT NULL DEFAULT FALSE/)
    expect(code).not.toMatch(/UPDATE\s+(public\.)?order_integration_settings/i)
    expect(code).not.toMatch(/INSERT\s+INTO\s+(public\.)?order_integration_settings/i)
    expect(code).not.toMatch(/logistics_mvp_enabled\s*=\s*(TRUE|true)/)
    expect(code).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i)
  })
  it('is additive: enum, nullable operational_role', () => {
    expect(code).toMatch(/ENUM \('commercial', 'logistics', 'supervisor'\)/)
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS operational_role public\.operational_role_enum NULL/)
  })
  it('does not touch orders or the InkaClick contract', () => {
    expect(code).not.toMatch(/order_confirmations|create_order_confirmation|recipient/i)
  })
  it('protects operational_role from the browser and clears it when the account changes', () => {
    expect(code).toMatch(/OR NEW\.operational_role IS DISTINCT FROM OLD\.operational_role\)\s+AND current_user = 'authenticated'/)
    expect(code).toMatch(/NEW\.account_id IS DISTINCT FROM OLD\.account_id THEN\s+NEW\.operational_role := NULL/)
    expect(code).toMatch(/BEFORE UPDATE OF account_id ON public\.profiles/)
  })
  it('set_member_operational_role: admin+, same account, flag ON, never touches account_role', () => {
    const fn = fnOf(mig, 'CREATE OR REPLACE FUNCTION public.set_member_operational_role(')
    expect(fn).toMatch(/SECURITY DEFINER/)
    expect(fn).toMatch(/NOT IN \('owner', 'admin'\)/)
    expect(fn).toMatch(/v_target_account_id <> v_caller_account_id/)
    expect(fn).toMatch(/logistics_mvp_enabled/)
    expect(fn).not.toMatch(/SET\s+account_role|account_role\s*=/)
    expect(code).toMatch(/GRANT EXECUTE ON FUNCTION public\.set_member_operational_role\(UUID, public\.operational_role_enum\) TO authenticated/)
  })
})
