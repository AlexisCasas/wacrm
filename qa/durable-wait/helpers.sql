-- QA helpers (committed in the scratch database; never part of a migration)
CREATE OR REPLACE FUNCTION public.qa_wait_run(n int, p_flow uuid DEFAULT 'a1000000-0000-4000-8000-0000000000f1') RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE f public.flows%ROWTYPE; c uuid := gen_random_uuid(); r uuid;
BEGIN
  SELECT * INTO f FROM public.flows WHERE id = p_flow;
  INSERT INTO public.contacts (id, user_id, account_id, phone, name) VALUES (c, f.user_id, f.account_id, '+1559' || lpad(n::text, 7, '0'), 'wait ' || n);
  INSERT INTO public.flow_runs (flow_id, account_id, user_id, contact_id, status, current_node_key) VALUES (f.id, f.account_id, f.user_id, c, 'active', 'start') RETURNING id INTO r;
  RETURN r;
END $$;
CREATE OR REPLACE FUNCTION public.qa_wait_row(p_run uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT to_jsonb(r) FROM public.flow_runs r WHERE r.id = p_run $$;
