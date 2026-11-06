-- MANUAL ROLLBACK of the Sheets migration (only if explicitly decided; the objects are inert while no destination is enabled). One transaction.
-- It deletes the export queue, exclusions and event log (all derived data: the commercial orders are untouched and the sheet can be rebuilt from them).
BEGIN;
SET LOCAL lock_timeout = '5s';
DROP FUNCTION IF EXISTS public.order_sheet_enqueue(uuid, integer), public.order_sheet_acquire(uuid, integer), public.order_sheet_renew(uuid, uuid, integer),
  public.order_sheet_release(uuid, uuid), public.order_sheet_claim(uuid, uuid, integer, integer, integer), public.order_sheet_complete(uuid, uuid, integer, integer, numeric),
  public.order_sheet_fail(uuid, uuid, text, integer, boolean, integer), public.order_sheet_requeue(uuid, uuid);
DROP TABLE IF EXISTS public.order_sheet_events, public.order_sheet_exclusions, public.order_sheet_exports, public.order_sheet_destinations;
COMMIT;
