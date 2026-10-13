-- E4.2 PR #30 audit round 2: a late Inbox repair must respect time.
--
-- Policy (persisted data only): the Inbox message takes the effect's confirmation time (flow_run_effects.finished_at,
-- NOT NULL for a confirmed effect) as its created_at, so it sorts where the send really happened. The conversation
-- preview and last_message_at move only when that time is STRICTLY newer than the conversation's last_message_at,
-- so repairing A after B (or after a customer message) leaves B's preview and ordering untouched.
-- Idempotency (link PK, UNIQUE (conversation_id, message_id)), account/contact validation and the fact that nothing
-- here touches the run or sends anything are unchanged from 060.

CREATE OR REPLACE FUNCTION public.persist_versioned_effect_message(p_effect_id UUID)
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
  INSERT INTO public.messages (conversation_id, sender_type, content_type, content_text, media_url, message_id, status, created_at)
  VALUES (e.conversation_id, 'bot', v_type, v_text, v_media, e.provider_message_id, 'sent', e.finished_at)
  ON CONFLICT (conversation_id, message_id) DO NOTHING RETURNING id INTO v_msg;
  IF v_msg IS NULL THEN
    SELECT m.id INTO v_msg FROM public.messages m WHERE m.conversation_id = e.conversation_id AND m.message_id = e.provider_message_id;
  ELSE
    -- the preview only moves forward in time: a late repair of an older confirmation must not replace a newer message.
    -- The guard runs inside the UPDATE, so two concurrent repairs on one conversation serialise on its row lock and
    -- the re-evaluated condition keeps the newest preview whatever the order. A tie keeps the existing preview.
    UPDATE public.conversations c SET last_message_text = v_preview, last_message_at = e.finished_at, updated_at = clock_timestamp()
     WHERE c.id = e.conversation_id AND (c.last_message_at IS NULL OR c.last_message_at < e.finished_at);
  END IF;
  INSERT INTO public.flow_run_effect_messages (effect_id, account_id, flow_run_id, message_id, conversation_id, provider_message_id, attempt, attempt_id)
  VALUES (e.id, e.account_id, e.flow_run_id, v_msg, e.conversation_id, e.provider_message_id, e.attempt, e.attempt_id);
  RETURN v_msg;
END;
$$;
REVOKE ALL ON FUNCTION public.persist_versioned_effect_message(UUID) FROM PUBLIC, anon, authenticated;
