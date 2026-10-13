-- E4.2C1: persistent effect ledger (outbox) for messaging nodes. Additive. Nothing here sends anything.
--
-- Identity of an effect: (flow_run_id, occurrence_revision). occurrence_revision is the run's
-- versioned_revision while the message node is the pending cursor. The CAS bumps that revision by
-- exactly one on every committed transition, so the same node reached again (second call of a subflow,
-- a loop) has a different revision, while a restart or retry of the SAME step sees the SAME revision.
--
-- State machine (enforced by RPCs and by a trigger):
--   pending   registered, never handed to a provider (the claim is persisted BEFORE any send)
--   claimed   one attempt owns it (owner + fencing token + attempt_id); outcome unknown to the database
--   confirmed provider accepted it (provider_message_id recorded)           [terminal]
--   failed    provider definitively rejected it                              [terminal]
--   ambiguous outcome unknown (timeout, crash while claimed); NEVER resent automatically
--   ambiguous -> pending | confirmed | failed only through resolve_versioned_effect with evidence
-- Delivery guarantee: at most one attempt in flight; a new attempt only after proof it was not sent.
-- This is NOT exactly-once: WhatsApp Cloud API offers no idempotency key.
ALTER TABLE public.flow_run_events DROP CONSTRAINT IF EXISTS flow_run_events_event_type_check;
ALTER TABLE public.flow_run_events ADD CONSTRAINT flow_run_events_event_type_check CHECK (event_type IN (
  'started', 'node_entered', 'message_sent', 'reply_received', 'fallback_fired', 'handoff', 'timeout', 'error', 'completed',
  'subflow_called', 'subflow_returned',
  'effect_registered', 'effect_claimed', 'effect_confirmed', 'effect_ambiguous', 'effect_failed', 'effect_resolved'
));

CREATE TABLE public.flow_run_effects (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL,
  flow_run_id UUID NOT NULL,
  flow_version_id UUID NOT NULL,
  node_key TEXT NOT NULL,
  occurrence_revision BIGINT NOT NULL CHECK (occurrence_revision >= 0),
  effect_type TEXT NOT NULL CHECK (effect_type IN ('send_message', 'send_media')),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'claimed', 'confirmed', 'ambiguous', 'failed')),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  attempt_id UUID,
  claimed_owner TEXT,
  claimed_fencing_token INTEGER,
  claimed_at TIMESTAMPTZ,
  contact_id UUID,
  conversation_id UUID,
  -- What the sender must send, rendered when the effect was registered so a retry sends exactly this.
  -- Message content: the table is service_role only and never copied into events or logs.
  request JSONB NOT NULL CHECK (jsonb_typeof(request) = 'object'),
  payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  provider_message_id TEXT CHECK (length(provider_message_id) BETWEEN 1 AND 200),
  error_code TEXT CHECK (length(error_code) <= 64),
  resolution_evidence TEXT CHECK (length(resolution_evidence) <= 500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  finished_at TIMESTAMPTZ,
  CONSTRAINT flow_run_effects_run_same_account_fkey FOREIGN KEY (flow_run_id, account_id)
    REFERENCES public.flow_runs (id, account_id) ON DELETE CASCADE,
  CONSTRAINT flow_run_effects_version_same_account_fkey FOREIGN KEY (flow_version_id, account_id)
    REFERENCES public.flow_versions (id, account_id) ON DELETE RESTRICT,
  CONSTRAINT flow_run_effects_occurrence_key UNIQUE (flow_run_id, occurrence_revision),
  CONSTRAINT flow_run_effects_state_shape CHECK (
    CASE state
      WHEN 'pending'   THEN claimed_owner IS NULL AND claimed_fencing_token IS NULL AND provider_message_id IS NULL AND finished_at IS NULL
      WHEN 'claimed'   THEN attempt >= 1 AND attempt_id IS NOT NULL AND claimed_owner IS NOT NULL AND claimed_fencing_token IS NOT NULL AND provider_message_id IS NULL AND finished_at IS NULL
      WHEN 'ambiguous' THEN attempt >= 1 AND attempt_id IS NOT NULL AND provider_message_id IS NULL AND finished_at IS NULL
      WHEN 'confirmed' THEN attempt >= 1 AND provider_message_id IS NOT NULL AND finished_at IS NOT NULL
      WHEN 'failed'    THEN finished_at IS NOT NULL AND provider_message_id IS NULL
    END)
);
CREATE UNIQUE INDEX flow_run_effects_provider_message_key ON public.flow_run_effects (account_id, provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX flow_run_effects_open_idx ON public.flow_run_effects (account_id, state) WHERE state IN ('pending', 'claimed', 'ambiguous');

-- Service-role only: no policy for members (the request holds message content), no grants to anyone else.
ALTER TABLE public.flow_run_effects ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.flow_run_effects FROM PUBLIC;
REVOKE ALL ON TABLE public.flow_run_effects FROM anon, authenticated;
GRANT ALL ON TABLE public.flow_run_effects TO service_role;

-- Defence in depth against buggy service-role writes: identity columns are immutable and only the
-- documented state transitions exist; attempts only count up, by one, when a claim starts.
CREATE FUNCTION public.guard_effect_transition()
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
    OR (OLD.state = 'ambiguous' AND NEW.state IN ('pending', 'confirmed', 'failed'))) THEN
    RAISE EXCEPTION 'illegal effect transition % -> %', OLD.state, NEW.state USING ERRCODE = '55000';
  END IF;
  IF NEW.attempt <> OLD.attempt AND NOT (OLD.state = 'pending' AND NEW.state = 'claimed' AND NEW.attempt = OLD.attempt + 1) THEN
    RAISE EXCEPTION 'effect attempts only advance when a claim starts' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER flow_run_effects_guard BEFORE UPDATE ON public.flow_run_effects FOR EACH ROW EXECUTE FUNCTION public.guard_effect_transition();
REVOKE ALL ON FUNCTION public.guard_effect_transition() FROM PUBLIC;

-- Shared gate for every ledger RPC: the run must be active and the caller must hold the live lease.
CREATE FUNCTION public.versioned_run_gate(p_run public.flow_runs, p_owner TEXT, p_token INTEGER)
RETURNS TEXT LANGUAGE plpgsql SECURITY INVOKER SET search_path = public
AS $$
BEGIN
  IF p_run.status <> 'active' THEN RETURN 'run_not_active'; END IF;
  IF p_run.versioned_lease_owner IS DISTINCT FROM p_owner OR p_run.versioned_lease <> p_token THEN RETURN 'stale_lease'; END IF;
  IF p_run.versioned_lease_expires_at <= clock_timestamp() THEN RETURN 'lease_expired'; END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.versioned_run_gate(public.flow_runs, TEXT, INTEGER) FROM PUBLIC;

-- 1. Register a pending effect for the message node that is the run's pending cursor. Idempotent per
--    step: repeating it returns the existing row (already_registered) or payload_mismatch.
--    Does not move the cursor or the revision; budget is only consumed by commit_versioned_effect_step.
CREATE FUNCTION public.register_versioned_effect(
  p_account_id UUID, p_run_id UUID, p_owner TEXT, p_fencing_token INTEGER, p_expected_revision BIGINT,
  p_effect_type TEXT, p_request JSONB
)
RETURNS TABLE (registered BOOLEAN, effect_id UUID, effect_state TEXT, effect_revision BIGINT, reason TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE
  v_run public.flow_runs%ROWTYPE; v_gate TEXT; v_ver public.flow_versions%ROWTYPE; v_hash TEXT; v_eff public.flow_run_effects%ROWTYPE;
BEGIN
  IF p_owner IS NULL OR length(p_owner) NOT BETWEEN 1 AND 200 OR p_fencing_token IS NULL OR p_expected_revision IS NULL
     OR p_effect_type IS NULL OR p_effect_type NOT IN ('send_message', 'send_media')
     OR jsonb_typeof(p_request) IS DISTINCT FROM 'object' OR octet_length(p_request::text) > 65536 THEN
    RAISE EXCEPTION 'invalid versioned effect request' USING ERRCODE = '22023';
  END IF;
  v_run := public.lock_versioned_run(p_account_id, p_run_id);
  v_gate := public.versioned_run_gate(v_run, p_owner, p_fencing_token);
  IF v_gate IS NOT NULL THEN RETURN QUERY SELECT false, NULL::uuid, NULL::text, v_run.versioned_revision, v_gate; RETURN; END IF;
  IF v_run.versioned_revision <> p_expected_revision THEN RETURN QUERY SELECT false, NULL::uuid, NULL::text, v_run.versioned_revision, 'revision_conflict'; RETURN; END IF;

  IF jsonb_typeof(v_run.versioned_checkpoint) IS DISTINCT FROM 'object'
     OR (v_run.versioned_checkpoint #>> '{cursor,flow_version_id}') IS DISTINCT FROM v_run.current_flow_version_id::text
     OR (v_run.versioned_checkpoint #>> '{cursor,node_key}') IS DISTINCT FROM v_run.versioned_node_key
     OR COALESCE(v_run.versioned_checkpoint->>'state', 'pending') <> 'pending' THEN
    RAISE EXCEPTION 'versioned checkpoint does not match the run cursor' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_ver FROM public.flow_versions fv WHERE fv.id = v_run.current_flow_version_id AND fv.account_id = p_account_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'versioned run references a missing version' USING ERRCODE = '55000'; END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(v_ver.definition->'nodes', '[]'::jsonb)) n
                 WHERE n->>'node_key' = v_run.versioned_node_key AND n->>'node_type' = p_effect_type) THEN
    RAISE EXCEPTION 'cursor node is not a node of the requested effect type' USING ERRCODE = '22023';
  END IF;

  v_hash := encode(digest(p_request::text, 'sha256'), 'hex');
  SELECT * INTO v_eff FROM public.flow_run_effects e WHERE e.flow_run_id = v_run.id AND e.occurrence_revision = v_run.versioned_revision;
  IF FOUND THEN
    RETURN QUERY SELECT false, v_eff.id, v_eff.state, v_eff.occurrence_revision,
      CASE WHEN v_eff.payload_hash = v_hash AND v_eff.effect_type = p_effect_type THEN 'already_registered' ELSE 'payload_mismatch' END;
    RETURN;
  END IF;
  IF v_run.versioned_messages_executed + 1 > 100 THEN RETURN QUERY SELECT false, NULL::uuid, NULL::text, v_run.versioned_revision, 'budget_exceeded'; RETURN; END IF;

  INSERT INTO public.flow_run_effects (account_id, flow_run_id, flow_version_id, node_key, occurrence_revision, effect_type, contact_id, conversation_id, request, payload_hash)
  VALUES (p_account_id, v_run.id, v_run.current_flow_version_id, v_run.versioned_node_key, v_run.versioned_revision, p_effect_type, v_run.contact_id, v_run.conversation_id, p_request, v_hash)
  RETURNING * INTO v_eff;
  INSERT INTO public.flow_run_events (flow_run_id, event_type, node_key, payload)
  VALUES (v_run.id, 'effect_registered', v_eff.node_key, jsonb_build_object('effect_id', v_eff.id, 'effect_type', v_eff.effect_type,
    'flow_version_id', v_eff.flow_version_id, 'occurrence_revision', v_eff.occurrence_revision, 'payload_hash', v_eff.payload_hash));
  RETURN QUERY SELECT true, v_eff.id, v_eff.state, v_eff.occurrence_revision, NULL::text;
END;
$$;

-- 2. Claim a pending effect for one attempt. The claim (with the attempt id the sender must use as its
--    client reference) is committed BEFORE any call to a provider, so "pending" always means "never sent".
CREATE FUNCTION public.claim_versioned_effect(
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
  UPDATE public.flow_run_effects e SET state = 'claimed', attempt = e.attempt + 1, attempt_id = gen_random_uuid(),
      claimed_owner = p_owner, claimed_fencing_token = p_fencing_token, claimed_at = clock_timestamp(), updated_at = clock_timestamp()
    WHERE e.id = v_eff.id RETURNING * INTO v_eff;
  INSERT INTO public.flow_run_events (flow_run_id, event_type, node_key, payload)
  VALUES (v_run.id, 'effect_claimed', v_eff.node_key, jsonb_build_object('effect_id', v_eff.id, 'effect_type', v_eff.effect_type,
    'occurrence_revision', v_eff.occurrence_revision, 'attempt', v_eff.attempt, 'attempt_id', v_eff.attempt_id, 'fencing_token', p_fencing_token));
  RETURN QUERY SELECT true, v_eff.state, v_eff.attempt, v_eff.attempt_id, NULL::text;
END;
$$;

-- 3. Record the outcome of the claimed attempt (confirmed / failed / ambiguous). Only the claim's owner,
--    token and attempt id may settle it. Does not move the cursor.
CREATE FUNCTION public.settle_versioned_effect(
  p_account_id UUID, p_run_id UUID, p_owner TEXT, p_fencing_token INTEGER, p_effect_id UUID, p_attempt_id UUID,
  p_outcome TEXT, p_provider_message_id TEXT DEFAULT NULL, p_error_code TEXT DEFAULT NULL
)
RETURNS TABLE (settled BOOLEAN, effect_state TEXT, reason TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_run public.flow_runs%ROWTYPE; v_gate TEXT; v_eff public.flow_run_effects%ROWTYPE; v_event TEXT;
BEGIN
  IF p_owner IS NULL OR length(p_owner) NOT BETWEEN 1 AND 200 OR p_fencing_token IS NULL OR p_effect_id IS NULL OR p_attempt_id IS NULL
     OR p_outcome IS NULL OR p_outcome NOT IN ('confirmed', 'failed', 'ambiguous')
     OR (p_outcome = 'confirmed' AND (p_provider_message_id IS NULL OR length(p_provider_message_id) NOT BETWEEN 1 AND 200))
     OR (p_outcome <> 'confirmed' AND p_provider_message_id IS NOT NULL)
     OR length(COALESCE(p_error_code, '')) > 64 THEN
    RAISE EXCEPTION 'invalid versioned effect request' USING ERRCODE = '22023';
  END IF;
  v_run := public.lock_versioned_run(p_account_id, p_run_id);
  v_gate := public.versioned_run_gate(v_run, p_owner, p_fencing_token);
  IF v_gate IS NOT NULL THEN RETURN QUERY SELECT false, NULL::text, v_gate; RETURN; END IF;
  SELECT * INTO v_eff FROM public.flow_run_effects e WHERE e.id = p_effect_id AND e.flow_run_id = v_run.id AND e.account_id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'versioned effect not found' USING ERRCODE = 'P0002'; END IF;
  IF v_eff.occurrence_revision <> v_run.versioned_revision THEN RETURN QUERY SELECT false, v_eff.state, 'effect_not_current'; RETURN; END IF;
  IF v_eff.state <> 'claimed' THEN RETURN QUERY SELECT false, v_eff.state, 'effect_not_claimed'; RETURN; END IF;
  IF v_eff.attempt_id <> p_attempt_id OR v_eff.claimed_owner <> p_owner OR v_eff.claimed_fencing_token <> p_fencing_token THEN
    RETURN QUERY SELECT false, v_eff.state, 'attempt_mismatch'; RETURN;
  END IF;
  UPDATE public.flow_run_effects e SET state = p_outcome, provider_message_id = p_provider_message_id, error_code = p_error_code, updated_at = clock_timestamp(),
      finished_at = CASE WHEN p_outcome = 'ambiguous' THEN NULL ELSE clock_timestamp() END
    WHERE e.id = v_eff.id RETURNING * INTO v_eff;
  v_event := CASE p_outcome WHEN 'confirmed' THEN 'effect_confirmed' WHEN 'failed' THEN 'effect_failed' ELSE 'effect_ambiguous' END;
  INSERT INTO public.flow_run_events (flow_run_id, event_type, node_key, payload)
  VALUES (v_run.id, v_event, v_eff.node_key, jsonb_build_object('effect_id', v_eff.id, 'effect_type', v_eff.effect_type,
    'occurrence_revision', v_eff.occurrence_revision, 'attempt', v_eff.attempt, 'attempt_id', v_eff.attempt_id,
    'provider_message_id', v_eff.provider_message_id, 'error_code', v_eff.error_code));
  RETURN QUERY SELECT true, v_eff.state, NULL::text;
END;
$$;

-- 4. Recovery for the NEW lease holder: an attempt claimed under an older fencing token may or may not
--    have reached the provider, so it becomes ambiguous. Pending effects were never attempted and stay
--    pending. Nothing is resent here.
CREATE FUNCTION public.recover_versioned_run_effects(p_account_id UUID, p_run_id UUID, p_owner TEXT, p_fencing_token INTEGER)
RETURNS TABLE (effect_id UUID, previous_state TEXT, new_state TEXT, reason TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_run public.flow_runs%ROWTYPE; v_gate TEXT; v_eff public.flow_run_effects%ROWTYPE;
BEGIN
  IF p_owner IS NULL OR length(p_owner) NOT BETWEEN 1 AND 200 OR p_fencing_token IS NULL THEN
    RAISE EXCEPTION 'invalid versioned effect request' USING ERRCODE = '22023';
  END IF;
  v_run := public.lock_versioned_run(p_account_id, p_run_id);
  v_gate := public.versioned_run_gate(v_run, p_owner, p_fencing_token);
  IF v_gate IS NOT NULL THEN RETURN QUERY SELECT NULL::uuid, NULL::text, NULL::text, v_gate; RETURN; END IF;
  FOR v_eff IN SELECT * FROM public.flow_run_effects e WHERE e.flow_run_id = v_run.id AND e.state = 'claimed' AND e.claimed_fencing_token < p_fencing_token ORDER BY e.occurrence_revision FOR UPDATE LOOP
    UPDATE public.flow_run_effects e SET state = 'ambiguous', updated_at = clock_timestamp() WHERE e.id = v_eff.id;
    INSERT INTO public.flow_run_events (flow_run_id, event_type, node_key, payload)
    VALUES (v_run.id, 'effect_ambiguous', v_eff.node_key, jsonb_build_object('effect_id', v_eff.id, 'effect_type', v_eff.effect_type,
      'occurrence_revision', v_eff.occurrence_revision, 'attempt', v_eff.attempt, 'attempt_id', v_eff.attempt_id, 'cause', 'claim_abandoned', 'fencing_token', p_fencing_token));
    RETURN QUERY SELECT v_eff.id, 'claimed'::text, 'ambiguous'::text, NULL::text;
  END LOOP;
END;
$$;

-- 5. Resolve an ambiguous effect with evidence (a delivery receipt, the provider's own record, an
--    operator's check). not_sent re-opens it as pending for a NEW attempt; the attempt counter is kept.
CREATE FUNCTION public.resolve_versioned_effect(
  p_account_id UUID, p_run_id UUID, p_owner TEXT, p_fencing_token INTEGER, p_effect_id UUID,
  p_resolution TEXT, p_evidence TEXT, p_provider_message_id TEXT DEFAULT NULL
)
RETURNS TABLE (resolved BOOLEAN, effect_state TEXT, reason TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_run public.flow_runs%ROWTYPE; v_gate TEXT; v_eff public.flow_run_effects%ROWTYPE; v_new TEXT;
BEGIN
  IF p_owner IS NULL OR length(p_owner) NOT BETWEEN 1 AND 200 OR p_fencing_token IS NULL OR p_effect_id IS NULL
     OR p_resolution IS NULL OR p_resolution NOT IN ('confirmed', 'not_sent', 'failed')
     OR p_evidence IS NULL OR length(btrim(p_evidence)) NOT BETWEEN 1 AND 500
     OR (p_resolution = 'confirmed' AND (p_provider_message_id IS NULL OR length(p_provider_message_id) NOT BETWEEN 1 AND 200))
     OR (p_resolution <> 'confirmed' AND p_provider_message_id IS NOT NULL) THEN
    RAISE EXCEPTION 'invalid versioned effect request' USING ERRCODE = '22023';
  END IF;
  v_run := public.lock_versioned_run(p_account_id, p_run_id);
  v_gate := public.versioned_run_gate(v_run, p_owner, p_fencing_token);
  IF v_gate IS NOT NULL THEN RETURN QUERY SELECT false, NULL::text, v_gate; RETURN; END IF;
  SELECT * INTO v_eff FROM public.flow_run_effects e WHERE e.id = p_effect_id AND e.flow_run_id = v_run.id AND e.account_id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'versioned effect not found' USING ERRCODE = 'P0002'; END IF;
  IF v_eff.occurrence_revision <> v_run.versioned_revision THEN RETURN QUERY SELECT false, v_eff.state, 'effect_not_current'; RETURN; END IF;
  IF v_eff.state <> 'ambiguous' THEN RETURN QUERY SELECT false, v_eff.state, 'effect_not_ambiguous'; RETURN; END IF;
  v_new := CASE p_resolution WHEN 'not_sent' THEN 'pending' ELSE p_resolution END;
  UPDATE public.flow_run_effects e SET state = v_new, provider_message_id = p_provider_message_id, resolution_evidence = btrim(p_evidence), updated_at = clock_timestamp(),
      finished_at = CASE WHEN v_new = 'pending' THEN NULL ELSE clock_timestamp() END,
      attempt_id = CASE WHEN v_new = 'pending' THEN NULL ELSE e.attempt_id END,
      claimed_owner = CASE WHEN v_new = 'pending' THEN NULL ELSE e.claimed_owner END,
      claimed_fencing_token = CASE WHEN v_new = 'pending' THEN NULL ELSE e.claimed_fencing_token END,
      claimed_at = CASE WHEN v_new = 'pending' THEN NULL ELSE e.claimed_at END
    WHERE e.id = v_eff.id RETURNING * INTO v_eff;
  INSERT INTO public.flow_run_events (flow_run_id, event_type, node_key, payload)
  VALUES (v_run.id, 'effect_resolved', v_eff.node_key, jsonb_build_object('effect_id', v_eff.id, 'effect_type', v_eff.effect_type,
    'occurrence_revision', v_eff.occurrence_revision, 'attempt', v_eff.attempt, 'resolution', p_resolution, 'provider_message_id', v_eff.provider_message_id));
  RETURN QUERY SELECT true, v_eff.state, NULL::text;
END;
$$;

-- 6. Leave a message node: requires the effect to be CONFIRMED, then moves cursor + checkpoint + revision
--    and consumes one node and one message of budget, in the same UPDATE. An interruption between
--    confirmation and this call is recovered by simply calling it again (nothing is resent); a repeated
--    call after success finds a newer revision (revision_conflict), so the budget is consumed once.
CREATE FUNCTION public.commit_versioned_effect_step(
  p_account_id UUID, p_run_id UUID, p_owner TEXT, p_fencing_token INTEGER, p_expected_revision BIGINT, p_effect_id UUID, p_checkpoint JSONB
)
RETURNS TABLE (committed BOOLEAN, revision BIGINT, reason TEXT, nodes_executed INTEGER, messages_executed INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_run public.flow_runs%ROWTYPE; v_gate TEXT; v_eff public.flow_run_effects%ROWTYPE; v_ver UUID; v_node TEXT; v_def JSONB;
  v_new BIGINT; v_nodes INTEGER; v_msgs INTEGER;
BEGIN
  IF p_owner IS NULL OR length(p_owner) NOT BETWEEN 1 AND 200 OR p_fencing_token IS NULL OR p_expected_revision IS NULL OR p_effect_id IS NULL
     OR jsonb_typeof(p_checkpoint) IS DISTINCT FROM 'object' OR jsonb_typeof(p_checkpoint->'cursor') IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_checkpoint->'step') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'invalid versioned effect request' USING ERRCODE = '22023';
  END IF;
  v_run := public.lock_versioned_run(p_account_id, p_run_id);
  v_gate := public.versioned_run_gate(v_run, p_owner, p_fencing_token);
  IF v_gate IS NOT NULL THEN RETURN QUERY SELECT false, v_run.versioned_revision, v_gate, v_run.versioned_nodes_executed, v_run.versioned_messages_executed; RETURN; END IF;
  IF v_run.versioned_revision <> p_expected_revision THEN
    RETURN QUERY SELECT false, v_run.versioned_revision, 'revision_conflict', v_run.versioned_nodes_executed, v_run.versioned_messages_executed; RETURN;
  END IF;
  SELECT * INTO v_eff FROM public.flow_run_effects e WHERE e.id = p_effect_id AND e.flow_run_id = v_run.id AND e.account_id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'versioned effect not found' USING ERRCODE = 'P0002'; END IF;
  IF v_eff.occurrence_revision <> v_run.versioned_revision OR v_eff.flow_version_id <> v_run.current_flow_version_id OR v_eff.node_key <> v_run.versioned_node_key THEN
    RETURN QUERY SELECT false, v_run.versioned_revision, 'effect_not_current', v_run.versioned_nodes_executed, v_run.versioned_messages_executed; RETURN;
  END IF;
  IF v_eff.state <> 'confirmed' THEN
    RETURN QUERY SELECT false, v_run.versioned_revision, 'effect_not_confirmed', v_run.versioned_nodes_executed, v_run.versioned_messages_executed; RETURN;
  END IF;
  IF v_run.versioned_nodes_executed + 1 > 500 OR v_run.versioned_messages_executed + 1 > 100 THEN
    RETURN QUERY SELECT false, v_run.versioned_revision, 'budget_exceeded', v_run.versioned_nodes_executed, v_run.versioned_messages_executed; RETURN;
  END IF;
  BEGIN
    v_ver := (p_checkpoint #>> '{cursor,flow_version_id}')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'invalid versioned effect request' USING ERRCODE = '22023';
  END;
  v_node := p_checkpoint #>> '{cursor,node_key}';
  IF v_ver IS NULL OR v_node IS NULL OR (p_checkpoint->>'step')::numeric < 0 OR (p_checkpoint->>'step')::numeric <> trunc((p_checkpoint->>'step')::numeric) THEN
    RAISE EXCEPTION 'invalid versioned effect request' USING ERRCODE = '22023';
  END IF;
  IF v_ver <> v_run.current_flow_version_id THEN
    RAISE EXCEPTION 'cursor can only change flow version through call frames' USING ERRCODE = '22023';
  END IF;
  SELECT fv.definition INTO v_def FROM public.flow_versions fv WHERE fv.id = v_ver AND fv.account_id = p_account_id;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(v_def->'nodes', '[]'::jsonb)) n WHERE n->>'node_key' = v_node) THEN
    RAISE EXCEPTION 'checkpoint cursor is not a node of a published version' USING ERRCODE = '22023';
  END IF;
  UPDATE public.flow_runs r SET versioned_checkpoint = p_checkpoint, versioned_node_key = v_node, current_node_key = v_node,
      versioned_revision = r.versioned_revision + 1, versioned_nodes_executed = r.versioned_nodes_executed + 1,
      versioned_messages_executed = r.versioned_messages_executed + 1, last_advanced_at = clock_timestamp()
    WHERE r.id = v_run.id RETURNING r.versioned_revision, r.versioned_nodes_executed, r.versioned_messages_executed INTO v_new, v_nodes, v_msgs;
  RETURN QUERY SELECT true, v_new, NULL::text, v_nodes, v_msgs;
END;
$$;

-- The generic commit now refuses to skip an unresolved effect (see the function body).
CREATE OR REPLACE FUNCTION public.commit_versioned_run_transition(
  p_account_id UUID, p_run_id UUID, p_owner TEXT, p_fencing_token INTEGER,
  p_expected_revision BIGINT, p_checkpoint JSONB,
  p_status TEXT DEFAULT 'active', p_end_reason TEXT DEFAULT NULL,
  p_nodes_delta INTEGER DEFAULT 0, p_messages_delta INTEGER DEFAULT 0
)
RETURNS TABLE (committed BOOLEAN, revision BIGINT, reason TEXT, nodes_executed INTEGER, messages_executed INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_run public.flow_runs%ROWTYPE; v_now TIMESTAMPTZ := clock_timestamp();
  v_ver UUID; v_node TEXT; v_def JSONB; v_new BIGINT; v_terminal BOOLEAN; v_nodes INTEGER; v_msgs INTEGER;
BEGIN
  IF p_owner IS NULL OR length(p_owner) NOT BETWEEN 1 AND 200 OR p_fencing_token IS NULL OR p_expected_revision IS NULL
     OR jsonb_typeof(p_checkpoint) IS DISTINCT FROM 'object' OR jsonb_typeof(p_checkpoint->'cursor') IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_checkpoint->'step') IS DISTINCT FROM 'number'
     OR p_status IS NULL OR p_status NOT IN ('active', 'completed', 'handed_off', 'failed')
     OR p_nodes_delta IS NULL OR p_nodes_delta NOT BETWEEN 0 AND 500
     OR p_messages_delta IS NULL OR p_messages_delta NOT BETWEEN 0 AND 100 THEN
    RAISE EXCEPTION 'invalid versioned run request' USING ERRCODE = '22023';
  END IF;
  v_run := public.lock_versioned_run(p_account_id, p_run_id);
  IF v_run.status <> 'active' THEN RETURN QUERY SELECT false, v_run.versioned_revision, 'run_not_active', v_run.versioned_nodes_executed, v_run.versioned_messages_executed; RETURN; END IF;
  IF v_run.versioned_lease_owner IS DISTINCT FROM p_owner OR v_run.versioned_lease <> p_fencing_token THEN
    RETURN QUERY SELECT false, v_run.versioned_revision, 'stale_lease', v_run.versioned_nodes_executed, v_run.versioned_messages_executed; RETURN;
  END IF;
  IF v_run.versioned_lease_expires_at <= v_now THEN RETURN QUERY SELECT false, v_run.versioned_revision, 'lease_expired', v_run.versioned_nodes_executed, v_run.versioned_messages_executed; RETURN; END IF;
  IF v_run.versioned_revision <> p_expected_revision THEN
    RETURN QUERY SELECT false, v_run.versioned_revision, 'revision_conflict', v_run.versioned_nodes_executed, v_run.versioned_messages_executed; RETURN;
  END IF;
  -- Only END of the root flow (no call frames) may complete the run.
  IF p_status = 'completed' AND (v_run.versioned_depth > 0 OR EXISTS (SELECT 1 FROM public.flow_run_call_frames f WHERE f.flow_run_id = v_run.id)) THEN
    RETURN QUERY SELECT false, v_run.versioned_revision, 'call_frames_active', v_run.versioned_nodes_executed, v_run.versioned_messages_executed; RETURN;
  END IF;
  -- B-C1: a message node whose effect is registered must be left through the ledger
  -- (commit_versioned_effect_step) once confirmed. The generic commit may not step past an
  -- unresolved or merely confirmed effect; only a terminal failure of the run is always allowed.
  IF p_status <> 'failed' AND EXISTS (
    SELECT 1 FROM public.flow_run_effects e
    WHERE e.flow_run_id = v_run.id AND e.occurrence_revision = v_run.versioned_revision AND e.state <> 'failed') THEN
    RETURN QUERY SELECT false, v_run.versioned_revision, 'effect_unresolved', v_run.versioned_nodes_executed, v_run.versioned_messages_executed; RETURN;
  END IF;
  IF v_run.versioned_nodes_executed + p_nodes_delta > 500 OR v_run.versioned_messages_executed + p_messages_delta > 100 THEN
    RETURN QUERY SELECT false, v_run.versioned_revision, 'budget_exceeded', v_run.versioned_nodes_executed, v_run.versioned_messages_executed; RETURN;
  END IF;

  -- The target cursor must be a real node of a published version of this account.
  BEGIN
    v_ver := (p_checkpoint #>> '{cursor,flow_version_id}')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'invalid versioned run request' USING ERRCODE = '22023';
  END;
  v_node := p_checkpoint #>> '{cursor,node_key}';
  -- Version changes happen only through push/pop, so cursor and call frames cannot diverge.
  IF v_ver IS DISTINCT FROM v_run.current_flow_version_id THEN
    RAISE EXCEPTION 'cursor can only change flow version through call frames' USING ERRCODE = '22023';
  END IF;
  IF v_ver IS NULL OR v_node IS NULL OR (p_checkpoint->>'step')::numeric < 0 OR (p_checkpoint->>'step')::numeric <> trunc((p_checkpoint->>'step')::numeric) THEN
    RAISE EXCEPTION 'invalid versioned run request' USING ERRCODE = '22023';
  END IF;
  SELECT definition INTO v_def FROM public.flow_versions WHERE id = v_ver AND account_id = p_account_id;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(v_def->'nodes', '[]'::jsonb)) n WHERE n->>'node_key' = v_node) THEN
    RAISE EXCEPTION 'checkpoint cursor is not a node of a published version' USING ERRCODE = '22023';
  END IF;

  v_terminal := p_status <> 'active';
  UPDATE public.flow_runs SET
      versioned_checkpoint = p_checkpoint,
      current_flow_version_id = v_ver,
      versioned_node_key = v_node,
      current_node_key = v_node,
      versioned_revision = versioned_revision + 1,
      versioned_nodes_executed = versioned_nodes_executed + p_nodes_delta,
      versioned_messages_executed = versioned_messages_executed + p_messages_delta,
      status = p_status,
      ended_at = CASE WHEN v_terminal THEN v_now ELSE ended_at END,
      end_reason = CASE WHEN v_terminal THEN p_end_reason ELSE end_reason END,
      versioned_lease_owner = CASE WHEN v_terminal THEN NULL ELSE versioned_lease_owner END,
      versioned_lease_expires_at = CASE WHEN v_terminal THEN NULL ELSE versioned_lease_expires_at END,
      last_advanced_at = v_now
    WHERE id = v_run.id RETURNING versioned_revision, versioned_nodes_executed, versioned_messages_executed INTO v_new, v_nodes, v_msgs;
  RETURN QUERY SELECT true, v_new, NULL::text, v_nodes, v_msgs;
END;
$$;

-- Enter a subflow: pin the target flow's currently published version, push a frame, move the
-- cursor to the target's entry node and consume one node (the call node) -- all in one UPDATE
-- guarded by lease, fencing token and expected revision. The checkpoint is built here, not by the
-- caller, so cursor, checkpoint and frames cannot disagree.
-- Controlled refusals (no write): run_not_active, stale_lease, lease_expired, revision_conflict,
-- cursor_mismatch, budget_exceeded, depth_exceeded, recursion_detected.
-- Errors: 22023 invalid request / missing return or entry node, P0002 run or target flow not found
-- (other account, draft, archived and unpublished targets are indistinguishable), 55000 corrupt state.

DO $$
DECLARE f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.register_versioned_effect(UUID,UUID,TEXT,INTEGER,BIGINT,TEXT,JSONB)',
    'public.claim_versioned_effect(UUID,UUID,TEXT,INTEGER,UUID)',
    'public.settle_versioned_effect(UUID,UUID,TEXT,INTEGER,UUID,UUID,TEXT,TEXT,TEXT)',
    'public.recover_versioned_run_effects(UUID,UUID,TEXT,INTEGER)',
    'public.resolve_versioned_effect(UUID,UUID,TEXT,INTEGER,UUID,TEXT,TEXT,TEXT)',
    'public.commit_versioned_effect_step(UUID,UUID,TEXT,INTEGER,BIGINT,UUID,JSONB)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $$;
