-- CALL-03B2.6 — RPC fencing and atomic acceptance attribution.
-- The sentinel forces a transaction rollback, leaving zero persistent fixtures.
DO $qa$
DECLARE
  a uuid := 'd6000000-0000-4000-8000-000000000001';
  b uuid := 'd6000000-0000-4000-8000-000000000002';
  acc uuid;
  phone text := '740434745820831';
  c1 text := 'wacid.qa-signal-before-terminal';
  c2 text := 'wacid.qa-terminal-before-signal';
  c3 text := 'wacid.qa-signal-unknown';
  epoch1 timestamptz;
  epoch2 timestamptz;
  epoch3 timestamptz;
  q1 uuid := gen_random_uuid();
  q2 uuid := gen_random_uuid();
  q3 uuid := gen_random_uuid();
BEGIN
  BEGIN
    IF to_regprocedure('public.whatsapp_call_signal_begin(uuid,text,text,uuid,uuid,text,timestamptz)') IS NULL
      OR to_regprocedure('public.whatsapp_call_signal_finish(uuid,text,text,uuid,uuid,text,uuid)') IS NULL
    THEN RAISE EXCEPTION 'CALL036_RPC_MISSING'; END IF;
    IF has_function_privilege('anon','public.whatsapp_call_signal_begin(uuid,text,text,uuid,uuid,text,timestamptz)','EXECUTE')
      OR has_function_privilege('authenticated','public.whatsapp_call_signal_begin(uuid,text,text,uuid,uuid,text,timestamptz)','EXECUTE')
      OR has_function_privilege('anon','public.whatsapp_call_signal_finish(uuid,text,text,uuid,uuid,text,uuid)','EXECUTE')
      OR has_function_privilege('authenticated','public.whatsapp_call_signal_finish(uuid,text,text,uuid,uuid,text,uuid)','EXECUTE')
      OR NOT has_function_privilege('service_role','public.whatsapp_call_signal_begin(uuid,text,text,uuid,uuid,text,timestamptz)','EXECUTE')
      OR NOT has_function_privilege('service_role','public.whatsapp_call_signal_finish(uuid,text,text,uuid,uuid,text,uuid)','EXECUTE')
    THEN RAISE EXCEPTION 'CALL036_ACL_INVALID'; END IF;

    INSERT INTO auth.users(
      id,aud,role,email,encrypted_password,email_confirmed_at,
      raw_app_meta_data,raw_user_meta_data,created_at,updated_at
    ) VALUES
      (a,'authenticated','authenticated','call036-a@example.invalid','',now(),'{}'::jsonb,'{}'::jsonb,now(),now()),
      (b,'authenticated','authenticated','call036-b@example.invalid','',now(),'{}'::jsonb,'{}'::jsonb,now(),now());
    SELECT account_id INTO acc FROM public.profiles WHERE user_id=a;
    UPDATE public.profiles SET account_id=acc,account_role='agent' WHERE user_id=b;
    DELETE FROM public.accounts WHERE owner_user_id=b;
    IF acc IS NULL THEN RAISE EXCEPTION 'CALL036_ACCOUNT_MISSING'; END IF;
    INSERT INTO public.whatsapp_call_sessions(
      account_id,phone_number_id,call_id,direction,state,
      session_sdp_encrypted,session_sdp_type,session_sdp_expires_at
    ) VALUES
      (acc,phone,c1,'USER_INITIATED','offered','qa-offer','offer',now()+interval '2 minutes'),
      (acc,phone,c2,'USER_INITIATED','offered','qa-offer','offer',now()+interval '2 minutes'),
      (acc,phone,c3,'USER_INITIATED','offered','qa-offer','offer',now()+interval '2 minutes');
    IF public.whatsapp_call_claim(acc,phone,c1,a) IS DISTINCT FROM true
      OR public.whatsapp_call_claim(acc,phone,c2,a) IS DISTINCT FROM true
      OR public.whatsapp_call_claim(acc,phone,c3,a) IS DISTINCT FROM true
    THEN RAISE EXCEPTION 'CALL036_CLAIM_FAILED'; END IF;
    SELECT claimed_at INTO epoch1 FROM public.whatsapp_call_sessions WHERE call_id=c1;
    SELECT claimed_at INTO epoch2 FROM public.whatsapp_call_sessions WHERE call_id=c2;
    SELECT claimed_at INTO epoch3 FROM public.whatsapp_call_sessions WHERE call_id=c3;
    IF public.whatsapp_call_session_agent_sdp_store(acc,phone,c1,a,'qa-answer',now()+interval '90 seconds') IS DISTINCT FROM true
      OR public.whatsapp_call_session_agent_sdp_store(acc,phone,c2,a,'qa-answer',now()+interval '90 seconds') IS DISTINCT FROM true
      OR public.whatsapp_call_session_agent_sdp_store(acc,phone,c3,a,'qa-answer',now()+interval '90 seconds') IS DISTINCT FROM true
    THEN RAISE EXCEPTION 'CALL036_SDP_STORE_FAILED'; END IF;

    -- pre_accept reserves first -> terminate/other agent claim lose.
    IF public.whatsapp_call_signal_begin(acc,phone,c1,a,q1,'pre_accept',epoch1) IS DISTINCT FROM 'reserved'
    THEN RAISE EXCEPTION 'CALL036_SIGNAL_RESERVE_FAILED'; END IF;
    IF public.whatsapp_call_terminal_reserve(acc,phone,c1,a,gen_random_uuid(),'terminate','claim_cleanup',epoch1) IS DISTINCT FROM 'in_progress'
      OR public.whatsapp_call_claim(acc,phone,c1,b) IS DISTINCT FROM false
      OR public.whatsapp_call_release(acc,phone,c1,a) IS DISTINCT FROM false
    THEN RAISE EXCEPTION 'CALL036_SIGNAL_NOT_FENCED'; END IF;
    IF public.whatsapp_call_signal_begin(acc,phone,c1,a,gen_random_uuid(),'pre_accept',epoch1) IS DISTINCT FROM 'in_progress'
    THEN RAISE EXCEPTION 'CALL036_DUPLICATE_META_PRE_ACCEPT'; END IF;
    IF public.whatsapp_call_signal_finish(acc,phone,c1,a,q1,'acknowledged',NULL) IS DISTINCT FROM 'acknowledged'
    THEN RAISE EXCEPTION 'CALL036_PRE_ACCEPT_ACK_MISSING'; END IF;
    IF public.whatsapp_call_signal_begin(acc,phone,c1,a,gen_random_uuid(),'pre_accept',epoch1) IS DISTINCT FROM 'already_acknowledged'
    THEN RAISE EXCEPTION 'CALL036_PRE_ACCEPT_IDEMPOTENCY_FAILED'; END IF;

    IF public.whatsapp_call_signal_begin(acc,phone,c1,a,q2,'accept',epoch1) IS DISTINCT FROM 'reserved'
      OR public.whatsapp_call_terminal_reserve(acc,phone,c1,a,gen_random_uuid(),'terminate','claim_cleanup',epoch1) IS DISTINCT FROM 'in_progress'
    THEN RAISE EXCEPTION 'CALL036_ACCEPT_NOT_FENCED'; END IF;
    IF public.whatsapp_call_signal_finish(acc,phone,c1,b,q2,'acknowledged',NULL) IS DISTINCT FROM 'denied'
    THEN RAISE EXCEPTION 'CALL036_FOREIGN_AGENT_FINISHED_ACCEPT'; END IF;
    IF public.whatsapp_call_signal_finish(acc,phone,c1,a,q2,'acknowledged',NULL) IS DISTINCT FROM 'acknowledged'
    THEN RAISE EXCEPTION 'CALL036_ACCEPT_ACK_FAILED'; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.whatsapp_call_sessions
      WHERE account_id=acc AND call_id=c1 AND accepted_by_user_id=a
        AND signal_action='accept' AND signal_status='acknowledged'
    ) THEN RAISE EXCEPTION 'CALL036_ATOMIC_ACCEPT_ATTRIBUTION_MISSING'; END IF;
    IF public.whatsapp_call_terminal_reserve(acc,phone,c1,a,gen_random_uuid(),'terminate','owned_call',NULL) IS DISTINCT FROM 'reserved'
    THEN RAISE EXCEPTION 'CALL036_ACKNOWLEDGED_ACCEPT_NOT_TERMINABLE'; END IF;

    -- Termination reserves first -> signal reservation loses.
    IF public.whatsapp_call_terminal_reserve(acc,phone,c2,a,gen_random_uuid(),'terminate','claim_cleanup',epoch2) IS DISTINCT FROM 'reserved'
      OR public.whatsapp_call_signal_begin(acc,phone,c2,a,gen_random_uuid(),'pre_accept',epoch2) IS DISTINCT FROM 'terminal_in_progress'
      OR public.whatsapp_call_signal_begin(acc,phone,c2,a,gen_random_uuid(),'accept',epoch2) IS DISTINCT FROM 'terminal_in_progress'
    THEN RAISE EXCEPTION 'CALL036_TERMINAL_FIRST_NOT_FENCED'; END IF;

    -- Unknown Meta result never permits another pre_accept, accept or terminate.
    IF public.whatsapp_call_signal_begin(acc,phone,c3,a,q3,'pre_accept',epoch3) IS DISTINCT FROM 'reserved'
      OR public.whatsapp_call_signal_finish(acc,phone,c3,a,q3,'unknown',NULL) IS DISTINCT FROM 'unknown'
      OR public.whatsapp_call_signal_begin(acc,phone,c3,a,gen_random_uuid(),'pre_accept',epoch3) IS DISTINCT FROM 'unknown'
      OR public.whatsapp_call_signal_begin(acc,phone,c3,a,gen_random_uuid(),'accept',epoch3) IS DISTINCT FROM 'unknown'
      OR public.whatsapp_call_terminal_reserve(acc,phone,c3,a,gen_random_uuid(),'terminate','claim_cleanup',epoch3) IS DISTINCT FROM 'in_progress'
    THEN RAISE EXCEPTION 'CALL036_UNKNOWN_RETRIED_OR_UNFENCED'; END IF;
    RAISE EXCEPTION 'CALL036_SENTINEL_ROLLBACK';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'CALL036_SENTINEL_ROLLBACK' THEN RAISE; END IF;
  END;
END;
$qa$;
