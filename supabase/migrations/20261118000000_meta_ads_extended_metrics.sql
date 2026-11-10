-- ============================================================
-- 20261118000000_meta_ads_extended_metrics
--
-- Meta Ads integration, last functional increment before the first deploy: NON-ADDITIVE metrics per range (reach, frequency), link / outbound clicks, Meta "actions"
-- (messaging results and others) and the secondary catalog details that the live audit confirmed. Must order AFTER 20261117000000_meta_ads_insights.
-- 20261116 and 20261117 are NOT modified: everything extra lives here.
-- ADDITIVE: two new tables, one new read function, nullable columns on the Meta Ads catalog tables and a widened CHECK on meta_ads_sync_state. No pre-existing WACRM table,
-- function or policy is touched (ads_results_report, ads_results_by_product, ads_results_product_ad_breakdown and order_ad_attribution are NOT modified), so the previous
-- application image keeps working. Reversible with docs/integrations/meta-ads/ROLLBACK-extended.sql.
--
-- Why a range cache: Meta's reach is a count of DISTINCT people and is NOT additive (the live audit: sum of daily reach > aggregated reach for 27 of 29 ads, and the sum of ads' reach
-- 1,854,280 vs 1,191,117 for the account). Reach and frequency are therefore stored exactly as Meta returns them for the whole window (7/30/90 complete days before today, Meta dates in
-- America/Bogota) and per level (account / campaign / adset / ad). They are never rebuilt from the daily rows.
--
--   meta_ads_insights_range   one row per (account, level, entity, days) = the latest aggregated window for that entity. since/until say which window it answers; the read function
--                             only returns a row when the requested window matches EXACTLY (a stale row is ignored, never shown as current).
--   meta_ads_actions_range    one row per (account, level, entity, days, action_type): Meta's `actions` list as-is (no aliases merged, no action_values: the audit found none).
-- ============================================================

-- 1) Job list: the aggregated-range sync is a fifth job ---------------------------
ALTER TABLE public.meta_ads_sync_state DROP CONSTRAINT meta_ads_sync_state_job;
ALTER TABLE public.meta_ads_sync_state
  ADD CONSTRAINT meta_ads_sync_state_job CHECK (job IN ('catalog', 'adsets', 'campaigns', 'insights', 'ranges'));

-- 2) Secondary catalog details confirmed by the live audit (all nullable; shown in the expandable detail only) ---------
-- Budgets are Meta's minor currency units as integers (PEN: centimos); the app converts for display.
ALTER TABLE public.meta_ads_campaigns
  ADD COLUMN objective TEXT,
  ADD COLUMN buying_type TEXT,
  ADD COLUMN daily_budget BIGINT,
  ADD COLUMN lifetime_budget BIGINT,
  ADD COLUMN start_time TIMESTAMPTZ,
  ADD COLUMN stop_time TIMESTAMPTZ,
  ADD COLUMN created_time TIMESTAMPTZ,
  ADD COLUMN updated_time TIMESTAMPTZ;
ALTER TABLE public.meta_ads_adsets
  ADD COLUMN optimization_goal TEXT,
  ADD COLUMN billing_event TEXT,
  ADD COLUMN bid_strategy TEXT,
  ADD COLUMN daily_budget BIGINT,
  ADD COLUMN lifetime_budget BIGINT,
  ADD COLUMN start_time TIMESTAMPTZ,
  ADD COLUMN end_time TIMESTAMPTZ,
  ADD COLUMN created_time TIMESTAMPTZ,
  ADD COLUMN updated_time TIMESTAMPTZ;

-- 3) Aggregated range metrics -----------------------------------------------------
CREATE TABLE public.meta_ads_insights_range (
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  level TEXT NOT NULL,
  -- Meta id of the campaign / ad set / ad; for level = 'account', the numeric Ad Account id (no act_ prefix).
  entity_id TEXT NOT NULL,
  days INTEGER NOT NULL,
  since DATE NOT NULL,
  until DATE NOT NULL,
  spend NUMERIC(18, 4) NOT NULL DEFAULT 0,
  impressions BIGINT NOT NULL DEFAULT 0,
  clicks BIGINT NOT NULL DEFAULT 0,
  reach BIGINT,
  -- Exactly what Meta returned for the window (validated: frequency = impressions / reach). NULL when Meta did not return it.
  frequency NUMERIC(12, 4),
  ctr NUMERIC(14, 6),
  cpc NUMERIC(18, 6),
  cpm NUMERIC(18, 6),
  inline_link_clicks BIGINT,
  -- Value of the `outbound_click` entry of Meta's outbound_clicks list.
  outbound_clicks BIGINT,
  currency TEXT NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, level, entity_id, days),
  CONSTRAINT meta_ads_range_level CHECK (level IN ('account', 'campaign', 'adset', 'ad')),
  CONSTRAINT meta_ads_range_days CHECK (days IN (7, 30, 90)),
  CONSTRAINT meta_ads_range_entity CHECK (entity_id ~ '^[0-9]{6,25}$'),
  CONSTRAINT meta_ads_range_window CHECK (until >= since),
  CONSTRAINT meta_ads_range_currency CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT meta_ads_range_nonneg CHECK (spend >= 0 AND impressions >= 0 AND clicks >= 0 AND (reach IS NULL OR reach >= 0) AND (frequency IS NULL OR frequency >= 0)
    AND (inline_link_clicks IS NULL OR inline_link_clicks >= 0) AND (outbound_clicks IS NULL OR outbound_clicks >= 0))
);

-- 4) Actions per range: Meta's own `action_type` strings, one row each ---------------------------------
CREATE TABLE public.meta_ads_actions_range (
  account_id UUID NOT NULL,
  level TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  days INTEGER NOT NULL,
  action_type TEXT NOT NULL,
  since DATE NOT NULL,
  until DATE NOT NULL,
  value NUMERIC(20, 4) NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, level, entity_id, days, action_type),
  -- An action row can only exist next to the range row it belongs to; removing/replacing that range removes its actions.
  CONSTRAINT meta_ads_actions_range_fk FOREIGN KEY (account_id, level, entity_id, days)
    REFERENCES public.meta_ads_insights_range (account_id, level, entity_id, days) ON DELETE CASCADE,
  CONSTRAINT meta_ads_actions_type CHECK (action_type ~ '^[A-Za-z0-9_.:-]{1,120}$'),
  CONSTRAINT meta_ads_actions_value CHECK (value >= 0),
  CONSTRAINT meta_ads_actions_window CHECK (until >= since)
);

-- Security: service_role writes; members of the owning account read (no secrets here).
ALTER TABLE public.meta_ads_insights_range ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meta_ads_actions_range ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.meta_ads_insights_range, public.meta_ads_actions_range FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.meta_ads_insights_range, public.meta_ads_actions_range TO service_role;
GRANT SELECT ON public.meta_ads_insights_range, public.meta_ads_actions_range TO authenticated;
CREATE POLICY meta_ads_range_member_read ON public.meta_ads_insights_range FOR SELECT TO authenticated USING (public.is_account_member(account_id, 'agent'));
CREATE POLICY meta_ads_actions_member_read ON public.meta_ads_actions_range FOR SELECT TO authenticated USING (public.is_account_member(account_id, 'agent'));

-- 5) Read function ---------------------------------------------------------------------
-- meta_ads_range_metrics: one row per entity of p_level with Meta's EXACT aggregated metrics for the window, and its actions as one jsonb object {action_type: value}.
-- Only rows whose stored window equals (p_days, p_since, p_until) are returned. Nothing is summed or recomputed here (reach is never an aggregate of anything).
-- SECURITY INVOKER (RLS applies) + agent+ membership of p_account.
CREATE FUNCTION public.meta_ads_range_metrics(p_account UUID, p_days INTEGER, p_since DATE, p_until DATE, p_level TEXT)
RETURNS TABLE (
  id TEXT, spend NUMERIC, impressions BIGINT, clicks BIGINT, reach BIGINT, frequency NUMERIC,
  inline_link_clicks BIGINT, outbound_clicks BIGINT, synced_at TIMESTAMPTZ, actions JSONB
)
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT r.entity_id, r.spend, r.impressions, r.clicks, r.reach, r.frequency, r.inline_link_clicks, r.outbound_clicks, r.synced_at,
         COALESCE((SELECT jsonb_object_agg(a.action_type, a.value)
                   FROM public.meta_ads_actions_range a
                   WHERE a.account_id = r.account_id AND a.level = r.level AND a.entity_id = r.entity_id AND a.days = r.days
                     AND a.since = r.since AND a.until = r.until), '{}'::jsonb)
  FROM public.meta_ads_insights_range r
  WHERE public.is_account_member(p_account, 'agent')
    AND r.account_id = p_account AND r.level = p_level AND r.days = p_days AND r.since = p_since AND r.until = p_until
$$;

REVOKE ALL ON FUNCTION public.meta_ads_range_metrics(UUID, INTEGER, DATE, DATE, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.meta_ads_range_metrics(UUID, INTEGER, DATE, DATE, TEXT) TO authenticated, service_role;
