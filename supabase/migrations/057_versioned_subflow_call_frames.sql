-- E4.2B2.1: atomic subflow call frames. Additive; no interpreter wiring.
--
-- flow_run_call_frames (053) records the CALLER side of a call. B2.1 also records the CALLEE so a
-- pop can prove that the cursor still sits in the version that was pinned on entry. The table has
-- never been written by any code path, so adding NOT NULL columns is safe; the guard below aborts
-- loudly if that assumption is ever false.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.flow_run_call_frames) THEN
    RAISE EXCEPTION 'flow_run_call_frames is not empty; migration 057 expects a never-used table';
  END IF;
END $$;
ALTER TABLE public.flow_run_call_frames
  ADD COLUMN callee_flow_id UUID NOT NULL,
  ADD COLUMN callee_flow_version_id UUID NOT NULL,
  ADD CONSTRAINT flow_run_call_frames_callee_version_same_account_fkey
    FOREIGN KEY (callee_flow_version_id, account_id) REFERENCES public.flow_versions (id, account_id) ON DELETE RESTRICT,
  ADD CONSTRAINT flow_run_call_frames_no_self_call CHECK (caller_flow_id <> callee_flow_id);

-- Commit one transition atomically (B2.1: refuses completion while call frames exist and
-- keeps the cursor inside the current flow version): cursor columns, checkpoint, revision,
-- execution budget counters and (optionally) a terminal status change in a
-- single UPDATE. The cursor is
-- taken from p_checkpoint->'cursor' so cursor and checkpoint cannot diverge.
-- Conflict checks run in a fixed order and return a reason without writing:
-- run_not_active, stale_lease, lease_expired, revision_conflict,
-- budget_exceeded (nodes > 500 or messages > 100 after adding the deltas;
-- the same limits as the flow_runs CHECK constraints and VERSIONED_LIMITS). A terminal
-- p_status also releases the lease (the token is kept).
CREATE OR REPLACE FUNCTION public.commit_versioned_run_transition(
  p_account_id UUID, p_run_id UUID, p_owner TEXT, p_fencing_token INTEGER,
  p_expected_revision BIGINT, p_checkpoint JSONB,
  p_status TEXT DEFAULT 'active', p_end_reason TEXT DEFAULT NULL,
  p_nodes_delta INTEGER DEFAULT 0, p_messages_delta INTEGER DEFAULT 0
)
RETURNS TABLE (committed BOOLEAN, revision BIGINT, reason TEXT, nodes_executed INTEGER, messages_executed INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_run public.flow_runs%ROWTYPE; v_now TIMESTAMPTZ := clock_timestamp();
  v_ver UUID; v_node TEXT; v_def JSONB; v_new BIGINT; v_terminal BOOLEAN; v_nodes INTEGER; v_msgs INTEGER;
BEGIN
  IF p_owner IS NULL OR length(p_owner) NOT BETWEEN 1 AND 200 OR p_fencing_token IS NULL OR p_expected_revision IS NULL
     OR jsonb_typeof(p_checkpoint) IS DISTINCT FROM 'object' OR jsonb_typeof(p_checkpoint->'cursor') IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_checkpoint->'step') IS DISTINCT FROM 'number'
     OR p_status IS NULL OR p_status NOT IN ('active', 'completed', 'handed_off', 'failed')
     OR p_nodes_delta IS NULL OR p_nodes_delta NOT BETWEEN 0 AND 500
     OR p_messages_delta IS NULL OR p_messages_delta NOT BETWEEN 0 AND 100 THEN
    RAISE EXCEPTION 'invalid versioned run request' USING ERRCODE = '22023';
  END IF;
  v_run := public.lock_versioned_run(p_account_id, p_run_id);
  IF v_run.status <> 'active' THEN RETURN QUERY SELECT false, v_run.versioned_revision, 'run_not_active', v_run.versioned_nodes_executed, v_run.versioned_messages_executed; RETURN; END IF;
  IF v_run.versioned_lease_owner IS DISTINCT FROM p_owner OR v_run.versioned_lease <> p_fencing_token THEN
    RETURN QUERY SELECT false, v_run.versioned_revision, 'stale_lease', v_run.versioned_nodes_executed, v_run.versioned_messages_executed; RETURN;
  END IF;
  IF v_run.versioned_lease_expires_at <= v_now THEN RETURN QUERY SELECT false, v_run.versioned_revision, 'lease_expired', v_run.versioned_nodes_executed, v_run.versioned_messages_executed; RETURN; END IF;
  IF v_run.versioned_revision <> p_expected_revision THEN
    RETURN QUERY SELECT false, v_run.versioned_revision, 'revision_conflict', v_run.versioned_nodes_executed, v_run.versioned_messages_executed; RETURN;
  END IF;
  -- Only END of the root flow (no call frames) may complete the run.
  IF p_status = 'completed' AND (v_run.versioned_depth > 0 OR EXISTS (SELECT 1 FROM public.flow_run_call_frames f WHERE f.flow_run_id = v_run.id)) THEN
    RETURN QUERY SELECT false, v_run.versioned_revision, 'call_frames_active', v_run.versioned_nodes_executed, v_run.versioned_messages_executed; RETURN;
  END IF;
  IF v_run.versioned_nodes_executed + p_nodes_delta > 500 OR v_run.versioned_messages_executed + p_messages_delta > 100 THEN
    RETURN QUERY SELECT false, v_run.versioned_revision, 'budget_exceeded', v_run.versioned_nodes_executed, v_run.versioned_messages_executed; RETURN;
  END IF;

  -- The target cursor must be a real node of a published version of this account.
  BEGIN
    v_ver := (p_checkpoint #>> '{cursor,flow_version_id}')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'invalid versioned run request' USING ERRCODE = '22023';
  END;
  v_node := p_checkpoint #>> '{cursor,node_key}';
  -- Version changes happen only through push/pop, so cursor and call frames cannot diverge.
  IF v_ver IS DISTINCT FROM v_run.current_flow_version_id THEN
    RAISE EXCEPTION 'cursor can only change flow version through call frames' USING ERRCODE = '22023';
  END IF;
  IF v_ver IS NULL OR v_node IS NULL OR (p_checkpoint->>'step')::numeric < 0 OR (p_checkpoint->>'step')::numeric <> trunc((p_checkpoint->>'step')::numeric) THEN
    RAISE EXCEPTION 'invalid versioned run request' USING ERRCODE = '22023';
  END IF;
  SELECT definition INTO v_def FROM public.flow_versions WHERE id = v_ver AND account_id = p_account_id;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(v_def->'nodes', '[]'::jsonb)) n WHERE n->>'node_key' = v_node) THEN
    RAISE EXCEPTION 'checkpoint cursor is not a node of a published version' USING ERRCODE = '22023';
  END IF;

  v_terminal := p_status <> 'active';
  UPDATE public.flow_runs SET
      versioned_checkpoint = p_checkpoint,
      current_flow_version_id = v_ver,
      versioned_node_key = v_node,
      current_node_key = v_node,
      versioned_revision = versioned_revision + 1,
      versioned_nodes_executed = versioned_nodes_executed + p_nodes_delta,
      versioned_messages_executed = versioned_messages_executed + p_messages_delta,
      status = p_status,
      ended_at = CASE WHEN v_terminal THEN v_now ELSE ended_at END,
      end_reason = CASE WHEN v_terminal THEN p_end_reason ELSE end_reason END,
      versioned_lease_owner = CASE WHEN v_terminal THEN NULL ELSE versioned_lease_owner END,
      versioned_lease_expires_at = CASE WHEN v_terminal THEN NULL ELSE versioned_lease_expires_at END,
      last_advanced_at = v_now
    WHERE id = v_run.id RETURNING versioned_revision, versioned_nodes_executed, versioned_messages_executed INTO v_new, v_nodes, v_msgs;
  RETURN QUERY SELECT true, v_new, NULL::text, v_nodes, v_msgs;
END;
$$;

-- Enter a subflow: pin the target flow's currently published version, push a frame, move the
-- cursor to the target's entry node and consume one node (the call node) -- all in one UPDATE
-- guarded by lease, fencing token and expected revision. The checkpoint is built here, not by the
-- caller, so cursor, checkpoint and frames cannot disagree.
-- Controlled refusals (no write): run_not_active, stale_lease, lease_expired, revision_conflict,
-- cursor_mismatch, budget_exceeded, depth_exceeded, recursion_detected.
-- Errors: 22023 invalid request / missing return or entry node, P0002 run or target flow not found
-- (other account, draft, archived and unpublished targets are indistinguishable), 55000 corrupt state.
CREATE FUNCTION public.push_versioned_run_subflow(
  p_account_id UUID, p_run_id UUID, p_owner TEXT, p_fencing_token INTEGER, p_expected_revision BIGINT,
  p_call_node_key TEXT, p_return_node_key TEXT, p_target_flow_id UUID
)
RETURNS TABLE (committed BOOLEAN, revision BIGINT, reason TEXT, new_depth INTEGER, cursor_flow_version_id UUID, cursor_node_key TEXT, nodes_executed INTEGER, messages_executed INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_run public.flow_runs%ROWTYPE; v_now TIMESTAMPTZ := clock_timestamp();
  v_caller public.flow_versions%ROWTYPE; v_target public.flows%ROWTYPE; v_tver public.flow_versions%ROWTYPE;
  v_entry TEXT; v_step INTEGER; v_frames INTEGER; v_maxdepth INTEGER; v_rev BIGINT; v_nodes INTEGER; v_depth INTEGER;
BEGIN
  IF p_owner IS NULL OR length(p_owner) NOT BETWEEN 1 AND 200 OR p_fencing_token IS NULL OR p_expected_revision IS NULL
     OR p_call_node_key IS NULL OR p_call_node_key = '' OR p_return_node_key IS NULL OR p_return_node_key = '' OR p_target_flow_id IS NULL THEN
    RAISE EXCEPTION 'invalid versioned run request' USING ERRCODE = '22023';
  END IF;
  v_run := public.lock_versioned_run(p_account_id, p_run_id);
  IF v_run.status <> 'active' THEN RETURN QUERY SELECT false, v_run.versioned_revision, 'run_not_active', v_run.versioned_depth, NULL::uuid, NULL::text, v_run.versioned_nodes_executed, v_run.versioned_messages_executed; RETURN; END IF;
  IF v_run.versioned_lease_owner IS DISTINCT FROM p_owner OR v_run.versioned_lease <> p_fencing_token THEN
    RETURN QUERY SELECT false, v_run.versioned_revision, 'stale_lease', v_run.versioned_depth, NULL::uuid, NULL::text, v_run.versioned_nodes_executed, v_run.versioned_messages_executed; RETURN;
  END IF;
  IF v_run.versioned_lease_expires_at <= v_now THEN
    RETURN QUERY SELECT false, v_run.versioned_revision, 'lease_expired', v_run.versioned_depth, NULL::uuid, NULL::text, v_run.versioned_nodes_executed, v_run.versioned_messages_executed; RETURN;
  END IF;
  IF v_run.versioned_revision <> p_expected_revision THEN
    RETURN QUERY SELECT false, v_run.versioned_revision, 'revision_conflict', v_run.versioned_depth, NULL::uuid, NULL::text, v_run.versioned_nodes_executed, v_run.versioned_messages_executed; RETURN;
  END IF;
  -- The pending checkpoint must agree with the run cursor, and the frame stack with the depth.
  IF jsonb_typeof(v_run.versioned_checkpoint) IS DISTINCT FROM 'object'
     OR (v_run.versioned_checkpoint #>> '{cursor,flow_version_id}') IS DISTINCT FROM v_run.current_flow_version_id::text
     OR (v_run.versioned_checkpoint #>> '{cursor,node_key}') IS DISTINCT FROM v_run.versioned_node_key
     OR COALESCE(v_run.versioned_checkpoint->>'state', 'pending') <> 'pending'
     OR jsonb_typeof(v_run.versioned_checkpoint->'step') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'versioned checkpoint does not match the run cursor' USING ERRCODE = '55000';
  END IF;
  v_step := (v_run.versioned_checkpoint->>'step')::integer;
  SELECT count(*), COALESCE(max(f.depth), 0) INTO v_frames, v_maxdepth FROM public.flow_run_call_frames f WHERE f.flow_run_id = v_run.id;
  IF v_frames <> v_run.versioned_depth OR v_maxdepth <> v_run.versioned_depth THEN
    RAISE EXCEPTION 'versioned call stack is inconsistent with versioned_depth' USING ERRCODE = '55000';
  END IF;
  IF p_call_node_key <> v_run.versioned_node_key THEN RETURN QUERY SELECT false, v_run.versioned_revision, 'cursor_mismatch', v_run.versioned_depth, NULL::uuid, NULL::text, v_run.versioned_nodes_executed, v_run.versioned_messages_executed; RETURN; END IF;
  IF v_run.versioned_nodes_executed + 1 > 500 THEN RETURN QUERY SELECT false, v_run.versioned_revision, 'budget_exceeded', v_run.versioned_depth, NULL::uuid, NULL::text, v_run.versioned_nodes_executed, v_run.versioned_messages_executed; RETURN; END IF;
  IF v_run.versioned_depth + 1 > 8 THEN RETURN QUERY SELECT false, v_run.versioned_revision, 'depth_exceeded', v_run.versioned_depth, NULL::uuid, NULL::text, v_run.versioned_nodes_executed, v_run.versioned_messages_executed; RETURN; END IF;

  SELECT * INTO v_caller FROM public.flow_versions WHERE id = v_run.current_flow_version_id AND account_id = p_account_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'versioned call stack references a missing version' USING ERRCODE = '55000'; END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(v_caller.definition->'nodes', '[]'::jsonb)) n WHERE n->>'node_key' = p_return_node_key) THEN
    RAISE EXCEPTION 'return node not found in caller version' USING ERRCODE = '22023';
  END IF;

  -- FOR SHARE: a concurrent republication of the target waits for this call (or this call sees the
  -- new version); either way the version read here is the one pinned in the frame.
  SELECT * INTO v_target FROM public.flows WHERE id = p_target_flow_id AND account_id = p_account_id FOR SHARE;
  IF NOT FOUND OR v_target.status <> 'active' OR v_target.active_version_id IS NULL THEN
    RAISE EXCEPTION 'active published flow not found' USING ERRCODE = 'P0002';
  END IF;
  -- Recursion is judged by flow identity across the whole stack, whatever the versions are.
  IF p_target_flow_id = v_caller.flow_id
     OR EXISTS (SELECT 1 FROM public.flow_run_call_frames f WHERE f.flow_run_id = v_run.id AND f.caller_flow_id = p_target_flow_id) THEN
    RETURN QUERY SELECT false, v_run.versioned_revision, 'recursion_detected', v_run.versioned_depth, NULL::uuid, NULL::text, v_run.versioned_nodes_executed, v_run.versioned_messages_executed; RETURN;
  END IF;
  SELECT * INTO v_tver FROM public.flow_versions WHERE id = v_target.active_version_id AND flow_id = v_target.id AND account_id = p_account_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'published version not found' USING ERRCODE = 'P0002'; END IF;
  v_entry := v_tver.definition #>> '{flow,entry_node_id}';
  IF v_entry IS NULL OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(v_tver.definition->'nodes', '[]'::jsonb)) n WHERE n->>'node_key' = v_entry) THEN
    RAISE EXCEPTION 'published definition has no entry cursor' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.flow_run_call_frames (flow_run_id, account_id, caller_flow_id, caller_flow_version_id, call_node_key, return_node_key, depth, callee_flow_id, callee_flow_version_id)
  VALUES (v_run.id, p_account_id, v_caller.flow_id, v_caller.id, p_call_node_key, p_return_node_key, v_run.versioned_depth + 1, v_target.id, v_tver.id);

  UPDATE public.flow_runs SET
      current_flow_version_id = v_tver.id, versioned_node_key = v_entry, current_node_key = v_entry,
      versioned_depth = versioned_depth + 1, versioned_nodes_executed = versioned_nodes_executed + 1,
      versioned_revision = versioned_revision + 1, last_advanced_at = v_now,
      versioned_checkpoint = jsonb_build_object(
        'cursor', jsonb_build_object('flow_version_id', v_tver.id, 'node_key', v_entry), 'step', v_step + 1, 'state', 'pending', 'failure', NULL,
        'confirmed', jsonb_build_object('flow_version_id', v_caller.id, 'node_key', p_call_node_key, 'step', v_step))
    WHERE id = v_run.id
    RETURNING versioned_revision, versioned_nodes_executed, versioned_depth INTO v_rev, v_nodes, v_depth;
  RETURN QUERY SELECT true, v_rev, NULL::text, v_depth, v_tver.id, v_entry, v_nodes, v_run.versioned_messages_executed;
END;
$$;

-- Return to the caller: valid only while the cursor sits on an END node of the callee version
-- recorded in the top frame. Restores the caller version and continuation node, deletes the frame
-- (the stack is the set of live frames), consumes one node (the END of the subflow) and keeps the
-- run active. Completing the root run is still the job of END without frames via the commit RPC.
-- Controlled refusals (no write): run_not_active, stale_lease, lease_expired, revision_conflict,
-- no_frame, cursor_not_at_end, budget_exceeded. Errors: 22023, P0002 (run), 55000 (corrupt state).
CREATE FUNCTION public.pop_versioned_run_subflow(
  p_account_id UUID, p_run_id UUID, p_owner TEXT, p_fencing_token INTEGER, p_expected_revision BIGINT
)
RETURNS TABLE (committed BOOLEAN, revision BIGINT, reason TEXT, new_depth INTEGER, cursor_flow_version_id UUID, cursor_node_key TEXT, nodes_executed INTEGER, messages_executed INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_run public.flow_runs%ROWTYPE; v_now TIMESTAMPTZ := clock_timestamp();
  v_frame public.flow_run_call_frames%ROWTYPE; v_callee public.flow_versions%ROWTYPE; v_caller public.flow_versions%ROWTYPE;
  v_step INTEGER; v_frames INTEGER; v_maxdepth INTEGER; v_rev BIGINT; v_nodes INTEGER; v_depth INTEGER;
BEGIN
  IF p_owner IS NULL OR length(p_owner) NOT BETWEEN 1 AND 200 OR p_fencing_token IS NULL OR p_expected_revision IS NULL THEN
    RAISE EXCEPTION 'invalid versioned run request' USING ERRCODE = '22023';
  END IF;
  v_run := public.lock_versioned_run(p_account_id, p_run_id);
  IF v_run.status <> 'active' THEN RETURN QUERY SELECT false, v_run.versioned_revision, 'run_not_active', v_run.versioned_depth, NULL::uuid, NULL::text, v_run.versioned_nodes_executed, v_run.versioned_messages_executed; RETURN; END IF;
  IF v_run.versioned_lease_owner IS DISTINCT FROM p_owner OR v_run.versioned_lease <> p_fencing_token THEN
    RETURN QUERY SELECT false, v_run.versioned_revision, 'stale_lease', v_run.versioned_depth, NULL::uuid, NULL::text, v_run.versioned_nodes_executed, v_run.versioned_messages_executed; RETURN;
  END IF;
  IF v_run.versioned_lease_expires_at <= v_now THEN
    RETURN QUERY SELECT false, v_run.versioned_revision, 'lease_expired', v_run.versioned_depth, NULL::uuid, NULL::text, v_run.versioned_nodes_executed, v_run.versioned_messages_executed; RETURN;
  END IF;
  IF v_run.versioned_revision <> p_expected_revision THEN
    RETURN QUERY SELECT false, v_run.versioned_revision, 'revision_conflict', v_run.versioned_depth, NULL::uuid, NULL::text, v_run.versioned_nodes_executed, v_run.versioned_messages_executed; RETURN;
  END IF;
  -- The pending checkpoint must agree with the run cursor, and the frame stack with the depth.
  IF jsonb_typeof(v_run.versioned_checkpoint) IS DISTINCT FROM 'object'
     OR (v_run.versioned_checkpoint #>> '{cursor,flow_version_id}') IS DISTINCT FROM v_run.current_flow_version_id::text
     OR (v_run.versioned_checkpoint #>> '{cursor,node_key}') IS DISTINCT FROM v_run.versioned_node_key
     OR COALESCE(v_run.versioned_checkpoint->>'state', 'pending') <> 'pending'
     OR jsonb_typeof(v_run.versioned_checkpoint->'step') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'versioned checkpoint does not match the run cursor' USING ERRCODE = '55000';
  END IF;
  v_step := (v_run.versioned_checkpoint->>'step')::integer;
  SELECT count(*), COALESCE(max(f.depth), 0) INTO v_frames, v_maxdepth FROM public.flow_run_call_frames f WHERE f.flow_run_id = v_run.id;
  IF v_frames <> v_run.versioned_depth OR v_maxdepth <> v_run.versioned_depth THEN
    RAISE EXCEPTION 'versioned call stack is inconsistent with versioned_depth' USING ERRCODE = '55000';
  END IF;
  IF v_run.versioned_depth = 0 THEN RETURN QUERY SELECT false, v_run.versioned_revision, 'no_frame', v_run.versioned_depth, NULL::uuid, NULL::text, v_run.versioned_nodes_executed, v_run.versioned_messages_executed; RETURN; END IF;
  SELECT * INTO v_frame FROM public.flow_run_call_frames f WHERE f.flow_run_id = v_run.id AND f.depth = v_run.versioned_depth FOR UPDATE;
  IF NOT FOUND OR v_frame.callee_flow_version_id IS DISTINCT FROM v_run.current_flow_version_id THEN
    RAISE EXCEPTION 'cursor is not inside the callee version of the top call frame' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_callee FROM public.flow_versions WHERE id = v_frame.callee_flow_version_id AND account_id = p_account_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'versioned call stack references a missing version' USING ERRCODE = '55000'; END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(v_callee.definition->'nodes', '[]'::jsonb)) n
                 WHERE n->>'node_key' = v_run.versioned_node_key AND n->>'node_type' = 'end') THEN
    RETURN QUERY SELECT false, v_run.versioned_revision, 'cursor_not_at_end', v_run.versioned_depth, NULL::uuid, NULL::text, v_run.versioned_nodes_executed, v_run.versioned_messages_executed; RETURN;
  END IF;
  IF v_run.versioned_nodes_executed + 1 > 500 THEN RETURN QUERY SELECT false, v_run.versioned_revision, 'budget_exceeded', v_run.versioned_depth, NULL::uuid, NULL::text, v_run.versioned_nodes_executed, v_run.versioned_messages_executed; RETURN; END IF;
  SELECT * INTO v_caller FROM public.flow_versions WHERE id = v_frame.caller_flow_version_id AND account_id = p_account_id;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(v_caller.definition->'nodes', '[]'::jsonb)) n WHERE n->>'node_key' = v_frame.return_node_key) THEN
    RAISE EXCEPTION 'return node not found in caller version' USING ERRCODE = '55000';
  END IF;

  DELETE FROM public.flow_run_call_frames WHERE id = v_frame.id;
  UPDATE public.flow_runs SET
      current_flow_version_id = v_caller.id, versioned_node_key = v_frame.return_node_key, current_node_key = v_frame.return_node_key,
      versioned_depth = versioned_depth - 1, versioned_nodes_executed = versioned_nodes_executed + 1,
      versioned_revision = versioned_revision + 1, last_advanced_at = v_now,
      versioned_checkpoint = jsonb_build_object(
        'cursor', jsonb_build_object('flow_version_id', v_caller.id, 'node_key', v_frame.return_node_key), 'step', v_step + 1, 'state', 'pending', 'failure', NULL,
        'confirmed', jsonb_build_object('flow_version_id', v_callee.id, 'node_key', v_run.versioned_node_key, 'step', v_step))
    WHERE id = v_run.id
    RETURNING versioned_revision, versioned_nodes_executed, versioned_depth INTO v_rev, v_nodes, v_depth;
  RETURN QUERY SELECT true, v_rev, NULL::text, v_depth, v_caller.id, v_frame.return_node_key, v_nodes, v_run.versioned_messages_executed;
END;
$$;

DO $$
DECLARE f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.push_versioned_run_subflow(UUID,UUID,TEXT,INTEGER,BIGINT,TEXT,TEXT,UUID)',
    'public.pop_versioned_run_subflow(UUID,UUID,TEXT,INTEGER,BIGINT)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $$;
