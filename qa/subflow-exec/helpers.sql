-- QA helpers (created in the scratch database only; never part of a migration)
CREATE OR REPLACE FUNCTION public.qa_acct(p_user uuid) RETURNS uuid LANGUAGE sql AS $$ SELECT account_id FROM public.profiles WHERE user_id = p_user $$;
CREATE OR REPLACE FUNCTION public.qa_enable(p_account uuid, p_sub boolean DEFAULT true, p_wait boolean DEFAULT false) RETURNS void LANGUAGE sql AS $$
  INSERT INTO public.flow_execution_enablement (account_id, subflow_execution, durable_wait_execution) VALUES (p_account, p_sub, p_wait)
  ON CONFLICT (account_id) DO UPDATE SET subflow_execution = EXCLUDED.subflow_execution, durable_wait_execution = EXCLUDED.durable_wait_execution $$;
-- nodes: [{"k":"start","t":"start","c":{...}}, ...]; entry node is always "start"
CREATE OR REPLACE FUNCTION public.qa_mkflow(p_account uuid, p_user uuid, p_name text, p_nodes jsonb, p_status text DEFAULT 'active') RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE f uuid; n jsonb;
BEGIN
  INSERT INTO public.flows (user_id, account_id, name, trigger_type, trigger_config, entry_node_id) VALUES (p_user, p_account, p_name, 'manual', '{}', 'start') RETURNING id INTO f;
  FOR n IN SELECT * FROM jsonb_array_elements(p_nodes) LOOP
    INSERT INTO public.flow_nodes (flow_id, node_key, node_type, config) VALUES (f, n->>'k', n->>'t', coalesce(n->'c', '{}'::jsonb));
  END LOOP;
  IF p_status = 'active' THEN UPDATE public.flows SET status = 'active' WHERE id = f; END IF;
  RETURN f;
END $$;
-- flow that calls `target` and continues at `ret`
CREATE OR REPLACE FUNCTION public.qa_simple(p_account uuid, p_user uuid, p_name text, p_scope text DEFAULT NULL) RETURNS uuid LANGUAGE sql AS $$
  SELECT public.qa_mkflow(p_account, p_user, p_name, jsonb_build_array(
    jsonb_build_object('k','start','t','start','c',jsonb_build_object('next_node_key','end')),
    jsonb_build_object('k','end','t','end','c', CASE WHEN p_scope IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('scope', p_scope) END))) $$;
-- root flow: start -> call1 (B) -> mid -> call2 (C) -> last -> end
CREATE OR REPLACE FUNCTION public.qa_caller(p_account uuid, p_user uuid, p_name text, p_b uuid, p_c uuid, p_status text DEFAULT 'active') RETURNS uuid LANGUAGE sql AS $$
  SELECT public.qa_mkflow(p_account, p_user, p_name, jsonb_build_array(
    jsonb_build_object('k','start','t','start','c',jsonb_build_object('next_node_key','info')),
    jsonb_build_object('k','info','t','send_message','c',jsonb_build_object('text','info','next_node_key','call1')),
    jsonb_build_object('k','call1','t','execute_flow','c',jsonb_build_object('target_flow_id',p_b,'next_node_key','mid','reference_node_key','info')),
    jsonb_build_object('k','mid','t','send_message','c',jsonb_build_object('text','mid','next_node_key','call2')),
    jsonb_build_object('k','call2','t','execute_flow','c',jsonb_build_object('target_flow_id',p_c,'next_node_key','last')),
    jsonb_build_object('k','last','t','send_message','c',jsonb_build_object('text','last','next_node_key','end')),
    jsonb_build_object('k','end','t','end','c','{}'::jsonb)), p_status) $$;
CREATE OR REPLACE FUNCTION public.qa_run(p_flow uuid, p_node text DEFAULT 'start') RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE f public.flows%ROWTYPE; c uuid := gen_random_uuid(); r uuid;
BEGIN
  SELECT * INTO f FROM public.flows WHERE id = p_flow;
  INSERT INTO public.contacts (id, user_id, account_id, phone, name) VALUES (c, f.user_id, f.account_id, '+1558' || lpad((floor(random() * 9000000))::int::text, 7, '0'), 'sub ' || left(c::text, 6));
  INSERT INTO public.flow_runs (flow_id, account_id, user_id, contact_id, status, current_node_key) VALUES (f.id, f.account_id, f.user_id, c, 'active', p_node) RETURNING id INTO r;
  RETURN r;
END $$;
CREATE OR REPLACE FUNCTION public.qa_row(p_run uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT to_jsonb(r) FROM public.flow_runs r WHERE r.id = p_run $$;
-- run the call as service_role would (the functions are SECURITY DEFINER; this only exercises the arguments)
CREATE OR REPLACE FUNCTION public.qa_push(p_run uuid, p_call text, p_callee uuid, p_ret text, p_ref jsonb DEFAULT NULL, p_policy text DEFAULT 'stop') RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.push_flow_subflow((SELECT account_id FROM public.flow_runs WHERE id = p_run), p_run, p_call, p_callee, p_ret, p_ref, p_policy) $$;
CREATE OR REPLACE FUNCTION public.qa_pop(p_run uuid, p_callee uuid) RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.pop_flow_subflow((SELECT account_id FROM public.flow_runs WHERE id = p_run), p_run, p_callee) $$;
