-- CALL-02 SQL verification.
-- One DO statement because supabase db query executes a prepared statement.
-- The nested exception block is a subtransaction: the final sentinel rolls back
-- every synthetic fixture while preserving the successful assertions.
DO $qa$
DECLARE
  v_account uuid := gen_random_uuid();
  v_first boolean;
  v_duplicate boolean;
  v_conflict boolean := false;
  v_signature text := 'public.whatsapp_call_event_apply(uuid,text,text,text,text,bigint,text,text,text,text,text,text,text,text,text,timestamp with time zone,timestamp with time zone,timestamp with time zone,integer)';
  v_permission_signature text := 'public.whatsapp_call_permission_upsert(uuid,text,text,text,text,text,text,text,timestamp with time zone,text,text)';
  v_claim_signature text := 'public.whatsapp_call_claim(uuid,text,text,uuid)';
  v_release_signature text := 'public.whatsapp_call_release(uuid,text,text,uuid)';
BEGIN
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname='whatsapp_call_sessions' AND c.relrowsecurity
    ) THEN RAISE EXCEPTION 'CALL02_SESSIONS_RLS_MISSING'; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname='whatsapp_call_events' AND c.relrowsecurity
    ) THEN RAISE EXCEPTION 'CALL02_EVENTS_RLS_MISSING'; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname='whatsapp_call_permissions' AND c.relrowsecurity
    ) THEN RAISE EXCEPTION 'CALL02_PERMISSIONS_RLS_MISSING'; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname='whatsapp_call_permission_requests' AND c.relrowsecurity
    ) THEN RAISE EXCEPTION 'CALL02_PERMISSION_REQUESTS_RLS_MISSING'; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='whatsapp_call_sessions' AND column_name='claim_expires_at'
    ) THEN RAISE EXCEPTION 'CALL02_CLAIM_LEASE_COLUMN_MISSING'; END IF;

    IF has_table_privilege('anon','public.whatsapp_call_sessions','SELECT')
      OR has_table_privilege('authenticated','public.whatsapp_call_sessions','SELECT')
      OR has_table_privilege('anon','public.whatsapp_call_events','SELECT')
      OR has_table_privilege('authenticated','public.whatsapp_call_events','SELECT')
      OR has_table_privilege('anon','public.whatsapp_call_permissions','SELECT')
      OR has_table_privilege('authenticated','public.whatsapp_call_permissions','SELECT')
      OR has_table_privilege('anon','public.whatsapp_call_permission_requests','SELECT')
      OR has_table_privilege('authenticated','public.whatsapp_call_permission_requests','SELECT')
      OR NOT has_table_privilege('service_role','public.whatsapp_call_permission_requests','INSERT')
    THEN RAISE EXCEPTION 'CALL02_API_ROLE_TABLE_ACCESS_OPEN'; END IF;

    IF NOT has_function_privilege('service_role', v_signature, 'EXECUTE')
      OR has_function_privilege('anon', v_signature, 'EXECUTE')
      OR has_function_privilege('authenticated', v_signature, 'EXECUTE')
      OR NOT has_function_privilege('service_role', v_permission_signature, 'EXECUTE')
      OR has_function_privilege('anon', v_permission_signature, 'EXECUTE')
      OR has_function_privilege('authenticated', v_permission_signature, 'EXECUTE')
      OR NOT has_function_privilege('service_role', v_claim_signature, 'EXECUTE')
      OR has_function_privilege('anon', v_claim_signature, 'EXECUTE')
      OR has_function_privilege('authenticated', v_claim_signature, 'EXECUTE')
      OR NOT has_function_privilege('service_role', v_release_signature, 'EXECUTE')
      OR has_function_privilege('anon', v_release_signature, 'EXECUTE')
      OR has_function_privilege('authenticated', v_release_signature, 'EXECUTE')
    THEN RAISE EXCEPTION 'CALL02_RPC_GRANTS_INVALID'; END IF;

    v_first := public.whatsapp_call_event_apply(
      v_account,'740434745820831','wacid.qa-call',repeat('a',64),
      'connect',1795120000,'USER_INITIATED','PE.qa-customer','51911111111',
      'PE.qa-customer',NULL,'Synthetic QA','offered','encrypted:synthetic-sdp','offer',
      now()+interval '5 minutes',NULL,NULL,NULL
    );
    IF v_first IS DISTINCT FROM true THEN RAISE EXCEPTION 'CALL02_FIRST_EVENT_NOT_APPLIED'; END IF;

    v_duplicate := public.whatsapp_call_event_apply(
      v_account,'740434745820831','wacid.qa-call',repeat('a',64),
      'connect',1795120000,'USER_INITIATED','PE.qa-customer','51911111111',
      'PE.qa-customer',NULL,'Synthetic QA','offered','encrypted:synthetic-sdp','offer',
      now()+interval '5 minutes',NULL,NULL,NULL
    );
    IF v_duplicate IS DISTINCT FROM false THEN RAISE EXCEPTION 'CALL02_DUPLICATE_NOT_IGNORED'; END IF;

    -- An older termination must not clear a newer offer or its SDP.
    PERFORM public.whatsapp_call_event_apply(
      v_account,'740434745820831','wacid.qa-call',repeat('b',64),
      'terminate',1795119990,'USER_INITIATED','PE.qa-customer','51911111111',
      'PE.qa-customer',NULL,'Synthetic QA','terminated',NULL,NULL,NULL,now(),now(),60
    );
    IF NOT EXISTS (
      SELECT 1 FROM public.whatsapp_call_sessions
      WHERE phone_number_id='740434745820831' AND call_id='wacid.qa-call'
        AND state='offered' AND session_sdp_encrypted='encrypted:synthetic-sdp'
    ) THEN RAISE EXCEPTION 'CALL02_STALE_EVENT_OVERWROTE_NEWER_STATE'; END IF;

    PERFORM public.whatsapp_call_event_apply(
      v_account,'740434745820831','wacid.qa-call',repeat('c',64),
      'terminate',1795120060,'USER_INITIATED','PE.qa-customer','51911111111',
      'PE.qa-customer',NULL,'Synthetic QA','terminated',NULL,NULL,NULL,now(),now(),60
    );
    IF NOT EXISTS (
      SELECT 1 FROM public.whatsapp_call_sessions
      WHERE phone_number_id='740434745820831' AND call_id='wacid.qa-call'
        AND state='terminated' AND session_sdp_encrypted IS NULL
        AND session_sdp_expires_at IS NULL AND duration_seconds=60
    ) THEN RAISE EXCEPTION 'CALL02_TERMINAL_STATE_OR_SDP_CLEANUP_FAILED'; END IF;

    BEGIN
      PERFORM public.whatsapp_call_event_apply(
        gen_random_uuid(),'740434745820831','wacid.qa-call',repeat('d',64),
        'status',1795120061,NULL,NULL,NULL,NULL,NULL,NULL,'connected',NULL,NULL,NULL,NULL,NULL,NULL
      );
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM='call_tenant_conflict' THEN v_conflict := true; ELSE RAISE; END IF;
    END;
    IF NOT v_conflict THEN RAISE EXCEPTION 'CALL02_TENANT_CONFLICT_NOT_REJECTED'; END IF;

    PERFORM public.whatsapp_call_permission_upsert(
      v_account,'740434745820831','PE.qa-customer','51911111111',
      'PE.qa-customer',NULL,'approved','temporary',
      to_timestamp(1795724800),'user_action','wamid.qa-permission'
    );
    IF NOT EXISTS (
      SELECT 1 FROM public.whatsapp_call_permissions
      WHERE phone_number_id='740434745820831' AND customer_key='PE.qa-customer'
        AND permission_state='approved' AND permission_type='temporary'
        AND response_source='user_action'
    ) THEN RAISE EXCEPTION 'CALL02_TEMP_PERMISSION_NOT_STORED'; END IF;

    PERFORM public.whatsapp_call_permission_upsert(
      v_account,'740434745820831','PE.qa-customer','51911111111',
      'PE.qa-customer',NULL,'rejected',NULL,NULL,'automatic','wamid.qa-revocation'
    );
    IF NOT EXISTS (
      SELECT 1 FROM public.whatsapp_call_permissions
      WHERE phone_number_id='740434745820831' AND customer_key='PE.qa-customer'
        AND permission_state='rejected' AND permission_type IS NULL
        AND expires_at IS NULL AND response_source='automatic'
    ) THEN RAISE EXCEPTION 'CALL02_AUTOMATIC_REVOCATION_NOT_STORED'; END IF;

    RAISE EXCEPTION '__CALL02_QA_ROLLBACK__';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM='__CALL02_QA_ROLLBACK__' THEN
      RAISE NOTICE 'CALL02_SQL_QA=PASS; synthetic fixtures rolled back';
    ELSE
      RAISE;
    END IF;
  END;
END
$qa$;
