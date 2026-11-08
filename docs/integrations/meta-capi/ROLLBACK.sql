-- Rollback of 20261111000000_meta_capi_ad_results. Removes ONLY objects created by that migration; nothing pre-existing is touched.
-- Run only after switching the feature off (META_CAPI_ENABLED unset, meta_capi_settings.enabled = false). Destroys the click history, the CAPI queue and its attempt log.
-- The image-only rollback does NOT need this file (the new tables are simply unused).
BEGIN;
DROP FUNCTION IF EXISTS public.ads_results_report(UUID, TIMESTAMPTZ, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS public.meta_capi_finish(UUID, INTEGER, TEXT, INTEGER, TEXT, TEXT, TIMESTAMPTZ, INTEGER);
DROP FUNCTION IF EXISTS public.meta_capi_claim(INTEGER, INTEGER, INTEGER);
DROP FUNCTION IF EXISTS public.meta_capi_enqueue(UUID, INTEGER);
DROP FUNCTION IF EXISTS public.meta_capi_disable(UUID, TEXT);
DROP FUNCTION IF EXISTS public.order_ad_attribution(UUID, INTEGER);
DROP TABLE IF EXISTS public.meta_capi_attempts;
DROP TABLE IF EXISTS public.meta_capi_events;
DROP TABLE IF EXISTS public.meta_capi_settings;
DROP TABLE IF EXISTS public.contact_ad_clicks;
COMMIT;
