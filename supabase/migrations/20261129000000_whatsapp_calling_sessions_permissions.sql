-- CALL-02: tenant-isolated durable Calling sessions, events and permissions.
-- SDP is encrypted by the application before persistence and is short-lived.
-- All tables and RPCs are restricted to service_role; no browser-facing access.

CREATE TABLE IF NOT EXISTS public.whatsapp_call_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  phone_number_id text NOT NULL CHECK (phone_number_id ~ '^[0-9]{5,25}$'),
  call_id text NOT NULL CHECK (call_id LIKE 'wacid.%' AND length(call_id) BETWEEN 7 AND 518),
  direction text CHECK (direction IN ('USER_INITIATED','BUSINESS_INITIATED')),
  customer_key text,
  customer_phone text,
  customer_bsuid text,
  customer_parent_bsuid text,
  customer_name text,
  state text NOT NULL DEFAULT 'offered'
    CHECK (state IN ('offered','ringing','connecting','connected','terminated','failed','rejected')),
  session_sdp_encrypted text,
  session_sdp_type text CHECK (session_sdp_type IN ('offer','answer')),
  session_sdp_expires_at timestamptz,
  started_at timestamptz,
  ended_at timestamptz,
  duration_seconds integer CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  last_meta_event text,
  last_meta_timestamp bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(phone_number_id, call_id)
);
CREATE INDEX IF NOT EXISTS whatsapp_call_sessions_account_recent_idx
  ON public.whatsapp_call_sessions(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS whatsapp_call_sessions_customer_recent_idx
  ON public.whatsapp_call_sessions(account_id, customer_key, created_at DESC);
CREATE INDEX IF NOT EXISTS whatsapp_call_sessions_active_idx
  ON public.whatsapp_call_sessions(account_id, state, created_at DESC)
  WHERE state IN ('offered','ringing','connecting','connected');

CREATE TABLE IF NOT EXISTS public.whatsapp_call_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  phone_number_id text NOT NULL CHECK (phone_number_id ~ '^[0-9]{5,25}$'),
  call_id text NOT NULL CHECK (call_id LIKE 'wacid.%' AND length(call_id) BETWEEN 7 AND 518),
  event_key text NOT NULL CHECK (event_key ~ '^[a-f0-9]{64}$'),
  event_name text NOT NULL CHECK (event_name IN ('connect','terminate','status')),
  meta_timestamp bigint NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(phone_number_id, event_key)
);
CREATE INDEX IF NOT EXISTS whatsapp_call_events_account_recent_idx
  ON public.whatsapp_call_events(account_id, received_at DESC);

CREATE TABLE IF NOT EXISTS public.whatsapp_call_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  phone_number_id text NOT NULL CHECK (phone_number_id ~ '^[0-9]{5,25}$'),
  customer_key text NOT NULL CHECK (length(customer_key) BETWEEN 1 AND 256),
  customer_phone text,
  customer_bsuid text,
  customer_parent_bsuid text,
  permission_state text NOT NULL CHECK (permission_state IN ('approved','rejected')),
  permission_type text CHECK (permission_type IN ('temporary','permanent')),
  expires_at timestamptz,
  response_source text CHECK (response_source IN ('user_action','automatic')),
  source_message_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (permission_state='rejected' AND permission_type IS NULL AND expires_at IS NULL)
    OR (permission_state='approved' AND permission_type='permanent' AND expires_at IS NULL)
    OR (permission_state='approved' AND permission_type='temporary' AND expires_at IS NOT NULL)
  ),
  UNIQUE(phone_number_id, customer_key)
);
CREATE INDEX IF NOT EXISTS whatsapp_call_permissions_account_idx
  ON public.whatsapp_call_permissions(account_id, customer_key);

ALTER TABLE public.whatsapp_call_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_call_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_call_permissions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.whatsapp_call_sessions, public.whatsapp_call_events, public.whatsapp_call_permissions
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_call_sessions, public.whatsapp_call_events, public.whatsapp_call_permissions
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
      length(p_session_sdp_encrypted)>140000 OR p_session_sdp_type NOT IN ('offer','answer')
    ))
  THEN
    RAISE EXCEPTION 'invalid_call_event' USING ERRCODE='22023';
  END IF;

  INSERT INTO public.whatsapp_call_events(
    account_id,phone_number_id,call_id,event_key,event_name,meta_timestamp
  ) VALUES (
    p_account_id,p_phone_number_id,p_call_id,p_event_key,p_event_name,p_meta_timestamp
  )
  ON CONFLICT(phone_number_id,event_key) DO NOTHING;

  GET DIAGNOSTICS v_inserted=ROW_COUNT;
  IF v_inserted=0 THEN RETURN false; END IF;

  INSERT INTO public.whatsapp_call_sessions(
    account_id,phone_number_id,call_id,direction,customer_key,customer_phone,
    customer_bsuid,customer_parent_bsuid,customer_name,state,
    session_sdp_encrypted,session_sdp_type,session_sdp_expires_at,
    started_at,ended_at,duration_seconds,last_meta_event,last_meta_timestamp,updated_at
  ) VALUES (
    p_account_id,p_phone_number_id,p_call_id,p_direction,p_customer_key,p_customer_phone,
    p_customer_bsuid,p_customer_parent_bsuid,p_customer_name,COALESCE(p_state,'offered'),
    p_session_sdp_encrypted,p_session_sdp_type,p_session_sdp_expires_at,
    p_started_at,p_ended_at,p_duration_seconds,p_event_name,p_meta_timestamp,now()
  )
  ON CONFLICT(phone_number_id,call_id) DO UPDATE SET
    direction=COALESCE(EXCLUDED.direction,whatsapp_call_sessions.direction),
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
        THEN whatsapp_call_sessions.session_sdp_encrypted
      WHEN EXCLUDED.state IN ('terminated','failed','rejected') THEN NULL
      WHEN EXCLUDED.session_sdp_encrypted IS NOT NULL THEN EXCLUDED.session_sdp_encrypted
      ELSE whatsapp_call_sessions.session_sdp_encrypted
    END,
    session_sdp_type=CASE
      WHEN EXCLUDED.last_meta_timestamp < COALESCE(whatsapp_call_sessions.last_meta_timestamp,0)
        THEN whatsapp_call_sessions.session_sdp_type
      WHEN EXCLUDED.state IN ('terminated','failed','rejected') THEN NULL
      WHEN EXCLUDED.session_sdp_encrypted IS NOT NULL THEN EXCLUDED.session_sdp_type
      ELSE whatsapp_call_sessions.session_sdp_type
    END,
    session_sdp_expires_at=CASE
      WHEN EXCLUDED.last_meta_timestamp < COALESCE(whatsapp_call_sessions.last_meta_timestamp,0)
        THEN whatsapp_call_sessions.session_sdp_expires_at
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

CREATE OR REPLACE FUNCTION public.whatsapp_call_permission_upsert(
  p_account_id uuid,
  p_phone_number_id text,
  p_customer_key text,
  p_customer_phone text,
  p_customer_bsuid text,
  p_customer_parent_bsuid text,
  p_permission_state text,
  p_permission_type text,
  p_expires_at timestamptz,
  p_response_source text,
  p_source_message_id text
) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
BEGIN
  IF p_account_id IS NULL
    OR p_phone_number_id !~ '^[0-9]{5,25}$'
    OR p_customer_key IS NULL
    OR length(p_customer_key) NOT BETWEEN 1 AND 256
    OR p_permission_state NOT IN ('approved','rejected')
    OR (p_permission_state='approved' AND (
      p_permission_type IS NULL OR p_permission_type NOT IN ('temporary','permanent')
    ))
    OR (p_permission_state='rejected' AND (p_permission_type IS NOT NULL OR p_expires_at IS NOT NULL))
    OR (p_permission_type='temporary' AND p_expires_at IS NULL)
    OR (p_permission_type='permanent' AND p_expires_at IS NOT NULL)
    OR (p_response_source IS NOT NULL AND p_response_source NOT IN ('user_action','automatic'))
  THEN
    RAISE EXCEPTION 'invalid_call_permission' USING ERRCODE='22023';
  END IF;

  INSERT INTO public.whatsapp_call_permissions(
    account_id,phone_number_id,customer_key,customer_phone,customer_bsuid,customer_parent_bsuid,
    permission_state,permission_type,expires_at,response_source,source_message_id,updated_at
  ) VALUES (
    p_account_id,p_phone_number_id,p_customer_key,p_customer_phone,p_customer_bsuid,p_customer_parent_bsuid,
    p_permission_state,p_permission_type,p_expires_at,p_response_source,p_source_message_id,now()
  )
  ON CONFLICT(phone_number_id,customer_key) DO UPDATE SET
    customer_phone=EXCLUDED.customer_phone,
    customer_bsuid=EXCLUDED.customer_bsuid,
    customer_parent_bsuid=EXCLUDED.customer_parent_bsuid,
    permission_state=EXCLUDED.permission_state,
    permission_type=EXCLUDED.permission_type,
    expires_at=EXCLUDED.expires_at,
    response_source=EXCLUDED.response_source,
    source_message_id=EXCLUDED.source_message_id,
    updated_at=now()
  WHERE whatsapp_call_permissions.account_id=EXCLUDED.account_id;

  IF NOT FOUND THEN RAISE EXCEPTION 'call_permission_tenant_conflict' USING ERRCODE='42501'; END IF;
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION public.whatsapp_call_event_apply(
  uuid,text,text,text,text,bigint,text,text,text,text,text,text,text,text,text,timestamptz,timestamptz,timestamptz,integer
), public.whatsapp_call_permission_upsert(
  uuid,text,text,text,text,text,text,text,timestamptz,text,text
) FROM PUBLIC,anon,authenticated;

GRANT EXECUTE ON FUNCTION public.whatsapp_call_event_apply(
  uuid,text,text,text,text,bigint,text,text,text,text,text,text,text,text,text,timestamptz,timestamptz,timestamptz,integer
), public.whatsapp_call_permission_upsert(
  uuid,text,text,text,text,text,text,text,timestamptz,text,text
) TO service_role;
