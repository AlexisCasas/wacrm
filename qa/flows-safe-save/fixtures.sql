-- Two synthetic accounts (the signup trigger provisions account + profile), one draft flow each. Synthetic data only.
INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) VALUES
 ('a1000000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','qa-a@example.test','{"full_name":"QA A"}'::jsonb, now(), now()),
 ('b2000000-0000-4000-8000-000000000002','00000000-0000-0000-0000-000000000000','authenticated','authenticated','qa-b@example.test','{"full_name":"QA B"}'::jsonb, now(), now());
SELECT account_id AS acct_a FROM public.profiles WHERE user_id='a1000000-0000-4000-8000-000000000001' \gset
SELECT account_id AS acct_b FROM public.profiles WHERE user_id='b2000000-0000-4000-8000-000000000002' \gset
INSERT INTO public.flows (id, user_id, account_id, name, description, trigger_type, entry_node_id, updated_at) VALUES
 ('a1000000-0000-4000-8000-0000000000f1','a1000000-0000-4000-8000-000000000001',:'acct_a','Flow A','original description','keyword','start', now() - interval '1 day'),
 ('b2000000-0000-4000-8000-0000000000f1','b2000000-0000-4000-8000-000000000002',:'acct_b','Flow B','b description','manual','start', now() - interval '1 day');
INSERT INTO public.flow_nodes (flow_id, node_key, node_type, config, position_x, position_y) VALUES
 ('a1000000-0000-4000-8000-0000000000f1','start','start','{"next_node_key":"m1"}',10,20),
 ('a1000000-0000-4000-8000-0000000000f1','m1','send_message','{"text":"hola","next_node_key":"end"}',30,40),
 ('a1000000-0000-4000-8000-0000000000f1','end','end','{}',50,60),
 ('b2000000-0000-4000-8000-0000000000f1','start','start','{"next_node_key":"end"}',0,0),
 ('b2000000-0000-4000-8000-0000000000f1','end','end','{}',0,0);
CREATE OR REPLACE FUNCTION public.qa_flow_state(p_flow uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('flow', (SELECT to_jsonb(f) FROM public.flows f WHERE f.id = p_flow),
    'nodes', COALESCE((SELECT jsonb_agg(to_jsonb(n) ORDER BY n.node_key) FROM public.flow_nodes n WHERE n.flow_id = p_flow), '[]'::jsonb))
$$;
