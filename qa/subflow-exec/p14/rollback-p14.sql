-- P14 ROLLBACK (database half). Run as supabase_admin, one transaction. Effective immediately for every company, no restart needed:
--   psql -U supabase_admin -h /var/run/postgresql -d postgres -v ON_ERROR_STOP=1 -1 -f rollback-p14.sql
-- Deleting a row or flipping a switch only stops NEW calls and activations; runs already parked or running would still be resumed by a
-- worker. So this script ALSO cancels every active run that uses the P6-P8 machinery (a scheduled wait, a call stack, or a graph with
-- "run another flow" / durable wait / customer-activity condition). It touches NO flow, NO message and NO legacy run: plain legacy runs
-- keep going. The call frames of cancelled runs are archived and removed by trigger flow_runs_close_stack (migration 072).
SELECT set_config('app.flow_publication', 'on', true);
-- 1) global default OFF
UPDATE public.flow_execution_defaults SET subflow_execution = false, durable_wait_execution = false, note = 'P14 rolled back', updated_at = now();
-- 2) individual ENABLING rows would still prevail over the OFF default: remove them. Explicit "off" rows stay (they only restrict).
DELETE FROM public.flow_execution_enablement WHERE subflow_execution OR durable_wait_execution;
-- 3) cancel the P6-P8 runs (identify first, audit event, then close)
CREATE TEMP TABLE _p14_runs ON COMMIT DROP AS
  SELECT r.id FROM public.flow_runs r
   WHERE r.status = 'active'
     AND (r.wait_until IS NOT NULL OR r.current_flow_id IS NOT NULL
          OR EXISTS (SELECT 1 FROM public.flow_run_subflow_frames f WHERE f.flow_run_id = r.id)
          OR EXISTS (SELECT 1 FROM public.flow_nodes n WHERE n.flow_id = r.flow_id
                      AND (n.node_type = 'execute_flow' OR (n.node_type = 'delay' AND n.config ? 'unit')
                           OR (n.node_type = 'condition' AND n.config->>'subject' = 'customer_activity'))));
INSERT INTO public.flow_run_events (flow_run_id, event_type, node_key, payload)
  SELECT r.id, 'error', r.current_node_key, jsonb_build_object('reason', 'operator_rollback', 'detail', 'P14 rolled back; run cancelled, nothing is sent')
    FROM public.flow_runs r WHERE r.id IN (SELECT id FROM _p14_runs);
UPDATE public.flow_runs r
   SET status = 'failed', ended_at = now(), end_reason = 'operator_rollback', wait_until = NULL, wait_node_key = NULL, wait_claim_token = NULL, wait_claimed_at = NULL
 WHERE r.id IN (SELECT id FROM _p14_runs) AND r.status = 'active';
-- 4) report (changes nothing): ACTIVE flows that use the features keep their status; with the switches off each new trigger fails closed
SELECT 'cancelled P6-P8 runs', count(*) FROM _p14_runs;
SELECT 'defaults now', subflow_execution, durable_wait_execution FROM public.flow_execution_defaults;
SELECT 'enabling rows left', count(*) FROM public.flow_execution_enablement WHERE subflow_execution OR durable_wait_execution;
SELECT 'active P6-P8 runs left', count(*) FROM public.flow_runs WHERE status = 'active' AND (wait_until IS NOT NULL OR current_flow_id IS NOT NULL);
SELECT 'frames of active runs left', count(*) FROM public.flow_run_subflow_frames f JOIN public.flow_runs r ON r.id = f.flow_run_id WHERE r.status = 'active';
SELECT 'ACTIVE flows using the features (review by hand, not changed)', f.account_id, count(DISTINCT f.id)
  FROM public.flows f JOIN public.flow_nodes n ON n.flow_id = f.id
 WHERE f.status = 'active' AND (n.node_type = 'execute_flow' OR (n.node_type = 'delay' AND n.config ? 'unit') OR (n.node_type = 'condition' AND n.config->>'subject' = 'customer_activity'))
 GROUP BY f.account_id;
