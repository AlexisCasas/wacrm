-- CALL-03B2.6: fence pre_accept/accept versus terminal side effects.
-- Do not hold a SQL transaction over HTTP. Each request commits its durable
-- reservation BEFORE the corresponding Meta POST; unknown outcomes stay fenced.
-- This is layered AFTER 20261201000000, and changes only QA after approval.

ALTER TABLE public.whatsapp_call_sessions
  ADD COLUMN signal_request_id uuid,
  ADD COLUMN signal_action text CHECK (signal_action IN ('pre_accept','accept')),
  ADD COLUMN signal_status text CHECK (signal_status IN ('reserved','acknowledged','unknown')),
  ADD COLUMN signal_actor_user_id uuid,
  ADD COLUMN signal_claimed_at timestamptz,
  ADD COLUMN signal_reserved_at timestamptz,
  ADD COLUMN signal_updated_at timestamptz;

ALTER TABLE public.whatsapp_call_sessions
  ADD CONSTRAINT whatsapp_call_signal_reservation_shape_ck CHECK (
    (signal_request_id IS NULL AND signal_action IS NULL
      AND signal_status IS NULL AND signal_actor_user_id IS NULL
      AND signal_claimed_at IS NULL AND signal_reserved_at IS NULL
      AND signal_updated_at IS NULL)
    OR
    (signal_request_id IS NOT NULL AND signal_action IS NOT NULL
      AND signal_status IS NOT NULL AND signal_actor_user_id IS NOT NULL
      AND signal_claimed_at IS NOT NULL AND signal_reserved_at IS NOT NULL
      AND signal_updated_at IS NOT NULL)
  );

-- Reserve an individual Meta signaling phase, serialized on the call row.
-- Result: reserved, already_acknowledged, in_progress, unknown,
--         terminal_in_progress, denied, or not_found.
CREATE OR REPLACE FUNCTION public.whatsapp_call_signal_begin(
  p_account_id uuid,
  p_phone_number_id text,
  p_call_id text,
  p_actor_user_id uuid,
  p_request_id uuid,
  p_action text,
  p_expected_claimed_at timestamptz
) RETURNS text
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public
AS $signal_begin$
DECLARE
  v_call public.whatsapp_call_sessions%ROWTYPE;
BEGIN
  IF p_request_id IS NULL OR p_action NOT IN ('pre_accept','accept')
    OR p_expected_claimed_at IS NULL THEN
    RAISE EXCEPTION 'invalid_call_signal_request' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE account_id=p_account_id AND user_id=p_actor_user_id
      AND account_role IN ('owner','admin','agent')
  ) THEN
    RAISE EXCEPTION 'call_signal_actor_forbidden' USING ERRCODE='42501';
  END IF;
  SELECT * INTO v_call
    FROM public.whatsapp_call_sessions
    WHERE account_id=p_account_id
      AND phone_number_id=p_phone_number_id
      AND call_id=p_call_id
    FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF v_call.terminal_request_id IS NOT NULL THEN RETURN 'terminal_in_progress'; END IF;
  IF v_call.state IN ('terminated','failed','rejected')
    OR v_call.rejected_by_user_id IS NOT NULL
    OR v_call.ended_by_user_id IS NOT NULL
    OR v_call.direction <> 'USER_INITIATED'
    OR v_call.claimed_by_user_id IS DISTINCT FROM p_actor_user_id
    OR v_call.claimed_at IS DISTINCT FROM p_expected_claimed_at
    OR v_call.claim_expires_at <= now()
    OR v_call.claim_expires_at IS NULL
    OR (v_call.accepted_by_user_id IS NOT NULL
      AND v_call.accepted_by_user_id IS DISTINCT FROM p_actor_user_id)
  THEN RETURN 'denied'; END IF;

  IF v_call.signal_request_id IS NOT NULL THEN
    IF v_call.signal_status='reserved' THEN RETURN 'in_progress'; END IF;
    IF v_call.signal_status='unknown' THEN RETURN 'unknown'; END IF;
    IF v_call.signal_action='accept' THEN
      RETURN CASE WHEN p_action='accept' THEN 'already_acknowledged' ELSE 'denied' END;
    END IF;
    IF v_call.signal_action='pre_accept' AND p_action='pre_accept' THEN
      RETURN 'already_acknowledged';
    END IF;
    -- Only the same actor and epoch may advance pre_accept -> accept.
    IF v_call.signal_action IS DISTINCT FROM 'pre_accept'
      OR v_call.signal_status IS DISTINCT FROM 'acknowledged'
      OR v_call.signal_actor_user_id IS DISTINCT FROM p_actor_user_id
      OR v_call.signal_claimed_at IS DISTINCT FROM p_expected_claimed_at
    THEN RETURN 'denied'; END IF;
  ELSIF p_action='accept' AND v_call.state <> 'connected' THEN
    -- Do not send accept to Meta without a confirmed pre_accept.
    RETURN 'denied';
  END IF;

  IF p_action='pre_accept' AND (
    v_call.state NOT IN ('offered','ringing')
    OR v_call.accepted_by_user_id IS NOT NULL
    OR v_call.agent_sdp_type IS DISTINCT FROM 'answer'
    OR v_call.agent_sdp_encrypted IS NULL
    OR v_call.agent_sdp_expires_at <= now()
  ) THEN RETURN 'denied'; END IF;
  IF p_action='accept' AND (
    v_call.agent_sdp_type IS DISTINCT FROM 'answer'
    OR v_call.agent_sdp_encrypted IS NULL
    OR v_call.agent_sdp_expires_at <= now()
  ) THEN RETURN 'denied'; END IF;

  UPDATE public.whatsapp_call_sessions
    SET signal_request_id=p_request_id,
        signal_action=p_action,
        signal_status='reserved',
        signal_actor_user_id=p_actor_user_id,
        signal_claimed_at=p_expected_claimed_at,
        signal_reserved_at=now(),
        signal_updated_at=now(),
        updated_at=now()
    WHERE id=v_call.id;
  RETURN 'reserved';
END;
$signal_begin$;

-- Never remove a signaling reservation on uncertainty. A confirmed accept
-- records attribution in the SAME row lock/transaction as its acknowledgment.
CREATE OR REPLACE FUNCTION public.whatsapp_call_signal_finish(
  p_account_id uuid,
  p_phone_number_id text,
  p_call_id text,
  p_actor_user_id uuid,
  p_request_id uuid,
  p_outcome text,
  p_conversation_id uuid DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public
AS $signal_finish$
DECLARE
  v_call public.whatsapp_call_sessions%ROWTYPE;
  v_outcome text;
BEGIN
  IF p_outcome NOT IN ('acknowledged','unknown') THEN
    RAISE EXCEPTION 'invalid_call_signal_outcome' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_call FROM public.whatsapp_call_sessions
    WHERE account_id=p_account_id
      AND phone_number_id=p_phone_number_id
      AND call_id=p_call_id
    FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF v_call.signal_request_id IS DISTINCT FROM p_request_id
    OR v_call.signal_actor_user_id IS DISTINCT FROM p_actor_user_id
    OR v_call.signal_status <> 'reserved'
  THEN RETURN 'denied'; END IF;
  IF p_conversation_id IS NOT NULL AND v_call.conversation_id IS NOT NULL
    AND v_call.conversation_id IS DISTINCT FROM p_conversation_id
  THEN RETURN 'denied'; END IF;

  v_outcome := p_outcome;
  -- Meta may have acknowledged accept but a signed terminal event arrived
  -- independently. Keep status unknown rather than marking an active call.
  IF p_outcome='acknowledged'
    AND v_call.state IN ('terminated','failed','rejected')
  THEN v_outcome := 'unknown'; END IF;

  UPDATE public.whatsapp_call_sessions
    SET signal_status=v_outcome,
        signal_updated_at=now(),
        accepted_by_user_id=CASE
          WHEN v_outcome='acknowledged' AND v_call.signal_action='accept'
            THEN COALESCE(accepted_by_user_id,p_actor_user_id)
          ELSE accepted_by_user_id END,
        conversation_id=CASE
          WHEN v_outcome='acknowledged' AND v_call.signal_action='accept'
            THEN COALESCE(conversation_id,p_conversation_id)
          ELSE conversation_id END,
        updated_at=now()
    WHERE id=v_call.id;
  RETURN v_outcome;
END;
$signal_finish$;

REVOKE ALL ON FUNCTION
  public.whatsapp_call_signal_begin(uuid,text,text,uuid,uuid,text,timestamptz),
  public.whatsapp_call_signal_finish(uuid,text,text,uuid,uuid,text,uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION
  public.whatsapp_call_signal_begin(uuid,text,text,uuid,uuid,text,timestamptz),
  public.whatsapp_call_signal_finish(uuid,text,text,uuid,uuid,text,uuid)
  TO service_role;

-- Existing RPCs are updated to fence active signaling reservations.

CREATE OR REPLACE FUNCTION public.whatsapp_call_claim(
  p_account_id uuid,
  p_phone_number_id text,
  p_call_id text,
  p_actor_user_id uuid
) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public
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
    AND terminal_request_id IS NULL
    AND signal_request_id IS NULL
    AND direction='USER_INITIATED'
    AND state IN ('offered','ringing','connected')
    AND accepted_by_user_id IS NULL
    AND rejected_by_user_id IS NULL
    AND ended_by_user_id IS NULL
    AND session_sdp_expires_at IS NOT NULL
    AND session_sdp_expires_at > now()
    AND (
      claimed_by_user_id IS NULL
      OR claim_expires_at <= now()
      OR claimed_by_user_id=p_actor_user_id
    );
  RETURN FOUND;
END;
$claim$;

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
    AND terminal_request_id IS NULL
    AND signal_status IS DISTINCT FROM 'unknown'
    AND claimed_by_user_id=p_actor_user_id
    AND claim_expires_at > now()
    AND state IN ('offered','ringing','connected')
    AND rejected_by_user_id IS NULL
    AND ended_by_user_id IS NULL;

  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.whatsapp_call_release(
  p_account_id uuid,
  p_phone_number_id text,
  p_call_id text,
  p_actor_user_id uuid
) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public
AS $release$
DECLARE
  v_role public.account_role_enum;
BEGIN
  SELECT account_role INTO v_role
  FROM public.profiles
  WHERE account_id=p_account_id AND user_id=p_actor_user_id;
  IF v_role IS NULL OR v_role NOT IN ('owner','admin','agent') THEN
    RAISE EXCEPTION 'call_release_actor_forbidden' USING ERRCODE='42501';
  END IF;
  UPDATE public.whatsapp_call_sessions
  SET claimed_by_user_id=NULL,claimed_at=NULL,claim_expires_at=NULL,updated_at=now()
  WHERE account_id=p_account_id
    AND phone_number_id=p_phone_number_id
    AND call_id=p_call_id
    AND terminal_request_id IS NULL
    AND signal_request_id IS NULL
    AND (claimed_by_user_id=p_actor_user_id OR v_role IN ('owner','admin'));
  RETURN FOUND;
END;
$release$;

CREATE OR REPLACE FUNCTION public.whatsapp_call_session_agent_sdp_store(
  p_account_id uuid,
  p_phone_number_id text,
  p_call_id text,
  p_actor_user_id uuid,
  p_agent_sdp_encrypted text,
  p_agent_sdp_expires_at timestamptz
) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public
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
    AND terminal_request_id IS NULL
    AND signal_request_id IS NULL
    AND direction='USER_INITIATED'
    AND state IN ('offered','ringing','connected')
    AND claimed_by_user_id=p_actor_user_id
    AND claim_expires_at > now()
    AND rejected_by_user_id IS NULL
    AND ended_by_user_id IS NULL;
  RETURN FOUND;
END;
$store$;

CREATE OR REPLACE FUNCTION public.whatsapp_call_terminal_reserve(
  p_account_id uuid,
  p_phone_number_id text,
  p_call_id text,
  p_actor_user_id uuid,
  p_request_id uuid,
  p_action text,
  p_context text,
  p_expected_claimed_at timestamptz DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public
AS $reserve$
DECLARE
  v_role public.account_role_enum;
  v_call public.whatsapp_call_sessions%ROWTYPE;
  v_claim_active boolean;
  v_allowed boolean := false;
BEGIN
  IF p_request_id IS NULL
    OR p_action NOT IN ('terminate','reject')
    OR p_context NOT IN ('owned_call','claim_cleanup','admin_override','reject')
    OR (p_action='reject' AND p_context<>'reject')
    OR (p_action='terminate' AND p_context='reject')
  THEN
    RAISE EXCEPTION 'invalid_call_terminal_request' USING ERRCODE='22023';
  END IF;

  SELECT account_role INTO v_role FROM public.profiles
  WHERE account_id=p_account_id AND user_id=p_actor_user_id;
  IF v_role IS NULL OR v_role NOT IN ('owner','admin','agent') THEN
    RAISE EXCEPTION 'call_terminal_actor_forbidden' USING ERRCODE='42501';
  END IF;

  SELECT * INTO v_call
  FROM public.whatsapp_call_sessions
  WHERE account_id=p_account_id
    AND phone_number_id=p_phone_number_id
    AND call_id=p_call_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;

  IF v_call.state IN ('terminated','failed','rejected')
    OR v_call.ended_by_user_id IS NOT NULL
    OR v_call.rejected_by_user_id IS NOT NULL
  THEN
    RETURN 'already_terminal';
  END IF;

  IF v_call.terminal_request_id IS NOT NULL THEN
    RETURN 'in_progress';
  END IF;

  -- Signaling that has gone to Meta (or may still arrive there) must never
  -- overlap an externally submitted terminal action.
  IF v_call.signal_status IN ('reserved','unknown') THEN
    RETURN 'in_progress';
  END IF;
  -- An acknowledged pre_accept permits later terminate; accept only after
  -- an acknowledged accept, which sets accepted_by_user_id atomically.


  v_claim_active := COALESCE(v_call.claim_expires_at > now(),false)
    AND v_call.claimed_by_user_id IS NOT NULL;

  IF p_action='reject' THEN
    v_allowed := v_call.direction='USER_INITIATED'
      AND v_call.state IN ('offered','ringing')
      AND v_call.accepted_by_user_id IS NULL
      AND NOT (v_claim_active AND v_call.claimed_by_user_id IS DISTINCT FROM p_actor_user_id);
  ELSIF p_context='claim_cleanup' THEN
    -- The immutable epoch from the original GET protects against stale tabs
    -- and a newly acquired claim, even if it belongs to the same user.
    v_allowed := v_call.direction='USER_INITIATED'
      AND v_call.accepted_by_user_id IS NULL
      AND v_claim_active
      AND v_call.claimed_by_user_id=p_actor_user_id
      AND p_expected_claimed_at IS NOT NULL
      AND v_call.claimed_at=p_expected_claimed_at;
  ELSIF p_context='owned_call' THEN
    v_allowed := (
      v_call.direction='BUSINESS_INITIATED'
        AND v_call.initiated_by_user_id=p_actor_user_id
    ) OR (
      v_call.direction='USER_INITIATED'
        AND v_call.accepted_by_user_id=p_actor_user_id
    );
  ELSIF p_context='admin_override' THEN
    -- Explicit privileged override is NEVER available for an unaccepted UIC
    -- actively claimed by a different agent.
    v_allowed := v_role IN ('owner','admin')
      AND NOT (
        v_call.direction='USER_INITIATED'
        AND v_call.accepted_by_user_id IS NULL
        AND v_claim_active
        AND v_call.claimed_by_user_id IS DISTINCT FROM p_actor_user_id
      );
  END IF;

  IF NOT COALESCE(v_allowed,false) THEN RETURN 'denied'; END IF;

  UPDATE public.whatsapp_call_sessions
  SET terminal_request_id=p_request_id,
      terminal_action=p_action,
      terminal_actor_user_id=p_actor_user_id,
      terminal_status='reserved',
      terminal_reserved_at=now(),
      terminal_updated_at=now(),
      updated_at=now()
  WHERE id=v_call.id;
  RETURN 'reserved';
END;
$reserve$;

CREATE OR REPLACE FUNCTION public.whatsapp_call_sdp_prune(p_limit integer DEFAULT 100)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=public
AS $prune$
DECLARE
  v_limit integer := LEAST(1000,GREATEST(1,COALESCE(p_limit,100)));
  v_inbound_count integer := 0;
  v_sdp_count integer := 0;
  v_attempt_count integer := 0;
BEGIN
  WITH expired_inbound AS (
    SELECT id
    FROM public.whatsapp_call_sessions
    WHERE direction='USER_INITIATED'
      AND state IN ('offered','ringing')
      AND accepted_by_user_id IS NULL
      AND signal_request_id IS NULL
      AND rejected_by_user_id IS NULL
      AND ended_by_user_id IS NULL
      AND (
        (session_sdp_expires_at IS NOT NULL AND session_sdp_expires_at <= now())
        OR (
          session_sdp_expires_at IS NULL
          AND created_at <= now()-interval '5 minutes'
          AND agent_sdp_encrypted IS NULL
          AND agent_sdp_expires_at IS NULL
        )
      )
    ORDER BY COALESCE(session_sdp_expires_at,created_at)
    LIMIT v_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.whatsapp_call_sessions s
  SET state='terminated',
      ended_at=COALESCE(s.ended_at,now()),
      claimed_by_user_id=NULL,
      claimed_at=NULL,
      claim_expires_at=NULL,
      session_sdp_encrypted=NULL,
      session_sdp_type=NULL,
      session_sdp_expires_at=NULL,
      agent_sdp_encrypted=NULL,
      agent_sdp_type=NULL,
      agent_sdp_expires_at=NULL,
      updated_at=now()
  FROM expired_inbound
  WHERE s.id=expired_inbound.id;
  GET DIAGNOSTICS v_inbound_count=ROW_COUNT;

  -- Preserve the existing ephemeral-SDP cleanup for all other sessions.
  WITH expired AS (
    SELECT id
    FROM public.whatsapp_call_sessions
    WHERE (
      session_sdp_encrypted IS NOT NULL
      AND session_sdp_expires_at IS NOT NULL
      AND session_sdp_expires_at <= now()
    ) OR (
      agent_sdp_encrypted IS NOT NULL
      AND agent_sdp_expires_at IS NOT NULL
      AND agent_sdp_expires_at <= now()
    )
    ORDER BY LEAST(
      COALESCE(session_sdp_expires_at,'infinity'::timestamptz),
      COALESCE(agent_sdp_expires_at,'infinity'::timestamptz)
    )
    LIMIT v_limit
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
  FROM expired
  WHERE s.id=expired.id;
  GET DIAGNOSTICS v_sdp_count=ROW_COUNT;

  WITH expired_attempts AS (
    SELECT id
    FROM public.whatsapp_call_outbound_attempts
    WHERE agent_sdp_encrypted IS NOT NULL
      AND agent_sdp_expires_at IS NOT NULL
      AND agent_sdp_expires_at <= now()
    ORDER BY agent_sdp_expires_at
    LIMIT v_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.whatsapp_call_outbound_attempts a
  SET agent_sdp_encrypted=NULL,
      agent_sdp_expires_at=NULL,
      updated_at=now()
  FROM expired_attempts
  WHERE a.id=expired_attempts.id;
  GET DIAGNOSTICS v_attempt_count=ROW_COUNT;

  RETURN v_inbound_count+v_sdp_count+v_attempt_count;
END;
$prune$;
