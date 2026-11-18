import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// FIX 04 static guards: the migration keeps its shape, every new function revokes the API roles explicitly (Supabase grants
// EXECUTE to anon/authenticated by default), and no LATER migration can quietly reopen the direct delete paths.
const DIR = 'supabase/migrations'
const FILE = '20261127000000_contact_deletion_controls.sql'
const sql = readFileSync(`${DIR}/${FILE}`, 'utf8')
const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()

describe(FILE, () => {
  it('sorts after every earlier migration and is not a duplicate version', () => {
    expect((files.at(-1) ?? '') >= FILE).toBe(true)
    expect(files.filter((f) => f.startsWith('20261127000000'))).toEqual([FILE])
    expect(files.indexOf(FILE)).toBeGreaterThan(files.indexOf('20261126000000_contacts_name_locked.sql'))
    expect(files.indexOf(FILE)).toBeGreaterThan(files.indexOf('20261125000000_whatsapp_inbound_dispatch_ledger.sql'))
  })

  it('creates the audit tables with RLS, read-only grants and append-only triggers', () => {
    expect(code).toMatch(/CREATE TABLE IF NOT EXISTS public\.contact_deletion_operations/)
    expect(code).toMatch(/CREATE TABLE IF NOT EXISTS public\.contact_deletion_items/)
    expect(code).toMatch(/ENABLE ROW LEVEL SECURITY/g)
    expect(code).toMatch(/REVOKE ALL ON TABLE public\.contact_deletion_operations, public\.contact_deletion_items FROM PUBLIC, anon, authenticated, service_role/)
    expect(code).toMatch(/GRANT SELECT ON TABLE public\.contact_deletion_operations, public\.contact_deletion_items TO authenticated, service_role/)
    expect(code).not.toMatch(/GRANT (INSERT|UPDATE|DELETE|ALL)[^;]*contact_deletion/i)
    expect(code.match(/BEFORE UPDATE OR DELETE/g)?.length).toBe(2)
    expect(code.match(/BEFORE TRUNCATE/g)?.length).toBe(2)
  })

  it('stores no personal data beyond the last 3 digits of the phone (no name, email, full phone, BSUID value)', () => {
    const items = code.slice(code.indexOf('CREATE TABLE IF NOT EXISTS public.contact_deletion_items'), code.indexOf('CREATE INDEX IF NOT EXISTS idx_contact_deletion_items_contact'))
    expect(items).toMatch(/phone_last3/)
    for (const forbidden of [/\bname\b/i, /\bemail\b/i, /\bphone\s+text/i, /bsuid\s+text/i, /wa_username/i]) expect(items).not.toMatch(forbidden)
  })

  it('every function it defines revokes PUBLIC, anon and authenticated explicitly and grants only service_role', () => {
    const defined = [...code.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(([^)]*)\)/g)].map((m) => m[1])
    expect(new Set(defined)).toEqual(new Set(['contact_deletion_audit_guard', 'contact_delete_limits', 'contact_delete_impact', 'bulk_delete_contacts_internal', 'purge_contact_deletion_audit']))
    for (const name of new Set(defined)) {
      expect(code).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\([^)]*\\) FROM PUBLIC, anon, authenticated`))
      if (name !== 'contact_deletion_audit_guard') expect(code).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\([^)]*\\) TO service_role`))
    }
    expect(code).not.toMatch(/GRANT EXECUTE[^;]*TO (PUBLIC|anon|authenticated)/i)
  })

  it('the retired 3-argument signature fails closed and the new one requires the actor', () => {
    expect(code).toMatch(/bulk_delete_contacts_internal\(p_account_id uuid, p_contact_ids uuid\[\], p_public_base text DEFAULT NULL\)[\s\S]*?RAISE EXCEPTION 'ACTOR_REQUIRED'/)
    expect(code).toMatch(/p_actor_user_id uuid, p_ack_protected boolean DEFAULT false/)
    expect(code).not.toMatch(/p_actor_user_id uuid DEFAULT/)
  })

  it('writes the audit before the delete, in the same function (one transaction), under a per-account lock', () => {
    const fn = code.slice(code.indexOf('p_actor_user_id uuid, p_ack_protected boolean DEFAULT false'))
    expect(fn.indexOf('pg_advisory_xact_lock')).toBeGreaterThan(-1)
    expect(fn.indexOf('INSERT INTO contact_deletion_operations')).toBeGreaterThan(fn.indexOf('pg_advisory_xact_lock'))
    expect(fn.indexOf('INSERT INTO contact_deletion_items')).toBeGreaterThan(fn.indexOf('INSERT INTO contact_deletion_operations'))
    expect(fn.indexOf('DELETE FROM contacts WHERE id = ANY(v_ids)')).toBeGreaterThan(fn.indexOf('INSERT INTO contact_deletion_items'))
    expect(fn).not.toMatch(/EXCEPTION\s+WHEN/i)        // no swallowed audit errors
  })

  it('closes the direct paths: no DELETE policy / privilege on contacts, no public merge functions', () => {
    expect(code).toMatch(/DROP POLICY IF EXISTS contacts_delete ON public\.contacts/)
    expect(code).toMatch(/REVOKE DELETE, TRUNCATE ON TABLE public\.contacts FROM PUBLIC, anon, authenticated, service_role/)
    expect(code).toMatch(/REVOKE ALL ON FUNCTION public\.merge_duplicate_contacts\(\) FROM PUBLIC, anon, authenticated/)
    expect(code).toMatch(/REVOKE ALL ON FUNCTION public\.merge_duplicate_conversations\(\) FROM PUBLIC, anon, authenticated/)
  })

  it('does not touch conversations, messages, orders or flows data (only the existing deletion semantics)', () => {
    expect(code).not.toMatch(/ALTER TABLE public\.(conversations|messages|order_confirmations|flows|flow_runs)/i)
    expect(code).not.toMatch(/DROP TABLE|TRUNCATE TABLE/i)
  })
})

describe('later migrations cannot silently reopen what FIX 04 closed', () => {
  const after = files.filter((f) => f > FILE).map((f) => [f, readFileSync(`${DIR}/${f}`, 'utf8')] as const)
  it('no migration after FIX 04 recreates the contacts DELETE policy or grants public EXECUTE on the merge functions', () => {
    for (const [f, text] of after) {
      expect(text, f).not.toMatch(/CREATE POLICY\s+"?contacts_delete"?/i)
      expect(text, f).not.toMatch(/GRANT[^;]*DELETE[^;]*ON[^;]*public\.contacts\b[^;]*TO[^;]*(anon|authenticated|PUBLIC)/i)
      expect(text, f).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.merge_duplicate_(contacts|conversations)/i)
    }
  })
  it('the DROP POLICY comes after every earlier CREATE POLICY contacts_delete in migration order', () => {
    let lastCreate = -1
    let dropAt = -1
    files.forEach((f, i) => {
      const t = readFileSync(`${DIR}/${f}`, 'utf8')
      if (/CREATE POLICY\s+"?contacts_delete"?/i.test(t)) lastCreate = i
      if (f === FILE) dropAt = i
    })
    expect(dropAt).toBeGreaterThan(lastCreate)
  })
})
