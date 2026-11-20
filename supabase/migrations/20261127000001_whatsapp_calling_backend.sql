-- ============================================================
-- 20261127000001_whatsapp_calling_backend
--
-- CALL-02: durable Calling sessions, explicit call permissions,
-- permission-request audit, and atomic agent claim leases.
--
-- Additive only. All new tables are service-role-only because call
-- signaling includes short-lived encrypted SDP material and customer
-- identifiers. Dashboard routes authenticate the member, resolve the
-- account_id, and explicitly scope every service-role query.
-- ============================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Two-key fail-closed feature gate. Existing and future numbers default OFF.
ALTER TABLE public.whatsapp_config
  ADD COLUMN IF NOT EXISTS calling_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.whatsapp_call_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  phone_number_id text NOT NULL CHECK (phone_number_id ~ '^[0-9]{5,25}$'),
  call_id text NOT NULL CHECK (call_id ~ '^wacid\.[A-Za-z0-9._~+/=-]{1,512}$'),
  contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  conversation_id uuid REFERENCES public.conversations(id) ON DELETE SET NULL,
  contact_phone text CHECK (contact_phone IS NULL OR length(contact_phone) <= 32),
  contact_user_id text CHECK (contact_user_id IS NULL OR length(contact_user_id) <= 200),
  direction text CHECK (direction IS NULL OR direction IN ('USER_INITIATED', 'BUSINESS_INITIATED')),
  state text NOT NULL DEFAULT 'unknown'
    CHECK (state IN ('ringing', 'connecting', 'accepted', 'rejected', 'terminated', 'missed', 'failed', 'unknown')),
  last_event text NOT NULL CHECK (length(last_event) BETWEEN 1 AND 64),
  last_event_status text CHECK (last_event_status IS NULL OR length(last_event_status) <= 64),
  last_event_at timestamptz NOT NULL,
  started_at timestamptz,
  ended_at timestamptz,
  duration_seconds integer CHECK (duration_seconds IS NULL OR duration_seconds BETWEEN 0 AND 86400),
  session_sdp_type text CHECK (session_sdp_type IS NULL OR session_sdp_type IN ('offer', 'answer')),
  session_sdp_ciphertext text CHECK (
    session_sdp_ciphertext IS NULL OR
    (length(session_sdp_ciphertext) <= 131072 AND session_sdp_ciphertext ~ '^[0-9a-f]{24}:[0-9a-f]+:[0-9a-f]{32}$')
  ),
  session_sdp_expires_at timestamptz,
  claimed_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  claim_token uuid,
  claim_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT whatsapp_call_sessions_phone_call_unique UNIQUE (phone_number_id, call_id),
  CONSTRAINT whatsapp_call_sessions_claim_consistency CHECK (
    (claim_token IS NULL AND claimed_by_user_id IS NULL AND claim_expires_at IS NULL)
    OR
    (claim_token IS NOT NULL AND claimed_by_user_id IS NOT NULL AND claim_expires_at IS NOT NULL)
  ),
  CONSTRAINT whatsapp_call_sessions_sdp_consistency CHECK (
    (session_sdp_type IS NULL AND session_sdp_ciphertext IS NULL AND session_sdp_expires_at IS NULL)
    OR
    (session_sdp_type IS NOT NULL AND session_sdp_ciphertext IS NOT NULL AND session_sdp_expires_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS whatsapp_call_sessions_account_state_idx
  ON public.whatsapp_call_sessions (account_id, state, last_event_at DESC);
CREATE INDEX IF NOT EXISTS whatsapp_call_sessions_contact_idx
  ON public.whatsapp_call_sessions (account_id, contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS whatsapp_call_sessions_sdp_expiry_idx
  ON public.whatsapp_call_sessions (session_sdp_expires_at)
  WHERE session_sdp_ciphertext IS NOT NULL;
CREATE INDEX IF NOT EXISTS whatsapp_call_sessions_claim_expiry_idx
  ON public.whatsapp_call_sessions (claim_expires_at)
  WHERE claim_token IS NOT NULL;

ALTER TABLE public.whatsapp_call_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.whatsapp_call_sessions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_call_sessions TO service_role;

CREATE TABLE IF NOT EXISTS public.whatsapp_call_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  phone_number_id text NOT NULL CHECK (phone_number_id ~ '^[0-9]{5,25}$'),
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('no_permission', 'temporary', 'permanent')),
  expiration_time bigint CHECK (expiration_time IS NULL OR expiration_time > 0),
  response_source text CHECK (response_source IS NULL OR response_source IN ('user_action', 'automatic')),
  last_message_id text CHECK (last_message_id IS NULL OR length(last_message_id) <= 512),
  context_id text CHECK (context_id IS NULL OR length(context_id) <= 512),
  last_checked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT whatsapp_call_permissions_phone_contact_unique UNIQUE (phone_number_id, contact_id),
  CONSTRAINT whatsapp_call_permissions_expiry_consistency CHECK (
    (status = 'temporary' AND expiration_time IS NOT NULL)
    OR (status IN ('no_permission', 'permanent') AND expiration_time IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS whatsapp_call_permissions_account_contact_idx
  ON public.whatsapp_call_permissions (account_id, contact_id);

ALTER TABLE public.whatsapp_call_permissions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.whatsapp_call_permissions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_call_permissions TO service_role;

CREATE TABLE IF NOT EXISTS public.whatsapp_call_permission_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  phone_number_id text NOT NULL CHECK (phone_number_id ~ '^[0-9]{5,25}$'),
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  request_message_id text NOT NULL CHECK (length(request_message_id) BETWEEN 1 AND 512),
  requested_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'expired')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  response_source text CHECK (response_source IS NULL OR response_source IN ('user_action', 'automatic')),
  CONSTRAINT whatsapp_call_permission_requests_message_unique UNIQUE (phone_number_id, request_message_id)
);

CREATE INDEX IF NOT EXISTS whatsapp_call_permission_requests_contact_idx
  ON public.whatsapp_call_permission_requests (account_id, contact_id, requested_at DESC);

ALTER TABLE public.whatsapp_call_permission_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.whatsapp_call_permission_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_call_permission_requests TO service_role;

-- Persist one Meta call event. A per-call advisory lock makes first creation
-- and state advancement race-safe. Older/duplicate events never regress a
-- terminal state. Plaintext SDP is never accepted by this function.
CREATE OR REPLACE FUNCTION public.upsert_whatsapp_call_session_event(
  p_account_id uuid,
  p_phone_number_id text,
  p_call_id text,
  p_contact_id uuid,
  p_conversation_id uuid,
  p_contact_phone text,
  p_contact_user_id text,
  p_direction text,
  p_event text,
  p_status text,
  p_event_at timestamptz,
  p_start_time timestamptz DEFAULT NULL,
  p_end_time timestamptz DEFAULT NULL,
  p_duration_seconds integer DEFAULT NULL,
  p_sdp_type text DEFAULT NULL,
  p_sdp_ciphertext text DEFAULT NULL,
  p_sdp_expires_at timestamptz DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_current public.whatsapp_call_sessions%ROWTYPE;
  v_next_state text;
  v_terminal boolean;
BEGIN
  IF p_account_id IS NULL
     OR p_phone_number_id IS NULL OR p_phone_number_id !~ '^[0-9]{5,25}$'
     OR p_call_id IS NULL OR p_call_id !~ '^wacid\.[A-Za-z0-9._~+/=-]{1,512}$'
     OR p_event IS NULL OR p_event NOT IN ('connect', 'pre_accept', 'accept', 'reject', 'terminate', 'status')
     OR p_event_at IS NULL
  THEN
    RAISE EXCEPTION 'invalid_call_event' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.whatsapp_config wc
    WHERE wc.account_id = p_account_id AND wc.phone_number_id = p_phone_number_id
  ) THEN
    RAISE EXCEPTION 'call_number_account_mismatch' USING ERRCODE = '42501';
  END IF;

  IF p_contact_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.contacts c
    WHERE c.id = p_contact_id AND c.account_id = p_account_id
  ) THEN
    RAISE EXCEPTION 'call_contact_account_mismatch' USING ERRCODE = '42501';
  END IF;

  IF p_conversation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.conversations cv
    WHERE cv.id = p_conversation_id
      AND cv.account_id = p_account_id
      AND (p_contact_id IS NULL OR cv.contact_id = p_contact_id)
  ) THEN
    RAISE EXCEPTION 'call_conversation_account_mismatch' USING ERRCODE = '42501';
  END IF;

  IF p_direction IS NOT NULL AND p_direction NOT IN ('USER_INITIATED', 'BUSINESS_INITIATED') THEN
    RAISE EXCEPTION 'invalid_call_direction' USING ERRCODE = '22023';
  END IF;

  IF p_sdp_ciphertext IS NOT NULL
     AND (p_sdp_type IS NULL OR p_sdp_type NOT IN ('offer', 'answer')
       OR length(p_sdp_ciphertext) > 131072
       OR p_sdp_ciphertext !~ '^[0-9a-f]{24}:[0-9a-f]+:[0-9a-f]{32}$'
       OR p_sdp_expires_at IS NULL OR p_sdp_expires_at <= now())
  THEN
    RAISE EXCEPTION 'invalid_call_sdp_ciphertext' USING ERRCODE = '22023';
  END IF;

  v_next_state := CASE
    WHEN upper(COALESCE(p_status, '')) IN ('FAILED', 'ERROR') THEN 'failed'
    WHEN upper(COALESCE(p_status, '')) = 'MISSED' THEN 'missed'
    WHEN p_event = 'reject' OR upper(COALESCE(p_status, '')) = 'REJECTED' THEN 'rejected'
    WHEN p_event = 'terminate' OR upper(COALESCE(p_status, '')) IN ('COMPLETED', 'TERMINATED') THEN 'terminated'
    WHEN p_event = 'accept' OR upper(COALESCE(p_status, '')) IN ('ACCEPTED', 'CONNECTED') THEN 'accepted'
    WHEN p_event = 'pre_accept' OR upper(COALESCE(p_status, '')) = 'CONNECTING' THEN 'connecting'
    WHEN upper(COALESCE(p_status, '')) = 'RINGING' THEN 'ringing'
    WHEN p_event = 'connect' AND p_direction = 'USER_INITIATED' THEN 'ringing'
    WHEN p_event = 'connect' AND p_direction = 'BUSINESS_INITIATED' THEN 'connecting'
    ELSE 'unknown'
  END;
  v_terminal := v_next_state IN ('rejected', 'terminated', 'missed', 'failed');

  PERFORM pg_advisory_xact_lock(hashtextextended(p_phone_number_id || ':' || p_call_id, 0));

  SELECT * INTO v_current
  FROM public.whatsapp_call_sessions s
  WHERE s.phone_number_id = p_phone_number_id AND s.call_id = p_call_id
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.whatsapp_call_sessions (
      account_id, phone_number_id, call_id, contact_id, conversation_id,
      contact_phone, contact_user_id, direction, state, last_event,
      last_event_status, last_event_at, started_at, ended_at,
      duration_seconds, session_sdp_type, session_sdp_ciphertext, session_sdp_expires_at
    ) VALUES (
      p_account_id, p_phone_number_id, p_call_id, p_contact_id, p_conversation_id,
      p_contact_phone, p_contact_user_id, p_direction, v_next_state, p_event,
      p_status, p_event_at, COALESCE(p_start_time, CASE WHEN v_next_state = 'accepted' THEN p_event_at END),
      COALESCE(p_end_time, CASE WHEN v_terminal THEN p_event_at END),
      p_duration_seconds,
      CASE WHEN v_terminal THEN NULL ELSE p_sdp_type END,
      CASE WHEN v_terminal THEN NULL ELSE p_sdp_ciphertext END,
      CASE WHEN v_terminal THEN NULL ELSE p_sdp_expires_at END
    )
    RETURNING id INTO v_id;
    RETURN v_id;
  END IF;

  v_id := v_current.id;
  IF v_current.account_id <> p_account_id THEN
    RAISE EXCEPTION 'call_session_account_mismatch' USING ERRCODE = '42501';
  END IF;

  IF p_event_at < v_current.last_event_at THEN
    RETURN v_id;
  END IF;
  IF v_current.state IN ('rejected', 'terminated', 'missed', 'failed') THEN
    RETURN v_id;
  END IF;
  IF v_current.state = 'accepted' AND v_next_state IN ('ringing', 'connecting') THEN
    v_next_state := v_current.state;
  ELSIF v_current.state = 'connecting' AND v_next_state = 'ringing' THEN
    v_next_state := v_current.state;
  END IF;

  UPDATE public.whatsapp_call_sessions
  SET contact_id = COALESCE(p_contact_id, contact_id),
      conversation_id = COALESCE(p_conversation_id, conversation_id),
      contact_phone = COALESCE(p_contact_phone, contact_phone),
      contact_user_id = COALESCE(p_contact_user_id, contact_user_id),
      direction = COALESCE(p_direction, direction),
      state = CASE WHEN v_next_state = 'unknown' THEN state ELSE v_next_state END,
      last_event = p_event,
      last_event_status = p_status,
      last_event_at = p_event_at,
      started_at = COALESCE(started_at, p_start_time, CASE WHEN v_next_state = 'accepted' THEN p_event_at END),
      ended_at = COALESCE(p_end_time, CASE WHEN v_terminal THEN p_event_at END, ended_at),
      duration_seconds = COALESCE(p_duration_seconds, duration_seconds),
      session_sdp_type = CASE
        WHEN v_terminal THEN NULL
        WHEN p_sdp_ciphertext IS NOT NULL THEN p_sdp_type
        WHEN session_sdp_expires_at IS NOT NULL AND session_sdp_expires_at <= now() THEN NULL
        ELSE session_sdp_type
      END,
      session_sdp_ciphertext = CASE
        WHEN v_terminal THEN NULL
        WHEN p_sdp_ciphertext IS NOT NULL THEN p_sdp_ciphertext
        WHEN session_sdp_expires_at IS NOT NULL AND session_sdp_expires_at <= now() THEN NULL
        ELSE session_sdp_ciphertext
      END,
      session_sdp_expires_at = CASE
        WHEN v_terminal THEN NULL
        WHEN p_sdp_ciphertext IS NOT NULL THEN p_sdp_expires_at
        WHEN session_sdp_expires_at IS NOT NULL AND session_sdp_expires_at <= now() THEN NULL
        ELSE session_sdp_expires_at
      END,
      claim_token = CASE WHEN v_terminal THEN NULL ELSE claim_token END,
      claimed_by_user_id = CASE WHEN v_terminal THEN NULL ELSE claimed_by_user_id END,
      claim_expires_at = CASE WHEN v_terminal THEN NULL ELSE claim_expires_at END,
      updated_at = now()
  WHERE id = v_id;

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_whatsapp_call_session(
  p_account_id uuid,
  p_session_id uuid,
  p_user_id uuid,
  p_lease_seconds integer DEFAULT 45
) RETURNS TABLE(outcome text, claim_token uuid, claim_expires_at timestamptz)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_row public.whatsapp_call_sessions%ROWTYPE;
  v_token uuid;
  v_until timestamptz;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'invalid_call_claim_user' USING ERRCODE = '22023';
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 15 AND 120 THEN
    RAISE EXCEPTION 'invalid_call_claim_lease' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_row
  FROM public.whatsapp_call_sessions s
  WHERE s.id = p_session_id AND s.account_id = p_account_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'missing'::text, NULL::uuid, NULL::timestamptz;
    RETURN;
  END IF;

  IF v_row.state <> 'ringing' OR v_row.direction <> 'USER_INITIATED' THEN
    RETURN QUERY SELECT 'not_ringing'::text, NULL::uuid, NULL::timestamptz;
    RETURN;
  END IF;

  IF v_row.claim_token IS NOT NULL
     AND v_row.claim_expires_at > now()
     AND v_row.claimed_by_user_id <> p_user_id
  THEN
    RETURN QUERY SELECT 'busy'::text, NULL::uuid, v_row.claim_expires_at;
    RETURN;
  END IF;

  v_token := gen_random_uuid();
  v_until := now() + make_interval(secs => p_lease_seconds);
  UPDATE public.whatsapp_call_sessions
  SET claimed_by_user_id = p_user_id,
      claim_token = v_token,
      claim_expires_at = v_until,
      updated_at = now()
  WHERE id = p_session_id AND account_id = p_account_id;

  RETURN QUERY SELECT 'claimed'::text, v_token, v_until;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_whatsapp_call_session_claim(
  p_account_id uuid,
  p_session_id uuid,
  p_user_id uuid,
  p_claim_token uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  UPDATE public.whatsapp_call_sessions
  SET claimed_by_user_id = NULL,
      claim_token = NULL,
      claim_expires_at = NULL,
      updated_at = now()
  WHERE id = p_session_id
    AND account_id = p_account_id
    AND claimed_by_user_id = p_user_id
    AND claim_token = p_claim_token
    AND state = 'ringing';
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_whatsapp_call_session_event(
  uuid,text,text,uuid,uuid,text,text,text,text,text,timestamptz,timestamptz,timestamptz,integer,text,text,timestamptz
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_whatsapp_call_session(uuid,uuid,uuid,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_whatsapp_call_session_claim(uuid,uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.upsert_whatsapp_call_session_event(
  uuid,text,text,uuid,uuid,text,text,text,text,text,timestamptz,timestamptz,timestamptz,integer,text,text,timestamptz
) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_whatsapp_call_session(uuid,uuid,uuid,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_whatsapp_call_session_claim(uuid,uuid,uuid,uuid) TO service_role;

COMMIT;
