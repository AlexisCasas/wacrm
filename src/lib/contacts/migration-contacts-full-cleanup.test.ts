import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Contract of migration 20261106000000 (behaviour is proven on a real Postgres by qa/contacts-bulk-delete/*.sql).
const sql = readFileSync(join(__dirname, '../../../supabase/migrations/20261106000000_contacts_full_cleanup.sql'), 'utf8')
const code = sql.replace(/^\s*--.*$/gm, '')

describe('migration 20261106000000_contacts_full_cleanup', () => {
  it('creates no table, no blocklist and no tombstone, and never marks a contact blocked', () => {
    expect(code).not.toMatch(/CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE/i)
    expect(code).not.toMatch(/blocked\s*=\s*(true|TRUE)|contact_block_events|INSERT\s+INTO/i)
  })
  it('both functions stay service_role only', () => {
    for (const fn of ['contact_chat_media_candidates', 'bulk_delete_contacts_internal']) {
      expect(code).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\(UUID, UUID\\[\\]\\) FROM authenticated`, 'i'))
      expect(code).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\(UUID, UUID\\[\\]\\) TO service_role`, 'i'))
    }
  })
  it('keeps the signature of bulk_delete_contacts_internal (same RPC, no new overload)', () => {
    expect(code).toMatch(/CREATE OR REPLACE FUNCTION public\.bulk_delete_contacts_internal\(\s*p_account_id UUID,\s*p_contact_ids UUID\[\]\s*\)/)
    expect(code).not.toMatch(/DROP\s+FUNCTION/i)
  })
  it('cleans only operational per-contact data of the given contacts and account', () => {
    expect(code).toMatch(/DELETE FROM flow_runs WHERE account_id = p_account_id AND contact_id = ANY\(v_ids\)/)
    expect(code).toMatch(/DELETE FROM automation_pending_executions WHERE account_id = p_account_id AND contact_id = ANY\(v_ids\)/)
    expect(code).toMatch(/DELETE FROM notifications WHERE account_id = p_account_id AND contact_id = ANY\(v_ids\)/)
    expect(code).toMatch(/DELETE FROM contacts WHERE id = ANY\(v_ids\) AND account_id = p_account_id/)
  })
  it('never deletes history by hand: deals, broadcasts, orders, audio requests, automation logs, usage, identity audit', () => {
    expect(code).not.toMatch(/DELETE FROM (deals|broadcasts|broadcast_recipients|order_confirmations|audio_guide_requests|automation_logs|ai_usage_log|contact_identity_audit|conversations|messages|flows|flow_nodes)/i)
  })
  it('rejects foreign ids before deleting anything and reports the media before the delete', () => {
    expect(code.indexOf('CONTACTS_NOT_IN_ACCOUNT')).toBeLessThan(code.indexOf('DELETE FROM flow_runs'))
    expect(code.indexOf('contact_chat_media_candidates(p_account_id, v_ids)')).toBeLessThan(code.indexOf('DELETE FROM contacts'))
  })
  it('the media list carries the keys the API reads', () => {
    expect(code).toMatch(/jsonb_build_object\('media_url', c\.media_url, 'shared', c\.shared\)/)
  })
})
