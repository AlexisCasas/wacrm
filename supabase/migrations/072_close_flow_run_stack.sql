-- ============================================================
-- 072_close_flow_run_stack   (DRAFT: written and tested, NOT applied in production)
--
-- Problem found in the real pilot (2026-10-15, run d3408025…): a run that finished INSIDE a called flow through
-- "End the whole execution" left its call frame behind in flow_run_subflow_frames. Harmless (only frames of ACTIVE runs matter),
-- but untidy, and the same would happen when an agent takes the conversation or the contact is blocked while a run sits inside a
-- called flow, because those paths change flow_runs.status directly and never go through the engine.
--
-- Fix at the ONE place every path goes through: when a run leaves 'active', its frames are written into the run's own event log
-- (so the evidence of "where the run was, who called whom, with which policy" is kept) and then removed.
--   * AFTER UPDATE OF status, only when OLD.status = 'active' AND NEW.status <> 'active' (WHEN clause: no other write calls it).
--   * Idempotent: a run with no frames writes nothing; a second update cannot fire it again (OLD is no longer active).
--   * Existing rows are NOT touched (no backfill): the residual frame of the pilot run stays as the incident evidence.
--   * No new table or column. The event type is the existing 'node_entered' (reason 'stack_closed_on_end'), so it cannot conflict
--     with E4's event-type constraint in any order.
-- ============================================================

CREATE FUNCTION public.close_flow_run_stack()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_frames JSONB;
BEGIN
  SELECT jsonb_agg(jsonb_build_object(
           'depth', f.depth, 'caller_flow_id', f.caller_flow_id, 'call_node_key', f.call_node_key, 'return_node_key', f.return_node_key,
           'callee_flow_id', f.callee_flow_id, 'on_customer_reply', f.on_customer_reply, 'called_at', f.called_at) ORDER BY f.depth)
    INTO v_frames
    FROM public.flow_run_subflow_frames f
   WHERE f.flow_run_id = NEW.id;
  IF v_frames IS NULL THEN RETURN NEW; END IF;
  INSERT INTO public.flow_run_events (flow_run_id, event_type, node_key, payload)
  VALUES (NEW.id, 'node_entered', NEW.current_node_key,
          jsonb_build_object('reason', 'stack_closed_on_end', 'end_status', NEW.status, 'end_reason', NEW.end_reason,
                             'current_flow_id', NEW.current_flow_id, 'frames', v_frames));
  DELETE FROM public.flow_run_subflow_frames f WHERE f.flow_run_id = NEW.id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER flow_runs_close_stack
  AFTER UPDATE OF status ON public.flow_runs
  FOR EACH ROW
  WHEN (OLD.status = 'active' AND NEW.status IS DISTINCT FROM 'active')
  EXECUTE FUNCTION public.close_flow_run_stack();

REVOKE ALL ON FUNCTION public.close_flow_run_stack() FROM PUBLIC, anon, authenticated;
