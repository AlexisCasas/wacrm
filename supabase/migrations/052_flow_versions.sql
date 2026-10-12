-- ============================================================
-- 052_flow_versions
--
-- E4.1 / F06: immutable published snapshots for conversational flows.
-- Drafts stay in flows + flow_nodes. A version is created only when an
-- agent activates a flow through publish_flow_version(). Existing runs
-- intentionally keep their legacy live-node behaviour until E4.2.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- The composite keys make account equality part of both relationships:
-- version -> flow and flow.active_version -> version.
ALTER TABLE public.flows
  ADD CONSTRAINT flows_id_account_key UNIQUE (id, account_id);

CREATE TABLE public.flow_versions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  flow_id UUID NOT NULL,
  account_id UUID NOT NULL,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  -- Canonical JSONB snapshot containing the flow envelope and ordered nodes.
  -- Edges remain in each node config, just as they do in flow_nodes.
  definition JSONB NOT NULL,
  definition_hash TEXT NOT NULL CHECK (definition_hash ~ '^[0-9a-f]{64}$'),
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  CONSTRAINT flow_versions_flow_same_account_fkey
    FOREIGN KEY (flow_id, account_id)
    REFERENCES public.flows (id, account_id)
    ON DELETE RESTRICT,
  CONSTRAINT flow_versions_flow_number_key UNIQUE (flow_id, version_number),
  CONSTRAINT flow_versions_id_flow_account_key UNIQUE (id, flow_id, account_id)
);

ALTER TABLE public.flows
  ADD COLUMN active_version_id UUID,
  ADD CONSTRAINT flows_active_version_same_flow_fkey
    FOREIGN KEY (active_version_id, id, account_id)
    REFERENCES public.flow_versions (id, flow_id, account_id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX idx_flow_versions_account_flow_published
  ON public.flow_versions (account_id, flow_id, published_at DESC);

ALTER TABLE public.flow_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.flow_versions FROM PUBLIC;
REVOKE ALL ON TABLE public.flow_versions FROM anon;
GRANT SELECT ON TABLE public.flow_versions TO authenticated;
GRANT ALL ON TABLE public.flow_versions TO service_role;

CREATE POLICY flow_versions_select ON public.flow_versions
  FOR SELECT USING (public.is_account_member(account_id));

-- Published definitions are append-only. The trigger is defense in depth
-- against accidental service-role mutations as well as client writes.
CREATE FUNCTION public.reject_flow_version_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'flow_versions are immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER flow_versions_immutable
  BEFORE UPDATE OR DELETE ON public.flow_versions
  FOR EACH ROW EXECUTE FUNCTION public.reject_flow_version_mutation();

-- An agent may still update draft/archive state through the normal flows
-- policy, but only the publication RPC can transition a flow to active.
-- This closes the direct Data API UPDATE path that would otherwise create
-- an active flow without an immutable version.
CREATE FUNCTION public.guard_flow_publication_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF (
      (TG_OP = 'INSERT' AND NEW.status = 'active')
      OR (TG_OP = 'UPDATE' AND NEW.status = 'active' AND OLD.status IS DISTINCT FROM 'active')
      OR (TG_OP = 'UPDATE' AND NEW.active_version_id IS DISTINCT FROM OLD.active_version_id)
    )
    AND current_setting('app.flow_publication', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'active flows and versions must be published through the publication API'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER flows_require_publication_for_activation
  BEFORE INSERT OR UPDATE OF status, active_version_id ON public.flows
  FOR EACH ROW EXECUTE FUNCTION public.guard_flow_publication_fields();

-- Direct node writes remain available to agents for existing APIs, but they
-- advance the parent revision. A publication therefore cannot silently use a
-- graph changed between API validation and the publication lock.
CREATE FUNCTION public.bump_flow_revision_for_node_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_flow_id UUID;
BEGIN
  v_flow_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.flow_id ELSE NEW.flow_id END;
  IF current_setting('app.flow_draft_save', true) IS DISTINCT FROM 'on' THEN
    UPDATE public.flows SET updated_at = clock_timestamp() WHERE id = v_flow_id;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER flow_nodes_bump_parent_revision
  AFTER INSERT OR UPDATE OR DELETE ON public.flow_nodes
  FOR EACH ROW EXECUTE FUNCTION public.bump_flow_revision_for_node_change();

-- Atomically replace a draft graph. The caller is authenticated and RLS
-- scoped; the revision comparison prevents a stale editor from deleting a
-- newer graph. p_nodes=NULL supports header-only saves.
CREATE FUNCTION public.save_flow_draft(
  p_flow_id UUID,
  p_expected_updated_at TIMESTAMPTZ,
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
  IF p_expected_updated_at IS NULL
    OR jsonb_typeof(p_patch) <> 'object'
    OR (p_nodes IS NOT NULL AND jsonb_typeof(p_nodes) <> 'array') THEN
    RAISE EXCEPTION 'invalid flow save request' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_flow
    FROM public.flows
    WHERE id = p_flow_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'flow not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.is_account_member(v_flow.account_id, 'agent') THEN
    RAISE EXCEPTION 'insufficient role' USING ERRCODE = '42501';
  END IF;
  IF v_flow.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'flow revision conflict' USING ERRCODE = '40001';
  END IF;
  IF p_patch ? 'name' AND COALESCE(btrim(p_patch->>'name'), '') = '' THEN
    RAISE EXCEPTION 'flow name cannot be empty' USING ERRCODE = '22023';
  END IF;

  UPDATE public.flows
     SET name = CASE WHEN p_patch ? 'name' THEN btrim(p_patch->>'name') ELSE name END,
         description = CASE WHEN p_patch ? 'description' THEN p_patch->>'description' ELSE description END,
         trigger_type = CASE WHEN p_patch ? 'trigger_type' THEN p_patch->>'trigger_type' ELSE trigger_type END,
         trigger_config = CASE WHEN p_patch ? 'trigger_config' THEN p_patch->'trigger_config' ELSE trigger_config END,
         entry_node_id = CASE WHEN p_patch ? 'entry_node_id' THEN p_patch->>'entry_node_id' ELSE entry_node_id END,
         fallback_policy = CASE WHEN p_patch ? 'fallback_policy' THEN p_patch->'fallback_policy' ELSE fallback_policy END,
         updated_at = clock_timestamp()
   WHERE id = v_flow.id
   RETURNING public.flows.updated_at INTO v_updated_at;

  IF p_nodes IS NOT NULL THEN
    PERFORM set_config('app.flow_draft_save', 'on', true);
    -- Constraints on flow_nodes (including the node-type check and unique
    -- node_key) make any bad insert abort the whole function transaction.
    DELETE FROM public.flow_nodes WHERE flow_id = v_flow.id;
    INSERT INTO public.flow_nodes (
      flow_id, node_key, node_type, config, position_x, position_y
    )
    SELECT
      v_flow.id,
      node_key,
      node_type,
      config,
      COALESCE(position_x, 0),
      COALESCE(position_y, 0)
    FROM jsonb_to_recordset(p_nodes) AS n(
      node_key TEXT,
      node_type TEXT,
      config JSONB,
      position_x INTEGER,
      position_y INTEGER
    );
  END IF;

  RETURN QUERY SELECT v_updated_at;
END;
$$;

-- Publish the exact revision the API validated. This is SECURITY DEFINER
-- solely because published rows deliberately have no client INSERT policy;
-- it checks the caller's JWT-backed account membership before every write.
CREATE FUNCTION public.publish_flow_version(
  p_flow_id UUID,
  p_expected_updated_at TIMESTAMPTZ,
  p_published_by UUID,
  p_expected_definition JSONB
)
RETURNS TABLE (version_id UUID, version_number INTEGER, updated_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_flow public.flows%ROWTYPE;
  v_definition JSONB;
  v_version_id UUID;
  v_version_number INTEGER;
  v_updated_at TIMESTAMPTZ;
BEGIN
  IF p_expected_updated_at IS NULL OR p_published_by IS NULL
    OR jsonb_typeof(p_expected_definition) <> 'object' THEN
    RAISE EXCEPTION 'invalid flow publication request' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_flow
    FROM public.flows
    WHERE id = p_flow_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'flow not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.user_id = p_published_by
      AND p.account_id = v_flow.account_id
      AND p.account_role IN ('owner', 'admin', 'agent')
  ) THEN
    RAISE EXCEPTION 'insufficient role' USING ERRCODE = '42501';
  END IF;
  IF v_flow.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'flow revision conflict' USING ERRCODE = '40001';
  END IF;

  -- Lock the graph as well as its header. Direct node writes take this lock
  -- through their parent-revision trigger, so neither can interleave with a
  -- successful snapshot.
  PERFORM 1 FROM public.flow_nodes WHERE flow_id = v_flow.id FOR UPDATE;

  SELECT jsonb_build_object(
    'flow', jsonb_build_object(
      'id', v_flow.id,
      'name', v_flow.name,
      'description', v_flow.description,
      'trigger_type', v_flow.trigger_type,
      'trigger_config', v_flow.trigger_config,
      'entry_node_id', v_flow.entry_node_id,
      'fallback_policy', v_flow.fallback_policy
    ),
    'nodes', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'node_key', n.node_key,
          'node_type', n.node_type,
          'config', n.config,
          'position_x', n.position_x,
          'position_y', n.position_y
        ) ORDER BY n.node_key
      )
      FROM public.flow_nodes n
      WHERE n.flow_id = v_flow.id
    ), '[]'::jsonb)
  ) INTO v_definition;

  IF v_definition IS DISTINCT FROM p_expected_definition THEN
    RAISE EXCEPTION 'flow definition changed after validation' USING ERRCODE = '40001';
  END IF;

  SELECT COALESCE(MAX(fv.version_number), 0) + 1
    INTO v_version_number
    FROM public.flow_versions fv
    WHERE fv.flow_id = v_flow.id;

  INSERT INTO public.flow_versions (
    flow_id, account_id, version_number, definition, definition_hash, published_by
  ) VALUES (
    v_flow.id,
    v_flow.account_id,
    v_version_number,
    v_definition,
    encode(digest(v_definition::text, 'sha256'), 'hex'),
    p_published_by
  ) RETURNING id INTO v_version_id;

  PERFORM set_config('app.flow_publication', 'on', true);
  UPDATE public.flows
     SET status = 'active',
         active_version_id = v_version_id,
         updated_at = clock_timestamp()
   WHERE id = v_flow.id
   RETURNING public.flows.updated_at INTO v_updated_at;

  RETURN QUERY SELECT v_version_id, v_version_number, v_updated_at;
END;
$$;

REVOKE ALL ON FUNCTION public.reject_flow_version_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.save_flow_draft(UUID, TIMESTAMPTZ, JSONB, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_flow_publication_fields() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bump_flow_revision_for_node_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.publish_flow_version(UUID, TIMESTAMPTZ, UUID, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.publish_flow_version(UUID, TIMESTAMPTZ, UUID, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.save_flow_draft(UUID, TIMESTAMPTZ, JSONB, JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.publish_flow_version(UUID, TIMESTAMPTZ, UUID, JSONB) TO service_role;
