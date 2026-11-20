-- ============================================================
-- 20261201000001_shipment_customer_message
--
-- PR-05A · the automatic message to the CUSTOMER at day 15 En destino. ADDITIVE; service_role only RPCs.
--
--   * order_shipment_messages: the idempotent LEDGER of that message, ONE row per (order, destination_episode, kind): however many ticks / workers / retries
--     there are, the message is due once. States: pending -> claimed -> sending -> sent | failed | uncertain | skipped. It is NOT PR-04's order_template_dispatches
--     (that ledger is tied to the packaging evidence and to ready_for_dispatch); it follows the same SAFE pattern: a send that may have reached WhatsApp but
--     could not be confirmed is `uncertain` and is NEVER re-sent automatically; a `failed` one (nothing reached WhatsApp) retries with a bounded backoff and a
--     person can retry it; a stale `sending` becomes `uncertain`.
--   * order_shipment_settings.destination_customer_message_enabled (default FALSE): stops the customer message WITHOUT stopping the Shalom tracking, the
--     internal alert or the abandonment detection. The template (name / language / variables) is configuration of the account: NOTHING is hardcoded and
--     no template is frozen (the real Meta template is PENDING PRE-DEPLOY).
--   * evaluate_pickup_day15: at 15 calendar days (America/Lima) En destino, the pickup condition becomes alerted_15d (regardless of the message switch) and, with
--     the switch ON, the ledger row is created (event destination_customer_message_due, once). The internal alert (evaluate_destination_alerts) is a separate,
--     untouched mechanism: it is neither duplicated nor replaced.
-- The message and the tracking are INDEPENDENT: a failed / uncertain message never changes the Shalom status, never stops the tracking, never blocks the alert
-- or the day-20 abandonment. The send itself is the EXISTING sendMessageToConversation (same conversation, same number, same history), driven by the app.
-- ============================================================

ALTER TABLE public.order_shipment_settings ADD COLUMN IF NOT EXISTS destination_customer_message_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.order_shipment_settings ADD COLUMN IF NOT EXISTS customer_message_template_name TEXT;
ALTER TABLE public.order_shipment_settings ADD COLUMN IF NOT EXISTS customer_message_template_language TEXT;
ALTER TABLE public.order_shipment_settings ADD COLUMN IF NOT EXISTS customer_message_template_params JSONB;
ALTER TABLE public.order_shipment_settings DROP CONSTRAINT IF EXISTS order_shipment_settings_message_template_pair;
ALTER TABLE public.order_shipment_settings ADD CONSTRAINT order_shipment_settings_message_template_pair CHECK ((customer_message_template_name IS NULL) = (customer_message_template_language IS NULL));
ALTER TABLE public.order_shipment_settings DROP CONSTRAINT IF EXISTS order_shipment_settings_message_template_form;
ALTER TABLE public.order_shipment_settings ADD CONSTRAINT order_shipment_settings_message_template_form CHECK (
  customer_message_template_name IS NULL
  OR (btrim(customer_message_template_name) <> '' AND char_length(customer_message_template_name) <= 512 AND btrim(customer_message_template_language) <> '' AND char_length(customer_message_template_language) <= 20)
);
ALTER TABLE public.order_shipment_settings DROP CONSTRAINT IF EXISTS order_shipment_settings_message_params_form;
ALTER TABLE public.order_shipment_settings ADD CONSTRAINT order_shipment_settings_message_params_form CHECK (
  customer_message_template_params IS NULL OR (jsonb_typeof(customer_message_template_params) = 'array' AND jsonb_array_length(customer_message_template_params) <= 20)
);

ALTER TABLE public.order_shipment_events DROP CONSTRAINT IF EXISTS order_shipment_events_type_check;
ALTER TABLE public.order_shipment_events ADD CONSTRAINT order_shipment_events_type_check CHECK (event_type IN (
  'shipment_registered', 'identifier_corrected', 'refresh_requested',
  'status_changed', 'regression_ignored', 'exception_unknown_state',
  'requires_attention', 'attention_cleared', 'tracking_stopped', 'delivered',
  'alert_created', 'alert_acknowledged', 'alert_resolved',
  'pickup_waiting_started', 'pickup_completed', 'pickup_abandonment_cleared',
  'destination_customer_message_due', 'destination_customer_message_sent', 'destination_customer_message_failed', 'destination_customer_message_uncertain',
  'destination_customer_message_skipped', 'destination_customer_message_retry_requested'
));
CREATE UNIQUE INDEX IF NOT EXISTS order_shipment_events_message_due_once ON public.order_shipment_events (order_id, ((detail ->> 'episode'))) WHERE event_type = 'destination_customer_message_due';

CREATE TABLE IF NOT EXISTS public.order_shipment_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  order_id UUID NOT NULL,
  destination_episode INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'destination_15d_customer',
  status TEXT NOT NULL DEFAULT 'pending',
  attempt INTEGER NOT NULL DEFAULT 0,
  claim_token UUID,
  lease_until TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  -- the SAME conversation as the order (never a new chat) and the template configured at the moment the message became due
  conversation_id UUID REFERENCES public.conversations(id) ON DELETE SET NULL,
  template_name TEXT,
  template_language TEXT,
  template_params JSONB,
  message_row_id UUID REFERENCES public.messages(id) ON DELETE SET NULL,
  wamid TEXT,
  error_code TEXT,
  -- Sanitized by the application: never a name, DNI, phone or token.
  error_detail TEXT,
  resolution TEXT,
  resolved_by UUID,
  resolved_at TIMESTAMPTZ,
  claimed_at TIMESTAMPTZ,
  sending_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT order_shipment_messages_order_fk FOREIGN KEY (order_id, account_id) REFERENCES public.order_confirmations (id, account_id) ON DELETE CASCADE,
  -- ONE message per episode of En destino and kind, whatever the number of ticks / workers / retries.
  CONSTRAINT order_shipment_messages_once UNIQUE (order_id, destination_episode, kind),
  CONSTRAINT order_shipment_messages_kind_check CHECK (kind IN ('destination_15d_customer')),
  CONSTRAINT order_shipment_messages_status_check CHECK (status IN ('pending', 'claimed', 'sending', 'sent', 'failed', 'uncertain', 'skipped')),
  CONSTRAINT order_shipment_messages_attempt_check CHECK (attempt >= 0 AND destination_episode >= 1),
  CONSTRAINT order_shipment_messages_resolution_check CHECK (resolution IS NULL OR resolution IN ('confirmed_sent', 'confirmed_not_sent')),
  CONSTRAINT order_shipment_messages_sent_shape CHECK (status <> 'sent' OR wamid IS NOT NULL OR resolution = 'confirmed_sent'),
  CONSTRAINT order_shipment_messages_claim_shape CHECK (status NOT IN ('claimed', 'sending') OR (claim_token IS NOT NULL AND lease_until IS NOT NULL)),
  CONSTRAINT order_shipment_messages_form CHECK (
    (error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,40}$') AND (error_detail IS NULL OR char_length(error_detail) <= 300)
  )
);
CREATE INDEX IF NOT EXISTS order_shipment_messages_due_idx ON public.order_shipment_messages (next_attempt_at) WHERE status IN ('pending', 'failed', 'claimed');
CREATE INDEX IF NOT EXISTS order_shipment_messages_order_idx ON public.order_shipment_messages (order_id, destination_episode);

-- Legal transitions only; `sent` / `skipped` are final; identity never changes. Same safe pattern as PR-04's dispatches.
CREATE OR REPLACE FUNCTION public.order_shipment_messages_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF public.order_logistics_history_protected(OLD.account_id, OLD.order_id) THEN
      RAISE EXCEPTION 'order_shipment_messages rows cannot be deleted' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.destination_episode IS DISTINCT FROM OLD.destination_episode OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (NEW.wamid IS DISTINCT FROM OLD.wamid AND OLD.wamid IS NOT NULL) THEN
    RAISE EXCEPTION 'message identity is immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.status IN ('sent', 'skipped') THEN
    RAISE EXCEPTION 'a % customer message is final', OLD.status USING ERRCODE = '42501';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      (OLD.status = 'pending' AND NEW.status IN ('claimed', 'skipped'))
      OR (OLD.status = 'claimed' AND NEW.status IN ('sending', 'failed', 'skipped', 'pending'))
      OR (OLD.status = 'sending' AND NEW.status IN ('sent', 'failed', 'uncertain'))
      OR (OLD.status = 'failed' AND NEW.status IN ('pending', 'claimed', 'skipped'))
      OR (OLD.status = 'uncertain' AND NEW.status IN ('sent', 'failed') AND NEW.resolution IS NOT NULL AND NEW.resolved_by IS NOT NULL)
    ) THEN
      RAISE EXCEPTION 'illegal customer message transition % -> %', OLD.status, NEW.status USING ERRCODE = '22023';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.order_shipment_messages_guard() OWNER TO postgres;
DROP TRIGGER IF EXISTS order_shipment_messages_guard ON public.order_shipment_messages;
CREATE TRIGGER order_shipment_messages_guard BEFORE UPDATE OR DELETE ON public.order_shipment_messages FOR EACH ROW EXECUTE FUNCTION public.order_shipment_messages_guard();

ALTER TABLE public.order_shipment_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.order_shipment_messages FROM anon, authenticated;
GRANT SELECT ON public.order_shipment_messages TO authenticated;
DROP POLICY IF EXISTS order_shipment_messages_select ON public.order_shipment_messages;
CREATE POLICY order_shipment_messages_select ON public.order_shipment_messages FOR SELECT USING (public.order_shipments_access(account_id));

-- ---------------------------------------------------------------
-- evaluate_pickup_day15
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.evaluate_pickup_day15(p_now TIMESTAMPTZ DEFAULT now(), p_days INTEGER DEFAULT 15)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r RECORD;
  v_alerted INTEGER := 0;
  v_due INTEGER := 0;
  v_id UUID;
BEGIN
  IF p_days IS NULL OR p_days < 1 THEN RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023'; END IF;

  -- 1. the pickup condition reaches alerted_15d (independent of the message switch)
  WITH moved AS (
    UPDATE public.order_shipments s SET pickup_state = 'alerted_15d', pickup_state_at = p_now, pickup_alerted_at = p_now
      FROM public.order_shipment_settings st, public.order_integration_settings ois
     WHERE st.account_id = s.account_id AND st.shalom_tracking_enabled AND ois.account_id = s.account_id AND ois.logistics_mvp_enabled
       AND s.tracking_state IN ('active', 'requires_attention') AND s.logistic_status = 'at_destination' AND s.pickup_state = 'waiting_pickup'
       AND s.destination_entered_at IS NOT NULL
       AND (p_now AT TIME ZONE 'America/Lima')::date >= (s.destination_entered_at AT TIME ZONE 'America/Lima')::date + p_days
    RETURNING s.id
  )
  SELECT count(*) INTO v_alerted FROM moved;

  -- 2. the customer message becomes DUE (ledger row) when the switch is ON; once per episode
  FOR r IN
    SELECT s.account_id, s.order_id, s.destination_episode, s.identifier_version, o.conversation_id,
           st.customer_message_template_name AS tname, st.customer_message_template_language AS tlang, st.customer_message_template_params AS tparams
      FROM public.order_shipments s
      JOIN public.order_shipment_settings st ON st.account_id = s.account_id AND st.shalom_tracking_enabled AND st.destination_customer_message_enabled
      JOIN public.order_integration_settings ois ON ois.account_id = s.account_id AND ois.logistics_mvp_enabled
      JOIN public.order_confirmations o ON o.id = s.order_id AND o.account_id = s.account_id
     WHERE s.tracking_state IN ('active', 'requires_attention') AND s.logistic_status = 'at_destination' AND s.pickup_state = 'alerted_15d'
       AND NOT EXISTS (SELECT 1 FROM public.order_shipment_messages m WHERE m.order_id = s.order_id AND m.destination_episode = s.destination_episode AND m.kind = 'destination_15d_customer')
  LOOP
    v_id := NULL;
    INSERT INTO public.order_shipment_messages (account_id, order_id, destination_episode, conversation_id, template_name, template_language, template_params, next_attempt_at, created_at)
    VALUES (r.account_id, r.order_id, r.destination_episode, r.conversation_id, r.tname, r.tlang, r.tparams, p_now, p_now)
    ON CONFLICT (order_id, destination_episode, kind) DO NOTHING
    RETURNING id INTO v_id;
    IF v_id IS NOT NULL THEN
      v_due := v_due + 1;
      PERFORM public.order_shipments_log(r.account_id, r.order_id, 'destination_customer_message_due', NULL, 'at_destination', r.identifier_version, NULL, 'system',
        jsonb_build_object('episode', r.destination_episode, 'message_id', v_id, 'kind', 'destination_15d_customer'));
    END IF;
  END LOOP;
  RETURN jsonb_build_object('alerted', v_alerted, 'messages_due', v_due);
END;
$$;
ALTER FUNCTION public.evaluate_pickup_day15(TIMESTAMPTZ, INTEGER) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.evaluate_pickup_day15(TIMESTAMPTZ, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.evaluate_pickup_day15(TIMESTAMPTZ, INTEGER) TO service_role;

-- ---------------------------------------------------------------
-- claim / mark sending / finish
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_shipment_messages(
  p_limit INTEGER DEFAULT 5, p_lease_seconds INTEGER DEFAULT 600, p_max_attempts INTEGER DEFAULT 3, p_order UUID DEFAULT NULL, p_now TIMESTAMPTZ DEFAULT now()
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r RECORD;
  v_rows JSONB;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 50 OR p_lease_seconds IS NULL OR p_lease_seconds < 5 OR p_max_attempts IS NULL OR p_max_attempts < 1 THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  -- a send whose process died is NOT retried: it may have reached WhatsApp, so a person confirms it
  FOR r IN
    UPDATE public.order_shipment_messages m SET status = 'uncertain', error_code = 'process_interrupted', finished_at = p_now, claim_token = NULL, lease_until = NULL
     WHERE m.status = 'sending' AND m.lease_until < p_now AND (p_order IS NULL OR m.order_id = p_order)
    RETURNING m.account_id, m.order_id, m.id, m.destination_episode
  LOOP
    PERFORM public.order_shipments_log(r.account_id, r.order_id, 'destination_customer_message_uncertain', NULL, NULL,
      (SELECT s.identifier_version FROM public.order_shipments s WHERE s.order_id = r.order_id), NULL, 'system',
      jsonb_build_object('episode', r.destination_episode, 'message_id', r.id, 'error_code', 'process_interrupted'));
  END LOOP;

  WITH picked AS (
    SELECT m.id
      FROM public.order_shipment_messages m
      JOIN public.order_shipment_settings st ON st.account_id = m.account_id AND st.shalom_tracking_enabled AND st.destination_customer_message_enabled
      JOIN public.order_integration_settings ois ON ois.account_id = m.account_id AND ois.logistics_mvp_enabled
     WHERE ((m.status = 'pending' AND m.next_attempt_at <= p_now)
         OR (m.status = 'failed' AND m.attempt < p_max_attempts AND m.next_attempt_at IS NOT NULL AND m.next_attempt_at <= p_now)
         OR (m.status = 'claimed' AND m.lease_until < p_now))
       AND (p_order IS NULL OR m.order_id = p_order)
     ORDER BY m.created_at, m.id
     LIMIT p_limit
     FOR UPDATE OF m SKIP LOCKED
  ), claimed AS (
    UPDATE public.order_shipment_messages m
       SET status = 'claimed', claim_token = gen_random_uuid(), lease_until = p_now + make_interval(secs => p_lease_seconds), claimed_at = p_now,
           attempt = CASE WHEN m.status = 'claimed' THEN m.attempt ELSE m.attempt + 1 END
      FROM picked WHERE m.id = picked.id
    RETURNING m.id, m.account_id, m.order_id, m.destination_episode, m.conversation_id, m.template_name, m.template_language, m.template_params, m.claim_token, m.attempt
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(c)), '[]'::jsonb) INTO v_rows FROM claimed c;
  RETURN v_rows;
END;
$$;
ALTER FUNCTION public.claim_shipment_messages(INTEGER, INTEGER, INTEGER, UUID, TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.claim_shipment_messages(INTEGER, INTEGER, INTEGER, UUID, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_shipment_messages(INTEGER, INTEGER, INTEGER, UUID, TIMESTAMPTZ) TO service_role;

-- Last check before WhatsApp: the shipment must STILL be En destino in the same episode and tracking. Otherwise the message is skipped (never sent).
CREATE OR REPLACE FUNCTION public.mark_shipment_message_sending(p_account UUID, p_message UUID, p_token UUID, p_lease_seconds INTEGER DEFAULT 600, p_now TIMESTAMPTZ DEFAULT now())
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  m public.order_shipment_messages%ROWTYPE;
  s public.order_shipments%ROWTYPE;
  v_reason TEXT;
BEGIN
  SELECT * INTO m FROM public.order_shipment_messages x WHERE x.id = p_message AND x.account_id = p_account FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  IF m.status <> 'claimed' OR m.claim_token IS DISTINCT FROM p_token THEN RETURN jsonb_build_object('ok', FALSE, 'reason', 'claim_lost'); END IF;
  SELECT * INTO s FROM public.order_shipments x WHERE x.order_id = m.order_id AND x.account_id = p_account;
  v_reason := CASE
    WHEN NOT FOUND THEN 'no_shipment'
    WHEN s.tracking_state NOT IN ('active', 'requires_attention') THEN 'tracking_not_active'
    WHEN s.logistic_status IS DISTINCT FROM 'at_destination' THEN 'no_longer_at_destination'
    WHEN s.destination_episode IS DISTINCT FROM m.destination_episode THEN 'episode_changed'
    ELSE NULL END;
  IF v_reason IS NOT NULL THEN
    UPDATE public.order_shipment_messages SET status = 'skipped', error_code = v_reason, finished_at = p_now, claim_token = NULL, lease_until = NULL WHERE id = m.id;
    PERFORM public.order_shipments_log(p_account, m.order_id, 'destination_customer_message_skipped', NULL, NULL, s.identifier_version, NULL, 'system',
      jsonb_build_object('episode', m.destination_episode, 'message_id', m.id, 'reason', v_reason));
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'skipped', 'skip_reason', v_reason);
  END IF;
  UPDATE public.order_shipment_messages SET status = 'sending', sending_at = p_now, lease_until = p_now + make_interval(secs => GREATEST(p_lease_seconds, 5)) WHERE id = m.id;
  RETURN jsonb_build_object('ok', TRUE);
END;
$$;
ALTER FUNCTION public.mark_shipment_message_sending(UUID, UUID, UUID, INTEGER, TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.mark_shipment_message_sending(UUID, UUID, UUID, INTEGER, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_shipment_message_sending(UUID, UUID, UUID, INTEGER, TIMESTAMPTZ) TO service_role;

CREATE OR REPLACE FUNCTION public.finish_shipment_message(
  p_account UUID, p_message UUID, p_token UUID, p_outcome TEXT, p_message_row UUID DEFAULT NULL, p_wamid TEXT DEFAULT NULL,
  p_error_code TEXT DEFAULT NULL, p_error_detail TEXT DEFAULT NULL, p_next_attempt_at TIMESTAMPTZ DEFAULT NULL, p_now TIMESTAMPTZ DEFAULT now()
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  m public.order_shipment_messages%ROWTYPE;
  v_version INTEGER;
  v_type TEXT;
BEGIN
  IF p_outcome NOT IN ('sent', 'failed', 'uncertain') THEN RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023'; END IF;
  SELECT * INTO m FROM public.order_shipment_messages x WHERE x.id = p_message AND x.account_id = p_account FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  IF m.claim_token IS DISTINCT FROM p_token OR m.status NOT IN ('claimed', 'sending') THEN RETURN jsonb_build_object('ok', FALSE, 'reason', 'claim_lost'); END IF;
  -- "sent" and "uncertain" only come out of an actual send attempt; a failure BEFORE Meta can be recorded straight from `claimed`
  IF p_outcome IN ('sent', 'uncertain') AND m.status <> 'sending' THEN RETURN jsonb_build_object('ok', FALSE, 'reason', 'not_sending'); END IF;
  SELECT s.identifier_version INTO v_version FROM public.order_shipments s WHERE s.order_id = m.order_id;

  UPDATE public.order_shipment_messages SET
    status = p_outcome, claim_token = NULL, lease_until = NULL, finished_at = p_now,
    message_row_id = CASE WHEN p_outcome = 'sent' THEN p_message_row ELSE message_row_id END,
    wamid = CASE WHEN p_outcome = 'sent' THEN p_wamid ELSE wamid END,
    error_code = CASE WHEN p_outcome = 'sent' THEN NULL ELSE p_error_code END,
    error_detail = CASE WHEN p_outcome = 'sent' THEN NULL ELSE left(p_error_detail, 300) END,
    next_attempt_at = CASE WHEN p_outcome = 'failed' THEN p_next_attempt_at ELSE NULL END
   WHERE id = m.id;
  v_type := 'destination_customer_message_' || p_outcome;
  PERFORM public.order_shipments_log(p_account, m.order_id, v_type, NULL, NULL, v_version, NULL, 'system',
    jsonb_build_object('episode', m.destination_episode, 'message_id', m.id, 'attempt', m.attempt, 'error_code', p_error_code));
  RETURN jsonb_build_object('ok', TRUE, 'status', p_outcome);
END;
$$;
ALTER FUNCTION public.finish_shipment_message(UUID, UUID, UUID, TEXT, UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.finish_shipment_message(UUID, UUID, UUID, TEXT, UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_shipment_message(UUID, UUID, UUID, TEXT, UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;

-- ---------------------------------------------------------------
-- actor-driven: controlled retry of a FAILED message / resolution of an UNCERTAIN one (Logística / Supervisor)
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.retry_shipment_message(p_account UUID, p_actor UUID, p_message UUID, p_now TIMESTAMPTZ DEFAULT now())
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name TEXT := public.order_shipments_actor(p_account, p_actor, FALSE);
  m public.order_shipment_messages%ROWTYPE;
  s public.order_shipments%ROWTYPE;
BEGIN
  SELECT * INTO m FROM public.order_shipment_messages x WHERE x.id = p_message AND x.account_id = p_account;
  IF NOT FOUND THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  PERFORM public.order_shipments_lock(m.order_id);
  SELECT * INTO m FROM public.order_shipment_messages x WHERE x.id = p_message FOR UPDATE;
  IF m.status <> 'failed' THEN RETURN jsonb_build_object('ok', FALSE, 'reason', CASE WHEN m.status = 'uncertain' THEN 'needs_resolution' ELSE 'not_failed' END); END IF;
  SELECT * INTO s FROM public.order_shipments x WHERE x.order_id = m.order_id AND x.account_id = p_account;
  IF NOT FOUND OR s.logistic_status IS DISTINCT FROM 'at_destination' OR s.destination_episode IS DISTINCT FROM m.destination_episode OR s.tracking_state NOT IN ('active', 'requires_attention') THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'no_longer_at_destination');
  END IF;
  UPDATE public.order_shipment_messages SET status = 'pending', next_attempt_at = p_now WHERE id = m.id;
  PERFORM public.order_shipments_log(p_account, m.order_id, 'destination_customer_message_retry_requested', NULL, NULL, s.identifier_version, p_actor, v_name,
    jsonb_build_object('episode', m.destination_episode, 'message_id', m.id, 'attempt', m.attempt));
  RETURN jsonb_build_object('ok', TRUE);
END;
$$;
ALTER FUNCTION public.retry_shipment_message(UUID, UUID, UUID, TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.retry_shipment_message(UUID, UUID, UUID, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.retry_shipment_message(UUID, UUID, UUID, TIMESTAMPTZ) TO service_role;

-- An UNCERTAIN message is resolved by a PERSON who looked at the conversation: it is never re-sent automatically.
CREATE OR REPLACE FUNCTION public.resolve_shipment_message(p_account UUID, p_actor UUID, p_message UUID, p_resolution TEXT, p_now TIMESTAMPTZ DEFAULT now())
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name TEXT := public.order_shipments_actor(p_account, p_actor, FALSE);
  m public.order_shipment_messages%ROWTYPE;
BEGIN
  IF p_resolution NOT IN ('confirmed_sent', 'confirmed_not_sent') THEN RETURN jsonb_build_object('ok', FALSE, 'reason', 'invalid_resolution'); END IF;
  SELECT * INTO m FROM public.order_shipment_messages x WHERE x.id = p_message AND x.account_id = p_account;
  IF NOT FOUND THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  PERFORM public.order_shipments_lock(m.order_id);
  SELECT * INTO m FROM public.order_shipment_messages x WHERE x.id = p_message FOR UPDATE;
  IF m.status <> 'uncertain' THEN RETURN jsonb_build_object('ok', FALSE, 'reason', 'not_uncertain'); END IF;
  UPDATE public.order_shipment_messages SET
    status = CASE WHEN p_resolution = 'confirmed_sent' THEN 'sent' ELSE 'failed' END,
    resolution = p_resolution, resolved_by = p_actor, resolved_at = p_now, finished_at = p_now,
    -- confirmed_not_sent: no automatic retry; a person retries explicitly
    next_attempt_at = NULL
   WHERE id = m.id;
  PERFORM public.order_shipments_log(p_account, m.order_id,
    CASE WHEN p_resolution = 'confirmed_sent' THEN 'destination_customer_message_sent' ELSE 'destination_customer_message_failed' END, NULL, NULL,
    (SELECT s.identifier_version FROM public.order_shipments s WHERE s.order_id = m.order_id), p_actor, v_name,
    jsonb_build_object('episode', m.destination_episode, 'message_id', m.id, 'resolution', p_resolution));
  RETURN jsonb_build_object('ok', TRUE, 'status', CASE WHEN p_resolution = 'confirmed_sent' THEN 'sent' ELSE 'failed' END);
END;
$$;
ALTER FUNCTION public.resolve_shipment_message(UUID, UUID, UUID, TEXT, TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.resolve_shipment_message(UUID, UUID, UUID, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_shipment_message(UUID, UUID, UUID, TEXT, TIMESTAMPTZ) TO service_role;
