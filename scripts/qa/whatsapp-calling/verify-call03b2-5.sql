-- CALL-03B2.5 — terminal reservation regression. All synthetic rows roll back.
-- Deliberately tests the actual RPCs, not a mocked claim implementation.
DO $qa$
DECLARE
  v_a uuid := 'd5000000-0000-4000-8000-000000000001';
  v_b uuid := 'd5000000-0000-4000-8000-000000000002';
  v_c uuid := 'd5000000-0000-4000-8000-000000000003';
  v_account uuid;
  v_other_account uuid;
  v_phone text := '740434745820831';
  v_call text := 'wacid.qa-terminal-race';
  v_reject text := 'wacid.qa-terminal-reject';
  v_outbound text := 'wacid.qa-terminal-outbound';
  v_epoch_a timestamptz;
  v_epoch_b timestamptz;
  v_req uuid := gen_random_uuid();
  v_result text;
BEGIN
  BEGIN
    IF to_regprocedure('public.whatsapp_call_terminal_reserve(uuid,text,text,uuid,uuid,text,text,timestamptz)') IS NULL
      OR to_regprocedure('public.whatsapp_call_terminal_finish(uuid,text,text,uuid,uuid,text)') IS NULL
    THEN RAISE EXCEPTION 'CALL035_TERMINAL_RPCS_MISSING'; END IF;
    IF has_function_privilege('anon','public.whatsapp_call_terminal_reserve(uuid,text,text,uuid,uuid,text,text,timestamptz)','EXECUTE')
      OR has_function_privilege('authenticated','public.whatsapp_call_terminal_reserve(uuid,text,text,uuid,uuid,text,text,timestamptz)','EXECUTE')
      OR NOT has_function_privilege('service_role','public.whatsapp_call_terminal_reserve(uuid,text,text,uuid,uuid,text,text,timestamptz)','EXECUTE')
      OR has_function_privilege('anon','public.whatsapp_call_terminal_finish(uuid,text,text,uuid,uuid,text)','EXECUTE')
      OR has_function_privilege('authenticated','public.whatsapp_call_terminal_finish(uuid,text,text,uuid,uuid,text)','EXECUTE')
      OR NOT has_function_privilege('service_role','public.whatsapp_call_terminal_finish(uuid,text,text,uuid,uuid,text)','EXECUTE')
    THEN RAISE EXCEPTION 'CALL035_UNSAFE_RPC_ACL'; END IF;

    INSERT INTO auth.users(
      id,aud,role,email,encrypted_password,email_confirmed_at,
      raw_app_meta_data,raw_user_meta_data,created_at,updated_at
    ) VALUES
      (v_a,'authenticated','authenticated','call035-a@example.invalid','',now(),'{}'::jsonb,'{}'::jsonb,now(),now()),
      (v_b,'authenticated','authenticated','call035-b@example.invalid','',now(),'{}'::jsonb,'{}'::jsonb,now(),now()),
      (v_c,'authenticated','authenticated','call035-c@example.invalid','',now(),'{}'::jsonb,'{}'::jsonb,now(),now());

    SELECT account_id INTO v_account FROM public.profiles WHERE user_id=v_a;
    SELECT account_id INTO v_other_account FROM public.profiles WHERE user_id=v_c;
    UPDATE public.profiles SET account_id=v_account,account_role='agent' WHERE user_id=v_b;
    DELETE FROM public.accounts WHERE owner_user_id=v_b;
    IF v_account IS NULL OR v_other_account IS NULL OR v_account=v_other_account THEN
      RAISE EXCEPTION 'CALL035_ACCOUNT_SETUP_FAILED';
    END IF;

    INSERT INTO public.whatsapp_call_sessions(
      account_id,phone_number_id,call_id,direction,state,
      session_sdp_encrypted,session_sdp_type,session_sdp_expires_at
    ) VALUES
      (v_account,v_phone,v_call,'USER_INITIATED','offered','qa-offer','offer',now()+interval '2 minutes'),
      (v_account,v_phone,v_reject,'USER_INITIATED','offered','qa-offer','offer',now()+interval '2 minutes'),
      (v_account,v_phone,v_outbound,'BUSINESS_INITIATED','connected',NULL,NULL,NULL);

    IF public.whatsapp_call_claim(v_account,v_phone,v_call,v_a) IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'CALL035_FIRST_CLAIM_FAILED'; END IF;
    SELECT claimed_at INTO v_epoch_a FROM public.whatsapp_call_sessions
    WHERE account_id=v_account AND phone_number_id=v_phone AND call_id=v_call;
    IF v_epoch_a IS NULL THEN RAISE EXCEPTION 'CALL035_CLAIM_EPOCH_MISSING'; END IF;

    -- Agent A's cleanup cannot close agent B's newly claimed offer.
    IF public.whatsapp_call_release(v_account,v_phone,v_call,v_a) IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'CALL035_RELEASE_BEFORE_HANDOFF_FAILED'; END IF;
    IF public.whatsapp_call_claim(v_account,v_phone,v_call,v_b) IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'CALL035_SECOND_CLAIM_FAILED'; END IF;
    SELECT claimed_at INTO v_epoch_b FROM public.whatsapp_call_sessions
    WHERE account_id=v_account AND phone_number_id=v_phone AND call_id=v_call;
    IF public.whatsapp_call_terminal_reserve(
      v_account,v_phone,v_call,v_a,gen_random_uuid(),'terminate','claim_cleanup',v_epoch_a
    ) IS DISTINCT FROM 'denied' THEN RAISE EXCEPTION 'CALL035_STALE_AGENT_TERMINATED_NEW_OWNER'; END IF;
    -- Owner A also must not override an active B claim, even explicitly.
    IF public.whatsapp_call_terminal_reserve(
      v_account,v_phone,v_call,v_a,gen_random_uuid(),'terminate','admin_override',NULL
    ) IS DISTINCT FROM 'denied' THEN RAISE EXCEPTION 'CALL035_ADMIN_OVERRIDE_STOLE_ACTIVE_CLAIM'; END IF;
    -- Only the active owner can reserve cleanup, using its original epoch.
    IF public.whatsapp_call_terminal_reserve(
      v_account,v_phone,v_call,v_b,v_req,'terminate','claim_cleanup',v_epoch_b
    ) IS DISTINCT FROM 'reserved' THEN RAISE EXCEPTION 'CALL035_RESERVATION_FAILED'; END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.whatsapp_call_sessions
      WHERE account_id=v_account AND phone_number_id=v_phone AND call_id=v_call
        AND terminal_request_id=v_req AND terminal_action='terminate'
        AND terminal_actor_user_id=v_b AND terminal_status='reserved'
    ) THEN RAISE EXCEPTION 'CALL035_RESERVATION_NOT_DURABLE'; END IF;
    IF public.whatsapp_call_claim(v_account,v_phone,v_call,v_a) IS DISTINCT FROM false
      OR public.whatsapp_call_release(v_account,v_phone,v_call,v_b) IS DISTINCT FROM false
      OR public.whatsapp_call_claim(v_account,v_phone,v_call,v_b) IS DISTINCT FROM false
    THEN RAISE EXCEPTION 'CALL035_RESERVED_CALL_RECLAIMABLE'; END IF;
    IF public.whatsapp_call_session_agent_sdp_store(
      v_account,v_phone,v_call,v_b,'qa-answer',now()+interval '3 minutes'
    ) IS DISTINCT FROM false THEN RAISE EXCEPTION 'CALL035_SDP_STORED_DURING_TERMINATION'; END IF;
    IF public.whatsapp_call_terminal_reserve(
      v_account,v_phone,v_call,v_b,gen_random_uuid(),'terminate','claim_cleanup',v_epoch_b
    ) IS DISTINCT FROM 'in_progress' THEN RAISE EXCEPTION 'CALL035_DUPLICATE_META_SIDE_EFFECT_ALLOWED'; END IF;
    IF public.whatsapp_call_terminal_finish(
      v_account,v_phone,v_call,v_a,v_req,'acknowledged'
    ) IS DISTINCT FROM false THEN RAISE EXCEPTION 'CALL035_OTHER_ACTOR_COMPLETED_RESERVATION'; END IF;
    IF public.whatsapp_call_terminal_finish(
      v_account,v_phone,v_call,v_b,v_req,'unknown'
    ) IS DISTINCT FROM true THEN RAISE EXCEPTION 'CALL035_UNKNOWN_RESULT_NOT_STORED'; END IF;
    UPDATE public.whatsapp_call_sessions SET claim_expires_at=now()-interval '10 minutes'
    WHERE account_id=v_account AND phone_number_id=v_phone AND call_id=v_call;
    IF public.whatsapp_call_claim(v_account,v_phone,v_call,v_a) IS DISTINCT FROM false
      OR public.whatsapp_call_terminal_reserve(
        v_account,v_phone,v_call,v_b,gen_random_uuid(),'terminate','claim_cleanup',v_epoch_b
      ) IS DISTINCT FROM 'in_progress'
    THEN RAISE EXCEPTION 'CALL035_UNKNOWN_RESERVATION_AUTO_UNLOCKED'; END IF;

    -- Reject also reserves atomically before Meta; cannot be claimed afterward.
    IF public.whatsapp_call_terminal_reserve(
      v_account,v_phone,v_reject,v_a,gen_random_uuid(),'reject','reject',NULL
    ) IS DISTINCT FROM 'reserved'
      OR public.whatsapp_call_claim(v_account,v_phone,v_reject,v_b) IS DISTINCT FROM false
    THEN RAISE EXCEPTION 'CALL035_REJECT_RACE'; END IF;

    -- Outbound authenticated initiator can reserve a terminate independently.
    IF public.whatsapp_call_session_agent_action(
      v_account,v_phone,v_outbound,v_a,'initiated',NULL
    ) IS DISTINCT FROM true THEN RAISE EXCEPTION 'CALL035_OUTBOUND_INITIATOR_FAILED'; END IF;
    IF public.whatsapp_call_terminal_reserve(
      v_account,v_phone,v_outbound,v_a,gen_random_uuid(),'terminate','owned_call',NULL
    ) IS DISTINCT FROM 'reserved' THEN RAISE EXCEPTION 'CALL035_OUTBOUND_TERMINATE_BLOCKED'; END IF;
    BEGIN
      PERFORM public.whatsapp_call_terminal_reserve(
        v_account,v_phone,v_outbound,v_c,gen_random_uuid(),'terminate','admin_override',NULL
      );
      RAISE EXCEPTION 'CALL035_CROSS_ACCOUNT_ACCESS_ALLOWED';
    EXCEPTION WHEN insufficient_privilege THEN
      NULL; -- a foreign-account actor has no service-side authority here
    END;

    RAISE EXCEPTION 'CALL035_SENTINEL_ROLLBACK';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'CALL035_SENTINEL_ROLLBACK' THEN RAISE; END IF;
  END;
END;
$qa$;
