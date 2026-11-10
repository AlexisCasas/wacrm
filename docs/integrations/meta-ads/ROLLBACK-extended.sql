-- Rollback of 20261118000000_meta_ads_extended_metrics. NOT required to restore service: the previous image never touches these objects.
-- Drops the cached aggregated ranges / actions and the secondary catalog details. Run BEFORE ROLLBACK-insights.sql if both are being removed.
BEGIN;
DROP FUNCTION IF EXISTS public.meta_ads_range_metrics(UUID, INTEGER, DATE, DATE, TEXT);
DROP TABLE IF EXISTS public.meta_ads_actions_range;
DROP TABLE IF EXISTS public.meta_ads_insights_range;
ALTER TABLE public.meta_ads_adsets
  DROP COLUMN IF EXISTS optimization_goal, DROP COLUMN IF EXISTS billing_event, DROP COLUMN IF EXISTS bid_strategy, DROP COLUMN IF EXISTS daily_budget,
  DROP COLUMN IF EXISTS lifetime_budget, DROP COLUMN IF EXISTS start_time, DROP COLUMN IF EXISTS end_time, DROP COLUMN IF EXISTS created_time, DROP COLUMN IF EXISTS updated_time;
ALTER TABLE public.meta_ads_campaigns
  DROP COLUMN IF EXISTS objective, DROP COLUMN IF EXISTS buying_type, DROP COLUMN IF EXISTS daily_budget, DROP COLUMN IF EXISTS lifetime_budget,
  DROP COLUMN IF EXISTS start_time, DROP COLUMN IF EXISTS stop_time, DROP COLUMN IF EXISTS created_time, DROP COLUMN IF EXISTS updated_time;
DELETE FROM public.meta_ads_sync_state WHERE job = 'ranges';
ALTER TABLE public.meta_ads_sync_state DROP CONSTRAINT meta_ads_sync_state_job;
ALTER TABLE public.meta_ads_sync_state ADD CONSTRAINT meta_ads_sync_state_job CHECK (job IN ('catalog', 'adsets', 'campaigns', 'insights'));
COMMIT;
