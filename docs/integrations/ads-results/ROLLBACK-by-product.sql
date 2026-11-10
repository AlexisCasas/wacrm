-- Rollback of 20261114000000_ads_results_by_product. Drops only the read-only function; no data is touched.
-- The app degrades gracefully without it (the "Por producto vendido" section is hidden). Image-only rollback does not need this file.
BEGIN;
DROP FUNCTION IF EXISTS public.ads_results_by_product(UUID, TIMESTAMPTZ, TIMESTAMPTZ);
COMMIT;
