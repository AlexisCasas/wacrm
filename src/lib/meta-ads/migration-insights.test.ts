import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// Static guards on the insights migration text (the SQL itself is validated by the QA script / pre-deploy checks, not here).
const sql = readFileSync(path.join(process.cwd(), 'supabase/migrations/20261117000000_meta_ads_insights.sql'), 'utf8')
const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')

describe('20261117000000_meta_ads_insights.sql', () => {
  it('creates the four new tables and two functions; touches no WACRM metric function or pre-existing table', () => {
    expect([...code.matchAll(/CREATE TABLE public\.(\w+)/g)].map((m) => m[1]).sort()).toEqual(['meta_ads_adsets', 'meta_ads_campaigns', 'meta_ads_insights_daily', 'meta_ads_reconciliation'])
    expect([...code.matchAll(/CREATE FUNCTION public\.(\w+)/g)].map((m) => m[1]).sort()).toEqual(['meta_ads_insights_totals', 'meta_ads_performance'])
    expect([...code.matchAll(/ALTER TABLE public\.(\w+)/g)].map((m) => m[1]).filter((t) => !t.startsWith('meta_ads_'))).toEqual([])
    expect(code).not.toMatch(/\bDROP (TABLE|FUNCTION|POLICY|INDEX|TRIGGER)\b|CREATE OR REPLACE|INSERT INTO|^\s*UPDATE\b|^\s*DELETE FROM/im)
    for (const untouched of ['ads_results_report', 'ads_results_by_product', 'ads_results_product_ad_breakdown', 'order_ad_attribution', 'contact_ad_attributions', 'order_confirmations']) expect(code).not.toContain(untouched)
  })
  it('daily insights: PK (account_id, ad_id, date), NUMERIC spend (no float), BIGINT counters, date from Meta, currency stored', () => {
    expect(code).toContain('PRIMARY KEY (account_id, ad_id, date)')
    expect(code).toMatch(/\bdate DATE NOT NULL/)
    expect(code).toMatch(/spend NUMERIC\(18, 4\) NOT NULL/)
    expect(code).toMatch(/impressions BIGINT NOT NULL/)
    expect(code).toMatch(/clicks BIGINT NOT NULL/)
    expect(code).toMatch(/reach BIGINT,/)
    expect(code).toMatch(/currency TEXT NOT NULL/)
    expect(code).not.toMatch(/\b(real|double precision|float\d?)\b/i)
  })
  it('reach is never aggregated or returned; ratios are not stored; no CPA/ROAS/cost-per-contact', () => {
    const fn = code.slice(code.indexOf('CREATE FUNCTION public.meta_ads_performance'))
    expect(fn).not.toMatch(/reach/i)
    expect(code).not.toMatch(/SUM\(\s*\w*\.?reach/i)
    expect(code).not.toMatch(/\b(ctr|cpc|cpm|cpa|roas)\b\s+(NUMERIC|DOUBLE|REAL|INTEGER|BIGINT)/i)
    expect(code).not.toMatch(/captured_at|contact_ad/i) // WACRM timestamps/attribution are never used for Meta metrics
  })
  it('security: the new tables are service_role-written, member-readable (RLS on); the read function is SECURITY INVOKER + guarded; totals are service_role only', () => {
    for (const t of ['meta_ads_campaigns', 'meta_ads_adsets', 'meta_ads_insights_daily', 'meta_ads_reconciliation']) expect(code).toContain(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY`)
    expect(code).toContain("public.is_account_member(account_id, 'agent')")
    expect(code).toContain('REVOKE ALL ON FUNCTION public.meta_ads_performance(UUID, DATE, DATE, TEXT) FROM PUBLIC, anon')
    expect(code).toContain('REVOKE ALL ON FUNCTION public.meta_ads_insights_totals(UUID, DATE, DATE) FROM PUBLIC, anon, authenticated')
    expect(code).toContain("public.is_account_member(p_account, 'agent')")
    expect(code).not.toMatch(/SECURITY DEFINER/i)
    expect(code).not.toMatch(/GRANT[^;]*meta_ads_insights_totals[^;]*authenticated/)
  })
  it('groups by Meta ids, never by name', () => {
    const fn = code.slice(code.indexOf('CREATE FUNCTION public.meta_ads_performance'))
    expect(fn).toMatch(/GROUP BY d\.sid/)
    expect(fn).toMatch(/GROUP BY d\.cid/)
    expect(fn).not.toMatch(/GROUP BY[^\n]*(name)/i)
  })
})
