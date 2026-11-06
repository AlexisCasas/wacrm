-- PREPARED, NOT APPLIED. Excludes from the commercial Sheets register the two Keyler orders verified in InkaClick as test records (is_test = true, test products).
-- References are the anonymized ones from EXCEPCIONES-HISTORICAS.md (first 8 hex of md5(order id)); the guards below make the script refuse to run on anything else.
-- Order of operations in production (each step needs its own authorization): 1) apply migration 20261109000000, 2) run THIS script, 3) enable the destination, 4) historical sync.
-- Idempotent: running it twice changes nothing. It never touches order_confirmations (status, InkaClick fields and history are untouched).
-- Usage (as postgres):  psql -v ON_ERROR_STOP=1 -1 -f exclude-test-orders.sql        Roll back:  DELETE FROM order_sheet_exclusions WHERE reason = 'test' AND order_id IN (...)  (see the end)
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  keyler CONSTANT uuid := '4d04a2e0-62b8-4508-a046-4b125aa2e8db';
  refs   CONSTANT text[] := ARRAY['c071235f', '821d22b1'];
  n int;
BEGIN
  IF to_regclass('public.order_sheet_exclusions') IS NULL THEN RAISE EXCEPTION 'migration 20261109000000 is not applied'; END IF;
  SELECT count(*) INTO n FROM order_confirmations o
   WHERE o.account_id = keyler AND left(md5(o.id::text), 8) = ANY (refs);
  IF n <> 2 THEN RAISE EXCEPTION 'expected exactly 2 orders for the references, found %', n; END IF;
  -- Independent guard: both must be acknowledged, single-line (traditional) and carry the test marker word in the product name.
  SELECT count(*) INTO n FROM order_confirmations o
   WHERE o.account_id = keyler AND left(md5(o.id::text), 8) = ANY (refs)
     AND o.delivery_status = 'acknowledged' AND o.product ~* '(^|[^a-z])prueba([^a-z]|$)'
     AND NOT EXISTS (SELECT 1 FROM order_confirmation_items i WHERE i.order_id = o.id);
  IF n <> 2 THEN RAISE EXCEPTION 'guard failed: the 2 orders no longer match (acknowledged / PRUEBA product / no lines); found %', n; END IF;

  INSERT INTO order_sheet_exclusions (order_id, account_id, reason)
  SELECT o.id, o.account_id, 'test' FROM order_confirmations o
   WHERE o.account_id = keyler AND left(md5(o.id::text), 8) = ANY (refs)
  ON CONFLICT (order_id) DO NOTHING;

  -- If a job already exists (the destination was enabled before this script), park it; an exported one is reported, never deleted.
  UPDATE order_sheet_exports e SET status = 'excluded', exclusion_reason = 'test', locked_until = NULL, updated_at = now()
   FROM order_confirmations o
   WHERE e.order_id = o.id AND o.account_id = keyler AND left(md5(o.id::text), 8) = ANY (refs) AND e.status IN ('pending', 'dead');
  SELECT count(*) INTO n FROM order_sheet_exports e JOIN order_confirmations o ON o.id = e.order_id
   WHERE o.account_id = keyler AND left(md5(o.id::text), 8) = ANY (refs) AND e.status IN ('processing', 'exported');
  IF n > 0 THEN RAISE EXCEPTION 'one of the orders is already exported/processing (%): remove its row from the sheet first', n; END IF;

  SELECT count(*) INTO n FROM order_sheet_exclusions x WHERE x.account_id = keyler AND x.reason = 'test' AND left(md5(x.order_id::text), 8) = ANY (refs);
  IF n <> 2 THEN RAISE EXCEPTION 'post-check failed: % exclusions', n; END IF;
END $$;

-- Verification (read-only): who is excluded, by anonymized reference only.
SELECT left(md5(order_id::text), 8) AS ref, reason FROM order_sheet_exclusions ORDER BY 1;
COMMIT;

-- Rollback (manual, only if the decision is reverted):
--   DELETE FROM order_sheet_exclusions WHERE reason = 'test' AND account_id = '4d04a2e0-62b8-4508-a046-4b125aa2e8db' AND left(md5(order_id::text), 8) IN ('c071235f','821d22b1');
--   DELETE FROM order_sheet_exports WHERE status = 'excluded' AND exclusion_reason = 'test' AND account_id = '4d04a2e0-62b8-4508-a046-4b125aa2e8db' AND left(md5(order_id::text), 8) IN ('c071235f','821d22b1');
--   (then run the sync: discovery creates the pending jobs again)
