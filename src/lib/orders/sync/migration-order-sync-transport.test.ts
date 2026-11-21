import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const sql = readFileSync(resolve(process.cwd(), 'supabase/migrations/20261205000008_order_sync_transport.sql'), 'utf8').replace(/\r\n/g, '\n')
const code = sql.replace(/^\s*--.*$/gm, '')

describe('SYNC-04 transport migration', () => {
  it('only extends sync receipts and never touches business tables', () => {
    expect(code).toMatch(/ALTER TABLE public\.order_sync_receipts/)
    expect(code).not.toMatch(/ALTER TABLE public\.(order_confirmations|order_payments|order_documents|order_logistics|order_shipments)/i)
    expect(code).not.toMatch(/CREATE TRIGGER|cron\.|http|pg_net/i)
  })
  it('uses fenced leases and bounded attempts', () => {
    expect(code).toMatch(/FOR UPDATE OF r SKIP LOCKED/)
    expect(code).toMatch(/claim_token=gen_random_uuid\(\)/)
    expect(code).toMatch(/attempts=r\.attempts\+1/)
    expect(code).toMatch(/attempts_exhausted/)
  })
  it('only service_role can claim and finish transport receipts', () => {
    expect(code).toMatch(/REVOKE ALL ON FUNCTION public\.claim_order_sync_outbound[\s\S]*?FROM PUBLIC, anon, authenticated;/)
    expect(code).toMatch(/GRANT EXECUTE ON FUNCTION public\.claim_order_sync_outbound[\s\S]*?TO service_role;/)
  })
})
