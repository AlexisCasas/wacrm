import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Contract of migration 20261107000000 (behaviour is proven on a real Postgres by qa/contacts-bulk-delete/durable-cleanup.sql).
const sql = readFileSync(join(__dirname, '../../../supabase/migrations/20261107000000_contact_media_cleanup_queue.sql'), 'utf8')
const code = sql.replace(/^\s*--.*$/gm, '')

describe('migration 20261107000000_contact_media_cleanup_queue', () => {
  it('the queue belongs to the OBJECT: no contact, phone, BSUID, username or conversation column — it cannot block or identify a future contact', () => {
    const table = code.slice(code.indexOf('CREATE TABLE IF NOT EXISTS public.contact_media_cleanup_items'), code.indexOf(');', code.indexOf('CREATE TABLE IF NOT EXISTS public.contact_media_cleanup_items')))
    expect(table).not.toMatch(/contact_id|phone|bsuid|username|conversation_id|blocked/i)
    for (const col of ['account_id', 'bucket', 'object_path', 'media_url', 'status', 'last_error', 'created_at', 'completed_at']) expect(table).toContain(col)
  })
  it('only chat-media under the owner account namespace can be queued, and rows are unique per object', () => {
    expect(code).toMatch(/CHECK \(bucket = 'chat-media'\)/)
    expect(code).toMatch(/CHECK \(object_path LIKE 'account-' \|\| account_id::text \|\| '\/%'\)/)
    expect(code).toMatch(/UNIQUE \(account_id, bucket, object_path\)/)
  })
  it('the queue is service-role only (RLS on, no policy, no browser grants)', () => {
    expect(code).toMatch(/ENABLE ROW LEVEL SECURITY/)
    expect(code).toMatch(/REVOKE ALL ON public\.contact_media_cleanup_items FROM anon, authenticated/)
    expect(code).not.toMatch(/CREATE POLICY/)
    expect(code).toMatch(/GRANT EXECUTE ON FUNCTION public\.bulk_delete_contacts_internal\(UUID, UUID\[\], TEXT\) TO service_role/)
    expect(code).toMatch(/REVOKE ALL ON FUNCTION public\.bulk_delete_contacts_internal\(UUID, UUID\[\], TEXT\) FROM PUBLIC, anon, authenticated/)
  })
  it('inside the delete function the order is: tenancy, lock chats, queue media, then delete the contacts (one transaction)', () => {
    const fn = code.slice(code.indexOf('CREATE OR REPLACE FUNCTION public.bulk_delete_contacts_internal'))
    const at = (needle: string) => fn.indexOf(needle)
    expect(at('CONTACTS_NOT_IN_ACCOUNT')).toBeGreaterThan(-1)
    expect(at('CONTACTS_NOT_IN_ACCOUNT')).toBeLessThan(at('INSERT INTO contact_media_cleanup_items'))
    expect(at('FROM conversations WHERE contact_id = ANY(v_ids) AND account_id = p_account_id FOR UPDATE')).toBeLessThan(at('INSERT INTO contact_media_cleanup_items'))
    expect(at('INSERT INTO contact_media_cleanup_items')).toBeLessThan(at('DELETE FROM contacts WHERE'))
  })
  it('shared / non-eligible objects are never queued, and history is still not deleted by hand', () => {
    expect(code).toMatch(/NOT o\.shared/)
    expect(code).toMatch(/o\.object_path IS NOT NULL/)
    expect(code).not.toMatch(/DELETE FROM (deals|broadcasts|broadcast_recipients|order_confirmations|audio_guide_requests|automation_logs|ai_usage_log|contact_identity_audit|conversations|messages|flows|flow_nodes)/i)
    expect(code).not.toMatch(/blocked\s*=\s*(true|TRUE)/)
  })
  it('does not touch Storage rows: no storage.objects writes from SQL', () => {
    expect(code).not.toMatch(/storage\.objects/i)
  })
})
