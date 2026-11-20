-- CALL-03A: durable conversation linkage, agent attribution and renewable inbound-call leases.
-- Additive only. CALL-02 event ingestion and its existing RPC contracts remain unchanged.
-- All new metadata is private to service_role; SDP and media are not added here.

ALTER TABLE public.whatsapp_call_sessions
  ADD COLUMN IF NOT EXISTS contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS conversation_id uuid REFERENCES public.conversations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS initiated_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS accepted_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rejected_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ended_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS biz_opaque_callback_data text
    CHECK (biz_opaque_callback_data IS NULL OR length(biz_opaque_callback_data) BETWEEN 1 AND 512);

CREATE INDEX IF NOT EXISTS whatsapp_call_sessions_account_conversation_recent_idx
  ON public.whatsapp_call_sessions(account_id, conversation_id, created_at DESC)
  WHERE conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS whatsapp_call_sessions_account_contact_recent_idx
  ON public.whatsapp_call_sessions(account_id, contact_id, created_at DESC)
  WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS whatsapp_call_sessions_account_initiator_recent_idx
  ON public.whatsapp_call_sessions(account_id, initiated_by_user_id, created_at DESC)
  WHERE initiated_by_user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_call_sessions_callback_data_uq
  ON public.whatsapp_call_sessions(phone_number_id, biz_opaque_callback_data)
  WHERE biz_opaque_callback_data IS NOT NULL;

-- A call may be linked only to a conversation/contact in the same tenant,
-- and only when at least one persisted WhatsApp identity matches the call.
-- This is enforced in the database as well as in the authenticated API.
CREATE OR REPLACE FUNCTION public.whatsapp_call_session_metadata_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public
AS $$
DECLARE
  v_contact_account_id uuid;
  v_contact_phone text;
  v_conversation_contact_id uuid;
  v_identity_match boolean := false;
  v_link_changed boolean := TG_OP = 'INSERT';
BEGIN
  IF TG_OP = 'UPDATE' THEN
    v_link_changed :=
      NEW.contact_id IS DISTINCT FROM OLD.contact_id
      OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id;
  END IF;

  IF NEW.contact_id IS NOT NULL THEN
    SELECT c.account_id, regexp_replace(COALESCE(c.phone,''), '\D', '', 'g')
      INTO v_contact_account_id, v_contact_phone
    FROM public.contacts c
    WHERE c.id=NEW.contact_id;

    IF NOT FOUND OR v_contact_account_id IS DISTINCT FROM NEW.account_id THEN
      RAISE EXCEPTION 'call_contact_tenant_conflict' USING ERRCODE='42501';
    END IF;
  END IF;

  IF NEW.conversation_id IS NOT NULL THEN
    SELECT c.contact_id
      INTO v_conversation_contact_id
    FROM public.conversations c
    WHERE c.id=NEW.conversation_id
      AND c.account_id=NEW.account_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'call_conversation_tenant_conflict' USING ERRCODE='42501';
    END IF;

    IF NEW.contact_id IS NOT NULL
      AND NEW.contact_id IS DISTINCT FROM v_conversation_contact_id THEN
      RAISE EXCEPTION 'call_conversation_contact_conflict' USING ERRCODE='42501';
    END IF;

    NEW.contact_id := v_conversation_contact_id;
  END IF;

  -- Do not re-check identity on unrelated webhook state updates. Check it
  -- whenever a new contact/conversation association is established.
  IF v_link_changed AND NEW.contact_id IS NOT NULL THEN
    SELECT regexp_replace(COALESCE(c.phone,''), '\D', '', 'g')
      INTO v_contact_phone
    FROM public.contacts c
    WHERE c.id=NEW.contact_id
      AND c.account_id=NEW.account_id;

    IF NEW.customer_phone IS NOT NULL
      AND NEW.customer_phone <> ''
      AND v_contact_phone = regexp_replace(NEW.customer_phone, '\D', '', 'g') THEN
      v_identity_match := true;
    END IF;

    IF NOT v_identity_match AND NEW.customer_bsuid IS NOT NULL THEN
      SELECT EXISTS (
        SELECT 1 FROM public.contact_identities i
        WHERE i.account_id=NEW.account_id
          AND i.contact_id=NEW.contact_id
          AND i.kind='bsuid'
          AND i.value=NEW.customer_bsuid
      ) INTO v_identity_match;
    END IF;

    IF NOT v_identity_match AND NEW.customer_parent_bsuid IS NOT NULL THEN
      SELECT EXISTS (
        SELECT 1 FROM public.contact_identities i
        WHERE i.account_id=NEW.account_id
          AND i.contact_id=NEW.contact_id
          AND i.kind='parent_bsuid'
          AND i.value=NEW.customer_parent_bsuid
      ) INTO v_identity_match;
    END IF;

    IF NOT v_identity_match THEN
      RAISE EXCEPTION 'call_contact_identity_mismatch' USING ERRCODE='42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS whatsapp_call_session_metadata_guard
  ON public.whatsapp_call_sessions;
CREATE TRIGGER whatsapp_call_session_metadata_guard
  BEFORE INSERT OR UPDATE OF account_id, contact_id, conversation_id,
    customer_phone, customer_bsuid, customer_parent_bsuid
  ON public.whatsapp_call_sessions
  FOR EACH ROW
  EXECUTE FUNCTION public.whatsapp_call_session_metadata_guard();

-- Preserve CALL-02's atomic claim contract while preventing another
-- agent from claiming a call after reject/terminate has been requested.
CREATE OR REPLACE FUNCTION public.whatsapp_call_claim(
  p_account_id uuid,
  p_phone_number_id text,
  p_call_id text,
  p_actor_user_id uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=public
AS $
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE account_id=p_account_id
      AND user_id=p_actor_user_id
      AND account_role IN ('owner','admin','agent')
  ) THEN
    RAISE EXCEPTION 'call_claim_actor_forbidden' USING ERRCODE='42501';
  END IF;

  UPDATE public.whatsapp_call_sessions
  SET claimed_by_user_id=p_actor_user_id,
      claimed_at=now(),
      claim_expires_at=now()+interval '90 seconds',
      updated_at=now()
  WHERE account_id=p_account_id
    AND phone_number_id=p_phone_number_id
    AND call_id=p_call_id
    AND direction='USER_INITIATED'
    AND state IN ('offered','ringing','connected')
    AND rejected_by_user_id IS NULL
    AND ended_by_user_id IS NULL
    AND (
      claimed_by_user_id IS NULL
      OR claim_expires_at <= now()
      OR claimed_by_user_id=p_actor_user_id
    );

  RETURN FOUND;
END;
$;

-- Keep a claimed inbound call owned by the same agent while WebRTC is
-- connecting/connected. A lease cannot be resurrected after it expires.
CREATE OR REPLACE FUNCTION public.whatsapp_call_claim_renew(
  p_account_id uuid,
  p_phone_number_id text,
  p_call_id text,
  p_actor_user_id uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE account_id=p_account_id
      AND user_id=p_actor_user_id
      AND account_role IN ('owner','admin','agent')
  ) THEN
    RAISE EXCEPTION 'call_claim_actor_forbidden' USING ERRCODE='42501';
  END IF;

  UPDATE public.whatsapp_call_sessions
  SET claim_expires_at=now()+interval '90 seconds',
      updated_at=now()
  WHERE account_id=p_account_id
    AND phone_number_id=p_phone_number_id
    AND call_id=p_call_id
    AND claimed_by_user_id=p_actor_user_id
    AND claim_expires_at > now()
    AND state IN ('offered','ringing','connected')
    AND rejected_by_user_id IS NULL
    AND ended_by_user_id IS NULL;

  RETURN FOUND;
END;
$;

-- Record the human actor and optional Inbox conversation for a call.
-- Meta remains authoritative for call state; this RPC records agent intent
-- only. Accept requires the active atomic claim; reject is allowed only when
-- no other agent holds it; terminate requires ownership or owner/admin role.
CREATE OR REPLACE FUNCTION public.whatsapp_call_session_agent_action(
  p_account_id uuid,
  p_phone_number_id text,
  p_call_id text,
  p_actor_user_id uuid,
  p_action text,
  p_conversation_id uuid DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=public
AS $$
DECLARE
  v_role public.account_role_enum;
  v_call public.whatsapp_call_sessions%ROWTYPE;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('initiated','accepted','rejected','ended') THEN
    RAISE EXCEPTION 'invalid_call_agent_action' USING ERRCODE='22023';
  END IF;

  SELECT p.account_role INTO v_role
  FROM public.profiles p
  WHERE p.account_id=p_account_id
    AND p.user_id=p_actor_user_id;

  IF v_role IS NULL OR v_role NOT IN ('owner','admin','agent') THEN
    RAISE EXCEPTION 'call_agent_action_forbidden' USING ERRCODE='42501';
  END IF;

  SELECT * INTO v_call
  FROM public.whatsapp_call_sessions s
  WHERE s.account_id=p_account_id
    AND s.phone_number_id=p_phone_number_id
    AND s.call_id=p_call_id
  FOR UPDATE;

  IF NOT FOUND THEN RETURN false; END IF;

  IF p_conversation_id IS NOT NULL
    AND v_call.conversation_id IS NOT NULL
    AND v_call.conversation_id IS DISTINCT FROM p_conversation_id THEN
    RAISE EXCEPTION 'call_conversation_already_linked' USING ERRCODE='42501';
  END IF;

  CASE p_action
    WHEN 'initiated' THEN
      IF v_call.direction IS DISTINCT FROM 'BUSINESS_INITIATED' THEN
        RAISE EXCEPTION 'call_initiator_direction_invalid' USING ERRCODE='22023';
      END IF;
      IF v_call.state IN ('terminated','failed','rejected')
        OR (v_call.initiated_by_user_id IS NOT NULL
          AND v_call.initiated_by_user_id IS DISTINCT FROM p_actor_user_id) THEN
        RETURN false;
      END IF;

    WHEN 'accepted' THEN
      IF v_call.direction IS DISTINCT FROM 'USER_INITIATED' THEN
        RAISE EXCEPTION 'call_accept_direction_invalid' USING ERRCODE='22023';
      END IF;
      IF v_call.state IN ('terminated','failed','rejected')
        OR v_call.rejected_by_user_id IS NOT NULL
        OR v_call.ended_by_user_id IS NOT NULL THEN
        RETURN false;
      END IF;
      IF v_call.accepted_by_user_id IS DISTINCT FROM p_actor_user_id
        AND NOT COALESCE(
          v_call.claimed_by_user_id=p_actor_user_id
          AND v_call.claim_expires_at > now(),
          false
        ) THEN
        RETURN false;
      END IF;

    WHEN 'rejected' THEN
      IF v_call.direction IS DISTINCT FROM 'USER_INITIATED' THEN
        RAISE EXCEPTION 'call_reject_direction_invalid' USING ERRCODE='22023';
      END IF;
      IF v_call.ended_by_user_id IS NOT NULL THEN RETURN false; END IF;
      IF v_call.rejected_by_user_id IS DISTINCT FROM p_actor_user_id
        AND (
          v_call.state NOT IN ('offered','ringing')
          OR (
            v_call.claimed_by_user_id IS NOT NULL
            AND v_call.claim_expires_at > now()
            AND v_call.claimed_by_user_id IS DISTINCT FROM p_actor_user_id
          )
          OR (
            v_call.rejected_by_user_id IS NOT NULL
            AND v_call.rejected_by_user_id IS DISTINCT FROM p_actor_user_id
          )
        ) THEN
        RETURN false;
      END IF;

    WHEN 'ended' THEN
      IF v_call.rejected_by_user_id IS NOT NULL
        AND v_call.ended_by_user_id IS DISTINCT FROM p_actor_user_id THEN
        RETURN false;
      END IF;
      IF v_call.ended_by_user_id IS DISTINCT FROM p_actor_user_id
        AND (
          v_call.state IN ('terminated','failed','rejected')
          OR NOT (
            COALESCE(v_call.initiated_by_user_id=p_actor_user_id,false)
            OR COALESCE(v_call.accepted_by_user_id=p_actor_user_id,false)
            OR COALESCE(v_call.claimed_by_user_id=p_actor_user_id,false)
            OR v_role IN ('owner','admin')
          )
        ) THEN
        RETURN false;
      END IF;
  END CASE;

  UPDATE public.whatsapp_call_sessions
  SET conversation_id=COALESCE(conversation_id,p_conversation_id),
      initiated_by_user_id=CASE
        WHEN p_action='initiated' THEN COALESCE(initiated_by_user_id,p_actor_user_id)
        ELSE initiated_by_user_id END,
      accepted_by_user_id=CASE
        WHEN p_action='accepted' THEN COALESCE(accepted_by_user_id,p_actor_user_id)
        ELSE accepted_by_user_id END,
      rejected_by_user_id=CASE
        WHEN p_action='rejected' THEN COALESCE(rejected_by_user_id,p_actor_user_id)
        ELSE rejected_by_user_id END,
      ended_by_user_id=CASE
        WHEN p_action='ended' THEN COALESCE(ended_by_user_id,p_actor_user_id)
        ELSE ended_by_user_id END,
      updated_at=now()
  WHERE id=v_call.id;

  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.whatsapp_call_session_metadata_guard()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.whatsapp_call_claim_renew(uuid,text,text,uuid),
  public.whatsapp_call_session_agent_action(uuid,text,text,uuid,text,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.whatsapp_call_claim_renew(uuid,text,text,uuid),
  public.whatsapp_call_session_agent_action(uuid,text,text,uuid,text,uuid)
  TO service_role;
