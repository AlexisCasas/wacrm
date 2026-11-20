import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const dir = resolve(process.cwd(), 'supabase/migrations')
const name = '20261127000000_conversation_handoff_rls.sql'
const mig = readFileSync(resolve(dir, name), 'utf8')
const code = mig.replace(/^--.*$/gm, '')
const fn = code.slice(code.indexOf('CREATE OR REPLACE FUNCTION public.conversation_operational_access('), code.indexOf('$$;') + 3)

describe(name, () => {
  it('is authorization-only: no data writes, no destructive DDL, no new state column or status', () => {
    expect(code).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|TRUNCATE)\b/i)
    expect(code).not.toMatch(/\bDROP\s+(TABLE|COLUMN|POLICY|TRIGGER)\b/i)
    expect(code).not.toMatch(/\bADD\s+COLUMN\b/i)
    expect(code).not.toMatch(/operational_stage|conversations\.status|status\s*=\s*'closed'/i)
    expect(code).not.toMatch(/logistics_mvp_enabled\s*=\s*(TRUE|true)/)
  })

  it('sorts after the supervisor migration and does not edit historical ones', () => {
    const all = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
    expect(all.indexOf(name)).toBeGreaterThan(all.indexOf('20261126000000_operational_role_supervisor_delegation.sql'))
  })

  it('adds a non-destructive, account-scoped partial index for the stage lookup', () => {
    expect(code).toMatch(/CREATE INDEX IF NOT EXISTS order_confirmations_account_conversation_idx\s+ON public\.order_confirmations \(account_id, conversation_id\)\s+WHERE conversation_id IS NOT NULL/)
    expect(code).not.toMatch(/CONCURRENTLY/) // migrations run in a transaction
  })

  it('helper: SECURITY DEFINER, STABLE, pinned search_path, owner postgres, least-privilege grants', () => {
    expect(fn).toMatch(/RETURNS BOOLEAN\s+LANGUAGE plpgsql\s+STABLE\s+SECURITY DEFINER\s+SET search_path = public/)
    expect(code).toMatch(/ALTER FUNCTION public\.conversation_operational_access\(UUID, UUID\) OWNER TO postgres/)
    expect(code).toMatch(/REVOKE ALL ON FUNCTION public\.conversation_operational_access\(UUID, UUID\) FROM PUBLIC/)
    expect(code).toMatch(/GRANT EXECUTE ON FUNCTION public\.conversation_operational_access\(UUID, UUID\) TO anon, authenticated/)
    expect(code).not.toMatch(/GRANT[^;]*conversation_operational_access[^;]*(service_role|PUBLIC)/)
  })

  it('helper: the caller is auth.uid(); no client-supplied authority beyond the two row ids; signed-out is FALSE', () => {
    expect(fn).toMatch(/v_uid UUID := auth\.uid\(\)/)
    expect(fn).toMatch(/IF v_uid IS NULL OR p_account_id IS NULL THEN\s+RETURN FALSE/)
    expect(fn).not.toMatch(/p_user|p_role|current_setting|request\.jwt/)
  })

  it('helper: flag OFF is the legacy answer and is decided BEFORE any role logic; flag ON requires membership AND an area', () => {
    const off = fn.indexOf('IF NOT v_enabled THEN')
    expect(off).toBeGreaterThan(0)
    expect(fn.slice(off, off + 80)).toMatch(/RETURN TRUE/)
    expect(fn.indexOf("v_role = 'supervisor'")).toBeGreaterThan(off)
    expect(fn.indexOf("v_role = 'commercial'")).toBeGreaterThan(off)
    expect(fn).toMatch(/IF NOT v_member OR v_role IS NULL THEN\s+RETURN FALSE/)
  })

  it('helper: the stage is derived from order_confirmations (account + conversation), commercial = no order, logistics = order, supervisor = both', () => {
    expect(fn).toMatch(/FROM order_confirmations o WHERE o\.account_id = p_account_id AND o\.conversation_id = p_conversation_id/)
    expect(fn).toMatch(/IF v_role = 'commercial' THEN\s+RETURN NOT v_has_order/)
    expect(fn).toMatch(/IF v_role = 'logistics' THEN\s+RETURN v_has_order/)
    expect(fn).toMatch(/IF v_role = 'supervisor' THEN\s+RETURN TRUE/)
  })

  it.each([
    ['conversations_select', 'conversations'],
    ['conversations_update', 'conversations'],
    ['conversations_delete', 'conversations'],
    ['messages_select', 'messages'],
    ['messages_modify', 'messages'],
    ['message_reactions_select', 'message_reactions'],
    ['message_reactions_modify', 'message_reactions'],
  ])('policy %s on %s is ALTERed (never dropped) to AND the stage helper onto the legacy membership term', (policy, table) => {
    const start = code.indexOf(`ALTER POLICY ${policy} ON public.${table}`)
    expect(start, policy).toBeGreaterThanOrEqual(0)
    const end = code.indexOf(';\n', start)
    const body = code.slice(start, end)
    expect(body).toMatch(/is_account_member\(/)
    expect(body).toMatch(/public\.conversation_operational_access\(/)
  })

  it('leaves conversations INSERT untouched', () => {
    expect(code).not.toMatch(/ALTER POLICY conversations_insert/)
  })
})
