-- RC2 metadata-only snapshot for ACL parity of restored production.
-- Invoke from a private host (never upload snapshots to GitHub):
--   psql -XAt -v ON_ERROR_STOP=1 -f supabase/ci/rc2-acl-snapshot.sql > before.jsonl
-- Run once against production READ ONLY and once against the isolated
-- restored database AFTER Calling migrations. Files must stay mode 0600.
-- Captures DDL metadata only; never reads customer rows or secrets.
WITH
rels AS (
  SELECT
    'relation:public.' || c.relname AS k,
    jsonb_build_object(
      'kind', c.relkind::text,
      'rls', c.relrowsecurity,
      'force_rls', c.relforcerowsecurity,
      'anon', jsonb_build_object(
        'select', has_table_privilege('anon', c.oid, 'SELECT'),
        'insert', has_table_privilege('anon', c.oid, 'INSERT'),
        'update', has_table_privilege('anon', c.oid, 'UPDATE'),
        'delete', has_table_privilege('anon', c.oid, 'DELETE')
      ),
      'authenticated', jsonb_build_object(
        'select', has_table_privilege('authenticated', c.oid, 'SELECT'),
        'insert', has_table_privilege('authenticated', c.oid, 'INSERT'),
        'update', has_table_privilege('authenticated', c.oid, 'UPDATE'),
        'delete', has_table_privilege('authenticated', c.oid, 'DELETE')
      ),
      'service_role', jsonb_build_object(
        'select', has_table_privilege('service_role', c.oid, 'SELECT'),
        'insert', has_table_privilege('service_role', c.oid, 'INSERT'),
        'update', has_table_privilege('service_role', c.oid, 'UPDATE'),
        'delete', has_table_privilege('service_role', c.oid, 'DELETE')
      ),
      'policies', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'name', p.polname, 'cmd', p.polcmd,
          'permissive', p.polpermissive,
          'roles', (SELECT array_agg(rolname ORDER BY rolname)
                    FROM pg_roles WHERE oid = ANY(p.polroles)),
          'qual', pg_get_expr(p.polqual, p.polrelid),
          'check', pg_get_expr(p.polwithcheck, p.polrelid)
        ) ORDER BY p.polname)
        FROM pg_policy AS p WHERE p.polrelid = c.oid
      ), '[]'::jsonb)
    ) AS v
  FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')
),
funcs AS (
  SELECT
    'function:public.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS k,
    jsonb_build_object(
      'definer', p.prosecdef, 'return_type', p.prorettype::regtype::text,
      'anon_execute', has_function_privilege('anon', p.oid, 'EXECUTE'),
      'authenticated_execute', has_function_privilege('authenticated', p.oid, 'EXECUTE'),
      'service_role_execute', has_function_privilege('service_role', p.oid, 'EXECUTE')
    ) AS v
  FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
),
schema_roles AS (
  SELECT 'schema:public' AS k,
    jsonb_build_object(
      'anon_usage', has_schema_privilege('anon', 'public', 'USAGE'),
      'authenticated_usage', has_schema_privilege('authenticated', 'public', 'USAGE'),
      'service_role_usage', has_schema_privilege('service_role', 'public', 'USAGE')
    ) AS v
),
realtime_role AS (
  SELECT 'role:supabase_realtime_admin' AS k,
    jsonb_build_object('exists',
      EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_realtime_admin')
    ) AS v
)
SELECT jsonb_build_object('key', k, 'value', v)::text
FROM (
  SELECT * FROM rels UNION ALL SELECT * FROM funcs
  UNION ALL SELECT * FROM schema_roles UNION ALL SELECT * FROM realtime_role
) objects ORDER BY k;
