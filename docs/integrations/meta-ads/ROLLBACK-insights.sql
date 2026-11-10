-- Rollback of 20261117000000_meta_ads_insights. NOT required to restore service: the previous image never touches these objects.
-- Drops the cached campaigns / ad sets / daily insights / reconciliation. Run BEFORE ROLLBACK-catalog.sql if both are being removed.
BEGIN;
DROP FUNCTION IF EXISTS public.meta_ads_insights_totals(UUID, DATE, DATE);
DROP FUNCTION IF EXISTS public.meta_ads_performance(UUID, DATE, DATE, TEXT);
DROP TABLE IF EXISTS public.meta_ads_reconciliation;
DROP TABLE IF EXISTS public.meta_ads_insights_daily;
DROP TABLE IF EXISTS public.meta_ads_adsets;
DROP TABLE IF EXISTS public.meta_ads_campaigns;
DELETE FROM public.meta_ads_sync_state WHERE job <> 'catalog';
ALTER TABLE public.meta_ads_sync_state DROP COLUMN IF EXISTS covered_from, DROP COLUMN IF EXISTS covered_to;
ALTER TABLE public.meta_ads_sync_state DROP CONSTRAINT meta_ads_sync_state_job;
ALTER TABLE public.meta_ads_sync_state ADD CONSTRAINT meta_ads_sync_state_job CHECK (job IN ('catalog'));
ALTER TABLE public.meta_ads_settings DROP CONSTRAINT IF EXISTS meta_ads_settings_insights_interval;
ALTER TABLE public.meta_ads_settings DROP COLUMN IF EXISTS insights_interval_minutes;
COMMIT;
