-- Rollback of 20261116000000_meta_ads_catalog. NOT required to restore service: the previous image never touches these objects.
-- Drops the cached Meta catalog and the stored (encrypted) token; the token must then be re-enrolled. Review before running.
BEGIN;
DROP FUNCTION IF EXISTS public.ads_results_meta_catalog(UUID, TEXT[]);
DROP TABLE IF EXISTS public.meta_ads_sync_state;
DROP TABLE IF EXISTS public.meta_ads_ads;
DROP TABLE IF EXISTS public.meta_ads_settings;
COMMIT;
