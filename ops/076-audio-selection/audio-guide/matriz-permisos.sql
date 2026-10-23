-- Privilege matrix of schema public for the three client roles (anon, authenticated, service_role). READ ONLY: catalog functions only.
-- Used twice with the SAME text: once on production (exported by the owner) and once on the restored copy by ensayo-076-v4.sh (check B07).
-- One line per object; no data, no owners (the copy is owned by supabase_admin by design), extension members excluded.
--   sch|public|<role>=UC                        schema USAGE / CREATE
--   tbl|<table>|<role>=rawdDxt                  SELECT INSERT UPDATE DELETE TRUNCATE REFERENCES TRIGGER ('-' when absent)
--   seq|<sequence>|<role>=Urw                   USAGE SELECT UPDATE
--   fn|<name>(<identity args>)|<role>=X         EXECUTE
WITH r(role) AS (VALUES ('anon'), ('authenticated'), ('service_role'))
SELECT line FROM (
  SELECT 'sch|public|' || string_agg(r.role || '='
         || CASE WHEN has_schema_privilege(r.role, 'public', 'USAGE') THEN 'U' ELSE '-' END
         || CASE WHEN has_schema_privilege(r.role, 'public', 'CREATE') THEN 'C' ELSE '-' END, ' ' ORDER BY r.role) AS line
    FROM r
  UNION ALL
  SELECT 'tbl|' || c.relname || '|' || string_agg(r.role || '='
         || CASE WHEN has_table_privilege(r.role, c.oid, 'SELECT') THEN 'r' ELSE '-' END
         || CASE WHEN has_table_privilege(r.role, c.oid, 'INSERT') THEN 'a' ELSE '-' END
         || CASE WHEN has_table_privilege(r.role, c.oid, 'UPDATE') THEN 'w' ELSE '-' END
         || CASE WHEN has_table_privilege(r.role, c.oid, 'DELETE') THEN 'd' ELSE '-' END
         || CASE WHEN has_table_privilege(r.role, c.oid, 'TRUNCATE') THEN 'D' ELSE '-' END
         || CASE WHEN has_table_privilege(r.role, c.oid, 'REFERENCES') THEN 'x' ELSE '-' END
         || CASE WHEN has_table_privilege(r.role, c.oid, 'TRIGGER') THEN 't' ELSE '-' END, ' ' ORDER BY r.role)
    FROM pg_class c CROSS JOIN r
   WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm')
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
   GROUP BY c.relname
  UNION ALL
  SELECT 'seq|' || c.relname || '|' || string_agg(r.role || '='
         || CASE WHEN has_sequence_privilege(r.role, c.oid, 'USAGE') THEN 'U' ELSE '-' END
         || CASE WHEN has_sequence_privilege(r.role, c.oid, 'SELECT') THEN 'r' ELSE '-' END
         || CASE WHEN has_sequence_privilege(r.role, c.oid, 'UPDATE') THEN 'w' ELSE '-' END, ' ' ORDER BY r.role)
    FROM pg_class c CROSS JOIN r
   WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'S'
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
   GROUP BY c.relname
  UNION ALL
  SELECT 'fn|' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')|' || string_agg(r.role || '='
         || CASE WHEN has_function_privilege(r.role, p.oid, 'EXECUTE') THEN 'X' ELSE '-' END, ' ' ORDER BY r.role)
    FROM pg_proc p CROSS JOIN r
   WHERE p.pronamespace = 'public'::regnamespace
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
   GROUP BY p.oid, p.proname
) s;
