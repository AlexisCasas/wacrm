import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const dir = resolve(process.cwd(), 'supabase/migrations')
const name = '20261128000000_conversation_routing.sql'
const mig = readFileSync(resolve(dir, name), 'utf8').replace(/\r\n/g, '\n')
const code = mig.replace(/^\s*--.*$/gm, '')
const fnOf = (sig: string) => {
  const a = code.indexOf(sig)
  expect(a, `missing ${sig}`).toBeGreaterThanOrEqual(0)
  const open = code.indexOf('$', a)
  const tag = code.slice(open, code.indexOf('$', open + 1) + 1) // $$ or $function$
  return code.slice(a, code.indexOf(tag + ';', code.indexOf(tag, open) + tag.length) + tag.length + 1)
}

describe(name, () => {
  it('sorts after the PR-02 migrations and edits none of them', () => {
    const all = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
    expect(all.indexOf(name)).toBeGreaterThan(all.indexOf('20261127000000_conversation_handoff_rls.sql'))
    expect(all.indexOf(name)).toBe(all.length - 1)
  })

  it('documents the model rule: no row means commercial, rows only for conversations that left the commercial stage', () => {
    expect(mig).toMatch(/ABSENCE OF A ROW IN conversation_routing MEANS stage = 'commercial'/)
    expect(mig).toMatch(/Conversations WITHOUT an order get NO row/)
  })

  it('conversation_routing: account-scoped composite FK, three stages, version, no browser writes', () => {
    expect(code).toMatch(/CREATE TABLE IF NOT EXISTS public\.conversation_routing \(/)
    expect(code).toMatch(/stage\s+TEXT NOT NULL CHECK \(stage IN \('commercial', 'logistics', 'shared'\)\)/)
    expect(code).toMatch(/FOREIGN KEY \(conversation_id, account_id\) REFERENCES public\.conversations \(id, account_id\) ON DELETE CASCADE/)
    expect(code).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS conversations_id_account_unique ON public\.conversations \(id, account_id\)/)
    expect(code).toMatch(/REVOKE ALL ON public\.conversation_routing FROM PUBLIC, anon, authenticated/)
    expect(code).toMatch(/GRANT SELECT ON public\.conversation_routing TO authenticated/)
    expect(code).not.toMatch(/CREATE POLICY[^;]*FOR (INSERT|UPDATE|DELETE|ALL)/i)
    expect(code).toMatch(/ENABLE ROW LEVEL SECURITY/)
  })

  it('conversation_routing_events: all audit columns, reserved reason, append-only guard, one transition per order', () => {
    for (const col of ['id', 'account_id', 'conversation_id', 'from_stage', 'to_stage', 'reason', 'actor_user_id', 'actor_name', 'order_id', 'created_at']) {
      expect(code, col).toMatch(new RegExp(`\\n\\s+${col}\\s`))
    }
    expect(code).toMatch(/'order_confirmed', 'derived_to_commercial', 'backfill', 'logistics_completed'/)
    expect(code).toMatch(/CHECK \(from_stage <> to_stage\)/)
    expect(code).toMatch(/BEFORE UPDATE OR DELETE ON public\.conversation_routing_events/)
    expect(code).toMatch(/IF TG_OP = 'UPDATE' THEN\s+RAISE EXCEPTION 'conversation_routing_events is append-only'/)
    expect(code).toMatch(/conversation_routing_events_order_once\s+ON public\.conversation_routing_events \(order_id\) WHERE reason = 'order_confirmed'/)
    expect(code).toMatch(/GRANT SELECT ON public\.conversation_routing_events TO authenticated/)
    // logistics_completed is reserved: nothing emits it
    expect(code.match(/'logistics_completed'/g)).toHaveLength(1)
  })

  it('create_order_confirmation: same signature/ACL, the routing call is in the SAME function right after the order, and NO trigger is used', () => {
    const fn = fnOf('CREATE OR REPLACE FUNCTION public.create_order_confirmation(')
    expect(fn).toMatch(/RETURNS TABLE\(order_id uuid, created boolean\)/)
    expect(fn).not.toMatch(/SECURITY DEFINER/) // unchanged: still runs as its caller (service role path)
    const insert = fn.indexOf('INSERT INTO order_confirmations AS o')
    const items = fn.indexOf('INSERT INTO public.order_confirmation_items')
    const stop = fn.indexOf('PERFORM public.stop_contact_automations_for_order')
    const routing = fn.indexOf('PERFORM public.apply_order_confirmed_routing(p_account, p_conversation, p_actor, p_actor_name, v_id)')
    const ret = fn.indexOf('RETURN QUERY SELECT v_id, TRUE')
    expect(routing).toBeGreaterThan(insert)
    expect(routing).toBeGreaterThan(items)
    expect(routing).toBeGreaterThan(stop)
    expect(routing).toBeLessThan(ret)
    expect(fn.match(/apply_order_confirmed_routing/g)).toHaveLength(1)
    expect(code).not.toMatch(/CREATE (OR REPLACE )?TRIGGER[^;]*order_confirmations/i)
    expect(code).not.toMatch(/ALTER FUNCTION public\.create_order_confirmation/) // owner/ACL untouched (CREATE OR REPLACE keeps them)
  })

  it('apply_order_confirmed_routing: internal (service_role only), locks the row, logistics stays, commercial/shared -> logistics, one event per order', () => {
    const fn = fnOf('CREATE OR REPLACE FUNCTION public.apply_order_confirmed_routing(')
    expect(fn).toMatch(/SECURITY DEFINER\s+SET search_path = public/)
    expect(fn).toMatch(/FOR UPDATE/)
    // flag OFF writes NOTHING: the flag guard precedes any read/write of the routing tables
    expect(fn).toMatch(/logistics_mvp_enabled/)
    expect(fn.indexOf('logistics_mvp_enabled')).toBeLessThan(fn.indexOf('FOR UPDATE'))
    expect(fn).toMatch(/IF v_stage IS DISTINCT FROM 'logistics' THEN/)
    expect(code).toMatch(/REVOKE ALL ON FUNCTION public\.apply_order_confirmed_routing\(UUID, UUID, UUID, TEXT, UUID\) FROM PUBLIC, anon, authenticated/)
    expect(code).toMatch(/GRANT EXECUTE ON FUNCTION public\.apply_order_confirmed_routing\(UUID, UUID, UUID, TEXT, UUID\) TO service_role/)
    expect(fn).toMatch(/'order_confirmed'/)
    expect(fn).toMatch(/ON CONFLICT DO NOTHING/)
  })

  it('derive_conversation_to_commercial: actor from auth.uid(), flag + role checks, row lock, ONLY logistics -> shared, idempotent, no order/message writes', () => {
    const fn = fnOf('CREATE OR REPLACE FUNCTION public.derive_conversation_to_commercial(')
    expect(fn).toMatch(/SECURITY DEFINER\s+SET search_path = public/)
    expect(fn).toMatch(/v_uid UUID := auth\.uid\(\)/)
    expect(fn).not.toMatch(/p_account|p_actor|p_stage/)
    expect(fn).toMatch(/v_conv_account <> v_account/)
    expect(fn).toMatch(/logistics_mvp_enabled/)
    expect(fn).toMatch(/v_role NOT IN \('logistics', 'supervisor'\)/)
    expect(fn).toMatch(/Viewers cannot derive/) // viewers are read-only, whatever their area
    expect(fn).toMatch(/FOR UPDATE/)
    expect(fn).toMatch(/IF NOT FOUND OR v_stage = 'commercial' THEN\s+RAISE EXCEPTION 'invalid_transition'/)
    expect(fn).toMatch(/IF v_stage = 'shared' THEN\s+RETURN QUERY SELECT 'shared'::TEXT, FALSE/)
    expect(fn).toMatch(/SET stage = 'shared'/)
    expect(fn).not.toMatch(/UPDATE (order_confirmations|messages|conversations)\b/i)
    expect(fn).not.toMatch(/INSERT INTO (messages|order_confirmations)/i)
    expect(code).toMatch(/GRANT EXECUTE ON FUNCTION public\.derive_conversation_to_commercial\(UUID\) TO authenticated/)
    expect(code).toMatch(/REVOKE ALL ON FUNCTION public\.derive_conversation_to_commercial\(UUID\) FROM PUBLIC, anon/)
  })

  it('helper: same signature and hardening, stage from conversation_routing (absent = commercial), flag OFF = legacy, matrix per role', () => {
    const fn = fnOf('CREATE OR REPLACE FUNCTION public.conversation_operational_access(')
    expect(fn).toMatch(/RETURNS BOOLEAN\s+LANGUAGE plpgsql\s+STABLE\s+SECURITY DEFINER\s+SET search_path = public/)
    expect(fn).toMatch(/COALESCE\(r\.stage, 'commercial'\)/)
    expect(fn).toMatch(/LEFT JOIN conversation_routing r ON r\.conversation_id = p_conversation_id AND r\.account_id = p_account_id/)
    expect(fn).not.toMatch(/order_confirmations/) // the stage no longer depends on orders
    expect(fn.indexOf('IF NOT v_enabled THEN')).toBeLessThan(fn.indexOf("v_role = 'supervisor'"))
    expect(fn).toMatch(/IF NOT v_member OR v_role IS NULL THEN\s+RETURN FALSE/)
    expect(fn).toMatch(/v_role = 'commercial' THEN\s+RETURN v_stage IN \('commercial', 'shared'\)/)
    expect(fn).toMatch(/v_role = 'logistics' THEN\s+RETURN v_stage IN \('logistics', 'shared'\)/)
    expect(fn).toMatch(/IF v_role = 'supervisor' THEN\s+RETURN TRUE/)
    expect(fn).toMatch(/v_uid UUID := auth\.uid\(\)/)
  })

  it('backfill: only conversations WITH an order become logistics (reason backfill, once per conversation); nothing is deleted; no destructive DDL beyond the superseded index', () => {
    expect(code).toMatch(/INSERT INTO public\.conversation_routing \(conversation_id, account_id, stage, updated_by, version\)\s+SELECT f\.conversation_id, f\.account_id, 'logistics', NULL, 1 FROM first_order f\s+ON CONFLICT \(conversation_id\) DO NOTHING/)
    expect(code).toMatch(/'commercial', 'logistics', 'backfill'/)
    // only accounts with the flag ON; service_role only; reusable per account (the procedure before enabling the flag later)
    const bf = fnOf('CREATE OR REPLACE FUNCTION public.backfill_conversation_routing(')
    expect(bf).toMatch(/JOIN public\.order_integration_settings s ON s\.account_id = o\.account_id AND s\.logistics_mvp_enabled/)
    expect(bf).toMatch(/p_account IS NULL OR o\.account_id = p_account/)
    expect(bf).toMatch(/ON CONFLICT \(conversation_id\) DO NOTHING/)
    expect(code).toMatch(/REVOKE ALL ON FUNCTION public\.backfill_conversation_routing\(UUID\) FROM PUBLIC, anon, authenticated/)
    expect(code).toMatch(/GRANT EXECUTE ON FUNCTION public\.backfill_conversation_routing\(UUID\) TO service_role/)
    expect(code).toMatch(/conversation_routing_events_backfill_once\s+ON public\.conversation_routing_events \(conversation_id\) WHERE reason = 'backfill'/)
    expect(code).not.toMatch(/\bDELETE\s+FROM\b|\bTRUNCATE\b|\bDROP\s+(TABLE|COLUMN)\b/i)
    // DROP POLICY / DROP TRIGGER only ever re-create this migration's OWN objects (the migration is re-runnable)
    expect(code.match(/DROP POLICY IF EXISTS \w+/g)).toEqual(['DROP POLICY IF EXISTS conversation_routing_select', 'DROP POLICY IF EXISTS conversation_routing_events_select'])
    expect(code).not.toMatch(/\bUPDATE\s+(public\.)?(messages|order_confirmations|conversations)\b/i)
    expect(code.match(/\bDROP INDEX\b[^;]*;/g)).toEqual(['DROP INDEX IF EXISTS public.order_confirmations_account_conversation_idx;'])
  })

  it('does not touch operational_role, delivery_status, conversations.status or messages', () => {
    expect(code).not.toMatch(/ALTER TABLE public\.(messages|order_confirmations)/)
    expect(code).not.toMatch(/ALTER TYPE|operational_role_enum\s+ADD/i)
    expect(code).not.toMatch(/conversations\.status|SET status|delivery_status\s*=/)
  })
})
