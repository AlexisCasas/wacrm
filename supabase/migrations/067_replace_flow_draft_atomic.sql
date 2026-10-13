-- ============================================================
-- 067_replace_flow_draft_atomic
--
-- Flow editor: save a draft's header AND its node graph in ONE transaction.
--
-- PUT /api/flows/[id] used to run three independent PostgREST calls (update the
-- header, delete every node, insert the new nodes). A failure between them left
-- the flow half saved: header changed, nodes gone or partial. One function call
-- is one transaction: either everything below is applied or nothing is.
--
-- Compatibility with E4.1 / F06 (migrations 052-066 live in Draft PRs, not in main):
--   * This file is numbered 067 so it replays AFTER them in filename order and cannot
--     collide with any of them. It applies cleanly on a database that stops at 051
--     AND on one that already has 052-066 (both orders are tested).
--   * It deliberately does NOT reuse the name save_flow_draft: E4.1's 052 creates
--     public.save_flow_draft(UUID, TIMESTAMPTZ, JSONB, JSONB) with a plain CREATE
--     FUNCTION, which would fail if the name/signature already existed. The two
--     functions do the same job; E4.1's additionally enforces an optimistic revision.
--     When E4.1 lands, its PUT route should call save_flow_draft and this function
--     can be dropped by a follow-up migration. Until then nothing depends on it but
--     the PUT route of main.
--   * Setting app.flow_draft_save mirrors 052's bump_flow_revision_for_node_change():
--     once that trigger exists, it skips the per-row parent bump during this save.
--     Without 052 the setting is simply unused.
--
-- Security model:
--   * SECURITY INVOKER: it gains no privilege. Only service_role may execute it
--     (explicitly revoked from PUBLIC, anon and authenticated, which would otherwise
--     inherit EXECUTE from the platform's default privileges).
--   * The caller (the API route) authenticates the user, enforces the role and derives
--     p_account_id from the session; the browser never supplies it. The function still
--     binds the flow to that account, so a wrong pair is "not found" and nothing is written.
--   * A draft may be incomplete: no graph validation happens here (activation validates).
-- ============================================================

CREATE FUNCTION public.replace_flow_draft_atomic(
  p_account_id UUID,
  p_flow_id UUID,
  p_patch JSONB,
  p_nodes JSONB DEFAULT NULL
)
RETURNS TABLE (updated_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_flow public.flows%ROWTYPE;
  v_updated_at TIMESTAMPTZ;
BEGIN
  IF p_account_id IS NULL OR p_flow_id IS NULL
     OR jsonb_typeof(p_patch) IS DISTINCT FROM 'object'
     OR (p_nodes IS NOT NULL AND jsonb_typeof(p_nodes) <> 'array') THEN
    RAISE EXCEPTION 'invalid flow save request' USING ERRCODE = '22023';
  END IF;
  IF p_patch ? 'name' AND COALESCE(btrim(p_patch->>'name'), '') = '' THEN
    RAISE EXCEPTION 'flow name cannot be empty' USING ERRCODE = '22023';
  END IF;

  -- Serialises concurrent saves of one flow, so two replace-all operations never interleave.
  SELECT * INTO v_flow FROM public.flows f WHERE f.id = p_flow_id AND f.account_id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'flow not found' USING ERRCODE = 'P0002';
  END IF;

  UPDATE public.flows f
     SET name = CASE WHEN p_patch ? 'name' THEN btrim(p_patch->>'name') ELSE f.name END,
         description = CASE WHEN p_patch ? 'description' THEN p_patch->>'description' ELSE f.description END,
         trigger_type = CASE WHEN p_patch ? 'trigger_type' THEN p_patch->>'trigger_type' ELSE f.trigger_type END,
         trigger_config = CASE WHEN p_patch ? 'trigger_config' THEN p_patch->'trigger_config' ELSE f.trigger_config END,
         entry_node_id = CASE WHEN p_patch ? 'entry_node_id' THEN p_patch->>'entry_node_id' ELSE f.entry_node_id END,
         fallback_policy = CASE WHEN p_patch ? 'fallback_policy' THEN p_patch->'fallback_policy' ELSE f.fallback_policy END,
         updated_at = clock_timestamp()
   WHERE f.id = v_flow.id
   RETURNING f.updated_at INTO v_updated_at;

  IF p_nodes IS NOT NULL THEN
    PERFORM set_config('app.flow_draft_save', 'on', true);
    -- The table's own constraints (node_type check, UNIQUE (flow_id, node_key), NOT NULLs) make any bad row
    -- abort the whole call, which also undoes the header update and the delete above.
    DELETE FROM public.flow_nodes n WHERE n.flow_id = v_flow.id;
    INSERT INTO public.flow_nodes (flow_id, node_key, node_type, config, position_x, position_y)
    SELECT v_flow.id, r.node_key, r.node_type, COALESCE(r.config, '{}'::jsonb), COALESCE(r.position_x, 0), COALESCE(r.position_y, 0)
      FROM jsonb_to_recordset(p_nodes) AS r(node_key TEXT, node_type TEXT, config JSONB, position_x INTEGER, position_y INTEGER);
  END IF;

  RETURN QUERY SELECT v_updated_at;
END;
$$;

REVOKE ALL ON FUNCTION public.replace_flow_draft_atomic(UUID, UUID, JSONB, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_flow_draft_atomic(UUID, UUID, JSONB, JSONB) TO service_role;
