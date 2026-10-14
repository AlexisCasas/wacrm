-- ROLLBACK of 071_flow_execution_defaults (operator script, NOT a migration; run with psql -1 -v ON_ERROR_STOP=1 as a privileged role).
-- Puts the three functions 071 replaced back to their 070 definitions (per-account row only) and removes what 071 added.
-- Safe at any time: 071 enabled nothing by itself. If the global default was ON, accounts without their own row stop being enabled the moment this runs.
BEGIN;
CREATE OR REPLACE FUNCTION public.push_flow_subflow(
  p_account_id UUID, p_run_id UUID, p_call_node_key TEXT, p_callee_flow_id UUID, p_return_node_key TEXT,
  p_reference JSONB DEFAULT NULL, p_on_customer_reply TEXT DEFAULT 'stop'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run public.flow_runs%ROWTYPE;
  v_caller UUID; v_depth INTEGER; v_top public.flow_run_subflow_frames%ROWTYPE; v_entry TEXT;
  v_caller_hash TEXT; v_callee_hash TEXT; v_problem TEXT; v_refs JSONB; v_calls INTEGER;
BEGIN
  IF p_account_id IS NULL OR p_run_id IS NULL OR p_callee_flow_id IS NULL OR p_call_node_key IS NULL OR btrim(p_call_node_key) = ''
     OR p_return_node_key IS NULL OR btrim(p_return_node_key) = '' OR p_on_customer_reply NOT IN ('stop', 'continue')
     OR (p_reference IS NOT NULL AND jsonb_typeof(p_reference) <> 'object') THEN
    RAISE EXCEPTION 'invalid subflow request' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_run FROM public.flow_runs r WHERE r.id = p_run_id AND r.account_id = p_account_id FOR UPDATE;
  IF NOT FOUND OR v_run.status <> 'active' THEN RETURN jsonb_build_object('ok', false, 'reason', 'run_not_active'); END IF;
  IF v_run.wait_until IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'run_waiting'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.flow_execution_enablement e WHERE e.account_id = p_account_id AND e.subflow_execution) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'subflow_execution_not_enabled');
  END IF;

  v_caller := coalesce(v_run.current_flow_id, v_run.flow_id);
  SELECT count(*) INTO v_depth FROM public.flow_run_subflow_frames x WHERE x.flow_run_id = v_run.id;
  IF v_depth >= 3 THEN RETURN jsonb_build_object('ok', false, 'reason', 'max_depth'); END IF;
  -- a loop that keeps calling flows (sequentially) is bounded too: at most 8 calls per run
  v_calls := CASE WHEN coalesce(v_run.vars->>'$call_count', '') ~ '^[0-9]{1,3}$' THEN (v_run.vars->>'$call_count')::INTEGER ELSE 0 END;
  IF v_calls >= 8 THEN RETURN jsonb_build_object('ok', false, 'reason', 'call_budget'); END IF;

  IF p_callee_flow_id = v_caller OR p_callee_flow_id = v_run.flow_id
     OR EXISTS (SELECT 1 FROM public.flow_run_subflow_frames x WHERE x.flow_run_id = v_run.id AND (x.callee_flow_id = p_callee_flow_id OR x.caller_flow_id = p_callee_flow_id)) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'cycle');
  END IF;

  -- the already-pinned part of the stack must still be intact before the run goes deeper
  v_problem := public.flow_run_stack_problem(v_run);
  IF v_problem IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'reason', v_problem); END IF;

  IF NOT EXISTS (SELECT 1 FROM public.flows f WHERE f.id = v_caller AND f.account_id = p_account_id AND f.status = 'active') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'caller_unavailable');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.flows f WHERE f.id = p_callee_flow_id AND f.account_id = p_account_id AND f.status = 'active') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'callee_unavailable');
  END IF;
  -- the node the engine says it is executing must really be this call, in the caller, with this target and return node
  IF NOT EXISTS (SELECT 1 FROM public.flow_nodes n WHERE n.flow_id = v_caller AND n.node_key = p_call_node_key AND n.node_type = 'execute_flow'
                    AND n.config->>'target_flow_id' = p_callee_flow_id::text AND n.config->>'next_node_key' = p_return_node_key) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'call_node_mismatch');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.flow_nodes n WHERE n.flow_id = v_caller AND n.node_key = p_return_node_key) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'return_node_missing');
  END IF;
  SELECT f.entry_node_id INTO v_entry FROM public.flows f WHERE f.id = p_callee_flow_id;
  IF v_entry IS NULL OR NOT EXISTS (SELECT 1 FROM public.flow_nodes n WHERE n.flow_id = p_callee_flow_id AND n.node_key = v_entry) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'callee_entry_missing');
  END IF;

  v_caller_hash := public.flow_graph_hash(v_caller);
  v_callee_hash := public.flow_graph_hash(p_callee_flow_id);
  INSERT INTO public.flow_run_subflow_frames (account_id, flow_run_id, depth, caller_flow_id, call_node_key, return_node_key, callee_flow_id,
                                              caller_graph_hash, callee_graph_hash, inherited_ref, on_customer_reply)
  VALUES (p_account_id, v_run.id, v_depth + 1, v_caller, p_call_node_key, p_return_node_key, p_callee_flow_id,
          v_caller_hash, v_callee_hash, p_reference, p_on_customer_reply);

  v_refs := coalesce(v_run.vars->'$refs', '{}'::jsonb);
  IF jsonb_typeof(v_refs) <> 'object' THEN v_refs := '{}'::jsonb; END IF;
  IF p_reference IS NULL THEN v_refs := v_refs - '$inherited'; ELSE v_refs := v_refs || jsonb_build_object('$inherited', p_reference); END IF;
  UPDATE public.flow_runs r
     SET current_flow_id = p_callee_flow_id, current_node_key = v_entry, last_advanced_at = clock_timestamp(),
         vars = coalesce(r.vars, '{}'::jsonb) || jsonb_build_object('$refs', v_refs, '$call_count', v_calls + 1)
   WHERE r.id = v_run.id;
  RETURN jsonb_build_object('ok', true, 'entry_node_key', v_entry, 'depth', v_depth + 1);
END;
$$;


CREATE OR REPLACE FUNCTION public.guard_execute_flow_activation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.flow_nodes n WHERE n.flow_id = NEW.id AND n.node_type = 'execute_flow')
     AND NOT EXISTS (SELECT 1 FROM public.flow_execution_enablement e WHERE e.account_id = NEW.account_id AND e.subflow_execution) THEN
    RAISE EXCEPTION 'flows with execute_flow nodes cannot be activated: subflow execution is not enabled' USING ERRCODE = '0A000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_durable_wait_activation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF current_setting('app.allow_durable_wait_activation', true) IS DISTINCT FROM 'on'
     AND EXISTS (SELECT 1 FROM public.flow_nodes n WHERE n.flow_id = NEW.id AND n.node_type = 'delay' AND n.config ? 'unit')
     AND NOT EXISTS (SELECT 1 FROM public.flow_execution_enablement e WHERE e.account_id = NEW.account_id AND e.durable_wait_execution) THEN
    RAISE EXCEPTION 'flows with durable waits cannot be activated: waiting is not enabled' USING ERRCODE = '0A000';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.push_flow_subflow(UUID, UUID, TEXT, UUID, TEXT, JSONB, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.push_flow_subflow(UUID, UUID, TEXT, UUID, TEXT, JSONB, TEXT) TO service_role;
DROP FUNCTION IF EXISTS public.enabled_execution_account_ids(TEXT);
DROP FUNCTION IF EXISTS public.flow_execution_enabled(UUID, TEXT);
DROP TABLE IF EXISTS public.flow_execution_defaults;
COMMIT;
