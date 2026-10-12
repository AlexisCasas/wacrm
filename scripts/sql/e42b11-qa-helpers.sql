-- Assertion helpers shared by the E4.2B1.1 suites. Every verdict is emitted
-- as "QA-RESULT <test> PASS|FAIL <detail>"; the runner parses these lines.
CREATE OR REPLACE FUNCTION public.qa_result(t text, ok boolean, detail text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok THEN RAISE NOTICE 'QA-RESULT % PASS %', t, detail;
  ELSE RAISE EXCEPTION 'QA-RESULT % FAIL %', t, detail; END IF;
END $$;

-- Runs call_sql and passes only when it raises exactly SQLSTATE + message.
CREATE OR REPLACE FUNCTION public.qa_expect_error(t text, call_sql text, want_state text, want_msg text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE got boolean := false; s text; m text;
BEGIN
  BEGIN
    EXECUTE call_sql;
  EXCEPTION WHEN OTHERS THEN
    got := true; s := SQLSTATE; m := SQLERRM;
  END;
  IF NOT got THEN PERFORM public.qa_result(t, false, 'no error raised, expected ' || want_state || ' ' || want_msg); END IF;
  PERFORM public.qa_result(t, s = want_state AND m = want_msg,
    CASE WHEN s = want_state AND m = want_msg THEN 'rejected ' || s || ' "' || m || '"'
         ELSE 'got ' || s || ' "' || m || '", expected ' || want_state || ' "' || want_msg || '"' END);
END $$;

-- Convenience: SQL text of a create_versioned_flow_run call.
CREATE OR REPLACE FUNCTION public.qa_call(p_account uuid, p_flow uuid, p_contact uuid, p_conv uuid, p_vars text DEFAULT '{}')
RETURNS text LANGUAGE sql AS $$
  SELECT format('SELECT * FROM public.create_versioned_flow_run(%L,%L,%L,%L,%L::jsonb)', p_account, p_flow, p_contact, p_conv, p_vars)
$$;

-- Publishes a flow through the real RPC (the only supported path to active).
CREATE OR REPLACE FUNCTION public.qa_publish(p_flow uuid, p_user uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE f public.flows%ROWTYPE; d jsonb;
BEGIN
  SELECT * INTO f FROM public.flows WHERE id = p_flow;
  SELECT jsonb_build_object(
    'flow', jsonb_build_object('id',f.id,'name',f.name,'description',f.description,'trigger_type',f.trigger_type,
            'trigger_config',f.trigger_config,'entry_node_id',f.entry_node_id,'fallback_policy',f.fallback_policy),
    'nodes', COALESCE((SELECT jsonb_agg(jsonb_build_object('node_key',n.node_key,'node_type',n.node_type,'config',n.config,
            'position_x',n.position_x,'position_y',n.position_y) ORDER BY n.node_key)
            FROM public.flow_nodes n WHERE n.flow_id = f.id), '[]'::jsonb)) INTO d;
  PERFORM public.publish_flow_version(f.id, f.updated_at, p_user, d);
END $$;

-- B1.2 helpers. qa_new_contact/qa_new_run make a fresh contact (and a versioned
-- run on flow 5000..01) per call so every test owns its row; ids derive from n.
CREATE OR REPLACE FUNCTION public.qa_new_contact(n int) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE cid uuid := ('31000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid; f public.flows%ROWTYPE;
BEGIN
  SELECT * INTO f FROM public.flows WHERE id = '50000000-0000-4000-8000-000000000001';
  INSERT INTO public.contacts (id, user_id, account_id, phone, name)
  VALUES (cid, f.user_id, f.account_id, '+1556' || lpad(n::text, 7, '0'), 'QA contact ' || n) ON CONFLICT DO NOTHING;
  RETURN cid;
END $$;
CREATE OR REPLACE FUNCTION public.qa_new_run(n int) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE r record; f public.flows%ROWTYPE;
BEGIN
  SELECT * INTO f FROM public.flows WHERE id = '50000000-0000-4000-8000-000000000001';
  SELECT * INTO r FROM public.create_versioned_flow_run(f.account_id, f.id, public.qa_new_contact(n), NULL);
  IF NOT r.created THEN RAISE EXCEPTION 'qa_new_run % failed: %', n, r.reason; END IF;
  RETURN r.flow_run_id;
END $$;
