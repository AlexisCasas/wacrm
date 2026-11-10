import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// Static guards on 20261118 (the SQL itself is validated by qa/meta-ads/run-sql-qa.sh).
const read = (f: string) => readFileSync(path.join(process.cwd(), 'supabase/migrations', f), 'utf8')
const sql = read('20261118000000_meta_ads_extended_metrics.sql')
const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')

describe('20261118000000_meta_ads_extended_metrics.sql', () => {
  it('creates exactly the two range tables and the read function; the previous migrations stay immutable', () => {
    expect([...code.matchAll(/CREATE TABLE public\.(\w+)/g)].map((m) => m[1]).sort()).toEqual(['meta_ads_actions_range', 'meta_ads_insights_range'])
    expect([...code.matchAll(/CREATE FUNCTION public\.(\w+)/g)].map((m) => m[1])).toEqual(['meta_ads_range_metrics'])
    expect([...code.matchAll(/ALTER TABLE public\.(\w+)/g)].map((m) => m[1]).filter((t) => !t.startsWith('meta_ads_'))).toEqual([])
    expect(code).not.toMatch(/\bDROP (TABLE|FUNCTION|POLICY|INDEX|TRIGGER)\b|CREATE OR REPLACE|INSERT INTO|^\s*UPDATE\b|^\s*DELETE FROM/im)
    for (const untouched of ['ads_results_report', 'ads_results_by_product', 'ads_results_product_ad_breakdown', 'order_ad_attribution', 'contact_ad_attributions', 'order_confirmations']) expect(code).not.toContain(untouched)
  })
  it('range cache is keyed by (account, level, entity, days) and stores the window; actions are one row per action_type and follow their range row', () => {
    expect(code).toContain('PRIMARY KEY (account_id, level, entity_id, days)')
    expect(code).toContain('PRIMARY KEY (account_id, level, entity_id, days, action_type)')
    expect(code).toMatch(/since DATE NOT NULL/)
    expect(code).toMatch(/until DATE NOT NULL/)
    expect(code).toMatch(/reach BIGINT,/)
    expect(code).toMatch(/frequency NUMERIC\(12, 4\)/)
    expect(code).toMatch(/spend NUMERIC\(18, 4\)/)
    expect(code).toContain('ON DELETE CASCADE')
    expect(code).not.toMatch(/action_values/i)
    expect(code).not.toMatch(/\b(real|double precision|float\d?)\b/i)
  })
  it('reach is never aggregated by the read function; only actions are aggregated (jsonb_object_agg)', () => {
    const fn = code.slice(code.indexOf('CREATE FUNCTION public.meta_ads_range_metrics'))
    expect(fn).toContain('jsonb_object_agg')
    expect(fn).not.toMatch(/\bsum\s*\(/i)
    expect(fn).not.toMatch(/token/i)
    expect(fn).toMatch(/r\.since = p_since AND r\.until = p_until/)
  })
  it('security: RLS on, service_role writes, members read, function SECURITY INVOKER + membership-guarded, anon revoked', () => {
    for (const t of ['meta_ads_insights_range', 'meta_ads_actions_range']) expect(code).toContain(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY`)
    expect(code).toContain('REVOKE ALL ON public.meta_ads_insights_range, public.meta_ads_actions_range FROM PUBLIC, anon, authenticated')
    expect(code).toContain('GRANT SELECT ON public.meta_ads_insights_range, public.meta_ads_actions_range TO authenticated')
    expect(code).not.toMatch(/GRANT (ALL|INSERT|UPDATE|DELETE)[^;]*TO[^;]*authenticated/)
    expect(code).toContain("public.is_account_member(p_account, 'agent')")
    expect(code).toContain('REVOKE ALL ON FUNCTION public.meta_ads_range_metrics(UUID, INTEGER, DATE, DATE, TEXT) FROM PUBLIC, anon')
    expect(code).not.toMatch(/SECURITY DEFINER/i)
  })
  it('20261116 and 20261117 do not mention anything of 20261118 (immutable)', () => {
    for (const f of ['20261116000000_meta_ads_catalog.sql', '20261117000000_meta_ads_insights.sql']) {
      const s = read(f)
      expect(s).not.toMatch(/meta_ads_insights_range|meta_ads_actions_range|'ranges'|objective|buying_type/)
    }
  })
})
