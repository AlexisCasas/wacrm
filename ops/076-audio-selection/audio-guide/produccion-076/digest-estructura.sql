-- Structure digest lines of schema public WITHOUT counts and WITHOUT privileges (those are checked by the privilege matrix). Catalog functions only; no table is read.
-- Lines are compared as a set, so the order does not matter. "char"-typed catalog columns are cast to text explicitly.
SELECT l FROM (
 SELECT 'col|'||c.relname||'|'||a.attname||'|'||format_type(a.atttypid,a.atttypmod)||'|'||a.attnotnull::text||'|'||coalesce(pg_get_expr(d.adbin,d.adrelid),'')||'|'||a.attgenerated::text AS l
   FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
  WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped
 UNION ALL SELECT 'con|'||c.relname||'|'||k.conname||'|'||pg_get_constraintdef(k.oid) FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid WHERE c.relnamespace='public'::regnamespace
 UNION ALL SELECT 'idx|'||tablename||'|'||indexname||'|'||indexdef FROM pg_indexes WHERE schemaname='public'
 UNION ALL SELECT 'fn|'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')|'||md5(p.prosrc)||'|'||p.prosecdef::text||'|'||coalesce(p.proconfig::text,'') FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
 UNION ALL SELECT 'trg|'||c.relname||'|'||t.tgname||'|'||pg_get_triggerdef(t.oid) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='public'::regnamespace AND NOT t.tgisinternal
 UNION ALL SELECT 'pol|'||tablename||'|'||policyname||'|'||cmd||'|'||roles::text||'|'||coalesce(qual,'')||'|'||coalesce(with_check,'') FROM pg_policies WHERE schemaname='public'
 UNION ALL SELECT 'rls|'||c.relname||'|'||c.relrowsecurity::text||'|'||c.relforcerowsecurity::text FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r'
) s;
