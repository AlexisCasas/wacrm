-- ============================================================
-- 20261129000004_order_template_dispatch_rpcs
--
-- PR-04 · the operational WhatsApp template of the packaging step: DURABLE, IDEMPOTENT state of the send. Purely additive (four new functions).
-- It wraps the EXISTING WhatsApp send (send-message / Meta core, untouched) with its own operational ledger, `order_template_dispatches`:
--
--   begin_template_dispatch     claim the send for (order, request_key). The same key is the same operation (double click, HTTP retry, two operators):
--                               a `sent` dispatch is simply returned, an in-flight one answers `in_progress`, an `uncertain` one answers `uncertain`.
--                               Only ONE unresolved dispatch can exist per order. A `failed` dispatch of the same key is retried (attempt + 1).
--                               A claim that never reached Meta (process died) is retaken after 5 minutes; a send that started and never reported is
--                               turned into `uncertain` after 5 minutes (it is NEVER re-sent automatically).
--   mark_template_dispatch_sending   claimed -> sending, called right before the Meta call: from this instant a crash means "uncertain", not "retry".
--   finish_template_dispatch    the outcome: sent | failed | uncertain. `sent` completes the packaging IN THE SAME TRANSACTION
--                               (order_logistics: packing -> ready_for_dispatch). `failed` / `uncertain` leave the order in packing.
--   resolve_template_dispatch   a PERSON settles an `uncertain` dispatch after looking at the chat: confirmed_sent (completes the packaging) or
--                               confirmed_not_sent (stays in packing, can be retried / re-sent with a new key). Audited.
--
-- The state of the order only advances after a confirmed send. Errors never carry names, DNI, phones, tokens or provider text (code + <= 300 chars).
-- Template name / language come from order_logistics_settings (resolved by the application); nothing is hardcoded here.
-- ============================================================

CREATE OR REPLACE FUNCTION public.begin_template_dispatch(
  p_account UUID, p_actor UUID, p_order UUID, p_request_key TEXT, p_template_name TEXT, p_template_language TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name TEXT := public.order_logistics_actor(p_account, p_actor);
  l public.order_logistics%ROWTYPE;
  d public.order_template_dispatches%ROWTYPE;
  o public.order_template_dispatches%ROWTYPE;
  v_conversation UUID;
BEGIN
  IF p_request_key IS NULL OR btrim(p_request_key) = '' OR char_length(p_request_key) > 100
     OR p_template_name IS NULL OR btrim(p_template_name) = '' OR p_template_language IS NULL OR btrim(p_template_language) = '' THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  PERFORM public.order_logistics_require_order(p_account, p_order);
  PERFORM public.order_logistics_lock(p_order);

  SELECT * INTO l FROM public.order_logistics x WHERE x.order_id = p_order FOR UPDATE;
  IF NOT FOUND OR l.status IN ('pending_voucher', 'voucher_validated') THEN
    -- A replay of a send that already completed the packaging is still answered below, but it needs the row: none means nothing was ever sent.
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'not_packing');
  END IF;

  -- Same operation again?
  SELECT * INTO d FROM public.order_template_dispatches t WHERE t.order_id = p_order AND t.request_key = p_request_key FOR UPDATE;
  IF FOUND THEN
    IF d.status = 'sent' THEN
      RETURN jsonb_build_object('ok', TRUE, 'replay', TRUE, 'status', 'sent', 'dispatch_id', d.id, 'message_row_id', d.message_row_id, 'wamid', d.wamid);
    ELSIF d.status = 'uncertain' THEN
      RETURN jsonb_build_object('ok', FALSE, 'reason', 'uncertain', 'dispatch_id', d.id);
    ELSIF d.status = 'sending' THEN
      IF d.sending_at < now() - interval '5 minutes' THEN
        UPDATE public.order_template_dispatches SET status = 'uncertain', finished_at = now(), error_code = 'send_interrupted' WHERE id = d.id;
        PERFORM public.order_logistics_log(p_account, p_order, NULL, d.id, p_actor, v_name, 'template_uncertain', 'error', d.attempt, 'send_interrupted', NULL, '{}'::jsonb);
        RETURN jsonb_build_object('ok', FALSE, 'reason', 'uncertain', 'dispatch_id', d.id);
      END IF;
      RETURN jsonb_build_object('ok', FALSE, 'reason', 'in_progress', 'dispatch_id', d.id);
    ELSIF d.status = 'claimed' THEN
      IF d.claimed_at >= now() - interval '5 minutes' THEN
        RETURN jsonb_build_object('ok', FALSE, 'reason', 'in_progress', 'dispatch_id', d.id);
      END IF;
      -- Claimed long ago and never sent (the process died before the Meta call): safe to retake.
      UPDATE public.order_template_dispatches SET status = 'failed', finished_at = now(), error_code = 'claim_expired' WHERE id = d.id;
    END IF;
    IF l.status = 'ready_for_dispatch' THEN
      RETURN jsonb_build_object('ok', FALSE, 'reason', 'already_ready');
    END IF;
    -- failed (now or before): the same operation is retried as a new attempt.
    UPDATE public.order_template_dispatches
       SET status = 'claimed', attempt = attempt + 1, claimed_at = now(), sending_at = NULL, finished_at = NULL, error_code = NULL, error_detail = NULL,
           resolution = NULL, resolved_by = NULL, resolved_at = NULL
     WHERE id = d.id
     RETURNING * INTO d;
    PERFORM public.order_logistics_log(p_account, p_order, d.evidence_document_id, d.id, p_actor, v_name, 'template_send_started', 'ok', d.attempt, NULL, NULL,
      jsonb_build_object('retry', TRUE));
    RETURN jsonb_build_object('ok', TRUE, 'replay', FALSE, 'dispatch_id', d.id, 'attempt', d.attempt, 'evidence_document_id', d.evidence_document_id, 'conversation_id', d.conversation_id);
  END IF;

  IF l.status = 'ready_for_dispatch' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'already_ready');
  END IF;
  IF l.evidence_document_id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'evidence_required');
  END IF;
  SELECT c.conversation_id INTO v_conversation FROM public.order_confirmations c WHERE c.id = p_order AND c.account_id = p_account;
  IF v_conversation IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'order_without_conversation');
  END IF;

  -- Another, unresolved dispatch (different key) blocks a new one; an interrupted `sending` is turned into `uncertain` first.
  SELECT * INTO o FROM public.order_template_dispatches t WHERE t.order_id = p_order AND t.status IN ('claimed', 'sending', 'uncertain') FOR UPDATE;
  IF FOUND THEN
    IF o.status = 'sending' AND o.sending_at < now() - interval '5 minutes' THEN
      UPDATE public.order_template_dispatches SET status = 'uncertain', finished_at = now(), error_code = 'send_interrupted' WHERE id = o.id;
      PERFORM public.order_logistics_log(p_account, p_order, NULL, o.id, p_actor, v_name, 'template_uncertain', 'error', o.attempt, 'send_interrupted', NULL, '{}'::jsonb);
      o.status := 'uncertain';
    ELSIF o.status = 'claimed' AND o.claimed_at < now() - interval '5 minutes' THEN
      UPDATE public.order_template_dispatches SET status = 'failed', finished_at = now(), error_code = 'claim_expired' WHERE id = o.id;
      o.status := 'failed';
    END IF;
    IF o.status IN ('claimed', 'sending', 'uncertain') THEN
      RETURN jsonb_build_object('ok', FALSE, 'reason', 'dispatch_open', 'dispatch_id', o.id, 'status', o.status);
    END IF;
  END IF;

  INSERT INTO public.order_template_dispatches
    (account_id, order_id, request_key, attempt, status, evidence_document_id, conversation_id, template_name, template_language, actor_user_id)
  VALUES
    (p_account, p_order, p_request_key, 1, 'claimed', l.evidence_document_id, v_conversation, p_template_name, p_template_language, p_actor)
  RETURNING * INTO d;
  PERFORM public.order_logistics_log(p_account, p_order, d.evidence_document_id, d.id, p_actor, v_name, 'template_send_started', 'ok', 1, NULL, NULL, '{}'::jsonb);
  RETURN jsonb_build_object('ok', TRUE, 'replay', FALSE, 'dispatch_id', d.id, 'attempt', 1, 'evidence_document_id', d.evidence_document_id, 'conversation_id', d.conversation_id);
END;
$$;
ALTER FUNCTION public.begin_template_dispatch(UUID, UUID, UUID, TEXT, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.begin_template_dispatch(UUID, UUID, UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_template_dispatch(UUID, UUID, UUID, TEXT, TEXT, TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.mark_template_dispatch_sending(p_account UUID, p_actor UUID, p_dispatch UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name TEXT := public.order_logistics_actor(p_account, p_actor);
  d public.order_template_dispatches%ROWTYPE;
BEGIN
  SELECT * INTO d FROM public.order_template_dispatches t WHERE t.id = p_dispatch AND t.account_id = p_account FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF d.status <> 'claimed' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'invalid_state', 'status', d.status);
  END IF;
  UPDATE public.order_template_dispatches SET status = 'sending', sending_at = now() WHERE id = p_dispatch;
  RETURN jsonb_build_object('ok', TRUE, 'status', 'sending');
END;
$$;
ALTER FUNCTION public.mark_template_dispatch_sending(UUID, UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.mark_template_dispatch_sending(UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_template_dispatch_sending(UUID, UUID, UUID) TO service_role;

-- Completes the packaging for a dispatch that is now `sent` (internal: used by finish and by a manual resolution). The caller holds the order lock.
CREATE OR REPLACE FUNCTION public.order_logistics_complete_packaging(p_account UUID, p_actor UUID, p_actor_name TEXT, p_dispatch UUID, p_order UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.order_logistics
     SET status = 'ready_for_dispatch', evidence_document_id = (SELECT t.evidence_document_id FROM public.order_template_dispatches t WHERE t.id = p_dispatch),
         completed_dispatch_id = p_dispatch, packaging_completed_at = now(), packaging_completed_by = p_actor, version = version + 1
   WHERE order_id = p_order AND account_id = p_account AND status = 'packing';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'packaging_not_completable' USING ERRCODE = '22023';
  END IF;
  PERFORM public.order_logistics_log(p_account, p_order, NULL, p_dispatch, p_actor, p_actor_name, 'packaging_completed', 'ok', NULL, NULL, NULL, '{}'::jsonb);
END;
$$;
ALTER FUNCTION public.order_logistics_complete_packaging(UUID, UUID, TEXT, UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.order_logistics_complete_packaging(UUID, UUID, TEXT, UUID, UUID) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.finish_template_dispatch(
  p_account UUID, p_actor UUID, p_dispatch UUID, p_outcome TEXT,
  p_message_row_id UUID DEFAULT NULL, p_wamid TEXT DEFAULT NULL, p_error_code TEXT DEFAULT NULL, p_error_detail TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name TEXT := public.order_logistics_actor(p_account, p_actor);
  d public.order_template_dispatches%ROWTYPE;
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('sent', 'failed', 'uncertain') THEN
    RAISE EXCEPTION 'invalid_outcome' USING ERRCODE = '22023';
  END IF;
  IF p_outcome <> 'sent' AND (p_error_code IS NULL OR p_error_code !~ '^[a-z0-9_]{1,40}$') THEN
    RAISE EXCEPTION 'invalid_error_code' USING ERRCODE = '22023';
  END IF;
  IF p_outcome = 'sent' AND (p_wamid IS NULL OR btrim(p_wamid) = '') THEN
    RAISE EXCEPTION 'wamid_required' USING ERRCODE = '22023';
  END IF;

  -- Lock order first, then dispatch (same order everywhere).
  SELECT t.* INTO d FROM public.order_template_dispatches t WHERE t.id = p_dispatch AND t.account_id = p_account;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  PERFORM public.order_logistics_lock(d.order_id);
  SELECT t.* INTO d FROM public.order_template_dispatches t WHERE t.id = p_dispatch FOR UPDATE;

  -- Idempotent: the same final outcome again changes nothing.
  IF d.status = p_outcome THEN
    RETURN jsonb_build_object('ok', TRUE, 'changed', FALSE, 'status', d.status);
  END IF;
  IF d.status NOT IN ('claimed', 'sending') THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'invalid_state', 'status', d.status);
  END IF;
  IF p_outcome IN ('sent', 'uncertain') AND d.status <> 'sending' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'invalid_state', 'status', d.status);
  END IF;

  IF p_outcome = 'sent' THEN
    UPDATE public.order_template_dispatches
       SET status = 'sent', finished_at = now(), message_row_id = p_message_row_id, wamid = p_wamid, error_code = NULL, error_detail = NULL
     WHERE id = p_dispatch;
    PERFORM public.order_logistics_log(p_account, d.order_id, d.evidence_document_id, p_dispatch, p_actor, v_name, 'template_sent', 'ok', d.attempt, NULL, NULL, '{}'::jsonb);
    PERFORM public.order_logistics_complete_packaging(p_account, p_actor, v_name, p_dispatch, d.order_id);
    RETURN jsonb_build_object('ok', TRUE, 'changed', TRUE, 'status', 'sent', 'order_status', 'ready_for_dispatch');
  END IF;

  UPDATE public.order_template_dispatches
     SET status = p_outcome, finished_at = now(), error_code = p_error_code, error_detail = left(p_error_detail, 300)
   WHERE id = p_dispatch;
  PERFORM public.order_logistics_log(p_account, d.order_id, d.evidence_document_id, p_dispatch, p_actor, v_name,
    CASE p_outcome WHEN 'failed' THEN 'template_failed' ELSE 'template_uncertain' END, 'error', d.attempt, p_error_code, NULL, '{}'::jsonb);
  RETURN jsonb_build_object('ok', TRUE, 'changed', TRUE, 'status', p_outcome, 'order_status', 'packing');
END;
$$;
ALTER FUNCTION public.finish_template_dispatch(UUID, UUID, UUID, TEXT, UUID, TEXT, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.finish_template_dispatch(UUID, UUID, UUID, TEXT, UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_template_dispatch(UUID, UUID, UUID, TEXT, UUID, TEXT, TEXT, TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.resolve_template_dispatch(p_account UUID, p_actor UUID, p_dispatch UUID, p_resolution TEXT, p_wamid TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name TEXT := public.order_logistics_actor(p_account, p_actor);
  d public.order_template_dispatches%ROWTYPE;
BEGIN
  IF p_resolution IS NULL OR p_resolution NOT IN ('confirmed_sent', 'confirmed_not_sent') THEN
    RAISE EXCEPTION 'invalid_resolution' USING ERRCODE = '22023';
  END IF;
  SELECT t.* INTO d FROM public.order_template_dispatches t WHERE t.id = p_dispatch AND t.account_id = p_account;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  PERFORM public.order_logistics_lock(d.order_id);
  SELECT t.* INTO d FROM public.order_template_dispatches t WHERE t.id = p_dispatch FOR UPDATE;

  IF d.resolution = p_resolution THEN
    RETURN jsonb_build_object('ok', TRUE, 'changed', FALSE, 'status', d.status);
  END IF;
  IF d.status <> 'uncertain' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'not_uncertain', 'status', d.status);
  END IF;

  IF p_resolution = 'confirmed_sent' THEN
    UPDATE public.order_template_dispatches
       SET status = 'sent', resolution = p_resolution, resolved_by = p_actor, resolved_at = now(), wamid = COALESCE(NULLIF(btrim(p_wamid), ''), wamid), finished_at = now()
     WHERE id = p_dispatch;
    PERFORM public.order_logistics_log(p_account, d.order_id, d.evidence_document_id, p_dispatch, p_actor, v_name, 'template_resolved', 'ok', d.attempt, NULL, NULL,
      jsonb_build_object('resolution', p_resolution));
    PERFORM public.order_logistics_complete_packaging(p_account, p_actor, v_name, p_dispatch, d.order_id);
    RETURN jsonb_build_object('ok', TRUE, 'changed', TRUE, 'status', 'sent', 'order_status', 'ready_for_dispatch');
  END IF;

  UPDATE public.order_template_dispatches
     SET status = 'failed', resolution = p_resolution, resolved_by = p_actor, resolved_at = now(), finished_at = now()
   WHERE id = p_dispatch;
  PERFORM public.order_logistics_log(p_account, d.order_id, d.evidence_document_id, p_dispatch, p_actor, v_name, 'template_resolved', 'ok', d.attempt, NULL, NULL,
    jsonb_build_object('resolution', p_resolution));
  RETURN jsonb_build_object('ok', TRUE, 'changed', TRUE, 'status', 'failed', 'order_status', 'packing');
END;
$$;
ALTER FUNCTION public.resolve_template_dispatch(UUID, UUID, UUID, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.resolve_template_dispatch(UUID, UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_template_dispatch(UUID, UUID, UUID, TEXT, TEXT) TO service_role;
