import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const sql = readFileSync(resolve(process.cwd(), 'supabase/migrations/20261205000005_supervised_order_total_correction.sql'), 'utf8')

describe('20261205000005_supervised_order_total_correction', () => {
  it('is an additive, fail-closed supervised RPC with append-only audit and no payment mutation', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.order_total_corrections/)
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.correct_order_total/)
    expect(sql).toMatch(/a\.actor_role <> 'supervisor'/)
    expect(sql).toMatch(/order_payments_lock\(p_order\)/)
    expect(sql).toMatch(/v_new < v_paid/)
    expect(sql).toMatch(/order total correction audit is append-only/)
    expect(sql).toMatch(/GRANT EXECUTE .* TO service_role/)
    expect(sql).not.toMatch(/DELETE FROM public\.order_payments/)
    expect(sql).not.toMatch(/INSERT INTO public\.order_payments/)
  })
})
