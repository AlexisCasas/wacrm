-- P14: general availability of EXECUTION (database half). Run as supabase_admin, one transaction, auditable:
--   psql -U supabase_admin -h /var/run/postgresql -d postgres -v ON_ERROR_STOP=1 -1 -f enable-p14.sql
-- Only the single row of flow_execution_defaults changes. Per-company rows in flow_execution_enablement are NOT touched: an explicit
-- row (true or false) keeps winning over this default, so any company can still be switched off individually.
SELECT 'before', subflow_execution, durable_wait_execution FROM public.flow_execution_defaults;
UPDATE public.flow_execution_defaults
   SET subflow_execution = true, durable_wait_execution = true, note = 'P14 general availability', updated_at = now();
SELECT 'after', subflow_execution, durable_wait_execution, note FROM public.flow_execution_defaults;
SELECT 'explicit company rows (they prevail over the default)', count(*) FILTER (WHERE NOT subflow_execution OR NOT durable_wait_execution) AS switched_off, count(*) AS total FROM public.flow_execution_enablement;
