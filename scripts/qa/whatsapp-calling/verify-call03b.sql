-- CALL-03B SQL verification: durable outbound idempotency, encrypted SDP reservation
-- and reconciliation when the Meta HTTP response is lost but a later webhook echoes
-- biz_opaque_callback_data. Synthetic fixtures are rolled back; local CI only.
DO $qa$
DECLARE
  v_user uuid := 'b3000000-0000-4000-8000-000000000001';
  v_account uuid;
  v_contact uuid := gen_random_uuid();
  v_conversation uuid := gen_random_uuid();
  v_request_id uuid := 'b3000000-0000-4000-8000-000000000002';
  v_call_id text := 'wacid.qa-call03b-reconciled';
  v_phone_number_id text := '740434745820831';
  v_offer_encrypted text := 'encrypted:CALL03B synthetic offer';
  v_expiry timestamptz := now()+interval '5 minutes';
  v_begin jsonb;
  v_duplicate jsonb;
  v_signature text := 'public.whatsapp_call_outbound_attempt_begin(uuid,text,uuid,uuid,uuid,uuid,text,text,text,text,text,text,timestamptz)';
  v_bad_phone_rejected boolean := false;
BEGIN
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='whatsapp_call_outbound_attempts'
        AND column_name='agent_sdp_encrypted'
    ) OR NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='whatsapp_call_sessions'
        AND column_name='last_claimed_by_user_id'
    ) THEN
      RAISE EXCEPTION 'CALL03B_SIGNALLING_COLUMNS_MISSING';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_class
      WHERE oid='public.whatsapp_call_outbound_attempts'::regclass AND relrowsecurity
    ) OR NOT has_table_privilege('service_role','public.whatsapp_call_outbound_attempts','SELECT')
      OR has_table_privilege('authenticated','public.whatsapp_call_outbound_attempts','SELECT')
      OR has_table_privilege('anon','public.whatsapp_call_outbound_attempts','SELECT')
    THEN
      RAISE EXCEPTION 'CALL03B_OUTBOUND_ATTEMPT_TABLE_GRANTS_INVALID';
    END IF;

    IF NOT has_function_privilege('service_role',v_signature,'EXECUTE')
      OR has_function_privilege('authenticated',v_signature,'EXECUTE')
      OR has_function_privilege('anon',v_signature,'EXECUTE')
    THEN
      RAISE EXCEPTION 'CALL03B_OUTBOUND_BEGIN_RPC_GRANTS_INVALID';
    END IF;

    INSERT INTO auth.users (
      id,aud,role,email,encrypted_password,email_confirmed_at,
      raw_app_meta_data,raw_user_meta_data,created_at,updated_at
    ) VALUES (
      v_user,'authenticated','authenticated','call03b-agent@example.invalid','',now(),
      '{}'::jsonb,'{"full_name":"CALL03B synthetic agent"}'::jsonb,now(),now()
    );

    SELECT account_id INTO v_account FROM public.profiles WHERE user_id=v_user;
    IF v_account IS NULL THEN
      RAISE EXCEPTION 'CALL03B_SYNTHETIC_ACCOUNT_NOT_CREATED';
    END IF;

    INSERT INTO public.whatsapp_config(
      user_id,account_id,phone_number_id,access_token,status
    ) VALUES (
      v_user,v_account,v_phone_number_id,'encrypted:synthetic-token','connected'
    );

    INSERT INTO public.contacts(id,user_id,account_id,phone,name)
    VALUES(v_contact,v_user,v_account,'51980942247','CALL03B synthetic contact');

    INSERT INTO public.conversations(id,user_id,account_id,contact_id,status)
    VALUES(v_conversation,v_user,v_account,v_contact,'open');

    v_begin := public.whatsapp_call_outbound_attempt_begin(
      v_account,v_phone_number_id,v_request_id,v_user,
      v_contact,v_conversation,'51980942247','51980942247',NULL,NULL,
      'CALL03B synthetic contact',v_offer_encrypted,v_expiry
    );

    IF v_begin->>'created' IS DISTINCT FROM 'true'
      OR v_begin->>'state' IS DISTINCT FROM 'pending'
      OR v_begin->>'callback_data' IS DISTINCT FROM v_request_id::text
    THEN
      RAISE EXCEPTION 'CALL03B_OUTBOUND_ATTEMPT_BEGIN_FAILED';
    END IF;

    -- Reusing the same idempotency key must return the existing pending
    -- attempt, even if the browser retries with a different local SDP.
    v_duplicate := public.whatsapp_call_outbound_attempt_begin(
      v_account,v_phone_number_id,v_request_id,v_user,
      v_contact,v_conversation,'51980942247','51980942247',NULL,NULL,
      'CALL03B synthetic contact','encrypted:different offer',v_expiry
    );
    IF v_duplicate->>'created' IS DISTINCT FROM 'false'
      OR v_duplicate->>'attempt_id' IS DISTINCT FROM v_begin->>'attempt_id'
    THEN
      RAISE EXCEPTION 'CALL03B_DUPLICATE_REQUEST_CREATED_SECOND_ATTEMPT';
    END IF;

    -- The initial BIC connect webhook creates the call session but does not
    -- echo biz_opaque_callback_data. A later status webhook does; that callback
    -- must reconcile the original attempt and attach the reserved local offer.
    PERFORM public.whatsapp_call_event_apply(
      v_account,v_phone_number_id,v_call_id,repeat('b',64),
      'connect',1795120000,'BUSINESS_INITIATED',
      '51980942247','51980942247',NULL,NULL,
      'CALL03B synthetic contact','connecting',NULL,NULL,NULL,NULL,NULL,NULL
    );

    IF public.whatsapp_call_session_callback_data_apply(
      v_account,v_phone_number_id,v_call_id,v_request_id::text
    ) IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'CALL03B_CALLBACK_RECONCILIATION_FAILED';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.whatsapp_call_outbound_attempts
      WHERE account_id=v_account AND request_id=v_request_id
        AND state='submitted' AND call_id=v_call_id
    ) THEN
      RAISE EXCEPTION 'CALL03B_OUTBOUND_ATTEMPT_NOT_RECONCILED';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.whatsapp_call_sessions
      WHERE account_id=v_account AND phone_number_id=v_phone_number_id
        AND call_id=v_call_id
        AND contact_id=v_contact AND conversation_id=v_conversation
        AND initiated_by_user_id=v_user
        AND biz_opaque_callback_data=v_request_id::text
        AND agent_sdp_encrypted=v_offer_encrypted
        AND agent_sdp_type='offer'
        AND agent_sdp_expires_at > now()
    ) THEN
      RAISE EXCEPTION 'CALL03B_SESSION_METADATA_NOT_RECONCILED';
    END IF;

    -- The HTTP response may arrive after the callback; completion is idempotent.
    IF public.whatsapp_call_outbound_attempt_complete(
      v_account,v_phone_number_id,v_request_id,v_user,v_call_id,
      v_offer_encrypted,v_expiry
    ) IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'CALL03B_LATE_HTTP_COMPLETION_NOT_IDEMPOTENT';
    END IF;

    BEGIN
      PERFORM public.whatsapp_call_outbound_attempt_begin(
        v_account,'999999999999999',gen_random_uuid(),v_user,
        v_contact,v_conversation,'51980942247','51980942247',NULL,NULL,
        'CALL03B synthetic contact',v_offer_encrypted,v_expiry
      );
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM='call_outbound_phone_config_unavailable' THEN
        v_bad_phone_rejected := true;
      ELSE
        RAISE;
      END IF;
    END;
    IF NOT v_bad_phone_rejected THEN
      RAISE EXCEPTION 'CALL03B_PHONE_NUMBER_TENANT_MISMATCH_ALLOWED';
    END IF;

    IF (SELECT count(*) FROM public.whatsapp_call_outbound_attempts
        WHERE account_id=v_account AND request_id=v_request_id) <> 1 THEN
      RAISE EXCEPTION 'CALL03B_IDEMPOTENCY_ATTEMPT_COUNT_INVALID';
    END IF;

    RAISE EXCEPTION '__CALL03B_QA_ROLLBACK__';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM='__CALL03B_QA_ROLLBACK__' THEN
      RAISE NOTICE 'CALL03B_SQL_QA=PASS; synthetic fixtures rolled back';
    ELSE
      RAISE;
    END IF;
  END;
END
$qa$;
