import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const sql = readFileSync(resolve(process.cwd(), 'supabase/migrations/20261110000001_bulk_delete_media_candidates_once.sql'), 'utf8')
const fn = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.bulk_delete_contacts_internal'))

describe('migration 20261110000001 — bulk delete media candidates once', () => {
  it('keeps the secure public function contract and ownership checks', () => {
    expect(fn).toMatch(/p_account_id UUID,\s*p_contact_ids UUID\[\],\s*p_public_base TEXT DEFAULT NULL/)
    expect(fn).toMatch(/SECURITY DEFINER SET search_path = public/)
    expect(fn).toContain('account_id = p_account_id')
    expect(fn.indexOf('CONTACTS_NOT_IN_ACCOUNT')).toBeLessThan(fn.indexOf('DELETE FROM contacts'))
    expect(fn).toContain('cardinality(v_ids) > 200')
    expect(fn.match(/FOR UPDATE/g)).toHaveLength(2)
  })

  it('uses one materialized candidate set while preserving cleanup and privileges', () => {
    expect(fn).toContain('WITH candidates AS MATERIALIZED')
    expect(fn.match(/contact_chat_media_candidates\(p_account_id, v_ids\)/g)).toHaveLength(1)
    expect(fn).toMatch(/stats AS \([\s\S]*FROM candidates/)
    expect(fn).toMatch(/objs AS \([\s\S]*FROM candidates c/)
    expect(fn).toContain('contact_media_cleanup_items')
    expect(fn).toContain('classify_chat_media_object')
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.bulk_delete_contacts_internal\(UUID, UUID\[\], TEXT\) FROM PUBLIC, anon, authenticated/)
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.bulk_delete_contacts_internal\(UUID, UUID\[\], TEXT\) TO service_role/)
  })

  it('contains no top-level data operation outside the function body', () => {
    const beforeFunction = sql.slice(0, sql.indexOf('CREATE OR REPLACE FUNCTION')).replace(/^--.*$/gm, '')
    expect(beforeFunction).not.toMatch(/\b(?:DELETE|UPDATE|INSERT)\b/i)
  })
})
