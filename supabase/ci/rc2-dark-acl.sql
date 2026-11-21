-- WACRM RC2 dark-release ACL regression guard. Executes in CI's isolated Postgres
-- AFTER all migrations. Never reads tenant rows or writes business data.
DO $rc2_acl$
DECLARE
  obj record;
  actor text;
  rel_count integer := 0;
  func_count integer := 0;
BEGIN
  FOR obj IN
    SELECT c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity
    FROM pg_class AS c
    JOIN pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND c.relname LIKE 'whatsapp_call_%'
  LOOP
    rel_count := rel_count + 1;
    IF NOT obj.relrowsecurity THEN
      RAISE EXCEPTION 'RC2_ACL_RLS_OFF on %', obj.relname;
    END IF;
    FOREACH actor IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF has_table_privilege(actor, obj.oid, 'SELECT')
        OR has_table_privilege(actor, obj.oid, 'INSERT')
        OR has_table_privilege(actor, obj.oid, 'UPDATE')
        OR has_table_privilege(actor, obj.oid, 'DELETE')
        OR has_table_privilege(actor, obj.oid, 'TRUNCATE')
        OR has_table_privilege(actor, obj.oid, 'REFERENCES')
        OR has_table_privilege(actor, obj.oid, 'TRIGGER')
      THEN
        RAISE EXCEPTION 'RC2_ACL_PUBLIC_TABLE_PERMISSION on % for %', obj.relname, actor;
      END IF;
    END LOOP;
  END LOOP;

  IF rel_count <> 5 THEN
    RAISE EXCEPTION 'RC2_ACL_EXPECTED_FIVE_CALLING_TABLES got %', rel_count;
  END IF;

  FOR obj IN
    SELECT p.oid, p.proname, p.prorettype
    FROM pg_proc AS p
    JOIN pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname LIKE 'whatsapp_call_%'
  LOOP
    func_count := func_count + 1;
    -- PostgreSQL trigger-returning functions are not directly callable.
    -- Their PUBLIC EXECUTE ACL is tracked, not mistaken for an API grant.
    IF obj.prorettype <> 'pg_catalog.trigger'::regtype THEN
      FOREACH actor IN ARRAY ARRAY['anon', 'authenticated'] LOOP
        IF has_function_privilege(actor, obj.oid, 'EXECUTE') THEN
          RAISE EXCEPTION 'RC2_ACL_PUBLIC_FUNCTION_EXECUTE on % for %', obj.proname, actor;
        END IF;
      END LOOP;
    END IF;
  END LOOP;
  IF func_count < 8 THEN
    RAISE EXCEPTION 'RC2_ACL_MISSING_CALLING_FUNCTIONS got %', func_count;
  END IF;
  RAISE NOTICE 'RC2_CALLING_ACL=PASS tables=% functions=%', rel_count, func_count;
END
$rc2_acl$;
