-- ============================================================
-- 20261130000002_order_shipments_rpcs
--
-- PR-05 (Shalom tracking) · the ONLY writers of the PR-05 tables. ADDITIVE. All SECURITY DEFINER, executable only by service_role; every actor-driven RPC
-- re-validates inside the database (actor of the account, logistics_mvp_enabled, shalom_tracking_enabled, logistics|supervisor area, agent+ role; stop
-- tracking: supervisor only; an order of THIS account) so a mistake of the backend still cannot cross accounts or roles. Viewers / commercial / no area /
-- the PR-03 `shared` routing grant nothing.
--
-- The poller side (claim / apply / release / breaker) has no actor: service_role only, and it works ONLY on accounts with both flags ON.
-- Scheduling policy (intervals, backoff, attention window) lives in the application configuration; these functions only STORE what they are told and
-- enforce the invariants: one claim per query (FOR UPDATE SKIP LOCKED + token + lease), guide versioning, late / stale answers ignored, the status never
-- goes backwards by itself, the same state never produces a second event.
-- ============================================================

-- ---------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.order_shipments_mask(p_value TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_value IS NULL THEN NULL ELSE repeat('*', GREATEST(char_length(p_value) - 3, 0)) || right(p_value, 3) END
$$;
ALTER FUNCTION public.order_shipments_mask(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.order_shipments_mask(TEXT) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.order_shipments_log(
  p_account UUID, p_order UUID, p_type TEXT, p_from TEXT, p_to TEXT, p_version INTEGER,
  p_actor UUID, p_actor_name TEXT, p_detail JSONB
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_rows INTEGER;
BEGIN
  -- ON CONFLICT DO NOTHING: the unique indexes of the model make a repeated technical state a no-op (returns FALSE when nothing was written).
  INSERT INTO public.order_shipment_events (account_id, order_id, event_type, from_status, to_status, identifier_version, source, actor_user_id, actor_name, detail)
  VALUES (p_account, p_order, p_type, p_from, p_to, p_version, CASE WHEN p_actor IS NULL THEN 'system' ELSE 'user' END, p_actor,
          COALESCE(NULLIF(btrim(p_actor_name), ''), 'system'), COALESCE(p_detail, '{}'::jsonb))
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$;
ALTER FUNCTION public.order_shipments_log(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID, TEXT, JSONB) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.order_shipments_log(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID, TEXT, JSONB) FROM PUBLIC, anon, authenticated, service_role;

-- Closes the open / acknowledged alerts of an order (history is kept). Returns how many were resolved.
CREATE OR REPLACE FUNCTION public.order_shipments_resolve_alerts(
  p_account UUID, p_order UUID, p_reason TEXT, p_actor UUID, p_actor_name TEXT, p_version INTEGER, p_now TIMESTAMPTZ
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE r RECORD; n INTEGER := 0;
BEGIN
  FOR r IN
    UPDATE public.order_shipment_alerts a SET status = 'resolved', resolved_at = p_now, resolved_reason = p_reason
     WHERE a.order_id = p_order AND a.account_id = p_account AND a.status IN ('open', 'acknowledged')
    RETURNING a.id, a.destination_episode
  LOOP
    n := n + 1;
    PERFORM public.order_shipments_log(p_account, p_order, 'alert_resolved', NULL, NULL, p_version, p_actor, p_actor_name,
      jsonb_build_object('alert_id', r.id, 'episode', r.destination_episode, 'reason', p_reason));
  END LOOP;
  RETURN n;
END;
$$;
ALTER FUNCTION public.order_shipments_resolve_alerts(UUID, UUID, TEXT, UUID, TEXT, INTEGER, TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.order_shipments_resolve_alerts(UUID, UUID, TEXT, UUID, TEXT, INTEGER, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.order_shipments_rank(p_status TEXT)
RETURNS INTEGER LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_status WHEN 'at_origin' THEN 1 WHEN 'in_transit' THEN 2 WHEN 'at_destination' THEN 3 WHEN 'delivered' THEN 4 ELSE 0 END
$$;
ALTER FUNCTION public.order_shipments_rank(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.order_shipments_rank(TEXT) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------
-- register_order_shipment: the guide (numero_orden + codigo) of an order that PR-04 left ready_for_dispatch. Idempotent for the same guide.
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.register_order_shipment(
  p_account UUID, p_actor UUID, p_order UUID, p_number TEXT, p_code TEXT, p_source TEXT DEFAULT 'manual', p_now TIMESTAMPTZ DEFAULT now()
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name TEXT := public.order_shipments_actor(p_account, p_actor, FALSE);
  v_number TEXT := btrim(p_number);
  v_code TEXT := upper(btrim(p_code));
  s public.order_shipments%ROWTYPE;
  v_status TEXT;
BEGIN
  PERFORM public.order_logistics_require_order(p_account, p_order);
  PERFORM public.order_shipments_lock(p_order);
  IF v_number !~ '^[0-9]{6,12}$' OR v_code !~ '^[A-Z0-9]{3,6}$' OR p_source NOT IN ('manual', 'ocr_prefill') THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'invalid_identifier');
  END IF;

  SELECT * INTO s FROM public.order_shipments x WHERE x.order_id = p_order;
  IF FOUND THEN
    IF s.tracking_number = v_number AND s.tracking_code = v_code THEN
      RETURN jsonb_build_object('ok', TRUE, 'created', FALSE, 'shipment_id', s.id, 'identifier_version', s.identifier_version);
    END IF;
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'already_registered');
  END IF;

  SELECT l.status INTO v_status FROM public.order_logistics l WHERE l.order_id = p_order AND l.account_id = p_account;
  IF v_status IS DISTINCT FROM 'ready_for_dispatch' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'not_ready_for_dispatch');
  END IF;

  INSERT INTO public.order_shipments (order_id, account_id, tracking_number, tracking_code, identifier_source, next_poll_at, created_by)
  VALUES (p_order, p_account, v_number, v_code, p_source, p_now, p_actor)
  RETURNING * INTO s;

  PERFORM public.order_shipments_log(p_account, p_order, 'shipment_registered', NULL, NULL, 1, p_actor, v_name,
    jsonb_build_object('source', p_source, 'number', public.order_shipments_mask(v_number), 'code', public.order_shipments_mask(v_code),
                       'hash', left(md5(v_number || '|' || v_code), 12)));
  RETURN jsonb_build_object('ok', TRUE, 'created', TRUE, 'shipment_id', s.id, 'identifier_version', 1);
END;
$$;
ALTER FUNCTION public.register_order_shipment(UUID, UUID, UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.register_order_shipment(UUID, UUID, UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_order_shipment(UUID, UUID, UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ) TO service_role;

-- ---------------------------------------------------------------
-- correct_order_shipment_identifier: a WRONG guide is corrected, never a second order / second row. identifier_version + 1 invalidates every query in
-- flight for the old guide; the tracking restarts (status NULL, polled now); the history stays; the audit keeps old / new only masked + a short hash.
-- A delivered shipment is locked (an exceptional flow, outside PR-05 base); a stopped one is not corrected.
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.correct_order_shipment_identifier(
  p_account UUID, p_actor UUID, p_order UUID, p_number TEXT, p_code TEXT, p_expected_version INTEGER DEFAULT NULL, p_now TIMESTAMPTZ DEFAULT now()
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name TEXT := public.order_shipments_actor(p_account, p_actor, FALSE);
  v_number TEXT := btrim(p_number);
  v_code TEXT := upper(btrim(p_code));
  s public.order_shipments%ROWTYPE;
  v_new INTEGER;
BEGIN
  PERFORM public.order_logistics_require_order(p_account, p_order);
  PERFORM public.order_shipments_lock(p_order);
  IF v_number !~ '^[0-9]{6,12}$' OR v_code !~ '^[A-Z0-9]{3,6}$' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'invalid_identifier');
  END IF;
  SELECT * INTO s FROM public.order_shipments x WHERE x.order_id = p_order AND x.account_id = p_account FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', FALSE, 'reason', 'no_shipment'); END IF;
  IF s.tracking_state = 'delivered' THEN RETURN jsonb_build_object('ok', FALSE, 'reason', 'delivered_locked'); END IF;
  IF s.tracking_state = 'stopped' THEN RETURN jsonb_build_object('ok', FALSE, 'reason', 'stopped'); END IF;
  IF p_expected_version IS NOT NULL AND p_expected_version <> s.identifier_version THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'stale', 'identifier_version', s.identifier_version);
  END IF;
  IF s.tracking_number = v_number AND s.tracking_code = v_code THEN
    RETURN jsonb_build_object('ok', TRUE, 'changed', FALSE, 'identifier_version', s.identifier_version);
  END IF;

  v_new := s.identifier_version + 1;
  UPDATE public.order_shipments SET
    tracking_number = v_number, tracking_code = v_code, identifier_version = v_new, identifier_source = 'manual',
    logistic_status = NULL, status_changed_at = NULL, destination_entered_at = NULL, destination_entered_source = NULL,
    last_raw = NULL, last_raw_hash = NULL, last_applied_started_at = NULL, last_success_at = NULL,
    tracking_state = 'active', consecutive_failures = 0, first_failure_at = NULL, last_error_kind = NULL, last_error_code = NULL,
    claim_token = NULL, lease_until = NULL, next_poll_at = p_now
  WHERE id = s.id;

  PERFORM public.order_shipments_resolve_alerts(p_account, p_order, 'left_destination', p_actor, v_name, v_new, p_now);
  PERFORM public.order_shipments_log(p_account, p_order, 'identifier_corrected', s.logistic_status, NULL, v_new, p_actor, v_name,
    jsonb_build_object('previous_version', s.identifier_version,
      'old_number', public.order_shipments_mask(s.tracking_number), 'old_code', public.order_shipments_mask(s.tracking_code), 'old_hash', left(md5(s.tracking_number || '|' || s.tracking_code), 12),
      'new_number', public.order_shipments_mask(v_number), 'new_code', public.order_shipments_mask(v_code), 'new_hash', left(md5(v_number || '|' || v_code), 12)));
  RETURN jsonb_build_object('ok', TRUE, 'changed', TRUE, 'identifier_version', v_new);
END;
$$;
ALTER FUNCTION public.correct_order_shipment_identifier(UUID, UUID, UUID, TEXT, TEXT, INTEGER, TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.correct_order_shipment_identifier(UUID, UUID, UUID, TEXT, TEXT, INTEGER, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.correct_order_shipment_identifier(UUID, UUID, UUID, TEXT, TEXT, INTEGER, TIMESTAMPTZ) TO service_role;

-- ---------------------------------------------------------------
-- stop_order_shipment: SUPERVISOR only. Technical capability for a future late cancellation (no cancellation flow is built here). History is kept.
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.stop_order_shipment(
  p_account UUID, p_actor UUID, p_order UUID, p_reason TEXT DEFAULT 'manual', p_now TIMESTAMPTZ DEFAULT now()
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name TEXT := public.order_shipments_actor(p_account, p_actor, TRUE);
  s public.order_shipments%ROWTYPE;
BEGIN
  PERFORM public.order_logistics_require_order(p_account, p_order);
  PERFORM public.order_shipments_lock(p_order);
  IF p_reason IS NULL OR p_reason !~ '^[a-z0-9_]{1,40}$' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'invalid_reason');
  END IF;
  SELECT * INTO s FROM public.order_shipments x WHERE x.order_id = p_order AND x.account_id = p_account FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', FALSE, 'reason', 'no_shipment'); END IF;
  IF s.tracking_state = 'delivered' THEN RETURN jsonb_build_object('ok', FALSE, 'reason', 'delivered_locked'); END IF;
  IF s.tracking_state = 'stopped' THEN RETURN jsonb_build_object('ok', TRUE, 'changed', FALSE); END IF;

  UPDATE public.order_shipments SET tracking_state = 'stopped', stop_reason = p_reason, stopped_by = p_actor, stopped_at = p_now,
         next_poll_at = NULL, claim_token = NULL, lease_until = NULL
   WHERE id = s.id;
  PERFORM public.order_shipments_resolve_alerts(p_account, p_order, 'stopped', p_actor, v_name, s.identifier_version, p_now);
  PERFORM public.order_shipments_log(p_account, p_order, 'tracking_stopped', s.logistic_status, NULL, s.identifier_version, p_actor, v_name,
    jsonb_build_object('reason', p_reason, 'previous_state', s.tracking_state));
  RETURN jsonb_build_object('ok', TRUE, 'changed', TRUE);
END;
$$;
ALTER FUNCTION public.stop_order_shipment(UUID, UUID, UUID, TEXT, TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.stop_order_shipment(UUID, UUID, UUID, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stop_order_shipment(UUID, UUID, UUID, TEXT, TIMESTAMPTZ) TO service_role;

-- ---------------------------------------------------------------
-- request_shipment_refresh: forces the next query of one order now, rate limited per order. A requires_attention shipment is re-armed with a FRESH window.
-- The query itself is executed by the application through claim_shipment_polls(p_order).
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.request_shipment_refresh(
  p_account UUID, p_actor UUID, p_order UUID, p_min_interval_seconds INTEGER DEFAULT 300, p_now TIMESTAMPTZ DEFAULT now()
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name TEXT := public.order_shipments_actor(p_account, p_actor, FALSE);
  s public.order_shipments%ROWTYPE;
  v_wait INTEGER;
BEGIN
  PERFORM public.order_logistics_require_order(p_account, p_order);
  PERFORM public.order_shipments_lock(p_order);
  SELECT * INTO s FROM public.order_shipments x WHERE x.order_id = p_order AND x.account_id = p_account FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', FALSE, 'reason', 'no_shipment'); END IF;
  IF s.tracking_state = 'delivered' THEN RETURN jsonb_build_object('ok', FALSE, 'reason', 'delivered_locked'); END IF;
  IF s.tracking_state = 'stopped' THEN RETURN jsonb_build_object('ok', FALSE, 'reason', 'stopped'); END IF;
  IF s.refresh_requested_at IS NOT NULL AND s.refresh_requested_at > p_now - make_interval(secs => p_min_interval_seconds) THEN
    v_wait := CEIL(EXTRACT(EPOCH FROM (s.refresh_requested_at + make_interval(secs => p_min_interval_seconds) - p_now)))::INTEGER;
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'rate_limited', 'retry_after_seconds', GREATEST(v_wait, 1));
  END IF;

  UPDATE public.order_shipments SET refresh_requested_at = p_now, next_poll_at = p_now,
         tracking_state = 'active', consecutive_failures = 0, first_failure_at = NULL
   WHERE id = s.id;
  IF s.tracking_state = 'requires_attention' THEN
    PERFORM public.order_shipments_log(p_account, p_order, 'attention_cleared', NULL, NULL, s.identifier_version, p_actor, v_name, jsonb_build_object('by', 'refresh'));
  END IF;
  PERFORM public.order_shipments_log(p_account, p_order, 'refresh_requested', NULL, NULL, s.identifier_version, p_actor, v_name, '{}'::jsonb);
  RETURN jsonb_build_object('ok', TRUE);
END;
$$;
ALTER FUNCTION public.request_shipment_refresh(UUID, UUID, UUID, INTEGER, TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.request_shipment_refresh(UUID, UUID, UUID, INTEGER, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_shipment_refresh(UUID, UUID, UUID, INTEGER, TIMESTAMPTZ) TO service_role;

-- ---------------------------------------------------------------
-- claim_shipment_polls: the poller's claim. FOR UPDATE SKIP LOCKED + a fresh claim token + a lease: two workers never get the same shipment; a crashed
-- worker's lease expires on its own. Only ACTIVE shipments that are due, of accounts with BOTH flags ON, while the credentials breaker is not open.
-- p_order restricts to one shipment (manual refresh).
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_shipment_polls(
  p_limit INTEGER DEFAULT 5, p_lease_seconds INTEGER DEFAULT 600, p_order UUID DEFAULT NULL, p_now TIMESTAMPTZ DEFAULT now()
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_rows JSONB;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 50 OR p_lease_seconds IS NULL OR p_lease_seconds < 5 THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  WITH picked AS (
    SELECT s.id
      FROM public.order_shipments s
      JOIN public.order_shipment_settings st ON st.account_id = s.account_id AND st.shalom_tracking_enabled
      JOIN public.order_integration_settings ois ON ois.account_id = s.account_id AND ois.logistics_mvp_enabled
     WHERE s.tracking_state = 'active'
       AND s.next_poll_at IS NOT NULL AND s.next_poll_at <= p_now
       AND (s.lease_until IS NULL OR s.lease_until < p_now)
       AND (st.credentials_paused_until IS NULL OR st.credentials_paused_until <= p_now)
       AND (p_order IS NULL OR s.order_id = p_order)
     ORDER BY s.next_poll_at, s.id
     LIMIT p_limit
     FOR UPDATE OF s SKIP LOCKED
  ), claimed AS (
    UPDATE public.order_shipments s SET claim_token = gen_random_uuid(), lease_until = p_now + make_interval(secs => p_lease_seconds)
      FROM picked WHERE s.id = picked.id
    RETURNING s.order_id, s.account_id, s.tracking_number, s.tracking_code, s.identifier_version, s.claim_token, s.first_failure_at,
              s.consecutive_failures, s.logistic_status
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(c)), '[]'::jsonb) INTO v_rows FROM claimed c;
  RETURN v_rows;
END;
$$;
ALTER FUNCTION public.claim_shipment_polls(INTEGER, INTEGER, UUID, TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.claim_shipment_polls(INTEGER, INTEGER, UUID, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_shipment_polls(INTEGER, INTEGER, UUID, TIMESTAMPTZ) TO service_role;

-- Releases claims WITHOUT counting a failure (the tick was paused: rate limit / credentials breaker / shutdown).
CREATE OR REPLACE FUNCTION public.release_shipment_claims(p_tokens UUID[], p_next_poll_at TIMESTAMPTZ DEFAULT NULL)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_rows INTEGER;
BEGIN
  UPDATE public.order_shipments SET claim_token = NULL, lease_until = NULL, next_poll_at = COALESCE(p_next_poll_at, next_poll_at)
   WHERE claim_token = ANY(p_tokens) AND tracking_state = 'active';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$$;
ALTER FUNCTION public.release_shipment_claims(UUID[], TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.release_shipment_claims(UUID[], TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_shipment_claims(UUID[], TIMESTAMPTZ) TO service_role;

-- GLOBAL credentials circuit breaker (401 / 403 / "auth failed"): pauses every account's polling for a while. It never marks an order as failed.
CREATE OR REPLACE FUNCTION public.trip_shalom_credentials_breaker(p_pause_seconds INTEGER, p_reason TEXT DEFAULT 'credentials', p_now TIMESTAMPTZ DEFAULT now())
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_rows INTEGER;
BEGIN
  IF p_pause_seconds IS NULL OR p_pause_seconds < 1 OR p_reason IS NULL OR p_reason !~ '^[a-z0-9_]{1,40}$' THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  UPDATE public.order_shipment_settings SET credentials_paused_until = p_now + make_interval(secs => p_pause_seconds), credentials_paused_reason = p_reason, updated_at = p_now WHERE TRUE;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$$;
ALTER FUNCTION public.trip_shalom_credentials_breaker(INTEGER, TEXT, TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.trip_shalom_credentials_breaker(INTEGER, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trip_shalom_credentials_breaker(INTEGER, TEXT, TIMESTAMPTZ) TO service_role;

CREATE OR REPLACE FUNCTION public.purge_shipment_polls(p_days INTEGER DEFAULT 30, p_now TIMESTAMPTZ DEFAULT now())
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_rows INTEGER;
BEGIN
  IF p_days IS NULL OR p_days < 1 THEN RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023'; END IF;
  -- the polls guard only blocks UPDATE: retention is the one way rows leave this technical log while their order still exists
  DELETE FROM public.order_shipment_polls WHERE created_at < p_now - make_interval(days => p_days);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$$;
ALTER FUNCTION public.purge_shipment_polls(INTEGER, TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.purge_shipment_polls(INTEGER, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_shipment_polls(INTEGER, TIMESTAMPTZ) TO service_role;

-- ---------------------------------------------------------------
-- apply_shipment_poll: applies ONE classified answer. Always records the technical poll; only applies it to the shipment when it is still the
-- legitimate answer: same guide version, still active, the claim is still ours, and not older than what was already applied.
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.apply_shipment_poll(
  p_account UUID, p_order UUID, p_claim_token UUID, p_identifier_version INTEGER,
  p_started_at TIMESTAMPTZ, p_finished_at TIMESTAMPTZ, p_trigger TEXT, p_outcome TEXT,
  p_http_status INTEGER, p_latency_ms INTEGER, p_normalized TEXT, p_raw_summary JSONB, p_raw_hash TEXT,
  p_destination_at TIMESTAMPTZ, p_next_poll_at TIMESTAMPTZ, p_attention BOOLEAN, p_error_code TEXT,
  p_now TIMESTAMPTZ DEFAULT now()
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s public.order_shipments%ROWTYPE;
  v_ignored TEXT;
  v_kind TEXT;
  v_cur INTEGER;
  v_new INTEGER;
  v_changed BOOLEAN := FALSE;
  v_state TEXT;
  v_entered TIMESTAMPTZ;
BEGIN
  IF p_outcome NOT IN ('ok', 'unknown_state', 'not_found', 'invalid_identifier', 'rate_limited', 'credentials', 'server_error', 'timeout', 'invalid_json', 'degraded_order', 'degraded_integration')
     OR p_trigger NOT IN ('cron', 'manual') OR p_started_at IS NULL OR p_finished_at IS NULL
     OR (p_outcome = 'ok' AND (p_normalized IS NULL OR p_normalized NOT IN ('at_origin', 'in_transit', 'at_destination', 'delivered'))) THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  PERFORM public.order_shipments_lock(p_order);
  SELECT * INTO s FROM public.order_shipments x WHERE x.order_id = p_order AND x.account_id = p_account FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;

  IF s.identifier_version IS DISTINCT FROM p_identifier_version THEN v_ignored := 'version_ignored';
  ELSIF s.tracking_state IN ('stopped', 'delivered') THEN v_ignored := 'not_active';
  ELSIF s.claim_token IS DISTINCT FROM p_claim_token THEN v_ignored := 'claim_lost';
  ELSIF s.last_applied_started_at IS NOT NULL AND p_started_at <= s.last_applied_started_at THEN v_ignored := 'stale_ignored';
  END IF;

  IF v_ignored IS NOT NULL THEN
    -- a stale answer that still holds the claim hands it back; any other ignored answer touches nothing
    IF v_ignored = 'stale_ignored' AND s.claim_token = p_claim_token THEN
      UPDATE public.order_shipments SET claim_token = NULL, lease_until = NULL WHERE id = s.id;
    END IF;
    INSERT INTO public.order_shipment_polls (account_id, order_id, identifier_version, claim_token, trigger, started_at, finished_at, outcome, http_status, latency_ms, normalized_status, raw_hash, error_code, applied, ignored_reason)
    VALUES (p_account, p_order, p_identifier_version, p_claim_token, p_trigger, p_started_at, p_finished_at, p_outcome, p_http_status, p_latency_ms, p_normalized, p_raw_hash, p_error_code, FALSE, v_ignored);
    RETURN jsonb_build_object('ok', TRUE, 'applied', FALSE, 'reason', v_ignored);
  END IF;

  v_kind := CASE
    WHEN p_outcome IN ('not_found', 'invalid_identifier', 'degraded_order') THEN 'order'
    WHEN p_outcome IN ('rate_limited', 'server_error', 'timeout', 'invalid_json', 'degraded_integration') THEN 'integration'
    WHEN p_outcome = 'credentials' THEN 'credentials'
    ELSE NULL END;

  -- common effects of an APPLIED answer
  UPDATE public.order_shipments SET last_polled_at = p_finished_at, last_applied_started_at = p_started_at, claim_token = NULL, lease_until = NULL
   WHERE id = s.id;
  v_state := s.tracking_state;

  IF p_outcome = 'ok' THEN
    UPDATE public.order_shipments SET last_success_at = p_finished_at, last_raw = p_raw_summary, last_raw_hash = p_raw_hash,
           consecutive_failures = 0, first_failure_at = NULL, last_error_kind = NULL, last_error_code = NULL, next_poll_at = p_next_poll_at,
           tracking_state = CASE WHEN tracking_state = 'requires_attention' THEN 'active' ELSE tracking_state END
     WHERE id = s.id;
    v_cur := public.order_shipments_rank(s.logistic_status);
    v_new := public.order_shipments_rank(p_normalized);
    IF v_new > v_cur THEN
      v_changed := TRUE;
      IF p_normalized = 'at_destination' THEN
        v_entered := LEAST(COALESCE(p_destination_at, p_finished_at), p_finished_at);
        UPDATE public.order_shipments SET logistic_status = 'at_destination', status_changed_at = p_finished_at, destination_episode = s.destination_episode + 1,
               destination_entered_at = v_entered, destination_entered_source = CASE WHEN p_destination_at IS NULL THEN 'observed' ELSE 'shalom' END
         WHERE id = s.id;
      ELSIF p_normalized = 'delivered' THEN
        UPDATE public.order_shipments SET logistic_status = 'delivered', tracking_state = 'delivered', status_changed_at = p_finished_at, next_poll_at = NULL
         WHERE id = s.id;
        v_state := 'delivered';
      ELSE
        UPDATE public.order_shipments SET logistic_status = p_normalized, status_changed_at = p_finished_at WHERE id = s.id;
      END IF;
      PERFORM public.order_shipments_log(p_account, p_order, 'status_changed', s.logistic_status, p_normalized, s.identifier_version, NULL, 'system',
        jsonb_build_object('trigger', p_trigger, 'raw_hash', p_raw_hash));
      IF p_normalized = 'delivered' THEN
        PERFORM public.order_shipments_log(p_account, p_order, 'delivered', s.logistic_status, 'delivered', s.identifier_version, NULL, 'system', '{}'::jsonb);
        PERFORM public.order_shipments_resolve_alerts(p_account, p_order, 'delivered', NULL, 'system', s.identifier_version, p_finished_at);
      END IF;
    ELSIF v_new < v_cur THEN
      -- never backwards by itself: recorded once, state untouched
      PERFORM public.order_shipments_log(p_account, p_order, 'regression_ignored', s.logistic_status, p_normalized, s.identifier_version, NULL, 'system',
        jsonb_build_object('trigger', p_trigger, 'raw_hash', p_raw_hash));
    END IF;
    IF s.tracking_state = 'requires_attention' THEN
      PERFORM public.order_shipments_log(p_account, p_order, 'attention_cleared', NULL, NULL, s.identifier_version, NULL, 'system', jsonb_build_object('by', 'poll'));
    END IF;

  ELSIF p_outcome = 'unknown_state' THEN
    -- a technically valid answer we cannot interpret: NOT an error and NOT a transition; visible as a technical exception
    UPDATE public.order_shipments SET last_success_at = p_finished_at, last_raw = p_raw_summary, last_raw_hash = p_raw_hash,
           consecutive_failures = 0, first_failure_at = NULL, last_error_kind = 'exception', last_error_code = 'unknown_status', next_poll_at = p_next_poll_at
     WHERE id = s.id;
    PERFORM public.order_shipments_log(p_account, p_order, 'exception_unknown_state', s.logistic_status, NULL, s.identifier_version, NULL, 'system',
      jsonb_build_object('trigger', p_trigger, 'raw_hash', p_raw_hash, 'raw', p_raw_summary));

  ELSIF v_kind = 'credentials' THEN
    -- GLOBAL: never counted against the order; the caller trips the breaker
    UPDATE public.order_shipments SET last_error_kind = 'credentials', last_error_code = COALESCE(p_error_code, 'credentials'), next_poll_at = COALESCE(p_next_poll_at, next_poll_at)
     WHERE id = s.id;

  ELSE
    UPDATE public.order_shipments SET consecutive_failures = s.consecutive_failures + 1, first_failure_at = COALESCE(s.first_failure_at, p_finished_at),
           last_error_kind = v_kind, last_error_code = COALESCE(p_error_code, p_outcome), next_poll_at = p_next_poll_at
     WHERE id = s.id;
    -- order-level errors (guide not found / invalid) only become "requires attention" after the configured window (the app decides p_attention);
    -- never from a single answer, and the guide / history are kept
    IF v_kind = 'order' AND p_attention AND s.tracking_state = 'active' THEN
      UPDATE public.order_shipments SET tracking_state = 'requires_attention', next_poll_at = NULL WHERE id = s.id;
      v_state := 'requires_attention';
      PERFORM public.order_shipments_log(p_account, p_order, 'requires_attention', s.logistic_status, NULL, s.identifier_version, NULL, 'system',
        jsonb_build_object('outcome', p_outcome, 'failures', s.consecutive_failures + 1));
    END IF;
  END IF;

  INSERT INTO public.order_shipment_polls (account_id, order_id, identifier_version, claim_token, trigger, started_at, finished_at, outcome, http_status, latency_ms, normalized_status, raw_hash, error_code, applied)
  VALUES (p_account, p_order, p_identifier_version, p_claim_token, p_trigger, p_started_at, p_finished_at, p_outcome, p_http_status, p_latency_ms, p_normalized, p_raw_hash, p_error_code, TRUE);
  RETURN jsonb_build_object('ok', TRUE, 'applied', TRUE, 'changed', v_changed, 'tracking_state', v_state);
END;
$$;
ALTER FUNCTION public.apply_shipment_poll(UUID, UUID, UUID, INTEGER, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, INTEGER, INTEGER, TEXT, JSONB, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN, TEXT, TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.apply_shipment_poll(UUID, UUID, UUID, INTEGER, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, INTEGER, INTEGER, TEXT, JSONB, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_shipment_poll(UUID, UUID, UUID, INTEGER, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, INTEGER, INTEGER, TEXT, JSONB, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN, TEXT, TIMESTAMPTZ) TO service_role;
