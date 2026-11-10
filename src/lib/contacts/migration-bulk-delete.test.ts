import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Contract of migration 20261105000000 (behaviour is proven against a real Postgres by qa/contacts-bulk-delete/scenarios.sql).
const sql = readFileSync(join(__dirname, '../../../supabase/migrations/20261105000001_contacts_time_filter_bulk_delete.sql'), 'utf8')
const code = sql.replace(/^\s*--.*$/gm, '')

describe('migration 20261105000001_contacts_time_filter_bulk_delete', () => {
  it('is additive: it never redefines the original tag filter nor changes any foreign key', () => {
    expect(code).not.toMatch(/FUNCTION\s+(public\.)?filter_contacts_by_tags\s*\(/i)
    expect(code).not.toMatch(/ALTER\s+TABLE|DROP\s+(TABLE|FUNCTION|CONSTRAINT)|ON\s+DELETE\s+CASCADE/i)
  })
  it('bulk delete is only callable by service_role', () => {
    expect(code).toMatch(/REVOKE ALL ON FUNCTION public\.bulk_delete_contacts_internal\(UUID, UUID\[\]\) FROM authenticated/i)
    expect(code).toMatch(/REVOKE ALL ON FUNCTION public\.bulk_delete_contacts_internal\(UUID, UUID\[\]\) FROM anon/i)
    expect(code).toMatch(/GRANT EXECUTE ON FUNCTION public\.bulk_delete_contacts_internal\(UUID, UUID\[\]\) TO service_role/i)
  })
  it('deletes only contacts of the given account and rejects foreign ids before deleting anything', () => {
    expect(code).toMatch(/DELETE FROM contacts WHERE id = ANY\(v_ids\) AND account_id = p_account_id/)
    expect(code.indexOf('CONTACTS_NOT_IN_ACCOUNT')).toBeLessThan(code.indexOf('DELETE FROM contacts'))
  })
  it('does not delete conversations / messages / deals / broadcast rows by hand (the existing FKs do it, history survives)', () => {
    expect(code).not.toMatch(/DELETE FROM (conversations|messages|deals|broadcast_recipients|broadcasts|flow_runs|flow_run_events)/i)
  })
  it('the time filter has an explicit half-open window on created_at', () => {
    expect(code).toMatch(/c\.created_at >= p_created_from/)
    expect(code).toMatch(/c\.created_at < p_created_to/)
  })
})
