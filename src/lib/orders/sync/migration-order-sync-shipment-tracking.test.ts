import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe,expect,it } from 'vitest'
const code=readFileSync(resolve(process.cwd(),'supabase/migrations/20261205000012_order_sync_shipment_tracking.sql'),'utf8').replace(/^\s*--.*$/gm,'')
describe('SYNC-08 shipment mirror',()=>{
 it('keeps the remote tracker separate',()=>{expect(code).toMatch(/order_shipment_sync_state/);expect(code).not.toMatch(/UPDATE public\.order_shipments/)} )
 it('normalizes and advances monotonically',()=>{expect(code).toMatch(/WHEN 'at_origin' THEN 1/);expect(code).toMatch(/WHEN 'delivered' THEN 4/);expect(code).toMatch(/incoming_rank>existing_rank/)})
 it('emits PII-free shipment snapshots',()=>{expect(code).toMatch(/'shipment\.snapshot'/);expect(code).not.toMatch(/customer_name|telefono|dni/i)})
 it('allows newer corrected guide only',()=>{expect(code).toMatch(/ELSIF e\.occurred_at>x\.source_updated_at THEN/)})
})
