-- E4.2B2.2: execute_flow node type + traceability of subflow transitions. Additive.
--
-- 1. flow_nodes.node_type accepts 'execute_flow' (all 13 existing types preserved). The legacy runner
--    does not know the type and ends such a run as unknown_node_type; the legacy validator rejects it
--    unless versioned validation is requested.
-- 2. flow_run_events accepts 'subflow_called' / 'subflow_returned', written by push/pop inside the same
--    transaction as the transition, so the trace is exactly as atomic as the frame itself.
-- 3. push_versioned_run_subflow additionally proves the call comes from a published execute_flow node
--    whose config names this very target and continuation (22023 otherwise).
ALTER TABLE public.flow_nodes DROP CONSTRAINT IF EXISTS flow_nodes_node_type_check;
ALTER TABLE public.flow_nodes ADD CONSTRAINT flow_nodes_node_type_check CHECK (node_type IN (
  'start', 'send_buttons', 'send_list', 'send_message', 'send_media', 'collect_input', 'condition',
  'set_tag', 'delay', 'set_contact_field', 'handoff', 'http_fetch', 'end', 'execute_flow'
));
ALTER TABLE public.flow_run_events DROP CONSTRAINT IF EXISTS flow_run_events_event_type_check;
ALTER TABLE public.flow_run_events ADD CONSTRAINT flow_run_events_event_type_check CHECK (event_type IN (
  'started', 'node_entered', 'message_sent', 'reply_received', 'fallback_fired', 'handoff', 'timeout', 'error', 'completed',
  'subflow_called', 'subflow_returned'
));

CREATE OR REPLACE FUNCTION public.push_versioned_run_subflow(
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

  -- Defence in depth: the privileged call must come from a published execute_flow node whose own
  -- configuration names exactly this target and this continuation. A caller (or a bug in one) cannot
  -- invent a transition the snapshot does not contain.
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(COALESCE(v_caller.definition->'nodes', '[]'::jsonb)) n
    WHERE n->>'node_key' = p_call_node_key AND n->>'node_type' = 'execute_flow'
      AND lower(n#>>'{config,target_flow_id}') = p_target_flow_id::text AND n#>>'{config,next_node_key}' = p_return_node_key
  ) THEN
    RAISE EXCEPTION 'call node is not an execute_flow node matching the requested call' USING ERRCODE = '22023';
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
  -- Trace that outlives the frame (frames are deleted on return). Ids and node keys only: no
  -- variables, message text or contact data.
  INSERT INTO public.flow_run_events (flow_run_id, event_type, node_key, payload)
  VALUES (v_run.id, 'subflow_called', p_call_node_key, jsonb_build_object(
    'caller_flow_id', v_caller.flow_id, 'caller_flow_version_id', v_caller.id,
    'callee_flow_id', v_target.id, 'callee_flow_version_id', v_tver.id,
    'call_node_key', p_call_node_key, 'return_node_key', p_return_node_key, 'depth', v_depth, 'revision', v_rev));
  RETURN QUERY SELECT true, v_rev, NULL::text, v_depth, v_tver.id, v_entry, v_nodes, v_run.versioned_messages_executed;
END;
$$;

CREATE OR REPLACE FUNCTION public.pop_versioned_run_subflow(
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
  INSERT INTO public.flow_run_events (flow_run_id, event_type, node_key, payload)
  VALUES (v_run.id, 'subflow_returned', v_frame.return_node_key, jsonb_build_object(
    'caller_flow_id', v_frame.caller_flow_id, 'caller_flow_version_id', v_frame.caller_flow_version_id,
    'callee_flow_id', v_frame.callee_flow_id, 'callee_flow_version_id', v_frame.callee_flow_version_id,
    'call_node_key', v_frame.call_node_key, 'return_node_key', v_frame.return_node_key, 'depth', v_frame.depth, 'revision', v_rev));
  RETURN QUERY SELECT true, v_rev, NULL::text, v_depth, v_caller.id, v_frame.return_node_key, v_nodes, v_run.versioned_messages_executed;
END;
$$;
