-- ============================================================
-- 20261116000000_meta_ads_catalog
--
-- Meta Ads integration, phases 1-2: foundation + AD CATALOG ONLY (names, campaign/adset, status).
-- PURELY ADDITIVE: three new tables and one new read-only function. No existing table, column, policy, trigger or function is touched
-- (ads_results_report, ads_results_by_product, ads_results_product_ad_breakdown and order_ad_attribution are NOT modified), so the previous
-- application image keeps working (image-only rollback; the new objects are then unused). Reversible with
-- docs/integrations/meta-ads/ROLLBACK-catalog.sql.
--
-- NOTHING IS CALLED ON META until (1) the process env META_ADS_ENABLED=true AND (2) meta_ads_settings.enabled = TRUE for the account.
-- Both are OFF by default; this migration creates NO settings row for any account (the ops script does, with enabled = FALSE).
-- NO insights, spend, impressions, reach, clicks, CTR, CPC, CPM, CPA or ROAS storage exists here, on purpose.
--
--   1. meta_ads_settings    per-account Meta Ad Account + token (encrypted, same AES-256-GCM scheme as whatsapp_config / meta_capi_settings).
--                           service_role ONLY: RLS on, no policy, every grant revoked from anon/authenticated.
--   2. meta_ads_ads         catalog of ads. ad_id = Meta Ad ID = contact_ad_attributions.source_id. Members of the account can READ it.
--   3. meta_ads_sync_state  one row per (account, job): lease, schedule, last result, failure counter. service_role ONLY.
--   4. ads_results_meta_catalog(account, ad_ids)  read-only lookup used by /ads-results to enrich the ads it already shows.
-- ============================================================

-- 1) Settings (OFF by default; no row for anyone) ---------------------------
CREATE TABLE public.meta_ads_settings (
  account_id UUID PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  -- Numeric Ad Account id WITHOUT the "act_" prefix.
  ad_account_id TEXT,
  access_token_enc TEXT,
  api_version TEXT NOT NULL DEFAULT 'v27.0',
  currency TEXT NOT NULL DEFAULT 'PEN',
  account_timezone TEXT NOT NULL DEFAULT 'America/Bogota',
  -- unverified = stored but never validated against Meta; valid = last call succeeded; invalid = Meta rejected it (sync stops until rotated).
  token_status TEXT NOT NULL DEFAULT 'unverified',
  token_rotated_at TIMESTAMPTZ,
  catalog_interval_minutes INTEGER NOT NULL DEFAULT 60,
  disabled_reason TEXT,
  disabled_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT meta_ads_settings_ad_account CHECK (ad_account_id IS NULL OR ad_account_id ~ '^[0-9]{6,25}$'),
  CONSTRAINT meta_ads_settings_version CHECK (api_version ~ '^v[0-9]{2}\.[0-9]$'),
  CONSTRAINT meta_ads_settings_currency CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT meta_ads_settings_token_status CHECK (token_status IN ('unverified', 'valid', 'invalid')),
  CONSTRAINT meta_ads_settings_interval CHECK (catalog_interval_minutes BETWEEN 15 AND 1440),
  -- Switching on requires a complete configuration.
  CONSTRAINT meta_ads_settings_complete CHECK (NOT enabled OR (ad_account_id IS NOT NULL AND access_token_enc IS NOT NULL))
);

-- 2) Ad catalog -------------------------------------------------------------
CREATE TABLE public.meta_ads_ads (
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  -- Meta Ad ID (text, never a number: ids exceed JS safe integers). Equals contact_ad_attributions.source_id.
  ad_id TEXT NOT NULL,
  name TEXT,
  adset_id TEXT,
  adset_name TEXT,
  campaign_id TEXT,
  campaign_name TEXT,
  status TEXT,
  effective_status TEXT,
  meta_created_time TIMESTAMPTZ,
  meta_updated_time TIMESTAMPTZ,
  first_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, ad_id),
  CONSTRAINT meta_ads_ads_id CHECK (ad_id ~ '^[0-9]{6,25}$')
);

-- 3) Sync state -------------------------------------------------------------
CREATE TABLE public.meta_ads_sync_state (
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  job TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle',
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_until TIMESTAMPTZ,
  last_attempt_at TIMESTAMPTZ,
  -- Last time a FULL paginated pass finished without error.
  last_success_at TIMESTAMPTZ,
  last_rows INTEGER,
  last_pages INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  last_error_summary TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, job),
  CONSTRAINT meta_ads_sync_state_job CHECK (job IN ('catalog')),
  CONSTRAINT meta_ads_sync_state_status CHECK (status IN ('idle', 'running', 'ok', 'error', 'paused'))
);

-- Security: tokens and sync internals are service_role only. The catalog is readable by members of the owning account.
ALTER TABLE public.meta_ads_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meta_ads_ads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meta_ads_sync_state ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.meta_ads_settings FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.meta_ads_sync_state FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.meta_ads_ads FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.meta_ads_settings TO service_role;
GRANT ALL ON public.meta_ads_sync_state TO service_role;
GRANT ALL ON public.meta_ads_ads TO service_role;
GRANT SELECT ON public.meta_ads_ads TO authenticated;

CREATE POLICY meta_ads_ads_member_read ON public.meta_ads_ads
  FOR SELECT TO authenticated
  USING (public.is_account_member(account_id, 'agent'));

-- 4) Read-only lookup for /ads-results --------------------------------------
-- One row per requested ad that exists in the synced catalog. Ads missing from the catalog simply have no row (the app shows them as
-- "Anuncio no sincronizado"; nothing is invented). SECURITY INVOKER (RLS applies) and it additionally requires agent+ membership of p_account.
-- The id list is capped so a caller cannot turn it into a catalog dump.
CREATE FUNCTION public.ads_results_meta_catalog(p_account UUID, p_ad_ids TEXT[])
RETURNS TABLE (
  ad_id TEXT, name TEXT, adset_id TEXT, adset_name TEXT, campaign_id TEXT, campaign_name TEXT,
  status TEXT, effective_status TEXT, last_synced_at TIMESTAMPTZ
)
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT a.ad_id, a.name, a.adset_id, a.adset_name, a.campaign_id, a.campaign_name, a.status, a.effective_status, a.last_synced_at
  FROM public.meta_ads_ads a
  WHERE public.is_account_member(p_account, 'agent')
    AND a.account_id = p_account
    AND a.ad_id = ANY (p_ad_ids[1:500])
$$;

REVOKE ALL ON FUNCTION public.ads_results_meta_catalog(UUID, TEXT[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ads_results_meta_catalog(UUID, TEXT[]) TO authenticated, service_role;
