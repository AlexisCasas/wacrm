-- ============================================================
-- 068_execute_flow_authoring_guards
--
-- Pilot: lets an opted-in account AUTHOR "run another flow" (execute_flow) nodes in DRAFT flows. Nothing here
-- executes a subflow: the legacy runner does not know the type, and these guards make sure such a flow can never
-- become active, so it can never be run, triggered or started.
--
-- 1. flow_nodes.node_type also accepts 'execute_flow'. The constraint is byte-for-byte the one in E4.2's migration
--    058, which drops and recreates it by name, so applying both (in either order) leaves the same constraint.
-- 2. guard_execute_flow_node: an execute_flow row
--      * may not be written into an ACTIVE flow;
--      * must have an object config;
--      * if it names a target (target_flow_id), the target must be an existing flow of the SAME account and not the
--        flow itself. An empty / missing target is allowed: a draft can be incomplete.
-- 3. guard_execute_flow_activation: a flow that contains an execute_flow node cannot change to status 'active'.
--    This is the database-level twin of the API's activation refusal and also covers direct PostgREST updates.
--    WHEN E4/F06 EXECUTION IS ENABLED, the migration that enables it must drop this trigger deliberately.
--
-- Who may author the node is decided by the API (server-side per-account flag); these guards hold for everyone.
-- Both triggers carry WHEN clauses, so writes that do not involve execute_flow / activation never call them.
-- Additive: no data is changed, nothing is dropped except the node_type CHECK, which is recreated wider.
-- ============================================================

ALTER TABLE public.flow_nodes DROP CONSTRAINT IF EXISTS flow_nodes_node_type_check;
ALTER TABLE public.flow_nodes ADD CONSTRAINT flow_nodes_node_type_check CHECK (node_type IN (
  'start', 'send_buttons', 'send_list', 'send_message', 'send_media', 'collect_input', 'condition',
  'set_tag', 'delay', 'set_contact_field', 'handoff', 'http_fetch', 'end', 'execute_flow'
));

CREATE FUNCTION public.guard_execute_flow_node()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_flow public.flows%ROWTYPE;
  v_target TEXT;
BEGIN
  SELECT * INTO v_flow FROM public.flows f WHERE f.id = NEW.flow_id;
  IF NOT FOUND THEN
    RETURN NEW; -- the flow_id foreign key reports this case
  END IF;
  IF v_flow.status = 'active' THEN
    RAISE EXCEPTION 'execute_flow nodes cannot be added to an active flow' USING ERRCODE = '0A000';
  END IF;
  IF jsonb_typeof(NEW.config) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'execute_flow config must be an object' USING ERRCODE = '22023';
  END IF;
  IF NEW.config ? 'target_flow_id' AND jsonb_typeof(NEW.config->'target_flow_id') NOT IN ('string', 'null') THEN
    RAISE EXCEPTION 'execute_flow target must be a flow id' USING ERRCODE = '22023';
  END IF;
  v_target := NULLIF(btrim(COALESCE(NEW.config->>'target_flow_id', '')), '');
  IF v_target IS NOT NULL THEN
    IF v_target !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR v_target::uuid = v_flow.id
       OR NOT EXISTS (SELECT 1 FROM public.flows t WHERE t.id = v_target::uuid AND t.account_id = v_flow.account_id) THEN
      RAISE EXCEPTION 'execute_flow target flow is not a flow of this account' USING ERRCODE = '23503';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER flow_nodes_guard_execute_flow
  BEFORE INSERT OR UPDATE ON public.flow_nodes
  FOR EACH ROW
  WHEN (NEW.node_type = 'execute_flow')
  EXECUTE FUNCTION public.guard_execute_flow_node();

CREATE FUNCTION public.guard_execute_flow_activation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.flow_nodes n WHERE n.flow_id = NEW.id AND n.node_type = 'execute_flow') THEN
    RAISE EXCEPTION 'flows with execute_flow nodes cannot be activated: subflow execution is not enabled' USING ERRCODE = '0A000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER flows_guard_execute_flow_activation
  BEFORE INSERT OR UPDATE OF status ON public.flows
  FOR EACH ROW
  WHEN (NEW.status = 'active')
  EXECUTE FUNCTION public.guard_execute_flow_activation();

REVOKE ALL ON FUNCTION public.guard_execute_flow_node() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_execute_flow_activation() FROM PUBLIC, anon, authenticated;
