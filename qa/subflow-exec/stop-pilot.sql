-- OPERATOR STOP for one pilot company. Run as supabase_admin:
--   psql -U supabase_admin -h /var/run/postgresql -d postgres -v ON_ERROR_STOP=1 -v account=<uuid> -f stop-pilot.sql
-- Deleting the enablement row only stops NEW calls / activations: runs that are already parked or running keep their state and a worker
-- could still resume them. So this script ALSO (inside one transaction): switches the company off, takes its connected / waiting flows
-- out of service, cancels every active run (including its scheduled wait) and removes the frames of the cancelled runs. It then prints
-- what remains. Flows are only moved to draft when they are the pilot's synthetic flows (names 'P8 A', 'P8 B', 'P8 C').
BEGIN;
SELECT set_config('app.flow_publication', 'on', true);
DELETE FROM public.flow_execution_enablement WHERE account_id = :'account';
UPDATE public.flows SET status = 'draft', updated_at = now() WHERE account_id = :'account' AND name IN ('P8 A', 'P8 B', 'P8 C') AND status = 'active';
CREATE TEMP TABLE _cancelled ON COMMIT DROP AS
  SELECT id FROM public.flow_runs WHERE account_id = :'account' AND status = 'active'
     AND (flow_id IN (SELECT id FROM public.flows WHERE account_id = :'account' AND name IN ('P8 A', 'P8 B', 'P8 C'))
          OR current_flow_id IN (SELECT id FROM public.flows WHERE account_id = :'account' AND name IN ('P8 A', 'P8 B', 'P8 C')) OR wait_until IS NOT NULL);
UPDATE public.flow_runs r SET status = 'failed', ended_at = now(), end_reason = 'operator_stop', wait_until = NULL, wait_node_key = NULL, wait_claim_token = NULL, wait_claimed_at = NULL
 WHERE r.id IN (SELECT id FROM _cancelled);
DELETE FROM public.flow_run_subflow_frames WHERE flow_run_id IN (SELECT id FROM _cancelled);
SELECT 'ejecuciones canceladas' AS resultado, count(*) FROM _cancelled;
SELECT 'ejecuciones activas que quedan en la empresa', count(*) FROM public.flow_runs WHERE account_id = :'account' AND status = 'active';
SELECT 'esperas programadas que quedan en la empresa', count(*) FROM public.flow_runs WHERE account_id = :'account' AND wait_until IS NOT NULL;
SELECT 'marcos que quedan de ejecuciones activas', count(*) FROM public.flow_run_subflow_frames f JOIN public.flow_runs r ON r.id = f.flow_run_id WHERE f.account_id = :'account' AND r.status = 'active';
SELECT 'filas de habilitación de la empresa', count(*) FROM public.flow_execution_enablement WHERE account_id = :'account';
SELECT 'flujos de prueba aún activos', count(*) FROM public.flows WHERE account_id = :'account' AND name IN ('P8 A', 'P8 B', 'P8 C') AND status = 'active';
COMMIT;
