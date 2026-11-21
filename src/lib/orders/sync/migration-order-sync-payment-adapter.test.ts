import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const MIGRATION = '20261205000007_order_sync_payment_adapter.sql'
const sql = readFileSync(resolve(process.cwd(), 'supabase/migrations', MIGRATION), 'utf8').replace(/\r\n/g, '\n')
const code = sql.replace(/^\s*--.*$/gm, '')

describe('SYNC-03 WACRM payment parity adapter', () => {
  it('adds RPCs only and installs no automatic trigger, cron or transport', () => {
    expect(code).toMatch(/CREATE OR REPLACE FUNCTION public\.emit_wacrm_payment_snapshot/)
    expect(code).toMatch(/CREATE OR REPLACE FUNCTION public\.apply_inkaclick_payment_snapshot/)
    expect(code).not.toMatch(/CREATE TRIGGER|cron\.|pg_net|http|webhook/i)
    expect(code).not.toMatch(/ALTER TABLE public\.(order_confirmations|order_payments|order_financials|order_documents)/i)
  })

  it('uses a PII-free cumulative snapshot contract', () => {
    expect(code).toMatch(/'payment\.snapshot'/)
    expect(code).toMatch(/jsonb_build_object\('total', v_total, 'paid', f\.paid_confirmed, 'balance', v_balance\)/)
    expect(code).not.toMatch(/customer_name|telefono|phone|dni|nombre_completo/i)
  })

  it('never reduces confirmed money and fails closed when WACRM is ahead', () => {
    expect(code).toMatch(/IF v_remote_paid < f\.paid_confirmed THEN/)
    expect(code).toMatch(/last_error_code='wacrm_ahead'/)
    expect(code).not.toMatch(/amount\s*=\s*-|paid_confirmed\s*=\s*v_remote_paid/i)
  })

  it('imports only the positive delta and labels it as an InkaClick sync payment', () => {
    expect(code).toMatch(/v_delta := v_remote_paid - f\.paid_confirmed/)
    expect(code).toMatch(/'sync_inkaclick'/)
    expect(code).toMatch(/'inkaclick_sync'/)
    expect(code).toMatch(/'InkaClick sync'/)
  })

  it('does not silently enroll historical untracked orders', () => {
    expect(code).toMatch(/last_error_code='not_tracked'/)
    expect(code).not.toMatch(/INSERT INTO public\.order_financials/)
  })

  it('requires total/arithmetic parity before any payment write', () => {
    const mismatch = code.indexOf("last_error_code='total_mismatch'")
    const insert = code.indexOf('INSERT INTO public.order_payments')
    expect(mismatch).toBeGreaterThanOrEqual(0)
    expect(insert).toBeGreaterThan(mismatch)
    expect(code).toMatch(/v_remote_balance <> GREATEST\(v_remote_total - v_remote_paid, 0\)/)
  })

  it('writer RPCs remain service-role only', () => {
    expect(code).toMatch(/REVOKE ALL ON FUNCTION public\.emit_wacrm_payment_snapshot\([\s\S]*?FROM PUBLIC, anon, authenticated;/)
    expect(code).toMatch(/GRANT EXECUTE ON FUNCTION public\.emit_wacrm_payment_snapshot\([\s\S]*?TO service_role;/)
  })
})
