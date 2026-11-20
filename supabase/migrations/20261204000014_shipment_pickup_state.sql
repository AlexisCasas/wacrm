-- ============================================================
-- 20261201000000_shipment_pickup_state
--
-- PR-05A/B · the PICKUP condition of a shipment that is En destino. ADDITIVE: columns on order_shipments (no new table), new event types, one trigger.
--
-- The Shalom status (logistic_status: at_origin / in_transit / at_destination / delivered) is NOT touched and its mapping is NOT touched. "Pickup" is a
-- WACRM operational condition that rides next to it:
--
--   none              not En destino (or delivered without ever waiting)
--   waiting_pickup    entered En destino (day 0)
--   alerted_15d       15 calendar days (America/Lima) En destino without Entregado     [set by 20261201000001]
--   abandoned         20 calendar days En destino without Entregado: "En abandono"      [set by 20261201000002]
--   completed         the shipment reached Entregado after having waited / been alerted / abandoned
--
-- Everything is per EPISODE of En destino (order_shipments.destination_episode). The CURRENT condition lives in these columns; the HISTORY lives in
-- order_shipment_events (pickup_waiting_started, pickup_completed, pickup_abandonment_cleared, ...), so a previous abandonment is never lost.
--
-- A trigger keeps the condition coherent with the Shalom status WITHOUT replacing any PR-05 RPC (apply_shipment_poll / correct_order_shipment_identifier
-- are untouched, so everything already validated behaves exactly as before):
--   * entering En destino (new episode)              -> waiting_pickup  (+ pickup_waiting_started, once per episode)
--   * leaving En destino because Shalom says delivered -> completed      (+ pickup_completed, or pickup_abandonment_cleared if it was abandoned)
--   * leaving En destino otherwise (guide corrected)   -> none            (+ pickup_abandonment_cleared if it was abandoned; the episode stays as history)
-- ============================================================

ALTER TABLE public.order_shipments ADD COLUMN IF NOT EXISTS pickup_state TEXT NOT NULL DEFAULT 'none';
ALTER TABLE public.order_shipments ADD COLUMN IF NOT EXISTS pickup_state_at TIMESTAMPTZ;
ALTER TABLE public.order_shipments ADD COLUMN IF NOT EXISTS pickup_alerted_at TIMESTAMPTZ;
ALTER TABLE public.order_shipments ADD COLUMN IF NOT EXISTS pickup_abandoned_at TIMESTAMPTZ;

ALTER TABLE public.order_shipments DROP CONSTRAINT IF EXISTS order_shipments_pickup_state_check;
ALTER TABLE public.order_shipments ADD CONSTRAINT order_shipments_pickup_state_check CHECK (pickup_state IN ('none', 'waiting_pickup', 'alerted_15d', 'abandoned', 'completed'));
ALTER TABLE public.order_shipments DROP CONSTRAINT IF EXISTS order_shipments_pickup_shape;
ALTER TABLE public.order_shipments ADD CONSTRAINT order_shipments_pickup_shape CHECK (
  (pickup_state NOT IN ('waiting_pickup', 'alerted_15d', 'abandoned') OR logistic_status = 'at_destination')
  AND (pickup_state <> 'completed' OR logistic_status = 'delivered')
  AND (pickup_state <> 'abandoned' OR pickup_abandoned_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS order_shipments_pickup_idx ON public.order_shipments (account_id, pickup_state) WHERE pickup_state IN ('alerted_15d', 'abandoned');

-- New event types (the table is PR-05's own).
ALTER TABLE public.order_shipment_events DROP CONSTRAINT IF EXISTS order_shipment_events_type_check;
ALTER TABLE public.order_shipment_events ADD CONSTRAINT order_shipment_events_type_check CHECK (event_type IN (
  'shipment_registered', 'identifier_corrected', 'refresh_requested',
  'status_changed', 'regression_ignored', 'exception_unknown_state',
  'requires_attention', 'attention_cleared', 'tracking_stopped', 'delivered',
  'alert_created', 'alert_acknowledged', 'alert_resolved',
  'pickup_waiting_started', 'pickup_completed', 'pickup_abandonment_cleared'
));
-- ONE event per episode, however many ticks / workers / polls.
CREATE UNIQUE INDEX IF NOT EXISTS order_shipment_events_pickup_waiting_once ON public.order_shipment_events (order_id, ((detail ->> 'episode'))) WHERE event_type = 'pickup_waiting_started';
CREATE UNIQUE INDEX IF NOT EXISTS order_shipment_events_pickup_completed_once ON public.order_shipment_events (order_id, ((detail ->> 'episode'))) WHERE event_type = 'pickup_completed';
CREATE UNIQUE INDEX IF NOT EXISTS order_shipment_events_pickup_cleared_once ON public.order_shipment_events (order_id, ((detail ->> 'episode'))) WHERE event_type = 'pickup_abandonment_cleared';

CREATE OR REPLACE FUNCTION public.order_shipments_pickup_sync()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_to TEXT;
BEGIN
  IF NEW.logistic_status = 'at_destination' AND OLD.logistic_status IS DISTINCT FROM 'at_destination' AND NEW.pickup_state = 'none' THEN
    -- a (new) episode of En destino starts waiting for the pickup
    NEW.pickup_state := 'waiting_pickup';
    NEW.pickup_state_at := now();
    NEW.pickup_alerted_at := NULL;
    NEW.pickup_abandoned_at := NULL;
    PERFORM public.order_shipments_log(NEW.account_id, NEW.order_id, 'pickup_waiting_started', NULL, 'at_destination', NEW.identifier_version, NULL, 'system',
      jsonb_build_object('episode', NEW.destination_episode));
  ELSIF NEW.logistic_status IS DISTINCT FROM 'at_destination' AND OLD.pickup_state IN ('waiting_pickup', 'alerted_15d', 'abandoned') AND NEW.pickup_state = OLD.pickup_state THEN
    v_to := CASE WHEN NEW.logistic_status = 'delivered' THEN 'completed' ELSE 'none' END;
    NEW.pickup_state := v_to;
    NEW.pickup_state_at := now();
    IF OLD.pickup_state = 'abandoned' THEN
      -- the abandonment is CLOSED as the current condition; the fact that it happened stays in the history (and pickup_abandoned_at of the event)
      PERFORM public.order_shipments_log(NEW.account_id, NEW.order_id, 'pickup_abandonment_cleared', 'at_destination', NEW.logistic_status, NEW.identifier_version, NULL, 'system',
        jsonb_build_object('episode', OLD.destination_episode, 'to', v_to, 'reason', CASE WHEN v_to = 'completed' THEN 'delivered' ELSE 'left_destination' END, 'abandoned_at', OLD.pickup_abandoned_at));
    ELSIF v_to = 'completed' THEN
      PERFORM public.order_shipments_log(NEW.account_id, NEW.order_id, 'pickup_completed', 'at_destination', 'delivered', NEW.identifier_version, NULL, 'system',
        jsonb_build_object('episode', OLD.destination_episode, 'from', OLD.pickup_state));
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.order_shipments_pickup_sync() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.order_shipments_pickup_sync() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS order_shipments_pickup ON public.order_shipments;
CREATE TRIGGER order_shipments_pickup BEFORE UPDATE ON public.order_shipments FOR EACH ROW EXECUTE FUNCTION public.order_shipments_pickup_sync();

-- Shipments that are ALREADY En destino when this migration runs start waiting too (one event per episode; nothing else changes).
WITH started AS (
  UPDATE public.order_shipments SET pickup_state = 'waiting_pickup', pickup_state_at = now()
   WHERE logistic_status = 'at_destination' AND pickup_state = 'none'
  RETURNING account_id, order_id, identifier_version, destination_episode
)
INSERT INTO public.order_shipment_events (account_id, order_id, event_type, to_status, identifier_version, source, actor_name, detail)
SELECT account_id, order_id, 'pickup_waiting_started', 'at_destination', identifier_version, 'system', 'system', jsonb_build_object('episode', destination_episode, 'backfill', TRUE)
  FROM started
ON CONFLICT DO NOTHING;
