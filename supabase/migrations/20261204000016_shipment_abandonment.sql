-- PR-05B · "EN ABANDONO": the WACRM operational condition reached at 20 COMPLETE calendar days (America/Lima) En destino without Entregado.
--
-- It is NOT a Shalom status: order_shipments.logistic_status keeps whatever Shalom says (at_destination) and the Shalom mapping is untouched. The condition lives
-- in order_shipments.pickup_state (added in 20261201000000): waiting_pickup -> alerted_15d -> abandoned -> (completed | none). This file only adds the evaluator
-- and the audit event; DETECT + LABEL + AUDIT, nothing else (no commercial / logistic action follows an abandonment).
--   * independent of the WhatsApp message switch and of the internal alert (a shipment can be abandoned without ever having been alerted);
--   * once per order + episode (unique event index); a second tick never repeats it;
--   * leaving En destino (delivered / guide correction) is handled by the existing order_shipments_pickup_sync trigger (pickup_abandonment_cleared).

ALTER TABLE public.order_shipment_events DROP CONSTRAINT IF EXISTS order_shipment_events_type_check;
ALTER TABLE public.order_shipment_events ADD CONSTRAINT order_shipment_events_type_check CHECK (event_type IN (
  'shipment_registered', 'identifier_corrected', 'refresh_requested',
  'status_changed', 'regression_ignored', 'exception_unknown_state',
  'requires_attention', 'attention_cleared', 'tracking_stopped', 'delivered',
  'alert_created', 'alert_acknowledged', 'alert_resolved',
  'pickup_waiting_started', 'pickup_completed', 'pickup_abandonment_cleared', 'pickup_abandoned',
  'destination_customer_message_due', 'destination_customer_message_sent', 'destination_customer_message_failed', 'destination_customer_message_uncertain',
  'destination_customer_message_skipped', 'destination_customer_message_retry_requested'
));
CREATE UNIQUE INDEX IF NOT EXISTS order_shipment_events_pickup_abandoned_once ON public.order_shipment_events (order_id, ((detail ->> 'episode'))) WHERE event_type = 'pickup_abandoned';

CREATE OR REPLACE FUNCTION public.evaluate_pickup_abandonment(p_now TIMESTAMPTZ DEFAULT now(), p_days INTEGER DEFAULT 20)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r RECORD;
  v_abandoned INTEGER := 0;
BEGIN
  IF p_days IS NULL OR p_days < 1 THEN RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023'; END IF;
  FOR r IN
    SELECT s.id, s.account_id, s.order_id, s.destination_episode, s.identifier_version, s.destination_entered_at
      FROM public.order_shipments s
      JOIN public.order_shipment_settings st ON st.account_id = s.account_id AND st.shalom_tracking_enabled
      JOIN public.order_integration_settings ois ON ois.account_id = s.account_id AND ois.logistics_mvp_enabled
     WHERE s.tracking_state IN ('active', 'requires_attention') AND s.logistic_status = 'at_destination' AND s.pickup_state IN ('waiting_pickup', 'alerted_15d')
       AND s.destination_entered_at IS NOT NULL
       AND (p_now AT TIME ZONE 'America/Lima')::date >= (s.destination_entered_at AT TIME ZONE 'America/Lima')::date + p_days
     ORDER BY s.destination_entered_at, s.id
       FOR UPDATE OF s SKIP LOCKED
  LOOP
    UPDATE public.order_shipments SET pickup_state = 'abandoned', pickup_state_at = p_now, pickup_abandoned_at = p_now WHERE id = r.id;
    v_abandoned := v_abandoned + 1;
    PERFORM public.order_shipments_log(r.account_id, r.order_id, 'pickup_abandoned', 'at_destination', 'at_destination', r.identifier_version, NULL, 'system',
      jsonb_build_object('episode', r.destination_episode, 'days', p_days, 'entered_at', r.destination_entered_at, 'abandoned_at', p_now));
  END LOOP;
  RETURN jsonb_build_object('abandoned', v_abandoned);
END;
$$;
ALTER FUNCTION public.evaluate_pickup_abandonment(TIMESTAMPTZ, INTEGER) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.evaluate_pickup_abandonment(TIMESTAMPTZ, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.evaluate_pickup_abandonment(TIMESTAMPTZ, INTEGER) TO service_role;
