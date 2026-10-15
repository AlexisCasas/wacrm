-- ROLLBACK of 072_close_flow_run_stack (operator script, NOT a migration). Frames archived into events stay in the events.
BEGIN;
DROP TRIGGER IF EXISTS flow_runs_close_stack ON public.flow_runs;
DROP FUNCTION IF EXISTS public.close_flow_run_stack();
COMMIT;
