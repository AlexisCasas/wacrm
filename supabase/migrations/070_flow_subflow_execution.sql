-- ============================================================
-- 070_flow_subflow_execution
--
-- Subflow execution with return for the LEGACY Flows engine: a flow can call another flow ("Run another flow"), the callee
-- runs its own sequence (delays, conditions, buttons...) and, when it finishes normally, the caller resumes at the node
-- the call points to. A -> B -> A -> C -> A is two SEQUENTIAL calls (depth 1 each), not nested.
--
-- Design (docs: qa/subflow-exec/DESIGN-P8.md):
--   * ONE run per contact, always. The call stack lives in flow_run_subflow_frames and the run keeps pointing at the
--     flow it is currently inside (flow_runs.current_flow_id, NULL = the root flow). The partial unique index that allows a
--     single active run per contact is untouched, and everything that already cancels an active run (agent takeover,
--     blocked contact, deleted flow, the stale sweep) cancels the whole stack with it.
--   * push_flow_subflow / pop_flow_subflow are the ONLY writers of the stack. Each is one atomic statement sequence under a
--     row lock on the run: two workers racing for the same call or return cannot both win.
--   * Fail closed. The stack pins the graph hash of the caller and of the callee at the moment of the call. If either
--     flow changed, stopped being active or left the account while the run was suspended, the return REFUSES and the engine
--     ends the run instead of executing new or incompatible nodes.
--   * Cycles (a flow already in the stack, including the root) and nesting deeper than 3 are refused. Targets must belong to
--     the run's own account and be active.
--   * Execution is OFF by default and is not enabled by this migration: flow_execution_enablement is created EMPTY. Only an
--     operator (migration or direct SQL as a privileged role) can insert rows; anon, authenticated and even service_role can
--     only READ it. The application's environment flag is a second, independent condition.
--   * 068 / 069 activation guards now consult that table, so enabling an account is a database-level decision instead of
--     a session setting PostgREST cannot set. Without a row the behaviour is exactly the one of 068 / 069.
--
-- Additive: one nullable column on flow_runs (+ CHECK), two new tables, helper functions, and CREATE OR REPLACE of the two
-- activation guard functions (their triggers and WHEN clauses are untouched). No data is changed or dropped.
-- Compatible with E4/F06 052-066 in any order: no name, constraint or event type of those migrations is reused.
-- ============================================================

-- ------------------------------------------------------------
-- Per-account enablement (backend-controlled, empty by default).
-- ------------------------------------------------------------
CREATE TABLE public.flow_execution_enablement (
  account_id UUID PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  subflow_execution BOOLEAN NOT NULL DEFAULT false,
  durable_wait_execution BOOLEAN NOT NULL DEFAULT false,
  note TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.flow_execution_enablement ENABLE ROW LEVEL SECURITY;   -- no policy: nobody but the owner / superusers
REVOKE ALL ON TABLE public.flow_execution_enablement FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.flow_execution_enablement TO service_role;  -- the backend may READ the switch, never flip it

-- ------------------------------------------------------------
-- Where the run currently is, and the call stack.
-- ------------------------------------------------------------
ALTER TABLE public.flow_runs
  ADD COLUMN IF NOT EXISTS current_flow_id UUID REFERENCES public.flows(id) ON DELETE CASCADE;
ALTER TABLE public.flow_runs DROP CONSTRAINT IF EXISTS flow_runs_current_flow_shape;
ALTER TABLE public.flow_runs ADD CONSTRAINT flow_runs_current_flow_shape CHECK (current_flow_id IS NULL OR current_flow_id <> flow_id);

CREATE TABLE public.flow_run_subflow_frames (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  flow_run_id UUID NOT NULL REFERENCES public.flow_runs(id) ON DELETE CASCADE,
  depth INTEGER NOT NULL CHECK (depth BETWEEN 1 AND 3),
  caller_flow_id UUID NOT NULL REFERENCES public.flows(id) ON DELETE CASCADE,
  call_node_key TEXT NOT NULL CHECK (btrim(call_node_key) <> ''),
  return_node_key TEXT NOT NULL CHECK (btrim(return_node_key) <> ''),
  callee_flow_id UUID NOT NULL REFERENCES public.flows(id) ON DELETE CASCADE,
  caller_graph_hash TEXT NOT NULL,
  callee_graph_hash TEXT NOT NULL,
  /** The reference message the caller chose to hand down (P7), restored for the parent when this frame is popped. */
  inherited_ref JSONB,
  on_customer_reply TEXT NOT NULL DEFAULT 'stop' CHECK (on_customer_reply IN ('stop', 'continue')),
  called_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT flow_run_subflow_frames_no_self_call CHECK (caller_flow_id <> callee_flow_id),
  CONSTRAINT flow_run_subflow_frames_depth_unique UNIQUE (flow_run_id, depth),
  CONSTRAINT flow_run_subflow_frames_callee_unique UNIQUE (flow_run_id, callee_flow_id)
);
ALTER TABLE public.flow_run_subflow_frames ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.flow_run_subflow_frames FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.flow_run_subflow_frames TO service_role;

-- ------------------------------------------------------------
-- Graph pin: md5 over the entry node and every node's key, type and config (layout coordinates are NOT part of it, so moving
-- boxes on the canvas never invalidates a suspended run).
-- ------------------------------------------------------------
CREATE FUNCTION public.flow_graph_hash(p_flow_id UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT md5(
    coalesce((SELECT f.entry_node_id FROM public.flows f WHERE f.id = p_flow_id), '') || '|' ||
    coalesce((SELECT string_agg(n.node_key || ':' || n.node_type || ':' || n.config::text, '|' ORDER BY n.node_key)
                FROM public.flow_nodes n WHERE n.flow_id = p_flow_id), '')
  )
$$;

-- ------------------------------------------------------------
-- Internal: why a run's stack can no longer be trusted (NULL = fine). Every flow in the stack must still exist in the run's
-- account, be active, and hash exactly as it did when the frame pinned it.
-- ------------------------------------------------------------
CREATE FUNCTION public.flow_run_stack_problem(p_run public.flow_runs)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_frame public.flow_run_subflow_frames%ROWTYPE;
  v_root_ok BOOLEAN;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.flow_run_subflow_frames x WHERE x.flow_run_id = p_run.id) THEN
    RETURN NULL; -- a flat run has no pinned graphs to protect
  END IF;
  SELECT EXISTS (SELECT 1 FROM public.flows f WHERE f.id = p_run.flow_id AND f.account_id = p_run.account_id AND f.status = 'active') INTO v_root_ok;
  IF NOT v_root_ok THEN RETURN 'caller_unavailable'; END IF;
  FOR v_frame IN SELECT * FROM public.flow_run_subflow_frames x WHERE x.flow_run_id = p_run.id ORDER BY x.depth LOOP
    IF v_frame.account_id <> p_run.account_id THEN RETURN 'account_mismatch'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.flows f WHERE f.id = v_frame.caller_flow_id AND f.account_id = p_run.account_id AND f.status = 'active') THEN
      RETURN 'caller_unavailable';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.flows f WHERE f.id = v_frame.callee_flow_id AND f.account_id = p_run.account_id AND f.status = 'active') THEN
      RETURN 'callee_unavailable';
    END IF;
    IF public.flow_graph_hash(v_frame.caller_flow_id) <> v_frame.caller_graph_hash THEN RETURN 'caller_graph_changed'; END IF;
    IF public.flow_graph_hash(v_frame.callee_flow_id) <> v_frame.callee_graph_hash THEN RETURN 'callee_graph_changed'; END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

-- Used by the engine before it resumes or answers a run that sits inside a subflow.
CREATE FUNCTION public.verify_flow_run_stack(p_account_id UUID, p_run_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_run public.flow_runs%ROWTYPE; v_problem TEXT;
BEGIN
  IF p_account_id IS NULL OR p_run_id IS NULL THEN RAISE EXCEPTION 'invalid subflow request' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_run FROM public.flow_runs r WHERE r.id = p_run_id AND r.account_id = p_account_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'run_not_found'); END IF;
  v_problem := public.flow_run_stack_problem(v_run);
  IF v_problem IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'reason', v_problem); END IF;
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- ------------------------------------------------------------
-- push_flow_subflow: enter the callee. Every check happens here, against the database, not against what the engine claims.
-- ------------------------------------------------------------
CREATE FUNCTION public.push_flow_subflow(
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

-- ------------------------------------------------------------
-- pop_flow_subflow: the callee finished normally; resume the caller at the return node. Refuses (changing nothing) when the
-- stack cannot be trusted, so the engine ends the run instead of continuing blindly.
-- ------------------------------------------------------------
CREATE FUNCTION public.pop_flow_subflow(p_account_id UUID, p_run_id UUID, p_expected_callee_flow_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run public.flow_runs%ROWTYPE; v_top public.flow_run_subflow_frames%ROWTYPE; v_parent_ref JSONB; v_problem TEXT; v_refs JSONB; v_new_current UUID;
BEGIN
  IF p_account_id IS NULL OR p_run_id IS NULL OR p_expected_callee_flow_id IS NULL THEN RAISE EXCEPTION 'invalid subflow request' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_run FROM public.flow_runs r WHERE r.id = p_run_id AND r.account_id = p_account_id FOR UPDATE;
  IF NOT FOUND OR v_run.status <> 'active' THEN RETURN jsonb_build_object('ok', false, 'reason', 'run_not_active'); END IF;
  IF v_run.wait_until IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'run_waiting'); END IF;
  SELECT * INTO v_top FROM public.flow_run_subflow_frames x WHERE x.flow_run_id = v_run.id ORDER BY x.depth DESC LIMIT 1;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_frame'); END IF;
  IF v_top.callee_flow_id <> p_expected_callee_flow_id OR v_run.current_flow_id IS DISTINCT FROM v_top.callee_flow_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'frame_mismatch');
  END IF;
  v_problem := public.flow_run_stack_problem(v_run);
  IF v_problem IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'reason', v_problem); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.flow_nodes n WHERE n.flow_id = v_top.caller_flow_id AND n.node_key = v_top.return_node_key) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'return_node_missing');
  END IF;

  SELECT x.inherited_ref INTO v_parent_ref FROM public.flow_run_subflow_frames x WHERE x.flow_run_id = v_run.id AND x.depth = v_top.depth - 1;
  v_refs := coalesce(v_run.vars->'$refs', '{}'::jsonb);
  IF jsonb_typeof(v_refs) <> 'object' THEN v_refs := '{}'::jsonb; END IF;
  IF v_parent_ref IS NULL THEN v_refs := v_refs - '$inherited'; ELSE v_refs := v_refs || jsonb_build_object('$inherited', v_parent_ref); END IF;
  v_new_current := CASE WHEN v_top.caller_flow_id = v_run.flow_id THEN NULL ELSE v_top.caller_flow_id END;
  DELETE FROM public.flow_run_subflow_frames x WHERE x.id = v_top.id;
  UPDATE public.flow_runs r
     SET current_flow_id = v_new_current, current_node_key = v_top.return_node_key, last_advanced_at = clock_timestamp(),
         vars = coalesce(r.vars, '{}'::jsonb) || jsonb_build_object('$refs', v_refs)
   WHERE r.id = v_run.id;
  RETURN jsonb_build_object('ok', true, 'return_node_key', v_top.return_node_key, 'caller_flow_id', v_top.caller_flow_id,
                            'on_customer_reply', v_top.on_customer_reply, 'called_at', v_top.called_at, 'depth', v_top.depth - 1);
END;
$$;

REVOKE ALL ON FUNCTION public.flow_graph_hash(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.flow_run_stack_problem(public.flow_runs) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.verify_flow_run_stack(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.push_flow_subflow(UUID, UUID, TEXT, UUID, TEXT, JSONB, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pop_flow_subflow(UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.flow_graph_hash(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.verify_flow_run_stack(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.push_flow_subflow(UUID, UUID, TEXT, UUID, TEXT, JSONB, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.pop_flow_subflow(UUID, UUID, UUID) TO service_role;

-- ------------------------------------------------------------
-- Activation guards (068 / 069) now read the enablement table. Same triggers, same WHEN clauses, same error codes.
-- ------------------------------------------------------------
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
