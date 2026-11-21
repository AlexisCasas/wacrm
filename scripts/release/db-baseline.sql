-- Release dry-run baseline. READ-ONLY (SELECTs only). Prints `section|key|value` lines: structure as names + md5 hashes of definitions, row counts and md5 hashes of the data
-- (never row contents), so two runs (PRE / POST migration) can be diffed without exposing any personal data.
--   psql -At -F '|' -d <db> -f scripts/release/db-baseline.sql > baseline.txt
\set ON_ERROR_STOP on
SET default_transaction_read_only = on;
SET search_path = pg_catalog; -- definitions fully qualified: the output must not depend on the database-level search_path

-- structure ---------------------------------------------------------------------------------------------------------------------------------
SELECT 'table', n.nspname || '.' || c.relname, md5(string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text || ':' || coalesce(pg_get_expr(d.adbin, d.adrelid), ''), ',' ORDER BY a.attnum))
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
  LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
 WHERE c.relkind IN ('r', 'p') AND n.nspname IN ('public', 'auth', 'storage') GROUP BY 2 ORDER BY 2;
SELECT 'constraint', conrelid::regclass::text || '.' || conname, md5(pg_get_constraintdef(oid)) FROM pg_constraint WHERE connamespace IN ('public'::regnamespace, 'auth'::regnamespace, 'storage'::regnamespace) ORDER BY 2;
SELECT 'index', schemaname || '.' || indexname, md5(indexdef) FROM pg_indexes WHERE schemaname IN ('public', 'auth', 'storage') ORDER BY 2;
SELECT 'function', n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', md5(p.prosrc || coalesce(array_to_string(p.proacl, ','), '') || p.prosecdef::text) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('public', 'auth', 'storage') ORDER BY 2;
SELECT 'trigger', tgrelid::regclass::text || '.' || tgname, md5(pg_get_triggerdef(oid)) FROM pg_trigger WHERE NOT tgisinternal AND tgrelid::regclass::text ~ '^(public|auth|storage)\.|^[a-z_]+$' ORDER BY 2;
SELECT 'policy', schemaname || '.' || tablename || '.' || policyname, md5(coalesce(qual, '') || '|' || coalesce(with_check, '') || '|' || cmd || '|' || array_to_string(roles, ',')) FROM pg_policies WHERE schemaname IN ('public', 'storage') ORDER BY 2;
SELECT 'enum', t.typname, md5(string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder)) FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' GROUP BY 2 ORDER BY 2;
SELECT 'rls', n.nspname || '.' || c.relname, c.relrowsecurity::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'r' AND n.nspname IN ('public', 'storage') ORDER BY 2;
SELECT 'bucket', id, public::text || ':' || coalesce(file_size_limit::text, '') || ':' || coalesce(array_to_string(allowed_mime_types, ','), '') FROM storage.buckets ORDER BY 2;
SELECT 'extension', extname, extversion FROM pg_extension ORDER BY 2;

-- row counts of EVERY public table -------------------------------------------------------------------------------------------------------------
SELECT 'count', 'public.' || table_name, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', table_name), false, true, '')))[1]::text
  FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 2;
SELECT 'count', 'auth.users', count(*)::text FROM auth.users;
SELECT 'count', 'storage.objects', count(*)::text FROM storage.objects;

-- md5 of the DATA of the critical tables (hash only, ordered by primary key: no content leaves the database) -----------------------------------------
SELECT 'data', t, (xpath('/row/h/text()', query_to_xml(format('select md5(coalesce(string_agg(md5(x::text), '''' order by md5(x::text)), '''')) as h from public.%I x', t), false, true, '')))[1]::text
  FROM unnest(ARRAY['accounts', 'profiles', 'contacts', 'conversations', 'messages', 'order_confirmations', 'order_confirmation_items', 'order_integration_settings', 'order_sellers',
                    'flows', 'flow_nodes', 'flow_runs', 'automations', 'whatsapp_config', 'message_templates', 'deals', 'notifications', 'inbound_dispatch_ledger', 'contact_deletion_operations']) AS t
 WHERE to_regclass('public.' || t) IS NOT NULL ORDER BY 2;
