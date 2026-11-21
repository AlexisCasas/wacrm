-- SYNC-05 · Automatic payment snapshot hooks with transactional anti-bounce.
--
-- A human/local WACRM financial change already converges through order_payments_after_change().
-- This migration extends that existing hook so the resulting financial state is recorded as a local
-- payment.snapshot in the SAME transaction. An imported InkaClick payment is marked by a transaction-
-- local GUC from a BEFORE INSERT trigger and therefore does not bounce back as a WACRM-origin event.
--
-- No HTTP call, cron, transport enablement or external side effect lives here.

CREATE OR REPLACE FUNCTION public.order_sync_mark_imported_payment()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.source = 'inkaclick_sync' THEN
    PERFORM set_config('app.order_sync_origin', 'inkaclick', true);
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.order_sync_mark_imported_payment() OWNER TO postgres;

DROP TRIGGER IF EXISTS order_sync_mark_imported_payment ON public.order_payments;
CREATE TRIGGER order_sync_mark_imported_payment
  BEFORE INSERT ON public.order_payments
  FOR EACH ROW EXECUTE FUNCTION public.order_sync_mark_imported_payment();

-- Preserve the final PR-06 finalization hook and add one local snapshot after the final financial
-- state is known. The imported-payment marker is transaction-local, so it disappears on commit/rollback.
CREATE OR REPLACE FUNCTION public.order_payments_after_change(
  p_account UUID,
  p_order UUID,
  p_actor UUID,
  p_actor_name TEXT,
  p_now TIMESTAMPTZ
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.order_payments_evaluate_finalization(p_account, p_order, p_actor, p_actor_name, p_now);

  IF current_setting('app.order_sync_origin', true) IS DISTINCT FROM 'inkaclick' THEN
    PERFORM public.emit_wacrm_payment_snapshot(p_account, p_order, p_now);
  END IF;
END;
$$;
ALTER FUNCTION public.order_payments_after_change(UUID, UUID, UUID, TEXT, TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.order_payments_after_change(UUID, UUID, UUID, TEXT, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated, service_role;
