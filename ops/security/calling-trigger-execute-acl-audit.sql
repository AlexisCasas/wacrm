-- SEC-CALL-ACL-01 read-only audit; no secrets or call/customer rows.
BEGIN READ ONLY;
SELECT p.oid::regprocedure AS routine,
       p.prorettype::regtype AS return_type,
       CASE WHEN p.prosecdef THEN 'DEFINER' ELSE 'INVOKER' END AS security_mode,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_execute,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_execute,
       has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'whatsapp_call_agent_sdp_terminal_clear';

SELECT t.tgname AS trigger_name,
       t.tgrelid::regclass AS table_name,
       t.tgenabled AS enabled,
       t.tgfoid::regprocedure AS handler
FROM pg_trigger t
WHERE t.tgname = 'whatsapp_call_agent_sdp_terminal_clear'
  AND NOT t.tgisinternal;

SELECT COUNT(*) AS calling_rpc_count,
       COUNT(*) FILTER (
         WHERE has_function_privilege('anon', p.oid, 'EXECUTE')
           OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
       ) AS exposed_rpc_count
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname LIKE 'whatsapp_call_%';
ROLLBACK;
