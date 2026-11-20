-- ============================================================
-- 20261205000001_shipment_arrival_message
--
-- Post-release patch (feat/meta-destination-arrival-message). ADDITIVE and IDEMPOTENT: no DROP of data, no historical migration edited, no setting changed, no flag activated.
--
-- The IMMEDIATE notice to the customer when a shipment first reaches "En destino" (the capability that today only exists in InkaClick). It REUSES the PR-05A ledger
-- (order_shipment_messages: claim / lease / retries / uncertain / skipped, the same sender, the same conversation, the same Meta wiring); it only adds a second
-- KIND next to the day-15 one:
--
--   kind 'destination_arrival_customer'   one ledger row per (order, destination_episode): the unique key already contains `kind`, so it can never collide with
--                                         the day-15 row of the same episode, and ticks / workers / refreshes / retries can never create a second one.
--
-- WHEN it becomes due: an AFTER UPDATE trigger on order_shipments fires only on the transition INTO 'at_destination' (OLD.logistic_status <> 'at_destination'). The
-- status never moves backwards and a repeated refresh that keeps 'at_destination' is not a transition, so it fires once per episode of En destino. A new legitimate
-- episode (after a guide correction) is a new transition and a new row. It is INERT unless the account has logistics_mvp_enabled AND shalom_tracking_enabled AND
-- destination_customer_message_enabled AND an arrival template: with any of them missing nothing is created (no row, no event, no claim, no message). Turning the switch ON later never notifies
-- shipments that were already En destino (the trigger only looks at transitions that happen while it is ON).
--
-- WHICH template: configuration of the account, NOT code (new columns arrival_message_template_name / _language / _params, snapshotted into the ledger row when it
-- becomes due, exactly like the day-15 message). The arrival notice is OPT-IN by configuring that template: with no arrival template configured the trigger does
-- nothing at all, so an account that only uses the day-15 message behaves exactly as before.
--
-- Everything else (claim_shipment_messages, mark_shipment_message_sending, finish_shipment_message, retry_shipment_message, resolve_shipment_message, the sender in
-- application code, the grants and the RLS) is shared and UNCHANGED: a failed send retries with the existing bounded backoff and then waits for a person, an uncertain
-- one is never re-sent automatically, a shipment that is no longer En destino when the send is due is skipped. The message needs no logged-in user.
-- ============================================================

-- 1. Template configuration of the arrival notice (separate from the day-15 template) ---------------------------------------------------------------------------
ALTER TABLE public.order_shipment_settings ADD COLUMN IF NOT EXISTS arrival_message_template_name TEXT;
ALTER TABLE public.order_shipment_settings ADD COLUMN IF NOT EXISTS arrival_message_template_language TEXT;
ALTER TABLE public.order_shipment_settings ADD COLUMN IF NOT EXISTS arrival_message_template_params JSONB;
ALTER TABLE public.order_shipment_settings DROP CONSTRAINT IF EXISTS order_shipment_settings_arrival_template_pair;
ALTER TABLE public.order_shipment_settings ADD CONSTRAINT order_shipment_settings_arrival_template_pair CHECK ((arrival_message_template_name IS NULL) = (arrival_message_template_language IS NULL));
ALTER TABLE public.order_shipment_settings DROP CONSTRAINT IF EXISTS order_shipment_settings_arrival_template_form;
ALTER TABLE public.order_shipment_settings ADD CONSTRAINT order_shipment_settings_arrival_template_form CHECK (
  arrival_message_template_name IS NULL
  OR (btrim(arrival_message_template_name) <> '' AND char_length(arrival_message_template_name) <= 512 AND btrim(arrival_message_template_language) <> '' AND char_length(arrival_message_template_language) <= 20)
);
ALTER TABLE public.order_shipment_settings DROP CONSTRAINT IF EXISTS order_shipment_settings_arrival_params_form;
ALTER TABLE public.order_shipment_settings ADD CONSTRAINT order_shipment_settings_arrival_params_form CHECK (
  arrival_message_template_params IS NULL OR (jsonb_typeof(arrival_message_template_params) = 'array' AND jsonb_array_length(arrival_message_template_params) <= 20)
);

-- 2. The new kind and its due event ------------------------------------------------------------------------------------------------------------------------------
ALTER TABLE public.order_shipment_messages DROP CONSTRAINT IF EXISTS order_shipment_messages_kind_check;
ALTER TABLE public.order_shipment_messages ADD CONSTRAINT order_shipment_messages_kind_check CHECK (kind IN ('destination_15d_customer', 'destination_arrival_customer'));

ALTER TABLE public.order_shipment_events DROP CONSTRAINT IF EXISTS order_shipment_events_type_check;
ALTER TABLE public.order_shipment_events ADD CONSTRAINT order_shipment_events_type_check CHECK (event_type IN (
  'shipment_registered', 'identifier_corrected', 'refresh_requested',
  'status_changed', 'regression_ignored', 'exception_unknown_state',
  'requires_attention', 'attention_cleared', 'tracking_stopped', 'delivered',
  'alert_created', 'alert_acknowledged', 'alert_resolved',
  'pickup_waiting_started', 'pickup_completed', 'pickup_abandonment_cleared', 'pickup_abandoned',
  'destination_customer_message_due', 'destination_customer_message_sent', 'destination_customer_message_failed', 'destination_customer_message_uncertain',
  'destination_customer_message_skipped', 'destination_customer_message_retry_requested',
  'destination_arrival_message_due'
));
-- ONE due event per episode for the arrival notice (the day-15 due event keeps its own index and its own event type).
CREATE UNIQUE INDEX IF NOT EXISTS order_shipment_events_arrival_due_once ON public.order_shipment_events (order_id, ((detail ->> 'episode'))) WHERE event_type = 'destination_arrival_message_due';

-- 3. The trigger -------------------------------------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.order_shipments_arrival_message()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  st RECORD;
  v_conversation UUID;
  v_id UUID;
BEGIN
  -- only the transition INTO En destino (belt and braces: the trigger's WHEN clause says the same)
  IF NEW.logistic_status IS DISTINCT FROM 'at_destination' OR OLD.logistic_status IS NOT DISTINCT FROM 'at_destination' THEN RETURN NULL; END IF;
  IF NEW.tracking_state NOT IN ('active', 'requires_attention') OR COALESCE(NEW.destination_episode, 0) < 1 THEN RETURN NULL; END IF;

  -- INERT unless every switch is ON for this account: nothing is created otherwise (no ledger row, no event).
  SELECT s.arrival_message_template_name AS tname, s.arrival_message_template_language AS tlang, s.arrival_message_template_params AS tparams
    INTO st
    FROM public.order_shipment_settings s
    JOIN public.order_integration_settings ois ON ois.account_id = s.account_id AND ois.logistics_mvp_enabled
   WHERE s.account_id = NEW.account_id AND s.shalom_tracking_enabled AND s.destination_customer_message_enabled;
  IF NOT FOUND OR st.tname IS NULL OR st.tlang IS NULL THEN RETURN NULL; END IF;

  SELECT o.conversation_id INTO v_conversation FROM public.order_confirmations o WHERE o.id = NEW.order_id AND o.account_id = NEW.account_id;

  INSERT INTO public.order_shipment_messages (account_id, order_id, destination_episode, kind, status, conversation_id, template_name, template_language, template_params, next_attempt_at)
  VALUES (NEW.account_id, NEW.order_id, NEW.destination_episode, 'destination_arrival_customer', 'pending', v_conversation, st.tname, st.tlang, st.tparams, now())
  ON CONFLICT (order_id, destination_episode, kind) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NOT NULL THEN
    PERFORM public.order_shipments_log(NEW.account_id, NEW.order_id, 'destination_arrival_message_due', NULL, 'at_destination', NEW.identifier_version, NULL, 'system',
      jsonb_build_object('episode', NEW.destination_episode, 'message_id', v_id, 'kind', 'destination_arrival_customer'));
  END IF;
  RETURN NULL;
END;
$$;
ALTER FUNCTION public.order_shipments_arrival_message() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.order_shipments_arrival_message() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS order_shipments_arrival ON public.order_shipments;
CREATE TRIGGER order_shipments_arrival AFTER UPDATE ON public.order_shipments
  FOR EACH ROW WHEN (NEW.logistic_status = 'at_destination' AND OLD.logistic_status IS DISTINCT FROM 'at_destination')
  EXECUTE FUNCTION public.order_shipments_arrival_message();
