-- SEC-CALL-ACL-01: narrowly harden the internal Call SDP cleanup trigger
-- WACRM/InkaClick only; does not alter call rows or replace trigger definitions.
-- Requires the read-only audit in docs/ops/CALLING_TRIGGER_ACL_HARDENING.md.
-- Run once AS FUNCTION OWNER with: docker exec -i supabase-db
--   psql -X -w -U supabase_admin -d postgres -v ON_ERROR_STOP=1 \\
--   < ops/security/calling-trigger-execute-acl.sql
-- A single transaction prevents partial changes if a guard fails.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $preflight$
DECLARE
  v_oid oid;
  v_triggers integer;
BEGIN
  SELECT p.oid INTO v_oid
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'whatsapp_call_agent_sdp_terminal_clear'
    AND p.pronargs = 0
    AND p.prorettype = 'pg_catalog.trigger'::regtype
    AND NOT p.prosecdef
    AND p.prokind = 'f';

  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'CALLING_TRIGGER_ACL_PRECHECK=FAIL_FUNCTION_MISMATCH';
  END IF;

  -- Postgres in this self-hosted instance is NO-SUPERUSER and not a member
  -- of supabase_admin, the function owner. It has only EXECUTE without
  -- GRANT OPTION, so REVOKE/GRANT appeared to run but changed nothing.
  -- Require the exact current execution role to be the function owner.
  -- Refuse to attempt any ACL mutation under postgres or another role.
  IF current_user <> (SELECT pg_get_userbyid(p.proowner)
                      FROM pg_proc p WHERE p.oid = v_oid) THEN
    RAISE EXCEPTION 'CALLING_TRIGGER_ACL_PRECHECK=FAIL_EXECUTOR_NOT_OWNER';
  END IF;

  IF current_user <> 'supabase_admin' THEN
    RAISE EXCEPTION 'CALLING_TRIGGER_ACL_PRECHECK=FAIL_UNEXPECTED_OWNER';
  END IF;

  RAISE NOTICE 'CALLING_TRIGGER_ACL_EXECUTOR=OWNER_CONFIRMED';

  SELECT COUNT(*) INTO v_triggers
  FROM pg_trigger t
  WHERE t.tgfoid = v_oid
    AND t.tgname = 'whatsapp_call_agent_sdp_terminal_clear'
    AND t.tgrelid = 'public.whatsapp_call_sessions'::regclass
    AND NOT t.tgisinternal
    AND t.tgenabled IN ('O', 'A');

  IF v_triggers <> 1 THEN
    RAISE EXCEPTION 'CALLING_TRIGGER_ACL_PRECHECK=FAIL_TRIGGER_MISMATCH';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    RAISE EXCEPTION 'CALLING_TRIGGER_ACL_PRECHECK=FAIL_SERVICE_ROLE_MISSING';
  END IF;
  RAISE NOTICE 'CALLING_TRIGGER_ACL_PRECHECK=PASS';
END;
$preflight$;

-- PUBLIC is the actual source of inherited EXECUTE; revoking only from
-- anon/authenticated would NOT remove an inherited PUBLIC grant.
REVOKE ALL ON FUNCTION public.whatsapp_call_agent_sdp_terminal_clear()
  FROM PUBLIC, anon, authenticated;

-- Explicitly preserve the server's service-role right.
GRANT EXECUTE ON FUNCTION public.whatsapp_call_agent_sdp_terminal_clear()
  TO service_role;

DO $verify$
DECLARE
  v_routine oid;
  v_total integer;
  v_exposed integer;
BEGIN
  SELECT 'public.whatsapp_call_agent_sdp_terminal_clear()'::regprocedure::oid
    INTO v_routine;

  IF has_function_privilege('anon', v_routine, 'EXECUTE')
    OR has_function_privilege('authenticated', v_routine, 'EXECUTE')
    OR NOT has_function_privilege('service_role', v_routine, 'EXECUTE') THEN
    RAISE EXCEPTION 'CALLING_TRIGGER_ACL_VERIFY=FAIL_TARGET_PRIVILEGE';
  END IF;

  SELECT COUNT(*),
         COUNT(*) FILTER (
           WHERE has_function_privilege('anon', p.oid, 'EXECUTE')
              OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
         )
    INTO v_total, v_exposed
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname LIKE 'whatsapp_call_%';

  IF v_total < 19 OR v_exposed <> 0 THEN
    RAISE EXCEPTION 'CALLING_TRIGGER_ACL_VERIFY=FAIL_EXPOSURE_COUNT total=% exposed=%',
      v_total, v_exposed;
  END IF;
  RAISE NOTICE 'CALLING_RPC_COUNT=%', v_total;
  RAISE NOTICE 'EXPOSED_RPC_COUNT=%', v_exposed;
  RAISE NOTICE 'RPC_ACL_GATE=PASS';
END;
$verify$;

COMMIT;
