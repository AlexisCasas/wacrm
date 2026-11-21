-- ============================================================
-- 20261205000003_shipment_voucher_message
--
-- P0 parity patch (feat/p0-parity-balance-voucher), unit 2 of 2. ADDITIVE and IDEMPOTENT: one new table, new RPCs, new nullable settings columns and four
-- new event types. No historical migration edited, no existing value changed, no flag activated, no template created, nothing loaded.
--
-- The "voucher notice": the customer receives the SHALOM VOUCHER (the validated PDF of PR-04) with the guide (order number + code) and the destination, through the
-- operational template `voucher_envio_shalom` (UTILITY, header DOCUMENT). It is the equivalent of InkaClick's `voucher_shalom_pdf`, which an operator sends by hand
-- (~62 per day): so it is MANUAL here too. Nothing in this migration (and nothing in the cron tick) ever sends it by itself.
--
--   order_shipment_voucher_messages   its OWN ledger (NOT order_shipment_messages: that one is picked up by the automatic tick and this notice must never be).
--                                     ONE row per (order, identifier_version) = ONE notice per guide; a corrected guide is a new version and may be sent again.
--                                     States: claimed -> sending -> sent | failed | uncertain | skipped. A `failed` one is retried ONLY by a person (retry RPC); an
--                                     `uncertain` one (Meta may have accepted it) is NEVER re-sent automatically: a person resolves it.
--   order_shipment_settings.voucher_message_template_*   the template (name / language / variables) is configuration of the account, not code; snapshotted into the
--                                     row when it is claimed (and refreshed when a person retries, so a configuration fix takes effect).
--   Everything is actor-driven (Logistica / Supervisor of the account; Commercial and others can neither send nor read it) and service_role only; the browser can
--   only SELECT. The shipment (guide) must exist, the order must have a chat, the PR-04 voucher must be validated, and the account switches must be ON.
-- ============================================================

-- 1. Template configuration ---------------------------------------------------------------------------------------------------------------------------------------
ALTER TABLE public.order_shipment_settings ADD COLUMN IF NOT EXISTS voucher_message_template_name TEXT;
ALTER TABLE public.order_shipment_settings ADD COLUMN IF NOT EXISTS voucher_message_template_language TEXT;
ALTER TABLE public.order_shipment_settings ADD COLUMN IF NOT EXISTS voucher_message_template_params JSONB;
ALTER TABLE public.order_shipment_settings DROP CONSTRAINT IF EXISTS order_shipment_settings_voucher_template_pair;
ALTER TABLE public.order_shipment_settings ADD CONSTRAINT order_shipment_settings_voucher_template_pair CHECK ((voucher_message_template_name IS NULL) = (voucher_message_template_language IS NULL));
ALTER TABLE public.order_shipment_settings DROP CONSTRAINT IF EXISTS order_shipment_settings_voucher_template_form;
ALTER TABLE public.order_shipment_settings ADD CONSTRAINT order_shipment_settings_voucher_template_form CHECK (
  voucher_message_template_name IS NULL
  OR (btrim(voucher_message_template_name) <> '' AND char_length(voucher_message_template_name) <= 512 AND btrim(voucher_message_template_language) <> '' AND char_length(voucher_message_template_language) <= 20)
);
ALTER TABLE public.order_shipment_settings DROP CONSTRAINT IF EXISTS order_shipment_settings_voucher_params_form;
ALTER TABLE public.order_shipment_settings ADD CONSTRAINT order_shipment_settings_voucher_params_form CHECK (
  voucher_message_template_params IS NULL OR (jsonb_typeof(voucher_message_template_params) = 'array' AND jsonb_array_length(voucher_message_template_params) <= 20)
);

-- 2. Event types (the audit trail of the shipment) --------------------------------------------------------------------------------------------------------------------
ALTER TABLE public.order_shipment_events DROP CONSTRAINT IF EXISTS order_shipment_events_type_check;
ALTER TABLE public.order_shipment_events ADD CONSTRAINT order_shipment_events_type_check CHECK (event_type IN (
  'shipment_registered', 'identifier_corrected', 'refresh_requested',
  'status_changed', 'regression_ignored', 'exception_unknown_state',
  'requires_attention', 'attention_cleared', 'tracking_stopped', 'delivered',
  'alert_created', 'alert_acknowledged', 'alert_resolved',
  'pickup_waiting_started', 'pickup_completed', 'pickup_abandonment_cleared', 'pickup_abandoned',
  'destination_customer_message_due', 'destination_customer_message_sent', 'destination_customer_message_failed', 'destination_customer_message_uncertain',
  'destination_customer_message_skipped', 'destination_customer_message_retry_requested',
  'destination_arrival_message_due',
  'shipment_voucher_sent', 'shipment_voucher_failed', 'shipment_voucher_uncertain', 'shipment_voucher_retry_requested', 'shipment_voucher_resolved'
));

-- 3. The ledger ---------------------------------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.order_shipment_voucher_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  order_id UUID NOT NULL,
  -- the guide (order_shipments.identifier_version) this notice is about: one notice per guide
  identifier_version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'claimed',
  attempt INTEGER NOT NULL DEFAULT 1,
  claim_token UUID,
  lease_until TIMESTAMPTZ,
  -- the SAME conversation as the order (never a new chat), the validated PR-04 voucher and the template configured at the moment of the claim
  conversation_id UUID REFERENCES public.conversations(id) ON DELETE SET NULL,
  voucher_document_id UUID,
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
  created_by UUID,
  claimed_at TIMESTAMPTZ,
  sending_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT order_shipment_voucher_messages_order_fk FOREIGN KEY (order_id, account_id) REFERENCES public.order_confirmations (id, account_id) ON DELETE CASCADE,
  -- ONE notice per guide, whatever the number of clicks / operators / retries.
  CONSTRAINT order_shipment_voucher_messages_once UNIQUE (order_id, identifier_version),
  CONSTRAINT order_shipment_voucher_messages_status_check CHECK (status IN ('claimed', 'sending', 'sent', 'failed', 'uncertain', 'skipped')),
  CONSTRAINT order_shipment_voucher_messages_attempt_check CHECK (attempt >= 1 AND identifier_version >= 1),
  CONSTRAINT order_shipment_voucher_messages_resolution_check CHECK (resolution IS NULL OR resolution IN ('confirmed_sent', 'confirmed_not_sent')),
  CONSTRAINT order_shipment_voucher_messages_sent_shape CHECK (status <> 'sent' OR wamid IS NOT NULL OR resolution = 'confirmed_sent'),
  CONSTRAINT order_shipment_voucher_messages_claim_shape CHECK (status NOT IN ('claimed', 'sending') OR (claim_token IS NOT NULL AND lease_until IS NOT NULL)),
  CONSTRAINT order_shipment_voucher_messages_form CHECK ((error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,40}$') AND (error_detail IS NULL OR char_length(error_detail) <= 300))
);
CREATE INDEX IF NOT EXISTS order_shipment_voucher_messages_order_idx ON public.order_shipment_voucher_messages (order_id, identifier_version);

-- Legal transitions only; `sent` / `skipped` are final; identity never changes.
CREATE OR REPLACE FUNCTION public.order_shipment_voucher_messages_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF public.order_logistics_history_protected(OLD.account_id, OLD.order_id) THEN
      RAISE EXCEPTION 'order_shipment_voucher_messages rows cannot be deleted' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.identifier_version IS DISTINCT FROM OLD.identifier_version OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (NEW.wamid IS DISTINCT FROM OLD.wamid AND OLD.wamid IS NOT NULL) THEN
    RAISE EXCEPTION 'voucher message identity is immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.status IN ('sent', 'skipped') THEN
    RAISE EXCEPTION 'a % voucher message is final', OLD.status USING ERRCODE = '42501';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      (OLD.status = 'claimed' AND NEW.status IN ('sending', 'failed', 'skipped'))
      OR (OLD.status = 'sending' AND NEW.status IN ('sent', 'failed', 'uncertain'))
      OR (OLD.status = 'failed' AND NEW.status IN ('claimed', 'skipped'))
      OR (OLD.status = 'uncertain' AND NEW.status IN ('sent', 'failed') AND NEW.resolution IS NOT NULL AND NEW.resolved_by IS NOT NULL)
    ) THEN
      RAISE EXCEPTION 'illegal voucher message transition % -> %', OLD.status, NEW.status USING ERRCODE = '22023';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.order_shipment_voucher_messages_guard() OWNER TO postgres;
DROP TRIGGER IF EXISTS order_shipment_voucher_messages_guard ON public.order_shipment_voucher_messages;
CREATE TRIGGER order_shipment_voucher_messages_guard BEFORE UPDATE OR DELETE ON public.order_shipment_voucher_messages FOR EACH ROW EXECUTE FUNCTION public.order_shipment_voucher_messages_guard();

ALTER TABLE public.order_shipment_voucher_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.order_shipment_voucher_messages FROM anon, authenticated;
GRANT SELECT ON public.order_shipment_voucher_messages TO authenticated;
DROP POLICY IF EXISTS order_shipment_voucher_messages_select ON public.order_shipment_voucher_messages;
CREATE POLICY order_shipment_voucher_messages_select ON public.order_shipment_voucher_messages FOR SELECT USING (public.order_shipments_access(account_id));

-- 4. begin (claim) ------------------------------------------------------------------------------------------------------------------------------------------------------
-- A person pressed "send the voucher". Everything that can be decided in the database is decided here; nothing is claimed unless it can be sent.
CREATE OR REPLACE FUNCTION public.begin_shipment_voucher_message(p_account UUID, p_actor UUID, p_order UUID, p_lease_seconds INTEGER DEFAULT 600, p_now TIMESTAMPTZ DEFAULT now())
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name TEXT := public.order_shipments_actor(p_account, p_actor, FALSE);
  s public.order_shipments%ROWTYPE;
  st RECORD;
  m public.order_shipment_voucher_messages%ROWTYPE;
  v_conversation UUID;
  v_voucher UUID;
  v_token UUID := gen_random_uuid();
BEGIN
  IF p_lease_seconds IS NULL OR p_lease_seconds < 5 THEN RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023'; END IF;
  PERFORM public.order_shipments_lock(p_order);
  SELECT * INTO s FROM public.order_shipments x WHERE x.order_id = p_order AND x.account_id = p_account;
  IF NOT FOUND THEN
    IF NOT EXISTS (SELECT 1 FROM public.order_confirmations o WHERE o.id = p_order AND o.account_id = p_account) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'no_shipment');
  END IF;
  SELECT x.destination_customer_message_enabled AS enabled, x.voucher_message_template_name AS tname, x.voucher_message_template_language AS tlang, x.voucher_message_template_params AS tparams
    INTO st FROM public.order_shipment_settings x WHERE x.account_id = p_account;
  IF NOT FOUND OR NOT COALESCE(st.enabled, FALSE) THEN RETURN jsonb_build_object('ok', FALSE, 'reason', 'customer_message_disabled'); END IF;
  IF st.tname IS NULL OR st.tlang IS NULL THEN RETURN jsonb_build_object('ok', FALSE, 'reason', 'template_not_configured'); END IF;
  IF s.tracking_state = 'stopped' THEN RETURN jsonb_build_object('ok', FALSE, 'reason', 'tracking_stopped'); END IF;
  SELECT o.conversation_id INTO v_conversation FROM public.order_confirmations o WHERE o.id = p_order AND o.account_id = p_account;
  IF v_conversation IS NULL THEN RETURN jsonb_build_object('ok', FALSE, 'reason', 'order_without_conversation'); END IF;
  SELECT d.id INTO v_voucher
    FROM public.order_logistics l JOIN public.order_documents d ON d.id = l.voucher_document_id AND d.account_id = l.account_id AND d.kind = 'voucher' AND d.status = 'validated'
   WHERE l.order_id = p_order AND l.account_id = p_account;
  IF v_voucher IS NULL THEN RETURN jsonb_build_object('ok', FALSE, 'reason', 'voucher_required'); END IF;

  SELECT * INTO m FROM public.order_shipment_voucher_messages x WHERE x.order_id = p_order AND x.identifier_version = s.identifier_version FOR UPDATE;
  IF FOUND THEN
    IF m.status = 'sent' THEN RETURN jsonb_build_object('ok', FALSE, 'reason', 'already_sent', 'message_id', m.id); END IF;
    IF m.status = 'skipped' THEN RETURN jsonb_build_object('ok', FALSE, 'reason', 'skipped', 'message_id', m.id); END IF;
    IF m.status = 'failed' THEN RETURN jsonb_build_object('ok', FALSE, 'reason', 'failed_use_retry', 'message_id', m.id); END IF;
    IF m.status = 'uncertain' THEN RETURN jsonb_build_object('ok', FALSE, 'reason', 'needs_resolution', 'message_id', m.id); END IF;
    IF m.status IN ('claimed', 'sending') AND m.lease_until >= p_now THEN RETURN jsonb_build_object('ok', FALSE, 'reason', 'in_progress', 'message_id', m.id); END IF;
    IF m.status = 'sending' THEN
      -- a send whose process died may have reached WhatsApp: it is NOT retried, a person confirms it
      UPDATE public.order_shipment_voucher_messages SET status = 'uncertain', error_code = 'process_interrupted', finished_at = p_now, claim_token = NULL, lease_until = NULL WHERE id = m.id;
      PERFORM public.order_shipments_log(p_account, p_order, 'shipment_voucher_uncertain', NULL, NULL, s.identifier_version, NULL, 'system', jsonb_build_object('message_id', m.id, 'error_code', 'process_interrupted'));
      RETURN jsonb_build_object('ok', FALSE, 'reason', 'needs_resolution', 'message_id', m.id);
    END IF;
    -- a claim that died BEFORE sending is simply retaken
    UPDATE public.order_shipment_voucher_messages SET claim_token = v_token, lease_until = p_now + make_interval(secs => p_lease_seconds), claimed_at = p_now, created_by = p_actor WHERE id = m.id RETURNING * INTO m;
  ELSE
    INSERT INTO public.order_shipment_voucher_messages (account_id, order_id, identifier_version, status, attempt, claim_token, lease_until, conversation_id, voucher_document_id, template_name, template_language, template_params, created_by, claimed_at)
    VALUES (p_account, p_order, s.identifier_version, 'claimed', 1, v_token, p_now + make_interval(secs => p_lease_seconds), v_conversation, v_voucher, st.tname, st.tlang, st.tparams, p_actor, p_now)
    RETURNING * INTO m;
  END IF;
  RETURN jsonb_build_object('ok', TRUE, 'message_id', m.id, 'claim_token', m.claim_token, 'attempt', m.attempt, 'conversation_id', m.conversation_id, 'voucher_document_id', m.voucher_document_id,
    'template_name', m.template_name, 'template_language', m.template_language, 'template_params', m.template_params, 'tracking_number', s.tracking_number, 'tracking_code', s.tracking_code,
    'identifier_version', s.identifier_version, 'actor_name', v_name);
END;
$$;
ALTER FUNCTION public.begin_shipment_voucher_message(UUID, UUID, UUID, INTEGER, TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.begin_shipment_voucher_message(UUID, UUID, UUID, INTEGER, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_shipment_voucher_message(UUID, UUID, UUID, INTEGER, TIMESTAMPTZ) TO service_role;

-- 5. last check before WhatsApp -----------------------------------------------------------------------------------------------------------------------------------------
-- The guide must STILL be the one this notice is about (a corrected guide makes it obsolete: skipped, never sent) and the tracking must not be stopped.
CREATE OR REPLACE FUNCTION public.mark_shipment_voucher_sending(p_account UUID, p_message UUID, p_token UUID, p_lease_seconds INTEGER DEFAULT 600, p_now TIMESTAMPTZ DEFAULT now())
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  m public.order_shipment_voucher_messages%ROWTYPE;
  s public.order_shipments%ROWTYPE;
  v_reason TEXT;
BEGIN
  SELECT * INTO m FROM public.order_shipment_voucher_messages x WHERE x.id = p_message AND x.account_id = p_account FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  IF m.status <> 'claimed' OR m.claim_token IS DISTINCT FROM p_token THEN RETURN jsonb_build_object('ok', FALSE, 'reason', 'claim_lost'); END IF;
  SELECT * INTO s FROM public.order_shipments x WHERE x.order_id = m.order_id AND x.account_id = p_account;
  v_reason := CASE
    WHEN NOT FOUND THEN 'no_shipment'
    WHEN s.tracking_state = 'stopped' THEN 'tracking_stopped'
    WHEN s.identifier_version IS DISTINCT FROM m.identifier_version THEN 'guide_changed'
    ELSE NULL END;
  IF v_reason IS NOT NULL THEN
    UPDATE public.order_shipment_voucher_messages SET status = 'skipped', error_code = v_reason, finished_at = p_now, claim_token = NULL, lease_until = NULL WHERE id = m.id;
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'skipped', 'skip_reason', v_reason);
  END IF;
  UPDATE public.order_shipment_voucher_messages SET status = 'sending', sending_at = p_now, lease_until = p_now + make_interval(secs => GREATEST(p_lease_seconds, 5)) WHERE id = m.id;
  RETURN jsonb_build_object('ok', TRUE);
END;
$$;
ALTER FUNCTION public.mark_shipment_voucher_sending(UUID, UUID, UUID, INTEGER, TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.mark_shipment_voucher_sending(UUID, UUID, UUID, INTEGER, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_shipment_voucher_sending(UUID, UUID, UUID, INTEGER, TIMESTAMPTZ) TO service_role;

-- 6. finish --------------------------------------------------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.finish_shipment_voucher_message(
  p_account UUID, p_message UUID, p_token UUID, p_outcome TEXT, p_message_row UUID DEFAULT NULL, p_wamid TEXT DEFAULT NULL,
  p_error_code TEXT DEFAULT NULL, p_error_detail TEXT DEFAULT NULL, p_now TIMESTAMPTZ DEFAULT now()
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  m public.order_shipment_voucher_messages%ROWTYPE;
BEGIN
  IF p_outcome NOT IN ('sent', 'failed', 'uncertain') THEN RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023'; END IF;
  SELECT * INTO m FROM public.order_shipment_voucher_messages x WHERE x.id = p_message AND x.account_id = p_account FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  IF m.claim_token IS DISTINCT FROM p_token OR m.status NOT IN ('claimed', 'sending') THEN RETURN jsonb_build_object('ok', FALSE, 'reason', 'claim_lost'); END IF;
  -- "sent" and "uncertain" only come out of an actual send attempt; a failure BEFORE Meta can be recorded straight from `claimed`
  IF p_outcome IN ('sent', 'uncertain') AND m.status <> 'sending' THEN RETURN jsonb_build_object('ok', FALSE, 'reason', 'not_sending'); END IF;
  UPDATE public.order_shipment_voucher_messages SET
    status = p_outcome, claim_token = NULL, lease_until = NULL, finished_at = p_now,
    message_row_id = CASE WHEN p_outcome = 'sent' THEN p_message_row ELSE message_row_id END,
    wamid = CASE WHEN p_outcome = 'sent' THEN p_wamid ELSE wamid END,
    error_code = CASE WHEN p_outcome = 'sent' THEN NULL ELSE p_error_code END,
    error_detail = CASE WHEN p_outcome = 'sent' THEN NULL ELSE left(p_error_detail, 300) END
   WHERE id = m.id;
  PERFORM public.order_shipments_log(p_account, m.order_id, 'shipment_voucher_' || p_outcome, NULL, NULL, m.identifier_version, NULL, 'system',
    jsonb_build_object('message_id', m.id, 'attempt', m.attempt, 'error_code', p_error_code));
  RETURN jsonb_build_object('ok', TRUE, 'status', p_outcome);
END;
$$;
ALTER FUNCTION public.finish_shipment_voucher_message(UUID, UUID, UUID, TEXT, UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.finish_shipment_voucher_message(UUID, UUID, UUID, TEXT, UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_shipment_voucher_message(UUID, UUID, UUID, TEXT, UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ) TO service_role;

-- 7. controlled retry of a FAILED notice (a person; never automatic) -------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.retry_shipment_voucher_message(p_account UUID, p_actor UUID, p_message UUID, p_lease_seconds INTEGER DEFAULT 600, p_now TIMESTAMPTZ DEFAULT now())
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name TEXT := public.order_shipments_actor(p_account, p_actor, FALSE);
  m public.order_shipment_voucher_messages%ROWTYPE;
  s public.order_shipments%ROWTYPE;
  st RECORD;
  v_token UUID := gen_random_uuid();
BEGIN
  IF p_lease_seconds IS NULL OR p_lease_seconds < 5 THEN RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023'; END IF;
  SELECT * INTO m FROM public.order_shipment_voucher_messages x WHERE x.id = p_message AND x.account_id = p_account;
  IF NOT FOUND THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  PERFORM public.order_shipments_lock(m.order_id);
  SELECT * INTO m FROM public.order_shipment_voucher_messages x WHERE x.id = p_message FOR UPDATE;
  IF m.status <> 'failed' THEN RETURN jsonb_build_object('ok', FALSE, 'reason', CASE WHEN m.status = 'uncertain' THEN 'needs_resolution' WHEN m.status = 'sent' THEN 'already_sent' ELSE 'not_failed' END); END IF;
  SELECT * INTO s FROM public.order_shipments x WHERE x.order_id = m.order_id AND x.account_id = p_account;
  IF NOT FOUND OR s.identifier_version IS DISTINCT FROM m.identifier_version OR s.tracking_state = 'stopped' THEN RETURN jsonb_build_object('ok', FALSE, 'reason', 'guide_changed'); END IF;
  SELECT x.destination_customer_message_enabled AS enabled, x.voucher_message_template_name AS tname, x.voucher_message_template_language AS tlang, x.voucher_message_template_params AS tparams
    INTO st FROM public.order_shipment_settings x WHERE x.account_id = p_account;
  IF NOT FOUND OR NOT COALESCE(st.enabled, FALSE) THEN RETURN jsonb_build_object('ok', FALSE, 'reason', 'customer_message_disabled'); END IF;
  IF st.tname IS NULL OR st.tlang IS NULL THEN RETURN jsonb_build_object('ok', FALSE, 'reason', 'template_not_configured'); END IF;
  -- the configuration is read AGAIN: a person fixed it and retries
  UPDATE public.order_shipment_voucher_messages SET status = 'claimed', attempt = m.attempt + 1, claim_token = v_token, lease_until = p_now + make_interval(secs => p_lease_seconds), claimed_at = p_now,
         template_name = st.tname, template_language = st.tlang, template_params = st.tparams, error_code = NULL, error_detail = NULL, created_by = p_actor
   WHERE id = m.id RETURNING * INTO m;
  PERFORM public.order_shipments_log(p_account, m.order_id, 'shipment_voucher_retry_requested', NULL, NULL, m.identifier_version, p_actor, v_name, jsonb_build_object('message_id', m.id, 'attempt', m.attempt));
  RETURN jsonb_build_object('ok', TRUE, 'message_id', m.id, 'claim_token', m.claim_token, 'attempt', m.attempt, 'conversation_id', m.conversation_id, 'voucher_document_id', m.voucher_document_id,
    'template_name', m.template_name, 'template_language', m.template_language, 'template_params', m.template_params, 'tracking_number', s.tracking_number, 'tracking_code', s.tracking_code,
    'identifier_version', s.identifier_version, 'actor_name', v_name);
END;
$$;
ALTER FUNCTION public.retry_shipment_voucher_message(UUID, UUID, UUID, INTEGER, TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.retry_shipment_voucher_message(UUID, UUID, UUID, INTEGER, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.retry_shipment_voucher_message(UUID, UUID, UUID, INTEGER, TIMESTAMPTZ) TO service_role;

-- 8. an UNCERTAIN notice is resolved by a PERSON who looked at the conversation ------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_shipment_voucher_message(p_account UUID, p_actor UUID, p_message UUID, p_resolution TEXT, p_now TIMESTAMPTZ DEFAULT now())
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name TEXT := public.order_shipments_actor(p_account, p_actor, FALSE);
  m public.order_shipment_voucher_messages%ROWTYPE;
BEGIN
  IF p_resolution NOT IN ('confirmed_sent', 'confirmed_not_sent') THEN RETURN jsonb_build_object('ok', FALSE, 'reason', 'invalid_resolution'); END IF;
  SELECT * INTO m FROM public.order_shipment_voucher_messages x WHERE x.id = p_message AND x.account_id = p_account;
  IF NOT FOUND THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  PERFORM public.order_shipments_lock(m.order_id);
  SELECT * INTO m FROM public.order_shipment_voucher_messages x WHERE x.id = p_message FOR UPDATE;
  IF m.status <> 'uncertain' THEN RETURN jsonb_build_object('ok', FALSE, 'reason', 'not_uncertain'); END IF;
  UPDATE public.order_shipment_voucher_messages SET
    status = CASE WHEN p_resolution = 'confirmed_sent' THEN 'sent' ELSE 'failed' END,
    resolution = p_resolution, resolved_by = p_actor, resolved_at = p_now, finished_at = p_now
   WHERE id = m.id;
  PERFORM public.order_shipments_log(p_account, m.order_id, 'shipment_voucher_resolved', NULL, NULL, m.identifier_version, p_actor, v_name,
    jsonb_build_object('message_id', m.id, 'resolution', p_resolution));
  RETURN jsonb_build_object('ok', TRUE, 'status', CASE WHEN p_resolution = 'confirmed_sent' THEN 'sent' ELSE 'failed' END);
END;
$$;
ALTER FUNCTION public.resolve_shipment_voucher_message(UUID, UUID, UUID, TEXT, TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.resolve_shipment_voucher_message(UUID, UUID, UUID, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_shipment_voucher_message(UUID, UUID, UUID, TEXT, TIMESTAMPTZ) TO service_role;
