-- Rollback of 20261115000000_ads_results_product_ad_breakdown. Drops only the read-only function; no data is touched.
-- The app degrades gracefully without it (drilldown hidden, "Vista completa por anuncio" shown open). Image-only rollback does not need this file.
BEGIN;
DROP FUNCTION IF EXISTS public.ads_results_product_ad_breakdown(UUID, TIMESTAMPTZ, TIMESTAMPTZ);
COMMIT;
