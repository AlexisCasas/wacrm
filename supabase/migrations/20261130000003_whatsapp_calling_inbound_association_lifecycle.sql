-- CALL-03B2.1: resolve an inbound call to one unambiguous contact and its
-- existing active conversation. This never creates or reopens CRM records.
ALTER TABLE public.whatsapp_call_sessions
  ADD COLUMN IF NOT EXISTS association_error_code text
    CHECK (association_error_code IS NULL OR association_error_code IN (
      'contact_not_found','contact_ambiguous','conversation_not_found'
    ));

CREATE OR REPLACE FUNCTION public.whatsapp_call_resolve_inbound_association(
  p_account_id uuid,
  p_customer_phone text,
  p_customer_bsuid text,
  p_customer_parent_bsuid text
) RETURNS TABLE (
  resolved_contact_id uuid,
  resolved_conversation_id uuid,
  error_code text
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path=public
AS $resolve$
DECLARE
  v_contact_ids uuid[];
  v_contact_id uuid;
  v_conversation_id uuid;
BEGIN
  SELECT array_agg(DISTINCT candidate.contact_id)
    INTO v_contact_ids
  FROM (
    SELECT i.contact_id
    FROM public.contact_identities i
    WHERE i.account_id=p_account_id
      AND (
        (p_customer_bsuid IS NOT NULL AND i.kind='bsuid' AND i.value=p_customer_bsuid)
        OR
        (p_customer_parent_bsuid IS NOT NULL AND i.kind='parent_bsuid' AND i.value=p_customer_parent_bsuid)
      )

    UNION

    SELECT c.id AS contact_id
    FROM public.contacts c
    WHERE c.account_id=p_account_id
      AND COALESCE(c.phone_normalized,'') <> ''
      AND c.phone_normalized=regexp_replace(COALESCE(p_customer_phone,''),'\D','','g')
  ) AS candidate;

  IF COALESCE(cardinality(v_contact_ids),0)=0 THEN
    resolved_contact_id := NULL;
    resolved_conversation_id := NULL;
    error_code := 'contact_not_found';
    RETURN NEXT;
    RETURN;
  END IF;

  IF cardinality(v_contact_ids)>1 THEN
    resolved_contact_id := NULL;
    resolved_conversation_id := NULL;
    error_code := 'contact_ambiguous';
    RETURN NEXT;
    RETURN;
  END IF;

  v_contact_id := v_contact_ids[1];

  SELECT c.id
    INTO v_conversation_id
  FROM public.conversations c
  WHERE c.account_id=p_account_id
    AND c.contact_id=v_contact_id
    AND c.status IN ('open','pending')
  ORDER BY CASE WHEN c.status='open' THEN 0 ELSE 1 END,
           c.updated_at DESC,
           c.created_at DESC,
           c.id
  LIMIT 1;

  resolved_contact_id := v_contact_id;
  resolved_conversation_id := v_conversation_id;
  error_code := CASE WHEN v_conversation_id IS NULL THEN 'conversation_not_found' ELSE NULL END;
  RETURN NEXT;
END;
$resolve$;

REVOKE ALL ON FUNCTION public.whatsapp_call_resolve_inbound_association(uuid,text,text,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.whatsapp_call_resolve_inbound_association(uuid,text,text,text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.whatsapp_call_event_apply(
  p_account_id uuid,
  p_phone_number_id text,
  p_call_id text,
  p_event_key text,
  p_event_name text,
  p_meta_timestamp bigint,
  p_direction text,
  p_customer_key text,
  p_customer_phone text,
  p_customer_bsuid text,
  p_customer_parent_bsuid text,
  p_customer_name text,
  p_state text,
  p_session_sdp_encrypted text,
  p_session_sdp_type text,
  p_session_sdp_expires_at timestamptz,
  p_started_at timestamptz,
  p_ended_at timestamptz,
  p_duration_seconds integer
) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE
  v_inserted integer;
  v_contact_id uuid;
  v_conversation_id uuid;
  v_association_error_code text;
BEGIN
  IF p_account_id IS NULL
    OR p_phone_number_id !~ '^[0-9]{5,25}$'
    OR p_call_id NOT LIKE 'wacid.%'
    OR length(p_call_id) NOT BETWEEN 7 AND 518
    OR p_event_key !~ '^[a-f0-9]{64}$'
    OR p_meta_timestamp IS NULL
    OR p_event_name NOT IN ('connect','terminate','status')
    OR (p_direction IS NOT NULL AND p_direction NOT IN ('USER_INITIATED','BUSINESS_INITIATED'))
    OR (p_state IS NOT NULL AND p_state NOT IN ('offered','ringing','connecting','connected','terminated','failed','rejected'))
    OR (p_session_sdp_encrypted IS NOT NULL AND (
      length(p_session_sdp_encrypted) > 140000
      OR p_session_sdp_type IS NULL
      OR p_session_sdp_type NOT IN ('offer','answer')
      OR p_session_sdp_expires_at IS NULL
    ))
    OR (p_session_sdp_encrypted IS NULL AND (
      p_session_sdp_type IS NOT NULL OR p_session_sdp_expires_at IS NOT NULL
    ))
  THEN
    RAISE EXCEPTION 'invalid_call_event' USING ERRCODE='22023';
  END IF;

  -- Only user-initiated connect events need webhook-side Inbox association.
  -- Outbound attempts already carry a trusted contact/conversation from the
  -- authenticated request and are linked by CALL-03B's completion RPC.
  IF p_event_name = 'connect' AND p_direction = 'USER_INITIATED' THEN
    SELECT resolved.resolved_contact_id,
           resolved.resolved_conversation_id,
           resolved.error_code
      INTO v_contact_id, v_conversation_id, v_association_error_code
    FROM public.whatsapp_call_resolve_inbound_association(
      p_account_id,
      p_customer_phone,
      p_customer_bsuid,
      p_customer_parent_bsuid
    ) AS resolved;
  END IF;

  INSERT INTO public.whatsapp_call_events(account_id,phone_number_id,call_id,event_key,event_name,meta_timestamp)
  VALUES (p_account_id,p_phone_number_id,p_call_id,p_event_key,p_event_name,p_meta_timestamp)
  ON CONFLICT (phone_number_id,event_key) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN RETURN false; END IF;

  INSERT INTO public.whatsapp_call_sessions(
    account_id,phone_number_id,call_id,direction,customer_key,customer_phone,
    customer_bsuid,customer_parent_bsuid,customer_name,contact_id,conversation_id,
    association_error_code,state,session_sdp_encrypted,session_sdp_type,session_sdp_expires_at,
    started_at,ended_at,duration_seconds,last_meta_event,last_meta_timestamp,updated_at
  ) VALUES (
    p_account_id,p_phone_number_id,p_call_id,p_direction,p_customer_key,p_customer_phone,
    p_customer_bsuid,p_customer_parent_bsuid,p_customer_name,v_contact_id,v_conversation_id,
    v_association_error_code,COALESCE(p_state,'offered'),p_session_sdp_encrypted,p_session_sdp_type,p_session_sdp_expires_at,
    p_started_at,p_ended_at,p_duration_seconds,p_event_name,p_meta_timestamp,now()
  )
  ON CONFLICT (phone_number_id,call_id) DO UPDATE SET
    direction=COALESCE(EXCLUDED.direction,whatsapp_call_sessions.direction),
    contact_id=COALESCE(whatsapp_call_sessions.contact_id,EXCLUDED.contact_id),
    conversation_id=CASE
      WHEN whatsapp_call_sessions.contact_id IS NULL
        OR whatsapp_call_sessions.contact_id IS NOT DISTINCT FROM EXCLUDED.contact_id
      THEN COALESCE(whatsapp_call_sessions.conversation_id,EXCLUDED.conversation_id)
      ELSE whatsapp_call_sessions.conversation_id
    END,
    association_error_code=CASE
      WHEN whatsapp_call_sessions.contact_id IS NOT NULL
        AND whatsapp_call_sessions.conversation_id IS NOT NULL
      THEN whatsapp_call_sessions.association_error_code
      WHEN EXCLUDED.conversation_id IS NOT NULL THEN NULL
      WHEN whatsapp_call_sessions.contact_id IS NOT NULL
        AND whatsapp_call_sessions.contact_id IS DISTINCT FROM EXCLUDED.contact_id
      THEN whatsapp_call_sessions.association_error_code
      ELSE COALESCE(EXCLUDED.association_error_code,whatsapp_call_sessions.association_error_code)
    END,
    customer_key=COALESCE(EXCLUDED.customer_key,whatsapp_call_sessions.customer_key),
    customer_phone=COALESCE(EXCLUDED.customer_phone,whatsapp_call_sessions.customer_phone),
    customer_bsuid=COALESCE(EXCLUDED.customer_bsuid,whatsapp_call_sessions.customer_bsuid),
    customer_parent_bsuid=COALESCE(EXCLUDED.customer_parent_bsuid,whatsapp_call_sessions.customer_parent_bsuid),
    customer_name=COALESCE(EXCLUDED.customer_name,whatsapp_call_sessions.customer_name),
    state=CASE
      WHEN EXCLUDED.last_meta_timestamp < COALESCE(whatsapp_call_sessions.last_meta_timestamp,0)
        OR whatsapp_call_sessions.state IN ('terminated','failed','rejected')
      THEN whatsapp_call_sessions.state
      ELSE COALESCE(EXCLUDED.state,whatsapp_call_sessions.state)
    END,
    session_sdp_encrypted=CASE
      WHEN EXCLUDED.last_meta_timestamp < COALESCE(whatsapp_call_sessions.last_meta_timestamp,0)
        THEN CASE
          WHEN whatsapp_call_sessions.session_sdp_encrypted IS NULL
            AND whatsapp_call_sessions.state NOT IN ('terminated','failed','rejected')
            AND EXCLUDED.session_sdp_encrypted IS NOT NULL
          THEN EXCLUDED.session_sdp_encrypted
          ELSE whatsapp_call_sessions.session_sdp_encrypted
        END
      WHEN EXCLUDED.state IN ('terminated','failed','rejected') THEN NULL
      WHEN EXCLUDED.session_sdp_encrypted IS NOT NULL THEN EXCLUDED.session_sdp_encrypted
      ELSE whatsapp_call_sessions.session_sdp_encrypted
    END,
    session_sdp_type=CASE
      WHEN EXCLUDED.last_meta_timestamp < COALESCE(whatsapp_call_sessions.last_meta_timestamp,0)
        THEN CASE
          WHEN whatsapp_call_sessions.session_sdp_encrypted IS NULL
            AND whatsapp_call_sessions.state NOT IN ('terminated','failed','rejected')
            AND EXCLUDED.session_sdp_encrypted IS NOT NULL
          THEN EXCLUDED.session_sdp_type
          ELSE whatsapp_call_sessions.session_sdp_type
        END
      WHEN EXCLUDED.state IN ('terminated','failed','rejected') THEN NULL
      WHEN EXCLUDED.session_sdp_encrypted IS NOT NULL THEN EXCLUDED.session_sdp_type
      ELSE whatsapp_call_sessions.session_sdp_type
    END,
    session_sdp_expires_at=CASE
      WHEN EXCLUDED.last_meta_timestamp < COALESCE(whatsapp_call_sessions.last_meta_timestamp,0)
        THEN CASE
          WHEN whatsapp_call_sessions.session_sdp_encrypted IS NULL
            AND whatsapp_call_sessions.state NOT IN ('terminated','failed','rejected')
            AND EXCLUDED.session_sdp_encrypted IS NOT NULL
          THEN EXCLUDED.session_sdp_expires_at
          ELSE whatsapp_call_sessions.session_sdp_expires_at
        END
      WHEN EXCLUDED.state IN ('terminated','failed','rejected') THEN NULL
      WHEN EXCLUDED.session_sdp_encrypted IS NOT NULL THEN EXCLUDED.session_sdp_expires_at
      ELSE whatsapp_call_sessions.session_sdp_expires_at
    END,
    started_at=COALESCE(whatsapp_call_sessions.started_at,EXCLUDED.started_at),
    ended_at=CASE
      WHEN EXCLUDED.last_meta_timestamp >= COALESCE(whatsapp_call_sessions.last_meta_timestamp,0)
      THEN COALESCE(EXCLUDED.ended_at,whatsapp_call_sessions.ended_at)
      ELSE whatsapp_call_sessions.ended_at
    END,
    duration_seconds=CASE
      WHEN EXCLUDED.last_meta_timestamp >= COALESCE(whatsapp_call_sessions.last_meta_timestamp,0)
      THEN COALESCE(EXCLUDED.duration_seconds,whatsapp_call_sessions.duration_seconds)
      ELSE whatsapp_call_sessions.duration_seconds
    END,
    claimed_by_user_id=CASE
      WHEN EXCLUDED.last_meta_timestamp >= COALESCE(whatsapp_call_sessions.last_meta_timestamp,0)
        AND EXCLUDED.state IN ('terminated','failed','rejected') THEN NULL
      ELSE whatsapp_call_sessions.claimed_by_user_id
    END,
    claimed_at=CASE
      WHEN EXCLUDED.last_meta_timestamp >= COALESCE(whatsapp_call_sessions.last_meta_timestamp,0)
        AND EXCLUDED.state IN ('terminated','failed','rejected') THEN NULL
      ELSE whatsapp_call_sessions.claimed_at
    END,
    claim_expires_at=CASE
      WHEN EXCLUDED.last_meta_timestamp >= COALESCE(whatsapp_call_sessions.last_meta_timestamp,0)
        AND EXCLUDED.state IN ('terminated','failed','rejected') THEN NULL
      ELSE whatsapp_call_sessions.claim_expires_at
    END,
    last_meta_event=CASE
      WHEN EXCLUDED.last_meta_timestamp >= COALESCE(whatsapp_call_sessions.last_meta_timestamp,0)
      THEN EXCLUDED.last_meta_event
      ELSE whatsapp_call_sessions.last_meta_event
    END,
    last_meta_timestamp=GREATEST(
      COALESCE(whatsapp_call_sessions.last_meta_timestamp,0),EXCLUDED.last_meta_timestamp
    ),
    updated_at=now()
  WHERE whatsapp_call_sessions.account_id=EXCLUDED.account_id;

  IF NOT FOUND THEN RAISE EXCEPTION 'call_tenant_conflict' USING ERRCODE='42501'; END IF;
  RETURN true;
END $$;

-- Backfill still-active inbound calls created before this migration.
-- Ambiguous and missing identities remain unlinked with an explicit reason.
WITH resolved AS (
  SELECT s.id,
         association.resolved_contact_id,
         association.resolved_conversation_id,
         association.error_code
  FROM public.whatsapp_call_sessions s
  CROSS JOIN LATERAL public.whatsapp_call_resolve_inbound_association(
    s.account_id,
    s.customer_phone,
    s.customer_bsuid,
    s.customer_parent_bsuid
  ) AS association
  WHERE s.direction='USER_INITIATED'
    AND s.contact_id IS NULL
    AND s.state IN ('offered','ringing','connected')
)
UPDATE public.whatsapp_call_sessions s
SET contact_id=resolved.resolved_contact_id,
    conversation_id=resolved.resolved_conversation_id,
    association_error_code=resolved.error_code,
    updated_at=now()
FROM resolved
WHERE s.id=resolved.id
  AND s.contact_id IS NULL;

-- Expire unanswered inbound offers when their short-lived SDP expires.
-- The API calls this bounded cleanup before listing, claiming or signaling calls.
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
      AND session_sdp_expires_at IS NOT NULL
      AND session_sdp_expires_at <= now()
    ORDER BY session_sdp_expires_at
    LIMIT v_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.whatsapp_call_sessions s
  SET state='failed',
      ended_at=COALESCE(s.ended_at,now()),
      claimed_by_user_id=NULL,
      claimed_at=NULL,
      claim_expires_at=NULL,
      session_sdp_encrypted=NULL,
      session_sdp_type=NULL,
      session_sdp_expires_at=NULL,
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

