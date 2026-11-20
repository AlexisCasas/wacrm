-- CALL-03B1: server-side Meta signaling, durable outbound idempotency and
-- separately encrypted agent SDP. No browser role receives direct table/RPC access.

ALTER TABLE public.whatsapp_call_sessions
  ADD COLUMN IF NOT EXISTS agent_sdp_encrypted text,
  ADD COLUMN IF NOT EXISTS agent_sdp_type text
    CHECK (agent_sdp_type IN ('offer','answer')),
  ADD COLUMN IF NOT EXISTS agent_sdp_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_claimed_by_user_id uuid
    REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS whatsapp_call_sessions_agent_sdp_expiry_idx
  ON public.whatsapp_call_sessions(agent_sdp_expires_at)
  WHERE agent_sdp_encrypted IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.whatsapp_call_outbound_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  phone_number_id text NOT NULL CHECK (phone_number_id ~ '^[0-9]{5,25}$'),
  request_id uuid NOT NULL,
  contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  conversation_id uuid REFERENCES public.conversations(id) ON DELETE SET NULL,
  customer_key text NOT NULL CHECK (length(customer_key) BETWEEN 1 AND 256),
  customer_phone text,
  customer_bsuid text,
  customer_parent_bsuid text,
  customer_name text,
  actor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  agent_sdp_encrypted text,
  agent_sdp_expires_at timestamptz,
  biz_opaque_callback_data text NOT NULL
    CHECK (length(biz_opaque_callback_data) BETWEEN 1 AND 512),
  call_id text CHECK (
    call_id IS NULL OR (call_id LIKE 'wacid.%' AND length(call_id) BETWEEN 7 AND 518)
  ),
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','submitted','failed','unknown')),
  failure_code text CHECK (failure_code IS NULL OR length(failure_code) <= 128),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, request_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_call_outbound_callback_uq
  ON public.whatsapp_call_outbound_attempts(phone_number_id,biz_opaque_callback_data);
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_call_outbound_call_id_uq
  ON public.whatsapp_call_outbound_attempts(phone_number_id,call_id)
  WHERE call_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS whatsapp_call_outbound_account_recent_idx
  ON public.whatsapp_call_outbound_attempts(account_id,created_at DESC);

ALTER TABLE public.whatsapp_call_outbound_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.whatsapp_call_outbound_attempts FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.whatsapp_call_outbound_attempts TO service_role;

-- Begin a durable outbound request before calling Meta. The client request_id
-- is an idempotency key; a repeated key never starts a second Meta call.
CREATE OR REPLACE FUNCTION public.whatsapp_call_outbound_attempt_begin(
  p_account_id uuid,
  p_phone_number_id text,
  p_request_id uuid,
  p_actor_user_id uuid,
  p_contact_id uuid,
  p_conversation_id uuid,
  p_customer_key text,
  p_customer_phone text,
  p_customer_bsuid text,
  p_customer_parent_bsuid text,
  p_customer_name text,
  p_agent_sdp_encrypted text,
  p_agent_sdp_expires_at timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=public
AS $begin$
DECLARE
  v_role public.account_role_enum;
  v_contact_phone text;
  v_conversation_contact_id uuid;
  v_identity_match boolean := false;
  v_attempt_id uuid;
  v_existing public.whatsapp_call_outbound_attempts%ROWTYPE;
  v_callback_data text;
BEGIN
  IF p_account_id IS NULL OR p_request_id IS NULL OR p_phone_number_id IS NULL
    OR p_phone_number_id !~ '^[0-9]{5,25}$'
    OR p_contact_id IS NULL OR p_conversation_id IS NULL
    OR p_customer_key IS NULL OR length(p_customer_key) NOT BETWEEN 1 AND 256
    OR p_agent_sdp_encrypted IS NULL OR length(p_agent_sdp_encrypted) NOT BETWEEN 1 AND 100000
    OR p_agent_sdp_expires_at IS NULL
    OR p_agent_sdp_expires_at <= now()
    OR p_agent_sdp_expires_at > now()+interval '5 minutes'
  THEN
    RAISE EXCEPTION 'invalid_call_outbound_attempt' USING ERRCODE='22023';
  END IF;

  SELECT account_role INTO v_role
  FROM public.profiles
  WHERE account_id=p_account_id AND user_id=p_actor_user_id;
  IF v_role IS NULL OR v_role NOT IN ('owner','admin','agent') THEN
    RAISE EXCEPTION 'call_outbound_actor_forbidden' USING ERRCODE='42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.whatsapp_config
    WHERE account_id=p_account_id
      AND phone_number_id=p_phone_number_id
      AND status='connected'
  ) THEN
    RAISE EXCEPTION 'call_outbound_phone_config_unavailable' USING ERRCODE='42501';
  END IF;

  SELECT regexp_replace(COALESCE(c.phone,''),'\D','','g')
    INTO v_contact_phone
  FROM public.contacts c
  WHERE c.id=p_contact_id AND c.account_id=p_account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'call_outbound_contact_tenant_conflict' USING ERRCODE='42501';
  END IF;

  SELECT c.contact_id INTO v_conversation_contact_id
  FROM public.conversations c
  WHERE c.id=p_conversation_id AND c.account_id=p_account_id;
  IF NOT FOUND OR v_conversation_contact_id IS DISTINCT FROM p_contact_id THEN
    RAISE EXCEPTION 'call_outbound_conversation_contact_conflict' USING ERRCODE='42501';
  END IF;

  IF p_customer_phone IS NOT NULL AND p_customer_phone !~ '^[0-9]{6,20}$' THEN
    RAISE EXCEPTION 'invalid_call_outbound_phone' USING ERRCODE='22023';
  END IF;
  IF p_customer_bsuid IS NOT NULL AND p_customer_bsuid !~ '^[A-Za-z0-9._~-]{1,256}$' THEN
    RAISE EXCEPTION 'invalid_call_outbound_bsuid' USING ERRCODE='22023';
  END IF;
  IF p_customer_parent_bsuid IS NOT NULL AND p_customer_parent_bsuid !~ '^[A-Za-z0-9._~-]{1,256}$' THEN
    RAISE EXCEPTION 'invalid_call_outbound_parent_bsuid' USING ERRCODE='22023';
  END IF;
  IF p_customer_key IS DISTINCT FROM COALESCE(p_customer_bsuid,p_customer_parent_bsuid,p_customer_phone) THEN
    RAISE EXCEPTION 'call_outbound_customer_key_mismatch' USING ERRCODE='22023';
  END IF;

  IF p_customer_phone IS NOT NULL AND v_contact_phone=p_customer_phone THEN
    v_identity_match := true;
  END IF;
  IF NOT v_identity_match AND p_customer_bsuid IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.contact_identities i
      WHERE i.account_id=p_account_id AND i.contact_id=p_contact_id
        AND i.kind='bsuid' AND i.value=p_customer_bsuid
    ) INTO v_identity_match;
  END IF;
  IF NOT v_identity_match AND p_customer_parent_bsuid IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.contact_identities i
      WHERE i.account_id=p_account_id AND i.contact_id=p_contact_id
        AND i.kind='parent_bsuid' AND i.value=p_customer_parent_bsuid
    ) INTO v_identity_match;
  END IF;
  IF NOT v_identity_match THEN
    RAISE EXCEPTION 'call_outbound_contact_identity_mismatch' USING ERRCODE='42501';
  END IF;

  v_callback_data := p_request_id::text;
  INSERT INTO public.whatsapp_call_outbound_attempts(
    account_id,phone_number_id,request_id,contact_id,conversation_id,
    customer_key,customer_phone,customer_bsuid,customer_parent_bsuid,customer_name,
    actor_user_id,agent_sdp_encrypted,agent_sdp_expires_at,biz_opaque_callback_data,state
  ) VALUES (
    p_account_id,p_phone_number_id,p_request_id,p_contact_id,p_conversation_id,
    p_customer_key,p_customer_phone,p_customer_bsuid,p_customer_parent_bsuid,p_customer_name,
    p_actor_user_id,p_agent_sdp_encrypted,p_agent_sdp_expires_at,v_callback_data,'pending'
  )
  ON CONFLICT (account_id,request_id) DO NOTHING
  RETURNING id INTO v_attempt_id;

  IF v_attempt_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'attempt_id',v_attempt_id,'state','pending','call_id',NULL,
      'callback_data',v_callback_data,'created',true
    );
  END IF;

  SELECT * INTO v_existing
  FROM public.whatsapp_call_outbound_attempts
  WHERE account_id=p_account_id AND request_id=p_request_id
  FOR UPDATE;

  IF NOT FOUND
    OR v_existing.phone_number_id IS DISTINCT FROM p_phone_number_id
    OR v_existing.actor_user_id IS DISTINCT FROM p_actor_user_id
    OR v_existing.contact_id IS DISTINCT FROM p_contact_id
    OR v_existing.conversation_id IS DISTINCT FROM p_conversation_id
    OR v_existing.customer_key IS DISTINCT FROM p_customer_key
  THEN
    RAISE EXCEPTION 'call_outbound_idempotency_conflict' USING ERRCODE='42501';
  END IF;

  RETURN jsonb_build_object(
    'attempt_id',v_existing.id,'state',v_existing.state,'call_id',v_existing.call_id,
    'callback_data',v_existing.biz_opaque_callback_data,'created',false
  );
END;
$begin$;

-- Complete the outbound attempt after Meta returns its call_id. This upsert
-- converges with a webhook-created session if Meta's webhook wins the race.
CREATE OR REPLACE FUNCTION public.whatsapp_call_outbound_attempt_complete(
  p_account_id uuid,
  p_phone_number_id text,
  p_request_id uuid,
  p_actor_user_id uuid,
  p_call_id text,
  p_agent_sdp_encrypted text,
  p_agent_sdp_expires_at timestamptz
) RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=public
AS $complete$
DECLARE
  v_attempt public.whatsapp_call_outbound_attempts%ROWTYPE;
BEGIN
  IF p_call_id IS NULL OR p_call_id !~ '^wacid\.[A-Za-z0-9._~+/=-]{1,512}$'
    OR p_agent_sdp_encrypted IS NULL
    OR p_agent_sdp_expires_at IS NULL
    OR p_agent_sdp_expires_at <= now()
    OR p_agent_sdp_expires_at > now()+interval '5 minutes'
  THEN
    RAISE EXCEPTION 'invalid_call_outbound_completion' USING ERRCODE='22023';
  END IF;

  SELECT * INTO v_attempt
  FROM public.whatsapp_call_outbound_attempts
  WHERE account_id=p_account_id
    AND phone_number_id=p_phone_number_id
    AND request_id=p_request_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF v_attempt.actor_user_id IS DISTINCT FROM p_actor_user_id THEN
    RAISE EXCEPTION 'call_outbound_actor_conflict' USING ERRCODE='42501';
  END IF;
  IF v_attempt.state='submitted' AND v_attempt.call_id=p_call_id THEN
    RETURN true;
  END IF;
  IF v_attempt.state<>'pending' THEN RETURN false; END IF;

  INSERT INTO public.whatsapp_call_sessions(
    account_id,phone_number_id,call_id,direction,customer_key,customer_phone,
    customer_bsuid,customer_parent_bsuid,customer_name,contact_id,conversation_id,
    initiated_by_user_id,biz_opaque_callback_data,state,
    agent_sdp_encrypted,agent_sdp_type,agent_sdp_expires_at
  ) VALUES (
    p_account_id,p_phone_number_id,p_call_id,'BUSINESS_INITIATED',v_attempt.customer_key,
    v_attempt.customer_phone,v_attempt.customer_bsuid,v_attempt.customer_parent_bsuid,
    v_attempt.customer_name,v_attempt.contact_id,v_attempt.conversation_id,
    p_actor_user_id,v_attempt.biz_opaque_callback_data,'connecting',
    v_attempt.agent_sdp_encrypted,'offer',v_attempt.agent_sdp_expires_at
  )
  ON CONFLICT (phone_number_id,call_id) DO UPDATE SET
    direction=COALESCE(whatsapp_call_sessions.direction,EXCLUDED.direction),
    customer_key=COALESCE(whatsapp_call_sessions.customer_key,EXCLUDED.customer_key),
    customer_phone=COALESCE(whatsapp_call_sessions.customer_phone,EXCLUDED.customer_phone),
    customer_bsuid=COALESCE(whatsapp_call_sessions.customer_bsuid,EXCLUDED.customer_bsuid),
    customer_parent_bsuid=COALESCE(whatsapp_call_sessions.customer_parent_bsuid,EXCLUDED.customer_parent_bsuid),
    customer_name=COALESCE(whatsapp_call_sessions.customer_name,EXCLUDED.customer_name),
    contact_id=COALESCE(whatsapp_call_sessions.contact_id,EXCLUDED.contact_id),
    conversation_id=COALESCE(whatsapp_call_sessions.conversation_id,EXCLUDED.conversation_id),
    initiated_by_user_id=COALESCE(whatsapp_call_sessions.initiated_by_user_id,EXCLUDED.initiated_by_user_id),
    biz_opaque_callback_data=COALESCE(whatsapp_call_sessions.biz_opaque_callback_data,EXCLUDED.biz_opaque_callback_data),
    agent_sdp_encrypted=CASE
      WHEN whatsapp_call_sessions.state IN ('terminated','failed','rejected')
      THEN whatsapp_call_sessions.agent_sdp_encrypted
      ELSE COALESCE(whatsapp_call_sessions.agent_sdp_encrypted,EXCLUDED.agent_sdp_encrypted)
    END,
    agent_sdp_type=CASE
      WHEN whatsapp_call_sessions.state IN ('terminated','failed','rejected')
      THEN whatsapp_call_sessions.agent_sdp_type
      ELSE COALESCE(whatsapp_call_sessions.agent_sdp_type,EXCLUDED.agent_sdp_type)
    END,
    agent_sdp_expires_at=CASE
      WHEN whatsapp_call_sessions.state IN ('terminated','failed','rejected')
      THEN whatsapp_call_sessions.agent_sdp_expires_at
      ELSE COALESCE(whatsapp_call_sessions.agent_sdp_expires_at,EXCLUDED.agent_sdp_expires_at)
    END,
    updated_at=now()
  WHERE whatsapp_call_sessions.account_id=EXCLUDED.account_id
    AND (whatsapp_call_sessions.direction IS NULL OR whatsapp_call_sessions.direction='BUSINESS_INITIATED')
    AND (whatsapp_call_sessions.initiated_by_user_id IS NULL
      OR whatsapp_call_sessions.initiated_by_user_id=EXCLUDED.initiated_by_user_id)
    AND (whatsapp_call_sessions.conversation_id IS NULL
      OR whatsapp_call_sessions.conversation_id=EXCLUDED.conversation_id);

  IF NOT FOUND THEN
    RAISE EXCEPTION 'call_outbound_session_conflict' USING ERRCODE='42501';
  END IF;

  UPDATE public.whatsapp_call_outbound_attempts
  SET state='submitted',call_id=p_call_id,
      agent_sdp_encrypted=NULL,agent_sdp_expires_at=NULL,updated_at=now()
  WHERE id=v_attempt.id;
  RETURN FOUND;
END;
$complete$;

CREATE OR REPLACE FUNCTION public.whatsapp_call_outbound_attempt_fail(
  p_account_id uuid,
  p_phone_number_id text,
  p_request_id uuid,
  p_actor_user_id uuid,
  p_state text,
  p_failure_code text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=public
AS $fail$
BEGIN
  IF p_state IS NULL OR p_state NOT IN ('failed','unknown')
    OR (p_failure_code IS NOT NULL AND length(p_failure_code)>128)
  THEN
    RAISE EXCEPTION 'invalid_call_outbound_failure' USING ERRCODE='22023';
  END IF;

  UPDATE public.whatsapp_call_outbound_attempts
  SET state=p_state,failure_code=p_failure_code,
      agent_sdp_encrypted=CASE WHEN p_state='failed' THEN NULL ELSE agent_sdp_encrypted END,
      agent_sdp_expires_at=CASE WHEN p_state='failed' THEN NULL ELSE agent_sdp_expires_at END,
      updated_at=now()
  WHERE account_id=p_account_id
    AND phone_number_id=p_phone_number_id
    AND request_id=p_request_id
    AND actor_user_id=p_actor_user_id
    AND state='pending';
  RETURN FOUND;
END;
$fail$;

-- Store the exact UIC answer after pre_accept. The accept route later decrypts
-- this value; it does not accept a second SDP from the browser.
CREATE OR REPLACE FUNCTION public.whatsapp_call_session_agent_sdp_store(
  p_account_id uuid,
  p_phone_number_id text,
  p_call_id text,
  p_actor_user_id uuid,
  p_agent_sdp_encrypted text,
  p_agent_sdp_expires_at timestamptz
) RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=public
AS $store$
DECLARE
  v_role public.account_role_enum;
BEGIN
  SELECT account_role INTO v_role
  FROM public.profiles
  WHERE account_id=p_account_id AND user_id=p_actor_user_id;
  IF v_role IS NULL OR v_role NOT IN ('owner','admin','agent') THEN
    RAISE EXCEPTION 'call_agent_sdp_actor_forbidden' USING ERRCODE='42501';
  END IF;

  IF p_agent_sdp_encrypted IS NULL
    OR p_agent_sdp_expires_at IS NULL
    OR p_agent_sdp_expires_at <= now()
    OR p_agent_sdp_expires_at > now()+interval '5 minutes'
  THEN
    RAISE EXCEPTION 'invalid_call_agent_sdp' USING ERRCODE='22023';
  END IF;

  UPDATE public.whatsapp_call_sessions
  SET agent_sdp_encrypted=COALESCE(agent_sdp_encrypted,p_agent_sdp_encrypted),
      agent_sdp_type=COALESCE(agent_sdp_type,'answer'),
      agent_sdp_expires_at=COALESCE(agent_sdp_expires_at,p_agent_sdp_expires_at),
      updated_at=now()
  WHERE account_id=p_account_id
    AND phone_number_id=p_phone_number_id
    AND call_id=p_call_id
    AND direction='USER_INITIATED'
    AND state IN ('offered','ringing','connected')
    AND claimed_by_user_id=p_actor_user_id
    AND claim_expires_at > now()
    AND rejected_by_user_id IS NULL
    AND ended_by_user_id IS NULL;

  RETURN FOUND;
END;
$store$;

-- Persist callback data echoed by later status/terminate webhooks. It is
-- deliberately not used to correlate the initial connect webhook.
CREATE OR REPLACE FUNCTION public.whatsapp_call_session_callback_data_apply(
  p_account_id uuid,
  p_phone_number_id text,
  p_call_id text,
  p_callback_data text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=public
AS $callback$
DECLARE
  v_existing text;
BEGIN
  IF p_callback_data IS NULL OR length(p_callback_data) NOT BETWEEN 1 AND 512 THEN
    RAISE EXCEPTION 'invalid_call_callback_data' USING ERRCODE='22023';
  END IF;

  SELECT biz_opaque_callback_data INTO v_existing
  FROM public.whatsapp_call_sessions
  WHERE account_id=p_account_id AND phone_number_id=p_phone_number_id AND call_id=p_call_id
  FOR UPDATE;

  IF NOT FOUND THEN RETURN false; END IF;
  IF v_existing IS NOT NULL AND v_existing IS DISTINCT FROM p_callback_data THEN
    RAISE EXCEPTION 'call_callback_data_conflict' USING ERRCODE='42501';
  END IF;

  UPDATE public.whatsapp_call_sessions
  SET biz_opaque_callback_data=p_callback_data,updated_at=now()
  WHERE account_id=p_account_id AND phone_number_id=p_phone_number_id AND call_id=p_call_id;
  IF NOT FOUND THEN RETURN false; END IF;

  -- A status/terminate webhook echoes the opaque data after the initial
  -- connect. Use it to reconcile an HTTP response lost after Meta accepted
  -- the request; this is not used to correlate the initial connect webhook.
  UPDATE public.whatsapp_call_outbound_attempts
  SET state='submitted',call_id=p_call_id,updated_at=now()
  WHERE account_id=p_account_id
    AND phone_number_id=p_phone_number_id
    AND biz_opaque_callback_data=p_callback_data
    AND state IN ('pending','unknown')
    AND (call_id IS NULL OR call_id=p_call_id);

  UPDATE public.whatsapp_call_sessions s
  SET direction=COALESCE(s.direction,'BUSINESS_INITIATED'),
      contact_id=COALESCE(s.contact_id,a.contact_id),
      conversation_id=COALESCE(s.conversation_id,a.conversation_id),
      initiated_by_user_id=COALESCE(s.initiated_by_user_id,a.actor_user_id),
      agent_sdp_encrypted=CASE
        WHEN s.state IN ('terminated','failed','rejected') THEN NULL
        WHEN a.agent_sdp_encrypted IS NOT NULL AND a.agent_sdp_expires_at > now()
          THEN COALESCE(s.agent_sdp_encrypted,a.agent_sdp_encrypted)
        ELSE s.agent_sdp_encrypted END,
      agent_sdp_type=CASE
        WHEN s.state IN ('terminated','failed','rejected') THEN NULL
        WHEN a.agent_sdp_encrypted IS NOT NULL AND a.agent_sdp_expires_at > now()
          THEN COALESCE(s.agent_sdp_type,'offer')
        ELSE s.agent_sdp_type END,
      agent_sdp_expires_at=CASE
        WHEN s.state IN ('terminated','failed','rejected') THEN NULL
        WHEN a.agent_sdp_encrypted IS NOT NULL AND a.agent_sdp_expires_at > now()
          THEN COALESCE(s.agent_sdp_expires_at,a.agent_sdp_expires_at)
        ELSE s.agent_sdp_expires_at END,
      updated_at=now()
  FROM public.whatsapp_call_outbound_attempts a
  WHERE a.account_id=p_account_id
    AND a.phone_number_id=p_phone_number_id
    AND a.biz_opaque_callback_data=p_callback_data
    AND a.call_id=p_call_id
    AND s.account_id=a.account_id
    AND s.phone_number_id=a.phone_number_id
    AND s.call_id=p_call_id
    AND (s.direction IS NULL OR s.direction='BUSINESS_INITIATED')
    AND (s.initiated_by_user_id IS NULL OR s.initiated_by_user_id=a.actor_user_id)
    AND (s.conversation_id IS NULL OR s.conversation_id=a.conversation_id);

  IF FOUND THEN
    UPDATE public.whatsapp_call_outbound_attempts
    SET agent_sdp_encrypted=NULL,agent_sdp_expires_at=NULL,updated_at=now()
    WHERE account_id=p_account_id
      AND phone_number_id=p_phone_number_id
      AND biz_opaque_callback_data=p_callback_data
      AND call_id=p_call_id;
  END IF;

  RETURN true;
END;
$callback$;

-- Preserve the last claimant across Meta's terminal-event lease cleanup so the
-- agent can still be attributed if the webhook races the API response.
CREATE OR REPLACE FUNCTION public.whatsapp_call_claim(
  p_account_id uuid,
  p_phone_number_id text,
  p_call_id text,
  p_actor_user_id uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=public
AS $claim$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE account_id=p_account_id AND user_id=p_actor_user_id
      AND account_role IN ('owner','admin','agent')
  ) THEN
    RAISE EXCEPTION 'call_claim_actor_forbidden' USING ERRCODE='42501';
  END IF;

  UPDATE public.whatsapp_call_sessions
  SET claimed_by_user_id=p_actor_user_id,
      last_claimed_by_user_id=p_actor_user_id,
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
$claim$;

-- Replace the CALL-03A agent action guard with terminal-webhook race handling.
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
AS $agent_action$
DECLARE
  v_role public.account_role_enum;
  v_call public.whatsapp_call_sessions%ROWTYPE;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('initiated','accepted','rejected','ended') THEN
    RAISE EXCEPTION 'invalid_call_agent_action' USING ERRCODE='22023';
  END IF;

  SELECT p.account_role INTO v_role
  FROM public.profiles p
  WHERE p.account_id=p_account_id AND p.user_id=p_actor_user_id;
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
          (
            v_call.state IN ('offered','ringing')
            AND v_call.claimed_by_user_id IS NOT NULL
            AND v_call.claim_expires_at > now()
            AND v_call.claimed_by_user_id IS DISTINCT FROM p_actor_user_id
          )
          OR (
            v_call.state='rejected'
            AND v_call.last_claimed_by_user_id IS DISTINCT FROM p_actor_user_id
          )
          OR v_call.state NOT IN ('offered','ringing','rejected')
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
        AND NOT (
          COALESCE(v_call.initiated_by_user_id=p_actor_user_id,false)
          OR COALESCE(v_call.accepted_by_user_id=p_actor_user_id,false)
          OR COALESCE(v_call.claimed_by_user_id=p_actor_user_id,false)
          OR COALESCE(v_call.last_claimed_by_user_id=p_actor_user_id,false)
          OR v_role IN ('owner','admin')
        ) THEN
        RETURN false;
      END IF;
  END CASE;

  UPDATE public.whatsapp_call_sessions
  SET conversation_id=COALESCE(conversation_id,p_conversation_id),
      claimed_by_user_id=CASE
        WHEN p_action IN ('rejected','ended') THEN NULL
        ELSE claimed_by_user_id END,
      claimed_at=CASE
        WHEN p_action IN ('rejected','ended') THEN NULL
        ELSE claimed_at END,
      claim_expires_at=CASE
        WHEN p_action IN ('rejected','ended') THEN NULL
        ELSE claim_expires_at END,
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
$agent_action$;

-- Clear both sides' ephemeral SDP on terminal state. The SDP is never retained
-- as call history; only non-sensitive call metadata survives.
CREATE OR REPLACE FUNCTION public.whatsapp_call_agent_sdp_terminal_clear()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public
AS $terminal$
BEGIN
  IF NEW.state IN ('terminated','failed','rejected') THEN
    NEW.agent_sdp_encrypted := NULL;
    NEW.agent_sdp_type := NULL;
    NEW.agent_sdp_expires_at := NULL;
  END IF;
  RETURN NEW;
END;
$terminal$;

DROP TRIGGER IF EXISTS whatsapp_call_agent_sdp_terminal_clear
  ON public.whatsapp_call_sessions;
CREATE TRIGGER whatsapp_call_agent_sdp_terminal_clear
  BEFORE UPDATE OF state ON public.whatsapp_call_sessions
  FOR EACH ROW
  EXECUTE FUNCTION public.whatsapp_call_agent_sdp_terminal_clear();

-- Opportunistic bounded cleanup now prunes remote and agent SDP together.
CREATE OR REPLACE FUNCTION public.whatsapp_call_sdp_prune(p_limit integer DEFAULT 100)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=public
AS $prune$
DECLARE
  v_count integer;
  v_attempt_count integer;
BEGIN
  WITH expired AS (
    SELECT id FROM public.whatsapp_call_sessions
    WHERE (session_sdp_encrypted IS NOT NULL AND session_sdp_expires_at IS NOT NULL
      AND session_sdp_expires_at <= now())
      OR (agent_sdp_encrypted IS NOT NULL AND agent_sdp_expires_at IS NOT NULL
      AND agent_sdp_expires_at <= now())
    ORDER BY LEAST(
      COALESCE(session_sdp_expires_at,'infinity'::timestamptz),
      COALESCE(agent_sdp_expires_at,'infinity'::timestamptz)
    )
    LIMIT LEAST(1000,GREATEST(1,COALESCE(p_limit,100)))
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.whatsapp_call_sessions s
  SET session_sdp_encrypted=CASE
        WHEN s.session_sdp_expires_at <= now() THEN NULL ELSE s.session_sdp_encrypted END,
      session_sdp_type=CASE
        WHEN s.session_sdp_expires_at <= now() THEN NULL ELSE s.session_sdp_type END,
      session_sdp_expires_at=CASE
        WHEN s.session_sdp_expires_at <= now() THEN NULL ELSE s.session_sdp_expires_at END,
      agent_sdp_encrypted=CASE
        WHEN s.agent_sdp_expires_at <= now() THEN NULL ELSE s.agent_sdp_encrypted END,
      agent_sdp_type=CASE
        WHEN s.agent_sdp_expires_at <= now() THEN NULL ELSE s.agent_sdp_type END,
      agent_sdp_expires_at=CASE
        WHEN s.agent_sdp_expires_at <= now() THEN NULL ELSE s.agent_sdp_expires_at END,
      updated_at=now()
  FROM expired WHERE s.id=expired.id;
  GET DIAGNOSTICS v_count=ROW_COUNT;

  WITH expired_attempts AS (
    SELECT id FROM public.whatsapp_call_outbound_attempts
    WHERE agent_sdp_encrypted IS NOT NULL
      AND agent_sdp_expires_at IS NOT NULL
      AND agent_sdp_expires_at <= now()
    ORDER BY agent_sdp_expires_at
    LIMIT LEAST(1000,GREATEST(1,COALESCE(p_limit,100)))
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.whatsapp_call_outbound_attempts a
  SET agent_sdp_encrypted=NULL,agent_sdp_expires_at=NULL,updated_at=now()
  FROM expired_attempts WHERE a.id=expired_attempts.id;
  GET DIAGNOSTICS v_attempt_count=ROW_COUNT;
  RETURN v_count+v_attempt_count;
END;
$prune$;

REVOKE ALL ON FUNCTION public.whatsapp_call_outbound_attempt_begin(
  uuid,text,uuid,uuid,uuid,uuid,text,text,text,text,text,text,timestamptz
), public.whatsapp_call_outbound_attempt_complete(uuid,text,uuid,uuid,text,text,timestamptz),
  public.whatsapp_call_outbound_attempt_fail(uuid,text,uuid,uuid,text,text),
  public.whatsapp_call_session_agent_sdp_store(uuid,text,text,uuid,text,timestamptz),
  public.whatsapp_call_session_callback_data_apply(uuid,text,text,text)
FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.whatsapp_call_outbound_attempt_begin(
  uuid,text,uuid,uuid,uuid,uuid,text,text,text,text,text,text,timestamptz
), public.whatsapp_call_outbound_attempt_complete(uuid,text,uuid,uuid,text,text,timestamptz),
  public.whatsapp_call_outbound_attempt_fail(uuid,text,uuid,uuid,text,text),
  public.whatsapp_call_session_agent_sdp_store(uuid,text,text,uuid,text,timestamptz),
  public.whatsapp_call_session_callback_data_apply(uuid,text,text,text)
TO service_role;
