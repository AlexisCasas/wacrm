-- E4.2C3.1: Inbox persistence of confirmed messaging effects. Additive; nothing here sends anything.
--
-- A message the provider accepted must appear in the Inbox exactly once. The persistence runs inside the SAME
-- transaction that turns the effect into 'confirmed' (a trigger on flow_run_effects), so there is no window in
-- which an effect is confirmed but its message is missing, whether the confirmation came from settle (the
-- sender's own acceptance) or from resolve (evidence supplied for an ambiguous effect). The legacy messages
-- table is not altered: the one-message-per-effect guarantee lives in flow_run_effect_messages (PRIMARY KEY on
-- effect_id, UNIQUE message_id), and the existing UNIQUE (conversation_id, message_id) on messages keeps a
-- repeated wamid from creating a second row. status is written as 'sent': the provider only ACCEPTED the
-- message; delivered/read arrive later from the status webhook, which finds the row through message_id.
-- A failure of the Inbox write never blocks a confirmation (the provider already has the message): it is
-- recorded as an 'error' event and repaired by reconcile_versioned_effect_messages.
CREATE TABLE public.flow_run_effect_messages (
  effect_id UUID PRIMARY KEY REFERENCES public.flow_run_effects(id) ON DELETE CASCADE,
  account_id UUID NOT NULL,
  flow_run_id UUID NOT NULL,
  message_id UUID NOT NULL UNIQUE REFERENCES public.messages(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL,
  provider_message_id TEXT NOT NULL CHECK (length(provider_message_id) BETWEEN 1 AND 200),
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  attempt_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT flow_run_effect_messages_run_same_account_fkey FOREIGN KEY (flow_run_id, account_id)
    REFERENCES public.flow_runs (id, account_id) ON DELETE CASCADE
);
CREATE INDEX flow_run_effect_messages_run_idx ON public.flow_run_effect_messages (flow_run_id);
ALTER TABLE public.flow_run_effect_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.flow_run_effect_messages FROM PUBLIC;
REVOKE ALL ON TABLE public.flow_run_effect_messages FROM anon, authenticated;
GRANT ALL ON TABLE public.flow_run_effect_messages TO service_role;

-- Creates (at most once) the Inbox message of a confirmed effect and returns its id; NULL when the effect has no
-- conversation or the conversation does not belong to the effect's account/contact. Idempotent.
CREATE FUNCTION public.persist_versioned_effect_message(p_effect_id UUID)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  e public.flow_run_effects%ROWTYPE; v_existing UUID; v_conv public.conversations%ROWTYPE; v_msg UUID;
  v_type TEXT; v_text TEXT; v_media TEXT; v_preview TEXT;
BEGIN
  SELECT * INTO e FROM public.flow_run_effects x WHERE x.id = p_effect_id AND x.state = 'confirmed';
  IF NOT FOUND OR e.conversation_id IS NULL OR e.provider_message_id IS NULL THEN RETURN NULL; END IF;
  SELECT m.message_id INTO v_existing FROM public.flow_run_effect_messages m WHERE m.effect_id = e.id;
  IF FOUND THEN RETURN v_existing; END IF;
  SELECT * INTO v_conv FROM public.conversations c
   WHERE c.id = e.conversation_id AND c.account_id = e.account_id AND (e.contact_id IS NULL OR c.contact_id = e.contact_id);
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF e.request->>'kind' = 'text' THEN
    v_type := 'text'; v_text := e.request->>'text'; v_media := NULL; v_preview := v_text;
  ELSIF e.request->>'kind' = 'media' AND e.request->>'media_type' IN ('image', 'video', 'document') THEN
    v_type := e.request->>'media_type'; v_text := e.request->>'caption'; v_media := e.request->>'media_url';
    v_preview := COALESCE(NULLIF(btrim(COALESCE(v_text, '')), ''), '[' || v_type || ']');
  ELSE
    RETURN NULL;
  END IF;

  -- (conversation_id, message_id) is UNIQUE on messages: a wamid that is already stored there is linked, not duplicated
  INSERT INTO public.messages (conversation_id, sender_type, content_type, content_text, media_url, message_id, status)
  VALUES (e.conversation_id, 'bot', v_type, v_text, v_media, e.provider_message_id, 'sent')
  ON CONFLICT (conversation_id, message_id) DO NOTHING RETURNING id INTO v_msg;
  IF v_msg IS NULL THEN
    SELECT m.id INTO v_msg FROM public.messages m WHERE m.conversation_id = e.conversation_id AND m.message_id = e.provider_message_id;
  ELSE
    UPDATE public.conversations c SET last_message_text = v_preview, last_message_at = clock_timestamp(), updated_at = clock_timestamp() WHERE c.id = e.conversation_id;
  END IF;
  INSERT INTO public.flow_run_effect_messages (effect_id, account_id, flow_run_id, message_id, conversation_id, provider_message_id, attempt, attempt_id)
  VALUES (e.id, e.account_id, e.flow_run_id, v_msg, e.conversation_id, e.provider_message_id, e.attempt, e.attempt_id);
  RETURN v_msg;
END;
$$;
REVOKE ALL ON FUNCTION public.persist_versioned_effect_message(UUID) FROM PUBLIC, anon, authenticated;

-- Never lets an Inbox problem undo a confirmation: failures become an 'error' event and are repaired by reconcile.
CREATE FUNCTION public.try_persist_versioned_effect_message(p_effect_id UUID)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_id UUID; e public.flow_run_effects%ROWTYPE;
BEGIN
  BEGIN
    v_id := public.persist_versioned_effect_message(p_effect_id);
    RETURN v_id;
  EXCEPTION WHEN OTHERS THEN
    SELECT * INTO e FROM public.flow_run_effects x WHERE x.id = p_effect_id;
    IF FOUND THEN
      INSERT INTO public.flow_run_events (flow_run_id, event_type, node_key, payload)
      VALUES (e.flow_run_id, 'error', e.node_key, jsonb_build_object('reason', 'inbox_persist_failed', 'effect_id', e.id, 'sqlstate', SQLSTATE));
    END IF;
    RETURN NULL;
  END;
END;
$$;
REVOKE ALL ON FUNCTION public.try_persist_versioned_effect_message(UUID) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.persist_message_on_effect_confirmed()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  PERFORM public.try_persist_versioned_effect_message(NEW.id);
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.persist_message_on_effect_confirmed() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER flow_run_effects_persist_message
  AFTER UPDATE OF state ON public.flow_run_effects
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM 'confirmed' AND NEW.state = 'confirmed')
  EXECUTE FUNCTION public.persist_message_on_effect_confirmed();

-- Repair: for the lease holder, create the Inbox message of every confirmed effect of the run that has none.
CREATE FUNCTION public.reconcile_versioned_effect_messages(p_account_id UUID, p_run_id UUID, p_owner TEXT, p_fencing_token INTEGER)
RETURNS TABLE (effect_id UUID, message_id UUID, outcome TEXT, reason TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_run public.flow_runs%ROWTYPE; v_gate TEXT; r public.flow_run_effects%ROWTYPE; v_had BOOLEAN; v_id UUID;
BEGIN
  IF p_owner IS NULL OR length(p_owner) NOT BETWEEN 1 AND 200 OR p_fencing_token IS NULL THEN
    RAISE EXCEPTION 'invalid versioned effect request' USING ERRCODE = '22023';
  END IF;
  v_run := public.lock_versioned_run(p_account_id, p_run_id);
  v_gate := public.versioned_run_gate(v_run, p_owner, p_fencing_token);
  IF v_gate IS NOT NULL THEN RETURN QUERY SELECT NULL::uuid, NULL::uuid, NULL::text, v_gate; RETURN; END IF;
  FOR r IN SELECT * FROM public.flow_run_effects x WHERE x.flow_run_id = v_run.id AND x.state = 'confirmed' ORDER BY x.occurrence_revision LOOP
    v_had := EXISTS (SELECT 1 FROM public.flow_run_effect_messages m WHERE m.effect_id = r.id);
    v_id := public.try_persist_versioned_effect_message(r.id);
    RETURN QUERY SELECT r.id, v_id, CASE WHEN v_had THEN 'already_persisted' WHEN v_id IS NULL THEN 'skipped' ELSE 'created' END, NULL::text;
  END LOOP;
END;
$$;

-- settle / resolve: a provider message id that already belongs to another effect is refused WITHOUT touching state.
CREATE OR REPLACE FUNCTION public.settle_versioned_effect(
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
  BEGIN
    UPDATE public.flow_run_effects e SET state = p_outcome, provider_message_id = p_provider_message_id, error_code = p_error_code, updated_at = clock_timestamp(),
        finished_at = CASE WHEN p_outcome = 'ambiguous' THEN NULL ELSE clock_timestamp() END
      WHERE e.id = v_eff.id RETURNING * INTO v_eff;
  EXCEPTION WHEN unique_violation THEN
    -- the provider message id already belongs to another effect: never overwrite, never lose the attempt
    IF SQLERRM NOT LIKE '%flow_run_effects_provider_message_key%' THEN RAISE; END IF;
    RETURN QUERY SELECT false, 'claimed'::text, 'provider_message_conflict'; RETURN;
  END;
  v_event := CASE p_outcome WHEN 'confirmed' THEN 'effect_confirmed' WHEN 'failed' THEN 'effect_failed' ELSE 'effect_ambiguous' END;
  INSERT INTO public.flow_run_events (flow_run_id, event_type, node_key, payload)
  VALUES (v_run.id, v_event, v_eff.node_key, jsonb_build_object('effect_id', v_eff.id, 'effect_type', v_eff.effect_type,
    'occurrence_revision', v_eff.occurrence_revision, 'attempt', v_eff.attempt, 'attempt_id', v_eff.attempt_id,
    'provider_message_id', v_eff.provider_message_id, 'error_code', v_eff.error_code));
  RETURN QUERY SELECT true, v_eff.state, NULL::text;
END;
$$;

CREATE OR REPLACE FUNCTION public.resolve_versioned_effect(
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
  BEGIN
UPDATE public.flow_run_effects e SET state = v_new, provider_message_id = p_provider_message_id, resolution_evidence = btrim(p_evidence), updated_at = clock_timestamp(),
        finished_at = CASE WHEN v_new = 'pending' THEN NULL ELSE clock_timestamp() END,
        attempt_id = CASE WHEN v_new = 'pending' THEN NULL ELSE e.attempt_id END,
        claimed_owner = CASE WHEN v_new = 'pending' THEN NULL ELSE e.claimed_owner END,
        claimed_fencing_token = CASE WHEN v_new = 'pending' THEN NULL ELSE e.claimed_fencing_token END,
        claimed_at = CASE WHEN v_new = 'pending' THEN NULL ELSE e.claimed_at END
      WHERE e.id = v_eff.id RETURNING * INTO v_eff;
  EXCEPTION WHEN unique_violation THEN
    IF SQLERRM NOT LIKE '%flow_run_effects_provider_message_key%' THEN RAISE; END IF;
    RETURN QUERY SELECT false, 'ambiguous'::text, 'provider_message_conflict'; RETURN;
  END;
  INSERT INTO public.flow_run_events (flow_run_id, event_type, node_key, payload)
  VALUES (v_run.id, 'effect_resolved', v_eff.node_key, jsonb_build_object('effect_id', v_eff.id, 'effect_type', v_eff.effect_type,
    'occurrence_revision', v_eff.occurrence_revision, 'attempt', v_eff.attempt, 'resolution', p_resolution, 'provider_message_id', v_eff.provider_message_id));
  RETURN QUERY SELECT true, v_eff.state, NULL::text;
END;
$$;


DO $$
DECLARE f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.reconcile_versioned_effect_messages(UUID,UUID,TEXT,INTEGER)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $$;
