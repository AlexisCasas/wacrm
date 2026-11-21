import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe,expect,it } from 'vitest'

const sql=readFileSync(resolve(process.cwd(),'supabase/migrations/20261205000011_order_sync_packaging_state.sql'),'utf8').replace(/\r\n/g,'\n')
const code=sql.replace(/^\s*--.*$/gm,'')

describe('SYNC-07 WACRM packaging parity',()=>{
  it('stores remote completion separately from the PR04 local state machine',()=>{
    expect(code).toMatch(/CREATE TABLE IF NOT EXISTS public\.order_packaging_sync_state/)
    expect(code).not.toMatch(/UPDATE public\.order_logistics[\s\S]*?SET status='ready_for_dispatch'/)
    expect(code).not.toMatch(/INSERT INTO public\.order_template_dispatches/)
  })

  it('local ready-for-dispatch emits a PII-free packing.completed event',()=>{
    expect(code).toMatch(/NEW\.status='ready_for_dispatch'/)
    expect(code).toMatch(/'packing\.completed'/)
    expect(code).toMatch(/jsonb_build_object\('customer_message_sent',TRUE\)/)
  })

  it('remote completion is terminal, audited and idempotent',()=>{
    expect(code).toMatch(/ON CONFLICT \(order_id\) DO NOTHING/)
    expect(code).toMatch(/'packaging_completed'/)
    expect(code).toMatch(/'InkaClick sync'/)
  })

  it('blocks new local packing and dispatch writes after remote completion',()=>{
    expect(code).toMatch(/packaging_completed_elsewhere/)
    expect(code).toMatch(/order_sync_block_packing_start/)
    expect(code).toMatch(/order_sync_block_template_dispatch/)
  })

  it('keeps browser access read-only',()=>{
    expect(code).toMatch(/GRANT SELECT ON public\.order_packaging_sync_state TO authenticated/)
    expect(code).toMatch(/GRANT ALL ON public\.order_packaging_sync_state TO service_role/)
  })
})
