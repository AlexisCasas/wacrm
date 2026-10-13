-- E4.2 PR #30 audit round 2: Retry-After above one day.
--
-- 062 honoured a provider Retry-After only up to 86400 s and silently used the 30..900 s backoff above it, i.e. it would
-- have retried EARLIER than the provider asked. Policy (conservative): a Retry-After of 1..604800 s (7 days) is honoured
-- exactly; above that nothing is shortened and nothing is deferred: defer_versioned_effect answers 'retry_after_too_long'
-- and leaves the effect 'claimed', so the caller settles it as definitively failed (the provider already refused it, it
-- was never accepted). NULL / 0 / negative still mean "no valid Retry-After" -> backoff by attempt.
-- The same limit exists in versioned-messaging.ts (MAX_DEFER_SECONDS).

CREATE OR REPLACE FUNCTION public.defer_versioned_effect(
  p_account_id UUID, p_run_id UUID, p_owner TEXT, p_fencing_token INTEGER, p_effect_id UUID, p_attempt_id UUID,
  p_retry_after_seconds INTEGER DEFAULT NULL, p_error_code TEXT DEFAULT NULL
)
RETURNS TABLE (deferred BOOLEAN, effect_state TEXT, not_before TIMESTAMPTZ, wait_seconds INTEGER, reason TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_run public.flow_runs%ROWTYPE; v_gate TEXT; v_eff public.flow_run_effects%ROWTYPE; v_wait INTEGER; v_source TEXT; v_until TIMESTAMPTZ;
BEGIN
  IF p_owner IS NULL OR length(p_owner) NOT BETWEEN 1 AND 200 OR p_fencing_token IS NULL OR p_effect_id IS NULL OR p_attempt_id IS NULL
     OR length(COALESCE(p_error_code, '')) > 64 THEN
    RAISE EXCEPTION 'invalid versioned effect request' USING ERRCODE = '22023';
  END IF;
  v_run := public.lock_versioned_run(p_account_id, p_run_id);
  v_gate := public.versioned_run_gate(v_run, p_owner, p_fencing_token);
  IF v_gate IS NOT NULL THEN RETURN QUERY SELECT false, NULL::text, NULL::timestamptz, NULL::integer, v_gate; RETURN; END IF;
  SELECT * INTO v_eff FROM public.flow_run_effects e WHERE e.id = p_effect_id AND e.flow_run_id = v_run.id AND e.account_id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'versioned effect not found' USING ERRCODE = 'P0002'; END IF;
  IF v_eff.occurrence_revision <> v_run.versioned_revision THEN RETURN QUERY SELECT false, v_eff.state, NULL::timestamptz, NULL::integer, 'effect_not_current'; RETURN; END IF;
  IF v_eff.state <> 'claimed' THEN RETURN QUERY SELECT false, v_eff.state, NULL::timestamptz, NULL::integer, 'effect_not_claimed'; RETURN; END IF;
  IF v_eff.attempt_id <> p_attempt_id OR v_eff.claimed_owner <> p_owner OR v_eff.claimed_fencing_token <> p_fencing_token THEN
    RETURN QUERY SELECT false, v_eff.state, NULL::timestamptz, NULL::integer, 'attempt_mismatch'; RETURN;
  END IF;
  -- a provider deadline is never shortened: longer than the limit is refused (state untouched) and the caller decides
  IF p_retry_after_seconds > 604800 THEN
    RETURN QUERY SELECT false, v_eff.state, NULL::timestamptz, NULL::integer, 'retry_after_too_long'; RETURN;
  END IF;
  IF p_retry_after_seconds BETWEEN 1 AND 604800 THEN
    v_wait := p_retry_after_seconds; v_source := 'retry_after';
  ELSE
    v_wait := LEAST(900, 30 * (2 ^ LEAST(v_eff.attempt - 1, 5))::integer); v_source := 'backoff';
  END IF;
  v_until := clock_timestamp() + make_interval(secs => v_wait);
  UPDATE public.flow_run_effects e SET state = 'pending', retry_not_before = v_until, error_code = p_error_code,
      attempt_id = NULL, claimed_owner = NULL, claimed_fencing_token = NULL, claimed_at = NULL, updated_at = clock_timestamp()
    WHERE e.id = v_eff.id RETURNING * INTO v_eff;
  INSERT INTO public.flow_run_events (flow_run_id, event_type, node_key, payload)
  VALUES (v_run.id, 'effect_deferred', v_eff.node_key, jsonb_build_object('effect_id', v_eff.id, 'effect_type', v_eff.effect_type,
    'occurrence_revision', v_eff.occurrence_revision, 'attempt', v_eff.attempt, 'wait_seconds', v_wait, 'wait_source', v_source, 'error_code', v_eff.error_code));
  RETURN QUERY SELECT true, v_eff.state, v_until, v_wait, NULL::text;
END;
$$;
REVOKE ALL ON FUNCTION public.defer_versioned_effect(UUID,UUID,TEXT,INTEGER,UUID,UUID,INTEGER,TEXT) FROM PUBLIC;
