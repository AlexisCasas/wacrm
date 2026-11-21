import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const sql = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20261205000009_order_sync_payment_hooks.sql'),
  'utf8',
).replace(/\r\n/g, '\n')
const code = sql.replace(/^\s*--.*$/gm, '')

describe('SYNC-05 WACRM automatic payment hooks', () => {
  it('marks only imported InkaClick payments with a transaction-local origin fence', () => {
    expect(code).toMatch(/IF NEW\.source = 'inkaclick_sync' THEN/)
    expect(code).toMatch(/set_config\('app\.order_sync_origin', 'inkaclick', true\)/)
    expect(code).toMatch(/BEFORE INSERT ON public\.order_payments/)
  })

  it('preserves the existing finalization behavior', () => {
    expect(code).toMatch(
      /PERFORM public\.order_payments_evaluate_finalization\(p_account, p_order, p_actor, p_actor_name, p_now\)/,
    )
  })

  it('emits one final financial snapshot only for non-imported changes', () => {
    expect(code).toMatch(
      /current_setting\('app\.order_sync_origin', true\) IS DISTINCT FROM 'inkaclick'/,
    )
    expect(code).toMatch(/PERFORM public\.emit_wacrm_payment_snapshot\(p_account, p_order, p_now\)/)
  })

  it('adds no transport, HTTP or cron behavior', () => {
    expect(code).not.toMatch(/pg_net|http|fetch|cron\./i)
  })

  it('does not modify payment amounts or statuses itself', () => {
    expect(code).not.toMatch(/UPDATE\s+public\.order_payments|DELETE\s+FROM\s+public\.order_payments/i)
    expect(code).not.toMatch(/SET\s+(amount|status)\s*=/i)
  })
})
