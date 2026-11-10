import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// Static guards on the migration text (the SQL itself is validated by the QA script / pre-deploy checks, not here).
const sql = readFileSync(path.join(process.cwd(), 'supabase/migrations/20261116000000_meta_ads_catalog.sql'), 'utf8')
const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')

describe('20261116000000_meta_ads_catalog.sql', () => {
  it('is purely additive: creates only the three new tables and one new function; alters/drops nothing existing', () => {
    expect([...code.matchAll(/CREATE TABLE public\.(\w+)/g)].map((m) => m[1]).sort()).toEqual(['meta_ads_ads', 'meta_ads_settings', 'meta_ads_sync_state'])
    expect([...code.matchAll(/CREATE FUNCTION public\.(\w+)/g)].map((m) => m[1])).toEqual(['ads_results_meta_catalog'])
    expect(code).not.toMatch(/\bDROP\b|ALTER TABLE public\.(?!meta_ads_)|CREATE OR REPLACE|INSERT INTO|^\s*UPDATE\b|^\s*DELETE FROM/im)
    for (const untouched of ['ads_results_report', 'ads_results_by_product', 'ads_results_product_ad_breakdown', 'order_ad_attribution']) expect(code).not.toContain(untouched)
  })
  it('token and sync internals are service_role only; RLS is on for all three tables; the catalog is member-readable only', () => {
    for (const t of ['meta_ads_settings', 'meta_ads_ads', 'meta_ads_sync_state']) expect(code).toContain(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY`)
    expect(code).toContain('REVOKE ALL ON public.meta_ads_settings FROM PUBLIC, anon, authenticated')
    expect(code).toContain('REVOKE ALL ON public.meta_ads_sync_state FROM PUBLIC, anon, authenticated')
    expect(code).not.toMatch(/GRANT[^;]*ON public\.meta_ads_settings[^;]*TO[^;]*(authenticated|anon|PUBLIC)/)
    expect(code).not.toMatch(/GRANT[^;]*ON public\.meta_ads_sync_state[^;]*TO[^;]*(authenticated|anon|PUBLIC)/)
    expect(code).toContain('GRANT SELECT ON public.meta_ads_ads TO authenticated')
    expect(code).toContain("public.is_account_member(account_id, 'agent')")
    expect(code).not.toMatch(/CREATE POLICY[^;]*meta_ads_(settings|sync_state)/)
    expect(code).toContain('REVOKE ALL ON FUNCTION public.ads_results_meta_catalog(UUID, TEXT[]) FROM PUBLIC, anon')
  })
  it('keeps the Meta Ad ID as TEXT, creates no settings row, and stores NO insights/spend/clicks/reach columns', () => {
    expect(code).toMatch(/ad_id TEXT NOT NULL/)
    expect(code).not.toMatch(/\b(spend|impressions|reach|clicks|ctr|cpc|cpm|cpa|roas)\b/i)
    expect(code).not.toMatch(/INSERT INTO/i)
    expect(code).toMatch(/enabled BOOLEAN NOT NULL DEFAULT FALSE/)
    expect(code).toContain("CONSTRAINT meta_ads_settings_complete CHECK (NOT enabled OR (ad_account_id IS NOT NULL AND access_token_enc IS NOT NULL))")
  })
  it('the lookup is SECURITY INVOKER (no DEFINER), STABLE and membership-guarded', () => {
    expect(code).toMatch(/LANGUAGE sql STABLE SET search_path = public/)
    expect(code).not.toMatch(/SECURITY DEFINER/i)
  })
})
