-- Controlled restoration of the historical customer row altered by the phase 4 E2E test order. TEMPLATE: replace every <PLACEHOLDER>; the values come
-- from the protected pre-image / baseline files, never from this repository. Nothing here deletes or edits the E2E order or its audit event.
-- Restore EVERY column the test may have touched (nombre, apellido, nombre_completo, total_pedidos, ultimo_pedido_at, updated_at); the final hash check
-- against the pre-test row catches anything left out. Lesson from 2026-11-01: a first attempt that restored only four columns aborted at that check.
-- Guards (the whole transaction aborts if any fails): the row is locked, it must still be in the exact post-test state (no concurrent change), and
-- no other order may have appeared for the customer. After the update the row must hash identical to the pre-test row.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$
DECLARE r public.customers; n int;
BEGIN
  SELECT * INTO r FROM public.customers WHERE id = '<CUSTOMER_ID>' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'customer not found'; END IF;
  IF md5(to_jsonb(r)::text) <> '<EXPECTED_POST_TEST_ROW_MD5>' THEN
    RAISE EXCEPTION 'the customer row changed since the test (concurrent change): aborting, nothing restored';
  END IF;
  SELECT count(*) INTO n FROM public.confirmed_orders
    WHERE (telefono_normalized = r.telefono_normalized OR (r.dni_normalized IS NOT NULL AND dni_normalized = r.dni_normalized))
      AND NOT (source = 'wacrm' AND external_order_id = '<EXTERNAL_ORDER_ID>');
  IF n <> <EXPECTED_OTHER_ORDERS> THEN RAISE EXCEPTION 'unexpected orders for this customer (%): aborting', n; END IF;

  ALTER TABLE public.customers DISABLE TRIGGER trg_customers_updated_at;   -- only to give back the original updated_at; rolled back with the transaction on failure
  UPDATE public.customers
     SET nombre = '<PRE_NOMBRE>', apellido = <PRE_APELLIDO_LITERAL_OR_NULL>, nombre_completo = '<PRE_NOMBRE_COMPLETO>', total_pedidos = <PRE_TOTAL_PEDIDOS>, ultimo_pedido_at = '<PRE_ULTIMO_PEDIDO_AT>', updated_at = '<PRE_UPDATED_AT>'
   WHERE id = '<CUSTOMER_ID>';
  ALTER TABLE public.customers ENABLE TRIGGER trg_customers_updated_at;

  SELECT * INTO r FROM public.customers WHERE id = '<CUSTOMER_ID>';
  IF md5(to_jsonb(r)::text) <> '<PRE_TEST_ROW_MD5>' THEN RAISE EXCEPTION 'the restored row does not match the pre-test row: aborting'; END IF;
  IF (SELECT count(*) FROM public.confirmed_orders WHERE source = 'wacrm' AND external_order_id = '<EXTERNAL_ORDER_ID>') <> 1 THEN RAISE EXCEPTION 'the E2E order must remain'; END IF;
  IF (SELECT count(*) FROM public.wacrm_order_events WHERE external_order_id = '<EXTERNAL_ORDER_ID>') < 1 THEN RAISE EXCEPTION 'the audit events must remain'; END IF;
END $$;
COMMIT;
