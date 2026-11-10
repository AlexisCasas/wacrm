-- ============================================================
-- 20261117000000_meta_ads_insights
--
-- Meta Ads integration, phases 3-4: campaigns/ad sets catalog + DAILY INSIGHTS (spend, impressions, clicks, reach) + read layer + reconciliation.
-- Must order AFTER 20261116000000_meta_ads_catalog (it extends meta_ads_sync_state / meta_ads_settings created there).
-- ADDITIVE: new tables and functions, plus two compatible ALTERs on the tables created by 20261116000000 (widen a CHECK, add nullable/defaulted columns).
-- No pre-existing WACRM table, function or policy is touched (ads_results_report, ads_results_by_product, ads_results_product_ad_breakdown and
-- order_ad_attribution are NOT modified), so the previous application image keeps working. Reversible with docs/integrations/meta-ads/ROLLBACK-insights.sql.
--
-- Rules baked into the schema:
--   * insights.date is Meta's `date_start` (a calendar day in the AD ACCOUNT's timezone, America/Bogota). It is never derived from WACRM timestamps
--     (contact_ad_attributions.captured_at is NOT used for any Meta metric).
--   * spend is NUMERIC (never float). impressions / clicks / reach are BIGINT.
--   * reach is stored per day as INFORMATION ONLY. Reach is not additive: no function here sums it, and none returns it.
--   * CTR / CPC / CPM are NOT stored: they are computed by the application from the TOTALS (clicks/impressions, spend/clicks, spend/impressions).
-- ============================================================

-- 1) Compatible extensions of the 20261116000000 tables -------------------------
ALTER TABLE public.meta_ads_sync_state DROP CONSTRAINT meta_ads_sync_state_job;
ALTER TABLE public.meta_ads_sync_state
  ADD CONSTRAINT meta_ads_sync_state_job CHECK (job IN ('catalog', 'adsets', 'campaigns', 'insights')),
  -- insights only: the contiguous range of days (Meta dates) already stored. Backfill extends covered_from downwards.
  ADD COLUMN covered_from DATE,
  ADD COLUMN covered_to DATE;
ALTER TABLE public.meta_ads_settings
  ADD COLUMN insights_interval_minutes INTEGER NOT NULL DEFAULT 180,
  ADD CONSTRAINT meta_ads_settings_insights_interval CHECK (insights_interval_minutes BETWEEN 15 AND 1440);

-- 2) Campaigns and ad sets (names + status, keyed by Meta ids) ------------------
CREATE TABLE public.meta_ads_campaigns (
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  campaign_id TEXT NOT NULL,
  name TEXT,
  status TEXT,
  effective_status TEXT,
  first_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, campaign_id),
  CONSTRAINT meta_ads_campaigns_id CHECK (campaign_id ~ '^[0-9]{6,25}$')
);
CREATE TABLE public.meta_ads_adsets (
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  adset_id TEXT NOT NULL,
  name TEXT,
  campaign_id TEXT,
  status TEXT,
  effective_status TEXT,
  first_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, adset_id),
  CONSTRAINT meta_ads_adsets_id CHECK (adset_id ~ '^[0-9]{6,25}$')
);

-- 3) Daily insights, level = ad -------------------------------------------------
CREATE TABLE public.meta_ads_insights_daily (
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  ad_id TEXT NOT NULL,
  date DATE NOT NULL,
  -- Parents and names as Meta returned them with the row: ids are the grouping keys, names are only a display fallback for a partial catalog.
  campaign_id TEXT,
  adset_id TEXT,
  ad_name TEXT,
  adset_name TEXT,
  campaign_name TEXT,
  impressions BIGINT NOT NULL DEFAULT 0,
  clicks BIGINT NOT NULL DEFAULT 0,
  spend NUMERIC(18, 4) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL,
  reach BIGINT,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, ad_id, date),
  CONSTRAINT meta_ads_insights_ad_id CHECK (ad_id ~ '^[0-9]{6,25}$'),
  CONSTRAINT meta_ads_insights_currency CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT meta_ads_insights_nonneg CHECK (impressions >= 0 AND clicks >= 0 AND spend >= 0 AND (reach IS NULL OR reach >= 0))
);
CREATE INDEX idx_meta_ads_insights_account_date ON public.meta_ads_insights_daily (account_id, date);

-- 4) Reconciliation of the local sums against Meta's account-level totals (latest result per window) ------
CREATE TABLE public.meta_ads_reconciliation (
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  window_days INTEGER NOT NULL,
  date_from DATE NOT NULL,
  date_to DATE NOT NULL,
  local_spend NUMERIC(18, 4) NOT NULL,
  meta_spend NUMERIC(18, 4) NOT NULL,
  local_impressions BIGINT NOT NULL,
  meta_impressions BIGINT NOT NULL,
  local_clicks BIGINT NOT NULL,
  meta_clicks BIGINT NOT NULL,
  ok BOOLEAN NOT NULL,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, window_days),
  CONSTRAINT meta_ads_reconciliation_window CHECK (window_days IN (7, 30, 90))
);

-- Security: written by service_role only; readable by members of the owning account (no secrets here).
ALTER TABLE public.meta_ads_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meta_ads_adsets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meta_ads_insights_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meta_ads_reconciliation ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.meta_ads_campaigns, public.meta_ads_adsets, public.meta_ads_insights_daily, public.meta_ads_reconciliation FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.meta_ads_campaigns, public.meta_ads_adsets, public.meta_ads_insights_daily, public.meta_ads_reconciliation TO service_role;
GRANT SELECT ON public.meta_ads_campaigns, public.meta_ads_adsets, public.meta_ads_insights_daily, public.meta_ads_reconciliation TO authenticated;
CREATE POLICY meta_ads_campaigns_member_read ON public.meta_ads_campaigns FOR SELECT TO authenticated USING (public.is_account_member(account_id, 'agent'));
CREATE POLICY meta_ads_adsets_member_read ON public.meta_ads_adsets FOR SELECT TO authenticated USING (public.is_account_member(account_id, 'agent'));
CREATE POLICY meta_ads_insights_member_read ON public.meta_ads_insights_daily FOR SELECT TO authenticated USING (public.is_account_member(account_id, 'agent'));
CREATE POLICY meta_ads_reconciliation_member_read ON public.meta_ads_reconciliation FOR SELECT TO authenticated USING (public.is_account_member(account_id, 'agent'));

-- 5) Read layer ---------------------------------------------------------------------
-- meta_ads_performance: one row per campaign / ad set / ad (p_level = 'campaign' | 'adset' | 'ad'; anything else => no rows) with the SUMS of spend,
-- impressions and clicks over Meta dates p_from..p_to (inclusive). Grouping is by Meta ids, never by name. Ratios are NOT computed here: the app derives
-- CTR/CPC/CPM from these totals. reach is deliberately not returned (not additive). Names: catalog first, then the name carried by the insights row;
-- status comes from the catalog tables only (NULL when not synced). SECURITY INVOKER (RLS applies) + agent+ membership of p_account.
-- Summing the rows of any level gives the same totals as summing the rows of another level.
CREATE FUNCTION public.meta_ads_performance(p_account UUID, p_from DATE, p_to DATE, p_level TEXT)
RETURNS TABLE (
  id TEXT, name TEXT, status TEXT,
  campaign_id TEXT, campaign_name TEXT, adset_id TEXT, adset_name TEXT,
  spend NUMERIC, impressions BIGINT, clicks BIGINT, active_days INTEGER
)
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH guard AS (SELECT public.is_account_member(p_account, 'agent') AS ok),
  per_ad AS (
    SELECT i.ad_id,
           SUM(i.spend) AS spend, SUM(i.impressions)::BIGINT AS impressions, SUM(i.clicks)::BIGINT AS clicks, COUNT(*)::INTEGER AS days,
           (array_agg(i.campaign_id ORDER BY i.date DESC) FILTER (WHERE i.campaign_id IS NOT NULL))[1] AS campaign_id,
           (array_agg(i.adset_id ORDER BY i.date DESC) FILTER (WHERE i.adset_id IS NOT NULL))[1] AS adset_id,
           (array_agg(i.ad_name ORDER BY i.date DESC) FILTER (WHERE i.ad_name IS NOT NULL))[1] AS ad_name,
           (array_agg(i.adset_name ORDER BY i.date DESC) FILTER (WHERE i.adset_name IS NOT NULL))[1] AS adset_name,
           (array_agg(i.campaign_name ORDER BY i.date DESC) FILTER (WHERE i.campaign_name IS NOT NULL))[1] AS campaign_name
    FROM public.meta_ads_insights_daily i, guard
    WHERE guard.ok AND i.account_id = p_account AND i.date BETWEEN p_from AND p_to
    GROUP BY i.ad_id
  ),
  ads AS (
    SELECT p.ad_id,
           COALESCE(a.campaign_id, p.campaign_id, '(sin id)') AS cid,
           COALESCE(a.adset_id, p.adset_id, '(sin id)') AS sid,
           COALESCE(a.name, p.ad_name) AS ad_name,
           COALESCE(a.effective_status, a.status) AS ad_status,
           COALESCE(s.name, p.adset_name, a.adset_name) AS adset_name,
           COALESCE(s.effective_status, s.status) AS adset_status,
           COALESCE(c.name, p.campaign_name, a.campaign_name) AS campaign_name,
           COALESCE(c.effective_status, c.status) AS campaign_status,
           p.spend, p.impressions, p.clicks, p.days
    FROM per_ad p
    LEFT JOIN public.meta_ads_ads a ON a.account_id = p_account AND a.ad_id = p.ad_id
    LEFT JOIN public.meta_ads_adsets s ON s.account_id = p_account AND s.adset_id = COALESCE(a.adset_id, p.adset_id)
    LEFT JOIN public.meta_ads_campaigns c ON c.account_id = p_account AND c.campaign_id = COALESCE(a.campaign_id, p.campaign_id)
  )
  SELECT x.* FROM (
    SELECT d.ad_id, d.ad_name, d.ad_status, d.cid, d.campaign_name, d.sid, d.adset_name, d.spend, d.impressions, d.clicks, d.days
    FROM ads d WHERE p_level = 'ad'
    UNION ALL
    SELECT d.sid, MAX(d.adset_name), MAX(d.adset_status), MAX(d.cid), MAX(d.campaign_name), d.sid, MAX(d.adset_name),
           SUM(d.spend), SUM(d.impressions)::BIGINT, SUM(d.clicks)::BIGINT, MAX(d.days)
    FROM ads d WHERE p_level = 'adset' GROUP BY d.sid
    UNION ALL
    SELECT d.cid, MAX(d.campaign_name), MAX(d.campaign_status), d.cid, MAX(d.campaign_name), NULL, NULL,
           SUM(d.spend), SUM(d.impressions)::BIGINT, SUM(d.clicks)::BIGINT, MAX(d.days)
    FROM ads d WHERE p_level = 'campaign' GROUP BY d.cid
  ) x
$$;

REVOKE ALL ON FUNCTION public.meta_ads_performance(UUID, DATE, DATE, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.meta_ads_performance(UUID, DATE, DATE, TEXT) TO authenticated, service_role;

-- meta_ads_insights_totals: local sums used ONLY by the reconciliation job (service_role).
CREATE FUNCTION public.meta_ads_insights_totals(p_account UUID, p_from DATE, p_to DATE)
RETURNS TABLE (spend NUMERIC, impressions BIGINT, clicks BIGINT)
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT COALESCE(SUM(i.spend), 0), COALESCE(SUM(i.impressions), 0)::BIGINT, COALESCE(SUM(i.clicks), 0)::BIGINT
  FROM public.meta_ads_insights_daily i
  WHERE i.account_id = p_account AND i.date BETWEEN p_from AND p_to
$$;

REVOKE ALL ON FUNCTION public.meta_ads_insights_totals(UUID, DATE, DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.meta_ads_insights_totals(UUID, DATE, DATE) TO service_role;
