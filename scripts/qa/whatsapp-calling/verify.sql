-- CALL-02 SQL verification. Run against an isolated disposable database AFTER the migration.
-- No production data is read or modified. All synthetic rows are rolled back.
BEGIN;

DO $$
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
  IF has_table_privilege('anon','public.whatsapp_call_sessions','SELECT')
     OR has_table_privilege('authenticated','public.whatsapp_call_sessions','SELECT')
     OR has_table_privilege('anon','public.whatsapp_call_permissions','SELECT')
     OR has_table_privilege('authenticated','public.whatsapp_call_permissions','SELECT')
  THEN RAISE EXCEPTION 'CALL02_API_ROLE_TABLE_ACCESS_OPEN'; END IF;
  IF NOT has_function_privilege('service_role',
      'public.whatsapp_call_event_apply(uuid,text,text,text,text,bigint,text,text,text,text,text,text,text,text,timestamp with time zone,timestamp with time zone,timestamp with time zone,integer)',
      'EXECUTE')
  THEN RAISE EXCEPTION 'CALL02_SERVICE_ROLE_EVENT_RPC_MISSING'; END IF;
  IF has_function_privilege('authenticated',
      'public.whatsapp_call_event_apply(uuid,text,text,text,text,bigint,text,text,text,text,text,text,text,text,timestamp with time zone,timestamp with time zone,timestamp with time zone,integer)',
      'EXECUTE')
  THEN RAISE EXCEPTION 'CALL02_AUTHENTICATED_EVENT_RPC_OPEN'; END IF;
END $$;

DO $$
DECLARE
  v_account uuid := gen_random_uuid();
  v_first boolean;
  v_duplicate boolean;
  v_conflict boolean := false;
  v_key text := repeat('a',64);
BEGIN
  v_first := public.whatsapp_call_event_apply(
    v_account,'740434745820831','wacid.qa-call','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'connect',1795120000,'USER_INITIATED','PE.qa-customer','51911111111','PE.qa-customer','Synthetic QA',
    'offered','encrypted:synthetic-sdp','offer',now()+interval '5 minutes',NULL,NULL,NULL
  );
  IF v_first IS DISTINCT FROM true THEN RAISE EXCEPTION 'CALL02_FIRST_EVENT_NOT_APPLIED'; END IF;

  v_duplicate := public.whatsapp_call_event_apply(
    v_account,'740434745820831','wacid.qa-call','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'connect',1795120000,'USER_INITIATED','PE.qa-customer','51911111111','PE.qa-customer','Synthetic QA',
    'offered','encrypted:synthetic-sdp','offer',now()+interval '5 minutes',NULL,NULL,NULL
  );
  IF v_duplicate IS DISTINCT FROM false THEN RAISE EXCEPTION 'CALL02_DUPLICATE_NOT_IGNORED'; END IF;

  PERFORM public.whatsapp_call_event_apply(
    v_account,'740434745820831','wacid.qa-call',repeat('b',64),
    'terminate',1795120060,'USER_INITIATED','PE.qa-customer','51911111111','PE.qa-customer','Synthetic QA',
    'terminated',NULL,NULL,NULL,now(),now(),60
  );
  IF NOT EXISTS (
    SELECT 1 FROM public.whatsapp_call_sessions
    WHERE phone_number_id='740434745820831' AND call_id='wacid.qa-call'
      AND state='terminated' AND session_sdp_encrypted IS NULL AND duration_seconds=60
  ) THEN RAISE EXCEPTION 'CALL02_TERMINAL_STATE_OR_SDP_CLEANUP_FAILED'; END IF;

  BEGIN
    PERFORM public.whatsapp_call_event_apply(
      gen_random_uuid(),'740434745820831','wacid.qa-call',repeat('c',64),
      'status',1795120061,NULL,NULL,NULL,NULL,NULL,'connected',NULL,NULL,NULL,NULL,NULL,NULL
    );
  EXCEPTION WHEN insufficient_privilege THEN v_conflict := true;
    WHEN OTHERS THEN
      IF SQLERRM='call_tenant_conflict' THEN v_conflict := true; ELSE RAISE; END IF;
  END;
  IF NOT v_conflict THEN RAISE EXCEPTION 'CALL02_TENANT_CONFLICT_NOT_REJECTED'; END IF;

  PERFORM public.whatsapp_call_permission_upsert(
    v_account,'740434745820831','PE.qa-customer','51911111111','PE.qa-customer',
    'approved','temporary',to_timestamp(1795724800),'wamid.qa-permission'
  );
  IF NOT EXISTS (
    SELECT 1 FROM public.whatsapp_call_permissions
    WHERE phone_number_id='740434745820831' AND customer_key='PE.qa-customer'
      AND permission_state='approved' AND permission_type='temporary'
  ) THEN RAISE EXCEPTION 'CALL02_TEMP_PERMISSION_NOT_STORED'; END IF;

  PERFORM public.whatsapp_call_permission_upsert(
    v_account,'740434745820831','PE.qa-customer','51911111111','PE.qa-customer',
    'rejected',NULL,NULL,'wamid.qa-rejection'
  );
  IF NOT EXISTS (
    SELECT 1 FROM public.whatsapp_call_permissions
    WHERE phone_number_id='740434745820831' AND customer_key='PE.qa-customer'
      AND permission_state='rejected' AND permission_type IS NULL AND expires_at IS NULL
  ) THEN RAISE EXCEPTION 'CALL02_PERMISSION_REJECTION_NOT_STORED'; END IF;
END $$;

ROLLBACK;
