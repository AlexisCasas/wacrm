-- E4.2 PR #30 audit fix (P2): temporary (rate-limit) rejections. Additive.
--
-- The adapter used to report Meta 429 / rate-limit answers as a definitive rejection, which settled the effect as
-- 'failed' and ended the run. A rate limit proves the message was NOT accepted, but it says nothing about the business
-- outcome: the run must wait and try again later.
--   * claimed -> pending is now possible, but ONLY through defer_versioned_effect and only together with a persisted
--     retry_not_before, so the retry time survives restarts and a worker that has not yet recorded the deferral leaves
--     the effect 'claimed' (recovery then makes it ambiguous: never resent)
--   * the wait is Retry-After when the provider sent a valid one (1..86400 s), otherwise an exponential backoff by
--     attempt (30, 60, 120, 240, 480 s, capped at 900 s); it is measured with the PostgreSQL clock
--   * claim_versioned_effect refuses with retry_not_due until then; the attempt counter is untouched by the deferral
--     and the message budget is only consumed by commit_versioned_effect_step, so nothing is consumed twice
--   * a deferral never creates an Inbox message (the persistence trigger only fires on 'confirmed')
--   * ambiguous results keep their own path (ambiguous, blocked, never resent automatically)
ALTER TABLE public.flow_run_events DROP CONSTRAINT IF EXISTS flow_run_events_event_type_check;
ALTER TABLE public.flow_run_events ADD CONSTRAINT flow_run_events_event_type_check CHECK (event_type IN (
  'started', 'node_entered', 'message_sent', 'reply_received', 'fallback_fired', 'handoff', 'timeout', 'error', 'completed',
  'subflow_called', 'subflow_returned',
  'effect_registered', 'effect_claimed', 'effect_confirmed', 'effect_ambiguous', 'effect_failed', 'effect_resolved',
  'effect_deferred'
));
ALTER TABLE public.flow_run_effects ADD COLUMN retry_not_before TIMESTAMPTZ;
ALTER TABLE public.flow_run_effects ADD CONSTRAINT flow_run_effects_retry_only_pending CHECK (retry_not_before IS NULL OR state = 'pending');

CREATE OR REPLACE FUNCTION public.guard_effect_transition()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER SET search_path = public
AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.account_id <> OLD.account_id OR NEW.flow_run_id <> OLD.flow_run_id OR NEW.flow_version_id <> OLD.flow_version_id
     OR NEW.node_key <> OLD.node_key OR NEW.occurrence_revision <> OLD.occurrence_revision OR NEW.effect_type <> OLD.effect_type
     OR NEW.request <> OLD.request OR NEW.payload_hash <> OLD.payload_hash OR NEW.created_at <> OLD.created_at
     OR NEW.contact_id IS DISTINCT FROM OLD.contact_id OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id THEN
    RAISE EXCEPTION 'effect identity and payload are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.state <> OLD.state AND NOT (
       (OLD.state = 'pending'   AND NEW.state = 'claimed')
    OR (OLD.state = 'claimed'   AND NEW.state IN ('confirmed', 'failed', 'ambiguous'))
    -- 062: a provably temporary rejection (rate limit) re-opens the effect, but only together with a persisted retry time
    OR (OLD.state = 'claimed'   AND NEW.state = 'pending' AND NEW.retry_not_before IS NOT NULL)
    OR (OLD.state = 'ambiguous' AND NEW.state IN ('pending', 'confirmed', 'failed'))) THEN
    RAISE EXCEPTION 'illegal effect transition % -> %', OLD.state, NEW.state USING ERRCODE = '55000';
  END IF;
  IF NEW.attempt <> OLD.attempt AND NOT (OLD.state = 'pending' AND NEW.state = 'claimed' AND NEW.attempt = OLD.attempt + 1) THEN
    RAISE EXCEPTION 'effect attempts only advance when a claim starts' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_versioned_effect(
  p_account_id UUID, p_run_id UUID, p_owner TEXT, p_fencing_token INTEGER, p_effect_id UUID
)
RETURNS TABLE (claimed BOOLEAN, effect_state TEXT, attempt_no INTEGER, claimed_attempt_id UUID, reason TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_run public.flow_runs%ROWTYPE; v_gate TEXT; v_eff public.flow_run_effects%ROWTYPE;
BEGIN
  IF p_owner IS NULL OR length(p_owner) NOT BETWEEN 1 AND 200 OR p_fencing_token IS NULL OR p_effect_id IS NULL THEN
    RAISE EXCEPTION 'invalid versioned effect request' USING ERRCODE = '22023';
  END IF;
  v_run := public.lock_versioned_run(p_account_id, p_run_id);
  v_gate := public.versioned_run_gate(v_run, p_owner, p_fencing_token);
  IF v_gate IS NOT NULL THEN RETURN QUERY SELECT false, NULL::text, NULL::integer, NULL::uuid, v_gate; RETURN; END IF;
  SELECT * INTO v_eff FROM public.flow_run_effects e WHERE e.id = p_effect_id AND e.flow_run_id = v_run.id AND e.account_id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'versioned effect not found' USING ERRCODE = 'P0002'; END IF;
  IF v_eff.occurrence_revision <> v_run.versioned_revision OR v_eff.flow_version_id <> v_run.current_flow_version_id OR v_eff.node_key <> v_run.versioned_node_key THEN
    RETURN QUERY SELECT false, v_eff.state, v_eff.attempt, NULL::uuid, 'effect_not_current'; RETURN;
  END IF;
  IF v_eff.state <> 'pending' THEN RETURN QUERY SELECT false, v_eff.state, v_eff.attempt, NULL::uuid, 'effect_not_pending'; RETURN; END IF;
  -- 062: a deferred effect cannot be claimed before its persisted retry time (PostgreSQL clock, survives restarts)
  IF v_eff.retry_not_before IS NOT NULL AND v_eff.retry_not_before > clock_timestamp() THEN
    RETURN QUERY SELECT false, v_eff.state, v_eff.attempt, NULL::uuid, 'retry_not_due'; RETURN;
  END IF;
  UPDATE public.flow_run_effects e SET state = 'claimed', attempt = e.attempt + 1, attempt_id = gen_random_uuid(), retry_not_before = NULL,
      claimed_owner = p_owner, claimed_fencing_token = p_fencing_token, claimed_at = clock_timestamp(), updated_at = clock_timestamp()
    WHERE e.id = v_eff.id RETURNING * INTO v_eff;
  INSERT INTO public.flow_run_events (flow_run_id, event_type, node_key, payload)
  VALUES (v_run.id, 'effect_claimed', v_eff.node_key, jsonb_build_object('effect_id', v_eff.id, 'effect_type', v_eff.effect_type,
    'occurrence_revision', v_eff.occurrence_revision, 'attempt', v_eff.attempt, 'attempt_id', v_eff.attempt_id, 'fencing_token', p_fencing_token));
  RETURN QUERY SELECT true, v_eff.state, v_eff.attempt, v_eff.attempt_id, NULL::text;
END;
$$;

-- Records that the claimed attempt was refused for a provably temporary reason. Only the claim's owner, token and attempt
-- id may defer it. p_retry_after_seconds outside 1..86400 (or NULL) means "no valid Retry-After": backoff by attempt.
CREATE FUNCTION public.defer_versioned_effect(
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
  IF p_retry_after_seconds BETWEEN 1 AND 86400 THEN
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
REVOKE ALL ON FUNCTION public.defer_versioned_effect(UUID,UUID,TEXT,INTEGER,UUID,UUID,INTEGER,TEXT) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.defer_versioned_effect(UUID,UUID,TEXT,INTEGER,UUID,UUID,INTEGER,TEXT) TO service_role;
