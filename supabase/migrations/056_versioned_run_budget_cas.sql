-- E4.2B1.3: the CAS commit also persists the execution budget counters in the
-- same UPDATE as cursor + checkpoint, so a restarted process can never lose
-- or double-count consumed nodes/messages. Replaces the 055 signature (8 args,
-- 3 result columns); callers using the old arguments keep working through the
-- new DEFAULTs. Additive on the schema, no data change.
DROP FUNCTION public.commit_versioned_run_transition(UUID,UUID,TEXT,INTEGER,BIGINT,JSONB,TEXT,TEXT);

-- Commit one transition atomically: cursor columns, checkpoint, revision,
-- execution budget counters and (optionally) a terminal status change in a
-- single UPDATE. The cursor is
-- taken from p_checkpoint->'cursor' so cursor and checkpoint cannot diverge.
-- Conflict checks run in a fixed order and return a reason without writing:
-- run_not_active, stale_lease, lease_expired, revision_conflict,
-- budget_exceeded (nodes > 500 or messages > 100 after adding the deltas;
-- the same limits as the flow_runs CHECK constraints and VERSIONED_LIMITS). A terminal
-- p_status also releases the lease (the token is kept).
CREATE FUNCTION public.commit_versioned_run_transition(
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

REVOKE ALL ON FUNCTION public.commit_versioned_run_transition(UUID,UUID,TEXT,INTEGER,BIGINT,JSONB,TEXT,TEXT,INTEGER,INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commit_versioned_run_transition(UUID,UUID,TEXT,INTEGER,BIGINT,JSONB,TEXT,TEXT,INTEGER,INTEGER) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commit_versioned_run_transition(UUID,UUID,TEXT,INTEGER,BIGINT,JSONB,TEXT,TEXT,INTEGER,INTEGER) TO service_role;
