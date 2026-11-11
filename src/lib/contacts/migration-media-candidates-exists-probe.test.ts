import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const original = read('supabase/migrations/20261106000000_contacts_full_cleanup.sql')
const probe = read('supabase/migrations/20261119000002_contact_chat_media_candidates_exists_probe.sql')
const qa = read('qa/contacts-bulk-delete/media-candidates-equivalence.sql')

const fnOf = (sql: string) => {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.contact_chat_media_candidates(')
  return sql.slice(start, sql.indexOf('$$;', start) + 3)
}
const oldFn = fnOf(original)
const newFn = fnOf(probe)
const code = probe.replace(/^--.*$/gm, '')

describe('migration 20261119000002 — contact_chat_media_candidates EXISTS probe', () => {
  it('is the previous function with ONLY the used-elsewhere predicate replaced', () => {
    const expected = oldFn
      .replace(/  \),\n  used_elsewhere AS \([\s\S]*?\n  \)\n/, '  )\n')
      .replace(
        'EXISTS (SELECT 1 FROM used_elsewhere u WHERE u.url = mine.url)',
        'EXISTS (SELECT 1 FROM messages o WHERE o.media_url = mine.url AND o.conversation_id <> ALL(v_convs))',
      )
    expect(newFn).toBe(expected)
    expect(newFn).not.toBe(oldFn)
  })

  it('no longer has the used_elsewhere CTE / DISTINCT join that forced a full scan of messages, and uses the media_url probe', () => {
    expect(newFn).not.toMatch(/used_elsewhere/)
    expect(newFn).not.toMatch(/SELECT DISTINCT/)
    expect(newFn).not.toMatch(/media_url IN \(SELECT/)
    expect(newFn).toContain('EXISTS (SELECT 1 FROM messages o WHERE o.media_url = mine.url AND o.conversation_id <> ALL(v_convs))')
  })

  it('keeps signature, return columns, security context and tenant validation', () => {
    expect(newFn).toMatch(/contact_chat_media_candidates\(\s*p_account_id UUID,\s*p_contact_ids UUID\[\]\s*\)/)
    expect(newFn).toMatch(/RETURNS TABLE \(media_url TEXT, shared BOOLEAN, message_count BIGINT\)/)
    expect(newFn).toMatch(/LANGUAGE plpgsql\s+STABLE\s+SECURITY DEFINER\s+SET search_path = public/)
    expect(newFn).toContain('CONTACTS_NOT_IN_ACCOUNT')
    expect(newFn).toContain('id = ANY(v_ids) AND account_id = p_account_id')
    expect(newFn).toContain('contact_id = ANY(v_ids) AND account_id = p_account_id')
    expect(newFn).toContain('EMPTY_BATCH')
    expect(newFn).toContain('BATCH_TOO_LARGE')
  })

  it('keeps flow_nodes / automation_steps reference detection and the message_count / ordering', () => {
    expect(newFn).toContain("FROM flow_nodes WHERE config::text LIKE '%/storage/v1/object/%'")
    expect(newFn).toContain("FROM automation_steps WHERE step_config::text LIKE '%/storage/v1/object/%'")
    expect(newFn).toContain('position(mine.url IN r) > 0')
    expect(newFn).toContain('count(*) AS n')
    expect(newFn).toContain('mine.n AS message_count')
    expect(newFn).toContain('ORDER BY mine.url')
  })

  it('changes nothing else: no privileges, other DDL, data operations or timeout settings', () => {
    expect(code.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(1)
    expect(code).not.toMatch(/\b(?:GRANT|REVOKE|DROP|ALTER|TRUNCATE|CREATE TABLE|CREATE INDEX|CREATE TRIGGER|CREATE POLICY)\b|statement_timeout/i)
    expect(code).not.toMatch(/\b(?:DELETE FROM|UPDATE\s+\w+\s+SET|INSERT INTO)\b/i)
    expect(code).not.toMatch(/tombstone|blacklist|blocked/i)
  })

  it('leaves the existing grants of the original migration in force (service_role only) and does not touch bulk_delete_contacts_internal', () => {
    expect(original).toMatch(/GRANT EXECUTE ON FUNCTION public\.contact_chat_media_candidates\(UUID, UUID\[\]\) TO service_role/)
    expect(code).not.toContain('bulk_delete_contacts_internal')
  })

  it('has an equivalence QA script that embeds exactly this function body (cannot drift)', () => {
    const embedded = qa.slice(qa.indexOf('CREATE OR REPLACE FUNCTION pg_temp.cmc_new('), qa.indexOf('$$;', qa.indexOf('pg_temp.cmc_new(')) + 3)
    expect(embedded).toBe(newFn.replace('public.contact_chat_media_candidates', 'pg_temp.cmc_new').replace('SET search_path = public', 'SET search_path = pg_temp, public'))
    const embeddedOld = qa.slice(qa.indexOf('CREATE OR REPLACE FUNCTION pg_temp.cmc_old('), qa.indexOf('$$;', qa.indexOf('pg_temp.cmc_old(')) + 3)
    expect(embeddedOld).toBe(oldFn.replace('public.contact_chat_media_candidates', 'pg_temp.cmc_old').replace('SET search_path = public', 'SET search_path = pg_temp, public'))
  })

  it('QA covers the required equivalence scenarios', () => {
    for (const label of ['used only by chats being deleted', 'surviving chat', 'flow node', 'automation step', 'unshared single use', 'message_count=4', 'exact difference 0']) {
      expect(qa).toContain(label)
    }
    expect((qa.match(/CONTACTS_NOT_IN_ACCOUNT/g) ?? []).length).toBeGreaterThanOrEqual(3)
  })
})
