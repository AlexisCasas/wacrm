-- ============================================================
-- 075_audio_guide_sequencer
--
-- "Audios por producto", stage 3: what the `send_product_audios` Flow node (and its resumer) need to send a catalog sequence safely.
-- Additive: no existing row changes meaning, and nothing runs until code calls it.
--
--   1. flow_nodes.node_type CHECK   widened with 'send_product_audios' (a superset of migration 068's list).
--   2. audio_guide_sends            + pre_delay_seconds (the 5 s pause, snapshotted per send) and not_before (when this send may go).
--   3. audio_guide_requests         + flow_run_id (traceability and the human-takeover check).
--   4. Functions (service role only) that move ONE step of a request atomically. They lock the request row, so two workers (the Flow
--      node and the resumer) can never send the same audio, nor an audio before its predecessor is final:
--        audio_guide_open_request     snapshot the product's ACTIVE audios into a request keyed by the inbound message (idempotent)
--        audio_guide_record_skip      record why nothing was sent (gate closed, no value, unknown product, ...)
--        audio_guide_claim_next_send  pending -> sending for the next due audio, in order; reports wait / busy / finished
--        audio_guide_finish_send      sending -> sent | failed | uncertain, schedules the next pause, halts the rest on trouble
--        audio_guide_halt_request     stop: every pending audio becomes skipped
--        audio_guide_recoverable_requests   requests a resumer may pick up
--
-- A send that was claimed ('sending') and never finished is, after a grace period, UNCERTAIN: Meta may or may not have accepted it, so it
-- is never sent again. Exactly-once delivery cannot be guaranteed when the process dies between Meta accepting a message and this
-- database recording it; the design guarantees AT MOST ONE ATTEMPT per audio instead, and says "uncertain" rather than guessing.
-- ============================================================

ALTER TABLE public.flow_nodes DROP CONSTRAINT IF EXISTS flow_nodes_node_type_check;
ALTER TABLE public.flow_nodes ADD CONSTRAINT flow_nodes_node_type_check CHECK (node_type IN (
  'start', 'send_buttons', 'send_list', 'send_message', 'send_media', 'collect_input', 'condition',
  'set_tag', 'delay', 'set_contact_field', 'handoff', 'http_fetch', 'end', 'execute_flow', 'send_product_audios'
));

ALTER TABLE public.audio_guide_sends ADD COLUMN pre_delay_seconds SMALLINT NOT NULL DEFAULT 5;
ALTER TABLE public.audio_guide_sends ADD CONSTRAINT audio_guide_sends_pre_delay CHECK (pre_delay_seconds BETWEEN 5 AND 30);
ALTER TABLE public.audio_guide_sends ADD COLUMN not_before TIMESTAMPTZ;
ALTER TABLE public.audio_guide_requests ADD COLUMN flow_run_id UUID REFERENCES public.flow_runs(id) ON DELETE SET NULL;

-- Recompute and store the request's status from its sends. Called with the request row already locked.
CREATE FUNCTION public.audio_guide_refresh_request(p_request UUID)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  v_total INTEGER; v_sent INTEGER; v_pending INTEGER; v_sending INTEGER; v_status TEXT;
BEGIN
  SELECT COUNT(*), COUNT(*) FILTER (WHERE status = 'sent'), COUNT(*) FILTER (WHERE status = 'pending'), COUNT(*) FILTER (WHERE status = 'sending')
    INTO v_total, v_sent, v_pending, v_sending
    FROM public.audio_guide_sends WHERE request_id = p_request;
  IF v_total > 0 AND v_sent = v_total THEN v_status := 'completed';
  ELSIF v_pending > 0 OR v_sending > 0 THEN v_status := CASE WHEN v_sent > 0 OR v_sending > 0 THEN 'sending' ELSE 'claimed' END;
  ELSIF v_sent > 0 THEN v_status := 'partial';
  ELSE v_status := 'failed';
  END IF;
  UPDATE public.audio_guide_requests
     SET status = v_status, finished_at = CASE WHEN v_status IN ('completed', 'partial', 'failed') THEN COALESCE(finished_at, NOW()) ELSE NULL END
   WHERE id = p_request;
  RETURN v_status;
END;
$$;

-- Snapshot the ACTIVE audios of an active product of this account into a new request keyed by the inbound message. Idempotent: a second
-- call for the same message creates nothing and reports the existing request.
CREATE FUNCTION public.audio_guide_open_request(
  p_account UUID, p_contact UUID, p_conversation UUID, p_run UUID, p_trigger TEXT, p_product_key TEXT, p_expected_revision INTEGER
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_product public.audio_guide_products%ROWTYPE;
  v_request UUID;
  v_status TEXT;
  v_count INTEGER;
BEGIN
  SELECT id, status INTO v_request, v_status FROM public.audio_guide_requests WHERE account_id = p_account AND trigger_message_id = p_trigger;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'created', false, 'request_id', v_request, 'status', v_status);
  END IF;
  SELECT * INTO v_product FROM public.audio_guide_products WHERE account_id = p_account AND product_key = p_product_key FOR SHARE;
  IF NOT FOUND OR NOT v_product.active THEN RETURN jsonb_build_object('ok', false, 'reason', 'product_unavailable'); END IF;
  IF p_expected_revision IS NOT NULL AND v_product.revision <> p_expected_revision THEN RETURN jsonb_build_object('ok', false, 'reason', 'catalog_changed'); END IF;
  SELECT COUNT(*) INTO v_count FROM public.audio_guide_items WHERE account_id = p_account AND product_id = v_product.id AND status = 'active';
  IF v_count = 0 THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_audios'); END IF;
  BEGIN
    INSERT INTO public.audio_guide_requests (account_id, contact_id, conversation_id, flow_run_id, trigger_message_id, product_id, product_key, status)
    VALUES (p_account, p_contact, p_conversation, p_run, p_trigger, v_product.id, v_product.product_key, 'claimed')
    RETURNING id INTO v_request;
  EXCEPTION WHEN unique_violation THEN
    -- a concurrent call for the same message won the insert
    SELECT id, status INTO v_request, v_status FROM public.audio_guide_requests WHERE account_id = p_account AND trigger_message_id = p_trigger;
    RETURN jsonb_build_object('ok', true, 'created', false, 'request_id', v_request, 'status', v_status);
  END;
  -- Positions are renumbered 1..n over the ACTIVE audios; each send carries its own pause. Only the first has a due time yet.
  INSERT INTO public.audio_guide_sends (account_id, request_id, item_id, position, voice_sha256, status, pre_delay_seconds, not_before)
  SELECT p_account, v_request, i.id, (ROW_NUMBER() OVER (ORDER BY i.position))::SMALLINT, i.voice_sha256, 'pending', i.pre_delay_seconds,
         CASE WHEN ROW_NUMBER() OVER (ORDER BY i.position) = 1 THEN NOW() + make_interval(secs => i.pre_delay_seconds) END
    FROM public.audio_guide_items i WHERE i.account_id = p_account AND i.product_id = v_product.id AND i.status = 'active';
  RETURN jsonb_build_object('ok', true, 'created', true, 'request_id', v_request, 'status', 'claimed', 'sends', v_count);
END;
$$;

CREATE FUNCTION public.audio_guide_record_skip(
  p_account UUID, p_contact UUID, p_conversation UUID, p_run UUID, p_trigger TEXT, p_product_key TEXT, p_reason TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_request UUID;
BEGIN
  INSERT INTO public.audio_guide_requests (account_id, contact_id, conversation_id, flow_run_id, trigger_message_id, product_key, status, reason, finished_at)
  VALUES (p_account, p_contact, p_conversation, p_run, p_trigger, left(p_product_key, 120), 'skipped', left(p_reason, 200), NOW())
  ON CONFLICT (account_id, trigger_message_id) DO NOTHING
  RETURNING id INTO v_request;
  RETURN jsonb_build_object('ok', true, 'created', v_request IS NOT NULL);
END;
$$;

CREATE FUNCTION public.audio_guide_halt_request(p_account UUID, p_request UUID, p_reason TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_status TEXT;
BEGIN
  PERFORM 1 FROM public.audio_guide_requests WHERE id = p_request AND account_id = p_account FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  -- an in-flight audio claimed long ago is recorded as uncertain here too, so a stopped request cannot stay 'sending' forever
  UPDATE public.audio_guide_sends SET status = 'uncertain', error_code = 'process_interrupted', finished_at = NOW() WHERE request_id = p_request AND status = 'sending' AND started_at < NOW() - INTERVAL '180 seconds';
  UPDATE public.audio_guide_sends SET status = 'skipped', error_code = left(p_reason, 80), finished_at = NOW() WHERE request_id = p_request AND status = 'pending';
  v_status := public.audio_guide_refresh_request(p_request);
  UPDATE public.audio_guide_requests SET reason = COALESCE(reason, left(p_reason, 200)) WHERE id = p_request;
  RETURN jsonb_build_object('ok', true, 'status', v_status);
END;
$$;

-- The next step of a request. Returns {state: 'claimed'|'wait'|'busy'|'finished', ...}.
CREATE FUNCTION public.audio_guide_claim_next_send(p_account UUID, p_request UUID, p_stale_seconds INTEGER DEFAULT 180)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_status TEXT;
  v_next public.audio_guide_sends%ROWTYPE;
  v_trouble BOOLEAN;
BEGIN
  SELECT status INTO v_status FROM public.audio_guide_requests WHERE id = p_request AND account_id = p_account FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('state', 'not_found'); END IF;
  IF v_status IN ('completed', 'partial', 'failed', 'skipped') THEN RETURN jsonb_build_object('state', 'finished', 'status', v_status); END IF;
  -- A send claimed long ago and never finished: Meta may or may not have it. UNCERTAIN, never retried.
  UPDATE public.audio_guide_sends SET status = 'uncertain', error_code = 'process_interrupted', finished_at = NOW()
   WHERE request_id = p_request AND status = 'sending' AND started_at < NOW() - make_interval(secs => p_stale_seconds);
  IF EXISTS (SELECT 1 FROM public.audio_guide_sends WHERE request_id = p_request AND status = 'sending') THEN
    RETURN jsonb_build_object('state', 'busy');
  END IF;
  -- Trouble earlier in the sequence stops everything after it: no audio is sent out of order or after a gap.
  SELECT EXISTS (SELECT 1 FROM public.audio_guide_sends WHERE request_id = p_request AND status IN ('failed', 'uncertain')) INTO v_trouble;
  IF v_trouble THEN
    UPDATE public.audio_guide_sends SET status = 'skipped', error_code = 'sequence_halted', finished_at = NOW() WHERE request_id = p_request AND status = 'pending';
    RETURN jsonb_build_object('state', 'finished', 'status', public.audio_guide_refresh_request(p_request));
  END IF;
  SELECT * INTO v_next FROM public.audio_guide_sends WHERE request_id = p_request AND status = 'pending' ORDER BY position LIMIT 1;
  IF NOT FOUND THEN RETURN jsonb_build_object('state', 'finished', 'status', public.audio_guide_refresh_request(p_request)); END IF;
  IF v_next.not_before IS NOT NULL AND v_next.not_before > NOW() THEN
    RETURN jsonb_build_object('state', 'wait', 'wait_ms', CEIL(EXTRACT(EPOCH FROM (v_next.not_before - NOW())) * 1000)::INTEGER);
  END IF;
  UPDATE public.audio_guide_sends SET status = 'sending', started_at = NOW() WHERE id = v_next.id;
  PERFORM public.audio_guide_refresh_request(p_request);
  RETURN jsonb_build_object('state', 'claimed', 'send', jsonb_build_object('id', v_next.id, 'position', v_next.position, 'sha256', v_next.voice_sha256, 'item_id', v_next.item_id));
END;
$$;

CREATE FUNCTION public.audio_guide_finish_send(
  p_account UUID, p_send UUID, p_status TEXT, p_wamid TEXT DEFAULT NULL, p_error_code TEXT DEFAULT NULL, p_error_detail TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_send public.audio_guide_sends%ROWTYPE;
  v_request_status TEXT;
BEGIN
  IF p_status NOT IN ('sent', 'failed', 'uncertain') THEN RETURN jsonb_build_object('ok', false, 'reason', 'invalid_status'); END IF;
  SELECT * INTO v_send FROM public.audio_guide_sends WHERE id = p_send AND account_id = p_account;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  PERFORM 1 FROM public.audio_guide_requests WHERE id = v_send.request_id FOR UPDATE;
  SELECT * INTO v_send FROM public.audio_guide_sends WHERE id = p_send;
  IF v_send.status = p_status AND p_status = 'sent' AND v_send.whatsapp_message_id IS NOT DISTINCT FROM p_wamid THEN
    RETURN jsonb_build_object('ok', true, 'request_status', (SELECT status FROM public.audio_guide_requests WHERE id = v_send.request_id), 'repeat', true);
  END IF;
  IF v_send.status <> 'sending' THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_sending', 'status', v_send.status); END IF;
  IF p_status = 'sent' AND (p_wamid IS NULL OR btrim(p_wamid) = '') THEN RETURN jsonb_build_object('ok', false, 'reason', 'message_id_required'); END IF;
  UPDATE public.audio_guide_sends
     SET status = p_status, whatsapp_message_id = CASE WHEN p_status = 'sent' THEN p_wamid ELSE NULL END,
         error_code = CASE WHEN p_status = 'sent' THEN NULL ELSE left(p_error_code, 80) END,
         error_detail = CASE WHEN p_status = 'sent' THEN NULL ELSE left(p_error_detail, 500) END, finished_at = NOW()
   WHERE id = p_send;
  IF p_status = 'sent' THEN
    -- the pause of the NEXT audio starts now
    UPDATE public.audio_guide_sends SET not_before = NOW() + make_interval(secs => pre_delay_seconds)
     WHERE request_id = v_send.request_id AND position = v_send.position + 1 AND status = 'pending';
  ELSE
    UPDATE public.audio_guide_sends SET status = 'skipped', error_code = 'sequence_halted', finished_at = NOW() WHERE request_id = v_send.request_id AND status = 'pending';
  END IF;
  v_request_status := public.audio_guide_refresh_request(v_send.request_id);
  RETURN jsonb_build_object('ok', true, 'request_status', v_request_status);
END;
$$;

CREATE FUNCTION public.audio_guide_recoverable_requests(p_limit INTEGER DEFAULT 20, p_stale_seconds INTEGER DEFAULT 180)
RETURNS TABLE (account_id UUID, request_id UUID)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT r.account_id, r.id
    FROM public.audio_guide_requests r
   WHERE r.status IN ('claimed', 'sending')
     AND (
       -- the NEXT audio (lowest pending) has its pause behind it and nothing is in flight...
       EXISTS (
         SELECT 1 FROM public.audio_guide_sends s
          WHERE s.request_id = r.id AND s.status = 'pending' AND s.not_before IS NOT NULL AND s.not_before <= NOW()
            AND s.position = (SELECT MIN(p.position) FROM public.audio_guide_sends p WHERE p.request_id = r.id AND p.status = 'pending')
            AND NOT EXISTS (SELECT 1 FROM public.audio_guide_sends w WHERE w.request_id = r.id AND w.status = 'sending'))
       -- ...or an audio was claimed long ago and never finished (to be marked uncertain)
       OR EXISTS (
         SELECT 1 FROM public.audio_guide_sends s
          WHERE s.request_id = r.id AND s.status = 'sending' AND s.started_at < NOW() - make_interval(secs => p_stale_seconds)))
   ORDER BY r.created_at
   LIMIT LEAST(GREATEST(p_limit, 1), 100)
$$;

REVOKE ALL ON FUNCTION public.audio_guide_refresh_request(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.audio_guide_open_request(UUID, UUID, UUID, UUID, TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.audio_guide_record_skip(UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.audio_guide_halt_request(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.audio_guide_claim_next_send(UUID, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.audio_guide_finish_send(UUID, UUID, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.audio_guide_recoverable_requests(INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.audio_guide_refresh_request(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.audio_guide_open_request(UUID, UUID, UUID, UUID, TEXT, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.audio_guide_record_skip(UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.audio_guide_halt_request(UUID, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.audio_guide_claim_next_send(UUID, UUID, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.audio_guide_finish_send(UUID, UUID, TEXT, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.audio_guide_recoverable_requests(INTEGER, INTEGER) TO service_role;
