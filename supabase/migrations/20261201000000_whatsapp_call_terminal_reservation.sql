-- CALL-03B2.5: reserve a terminal Meta side effect before issuing it.
-- A terminal reservation is permanent until a trusted reconciliation: network
-- uncertainty must never silently unlock the call or trigger another Meta POST.
-- Versioned ADDITIVE migration. Only service_role can execute these RPCs.

ALTER TABLE public.whatsapp_call_sessions
  ADD COLUMN terminal_request_id uuid,
  ADD COLUMN terminal_action text CHECK (terminal_action IN ('terminate','reject')),
  ADD COLUMN terminal_actor_user_id uuid,
  ADD COLUMN terminal_status text CHECK (terminal_status IN ('reserved','acknowledged','unknown')),
  ADD COLUMN terminal_reserved_at timestamptz,
  ADD COLUMN terminal_updated_at timestamptz;

ALTER TABLE public.whatsapp_call_sessions
  ADD CONSTRAINT whatsapp_call_terminal_reservation_shape_ck CHECK (
    (terminal_request_id IS NULL
      AND terminal_action IS NULL AND terminal_actor_user_id IS NULL
      AND terminal_status IS NULL AND terminal_reserved_at IS NULL
      AND terminal_updated_at IS NULL)
    OR
    (terminal_request_id IS NOT NULL
      AND terminal_action IS NOT NULL AND terminal_actor_user_id IS NOT NULL
      AND terminal_status IS NOT NULL AND terminal_reserved_at IS NOT NULL
      AND terminal_updated_at IS NOT NULL)
  );

-- Claim and terminal_reserve update the SAME row. PostgreSQL locks this row
-- for the duration of either statement/transaction, serializing both decisions.
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

-- A release cannot remove the held owner while terminal work is reserved.
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
    AND (claimed_by_user_id=p_actor_user_id OR v_role IN ('owner','admin'));
  RETURN FOUND;
END;
$release$;

-- No fresh agent SDP may be written after a terminal action was reserved.
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
    AND direction='USER_INITIATED'
    AND state IN ('offered','ringing','connected')
    AND claimed_by_user_id=p_actor_user_id
    AND claim_expires_at > now()
    AND rejected_by_user_id IS NULL
    AND ended_by_user_id IS NULL;
  RETURN FOUND;
END;
$store$;

-- RETURNS: reserved | in_progress | already_terminal | denied | not_found
-- No HTTP call is made in this transaction. The reservation survives COMMIT.
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

-- Complete a previously reserved request, without clearing it. A Meta error
-- is ambiguous even if HTTP reports failure; never automatically retry it.
CREATE OR REPLACE FUNCTION public.whatsapp_call_terminal_finish(
  p_account_id uuid,
  p_phone_number_id text,
  p_call_id text,
  p_actor_user_id uuid,
  p_request_id uuid,
  p_outcome text
) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public
AS $finish$
BEGIN
  IF p_outcome NOT IN ('acknowledged','unknown') THEN
    RAISE EXCEPTION 'invalid_call_terminal_outcome' USING ERRCODE='22023';
  END IF;
  UPDATE public.whatsapp_call_sessions
  SET terminal_status=p_outcome,
      terminal_updated_at=now(),
      updated_at=now()
  WHERE account_id=p_account_id
    AND phone_number_id=p_phone_number_id
    AND call_id=p_call_id
    AND terminal_actor_user_id=p_actor_user_id
    AND terminal_request_id=p_request_id
    AND terminal_status='reserved';
  RETURN FOUND;
END;
$finish$;

REVOKE ALL ON FUNCTION
  public.whatsapp_call_terminal_reserve(uuid,text,text,uuid,uuid,text,text,timestamptz),
  public.whatsapp_call_terminal_finish(uuid,text,text,uuid,uuid,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.whatsapp_call_terminal_reserve(uuid,text,text,uuid,uuid,text,text,timestamptz),
  public.whatsapp_call_terminal_finish(uuid,text,text,uuid,uuid,text)
  TO service_role;
