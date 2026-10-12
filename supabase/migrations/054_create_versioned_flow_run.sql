-- E4.2B1.1: server-only, atomic creation of an initially idle versioned run.
CREATE FUNCTION public.create_versioned_flow_run(
  p_account_id UUID, p_flow_id UUID, p_contact_id UUID, p_conversation_id UUID DEFAULT NULL,
  p_vars JSONB DEFAULT '{}'::jsonb
)
RETURNS TABLE (created BOOLEAN, flow_run_id UUID, reason TEXT)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_flow public.flows%ROWTYPE;
  v_version public.flow_versions%ROWTYPE;
  v_entry TEXT;
  v_run_id UUID;
BEGIN
  IF p_account_id IS NULL OR p_flow_id IS NULL OR p_contact_id IS NULL OR jsonb_typeof(p_vars) <> 'object' THEN
    RAISE EXCEPTION 'invalid versioned run request' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_flow FROM public.flows WHERE id=p_flow_id AND account_id=p_account_id FOR UPDATE;
  IF NOT FOUND OR v_flow.status <> 'active' OR v_flow.active_version_id IS NULL THEN
    RAISE EXCEPTION 'active published flow not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.contacts WHERE id=p_contact_id AND account_id=p_account_id) THEN
    RAISE EXCEPTION 'contact not found in account' USING ERRCODE = 'P0002';
  END IF;
  IF p_conversation_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.conversations WHERE id=p_conversation_id AND account_id=p_account_id) THEN
    RAISE EXCEPTION 'conversation not found in account' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_version FROM public.flow_versions WHERE id=v_flow.active_version_id AND flow_id=v_flow.id AND account_id=p_account_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'published version not found' USING ERRCODE='P0002'; END IF;
  v_entry := v_version.definition #>> '{flow,entry_node_id}';
  IF v_entry IS NULL OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(v_version.definition->'nodes','[]'::jsonb)) n WHERE n->>'node_key'=v_entry) THEN
    RAISE EXCEPTION 'published definition has no entry cursor' USING ERRCODE='22023';
  END IF;
  BEGIN
    INSERT INTO public.flow_runs (flow_id,account_id,user_id,contact_id,conversation_id,status,current_node_key,vars,execution_mode,root_flow_version_id,current_flow_version_id,versioned_node_key,versioned_checkpoint)
    VALUES (v_flow.id,p_account_id,v_flow.user_id,p_contact_id,p_conversation_id,'active',v_entry,p_vars,'versioned',v_version.id,v_version.id,v_entry,jsonb_build_object('cursor',jsonb_build_object('flow_version_id',v_version.id,'node_key',v_entry),'step',0))
    RETURNING id INTO v_run_id;
  EXCEPTION WHEN unique_violation THEN
    RETURN QUERY SELECT false, NULL::uuid, 'active_run_exists'; RETURN;
  END;
  RETURN QUERY SELECT true, v_run_id, NULL::text;
END;
$$;
REVOKE ALL ON FUNCTION public.create_versioned_flow_run(UUID,UUID,UUID,UUID,JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_versioned_flow_run(UUID,UUID,UUID,UUID,JSONB) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_versioned_flow_run(UUID,UUID,UUID,UUID,JSONB) TO service_role;
