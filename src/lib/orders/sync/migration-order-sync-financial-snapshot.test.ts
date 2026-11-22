import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const file = resolve(process.cwd(), 'supabase/migrations/20261205000007_order_sync_financial_snapshot.sql')
const sql = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
const code = sql.replace(/^\s*--.*$/gm, '')

describe('SYNC-03A WACRM financial snapshot', () => {
  it('is a read-only view over orders + financials', () => {
    expect(code).toMatch(/CREATE OR REPLACE VIEW public\.order_sync_financial_snapshot/)
    expect(code).toMatch(/FROM public\.order_confirmations o/)
    expect(code).toMatch(/LEFT JOIN public\.order_financials f/)
    expect(code).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE TRIGGER|ALTER TABLE)\b/i)
  })

  it('uses the WACRM UUID as the canonical identity', () => {
    expect(code).toMatch(/o\.id AS canonical_order_id/)
    expect(code).not.toMatch(/inkaclick_order_id|legacy_inkaclick_id/)
  })

  it('never converts untracked historical orders into unpaid zero-payment orders', () => {
    expect(code).toMatch(/WHEN f\.order_id IS NULL THEN NULL/)
    expect(code).toMatch(/WHEN f\.order_id IS NULL THEN 'not_tracked'/)
    expect(code).toMatch(/\(f\.order_id IS NOT NULL\) AS tracked/)
    expect(code).not.toMatch(/COALESCE\s*\(\s*f\.paid_confirmed\s*,\s*0/i)
  })

  it('derives balance from the immutable WACRM total and confirmed paid amount', () => {
    expect(code).toMatch(/GREATEST\(o\.price - f\.paid_confirmed, 0\)/)
  })

  it('is server-only', () => {
    expect(code).toMatch(/REVOKE ALL ON public\.order_sync_financial_snapshot FROM PUBLIC, anon, authenticated/)
    expect(code).toMatch(/GRANT SELECT ON public\.order_sync_financial_snapshot TO service_role/)
  })
})
