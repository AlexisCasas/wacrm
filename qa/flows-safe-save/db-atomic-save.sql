-- DB checks for replace_flow_draft_atomic (migration 067). Runs inside ONE transaction that is rolled back by the runner.
-- IDs D01..D09. Fault injection exists ONLY inside this test (a trigger created here, undone by the ROLLBACK).
\set A 'a1000000-0000-4000-8000-0000000000f1'
\set B 'b2000000-0000-4000-8000-0000000000f1'

-- a QA-only fault injector: fails the insert of the node whose key is in qa.fail_on_key (never part of a migration)
CREATE FUNCTION public.qa_fail_on_key() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.node_key = current_setting('qa.fail_on_key', true) THEN RAISE EXCEPTION 'qa injected persistence failure' USING ERRCODE = 'P9998'; END IF; RETURN NEW; END $$;
CREATE TRIGGER qa_fail_on_key BEFORE INSERT ON public.flow_nodes FOR EACH ROW EXECUTE FUNCTION public.qa_fail_on_key();

-- D01: happy path replaces header fields that are present and the whole graph, once
DO $$
DECLARE a uuid := 'a1000000-0000-4000-8000-0000000000f1'; acct uuid; before_s jsonb; after_s jsonb; r timestamptz; ok boolean := true; detail text := ''; n jsonb;
BEGIN
  SELECT account_id INTO acct FROM public.flows WHERE id = a; before_s := public.qa_flow_state(a);
  SELECT updated_at INTO r FROM public.replace_flow_draft_atomic(acct, a,
    '{"name":"  Renamed  ","trigger_type":"first_inbound_message","entry_node_id":"s2","trigger_config":{"keywords":["hi"]}}'::jsonb,
    '[{"node_key":"s2","node_type":"start","config":{"next_node_key":"c1"},"position_x":5,"position_y":6},
      {"node_key":"c1","node_type":"condition","config":{"subject":"message","next_node_key":"x"}},
      {"node_key":"x","node_type":"end","config":{}}]'::jsonb);
  after_s := public.qa_flow_state(a);
  IF after_s#>>'{flow,name}' <> 'Renamed' OR after_s#>>'{flow,trigger_type}' <> 'first_inbound_message' OR after_s#>>'{flow,entry_node_id}' <> 's2' OR after_s#>'{flow,trigger_config}' <> '{"keywords":["hi"]}'::jsonb THEN ok := false; detail := detail || ' [header]'; END IF;
  IF after_s#>>'{flow,description}' <> 'original description' THEN ok := false; detail := detail || ' [absent field changed]'; END IF;
  IF (after_s#>>'{flow,updated_at}')::timestamptz <> r THEN ok := false; detail := detail || ' [updated_at returned=' || r || ' stored=' || (after_s#>>'{flow,updated_at}') || ' before=' || (before_s#>>'{flow,updated_at}') || ']'; END IF;
  SELECT jsonb_agg(jsonb_build_object('k', node_key, 't', node_type, 'x', position_x, 'y', position_y) ORDER BY node_key) INTO n FROM public.flow_nodes WHERE flow_id = a;
  IF n <> '[{"k":"c1","t":"condition","x":0,"y":0},{"k":"s2","t":"start","x":5,"y":6},{"k":"x","t":"end","x":0,"y":0}]'::jsonb THEN ok := false; detail := detail || ' [nodes ' || n::text || ']'; END IF;
  IF (SELECT status FROM public.flows WHERE id = a) <> 'draft' THEN ok := false; detail := detail || ' [status]'; END IF;
  PERFORM public.qa_result('D01', ok, 'header fields present in the patch and the full node graph replaced in one call; absent fields, status untouched; the returned updated_at is the stored one (monotonic advance across real transactions: D11); defaults position 0' || detail);
END $$;

-- D02: header-only and empty-graph saves
DO $$
DECLARE a uuid := 'a1000000-0000-4000-8000-0000000000f1'; acct uuid; ids_before uuid[]; ok boolean := true; detail text := '';
BEGIN
  SELECT account_id INTO acct FROM public.flows WHERE id = a;
  SELECT array_agg(id ORDER BY id) INTO ids_before FROM public.flow_nodes WHERE flow_id = a;
  PERFORM public.replace_flow_draft_atomic(acct, a, '{"description":null}'::jsonb);
  IF (SELECT description FROM public.flows WHERE id = a) IS NOT NULL THEN ok := false; detail := detail || ' [description not cleared]'; END IF;
  IF (SELECT array_agg(id ORDER BY id) FROM public.flow_nodes WHERE flow_id = a) IS DISTINCT FROM ids_before THEN ok := false; detail := detail || ' [header-only save touched the nodes]'; END IF;
  PERFORM public.replace_flow_draft_atomic(acct, a, '{}'::jsonb, '[]'::jsonb);
  IF EXISTS (SELECT 1 FROM public.flow_nodes WHERE flow_id = a) THEN ok := false; detail := detail || ' [empty array did not clear the graph]'; END IF;
  PERFORM public.qa_result('D02', ok, 'p_nodes omitted: nodes untouched (null description clears it); p_nodes = []: the graph is cleared, as the route always did' || detail);
END $$;

-- D03: every failure leaves header, nodes, ids and connections exactly as they were
DO $$
DECLARE a uuid := 'a1000000-0000-4000-8000-0000000000f1'; acct uuid; before_s jsonb; ok boolean := true; detail text := ''; c record; st text; msg text;
BEGIN
  SELECT account_id INTO acct FROM public.flows WHERE id = a;
  PERFORM public.replace_flow_draft_atomic(acct, a, '{"name":"Baseline"}'::jsonb,
    '[{"node_key":"start","node_type":"start","config":{"next_node_key":"m1"},"position_x":1,"position_y":2},
      {"node_key":"m1","node_type":"send_message","config":{"text":"keep me","next_node_key":"end"},"position_x":3,"position_y":4},
      {"node_key":"end","node_type":"end","config":{}}]'::jsonb);
  before_s := public.qa_flow_state(a);
  FOR c IN SELECT * FROM (VALUES
      ('duplicate node_key', '23505', '[{"node_key":"n1","node_type":"start"},{"node_key":"n1","node_type":"end"}]'),
      ('unknown node_type', '23514', '[{"node_key":"n1","node_type":"start"},{"node_key":"n2","node_type":"not_a_type"}]'),
      ('missing node_key', '23502', '[{"node_type":"start"}]'),
      ('missing node_type', '23502', '[{"node_key":"n1"}]'),
      ('wrong value type', '22P02', '[{"node_key":"n1","node_type":"start","position_x":"abc"}]'),
      ('injected failure on the 3rd insert', 'P9998', '[{"node_key":"n1","node_type":"start"},{"node_key":"n2","node_type":"end"},{"node_key":"boom","node_type":"end"}]')
    ) v(label, want, nodes) LOOP
    st := NULL; msg := NULL;
    PERFORM set_config('qa.fail_on_key', 'boom', true);
    BEGIN
      PERFORM public.replace_flow_draft_atomic(acct, a, '{"name":"CHANGED","description":"changed","entry_node_id":"n1","trigger_type":"manual"}'::jsonb, c.nodes::jsonb);
    EXCEPTION WHEN OTHERS THEN st := SQLSTATE; msg := SQLERRM;
    END;
    IF st IS DISTINCT FROM c.want THEN ok := false; detail := detail || ' [' || c.label || ': ' || coalesce(st, 'no error') || ' ' || coalesce(msg, '') || ']'; END IF;
    IF public.qa_flow_state(a) <> before_s THEN ok := false; detail := detail || ' [' || c.label || ': state changed]'; END IF;
  END LOOP;
  PERFORM set_config('qa.fail_on_key', '', true);
  PERFORM public.qa_result('D03', ok, '6 failure modes (duplicate key, bad type, null key, null type, bad value type, injected fault after two inserts): header (incl. updated_at), node ids, configs/connections and positions are byte-identical to the state before the call' || detail);
END $$;

-- D04: an incomplete draft is accepted (activation, not saving, validates a graph)
DO $$
DECLARE a uuid := 'a1000000-0000-4000-8000-0000000000f1'; acct uuid; ok boolean := true; detail text := '';
BEGIN
  SELECT account_id INTO acct FROM public.flows WHERE id = a;
  PERFORM public.replace_flow_draft_atomic(acct, a, '{"entry_node_id":"ghost"}'::jsonb,
    '[{"node_key":"lonely","node_type":"send_message","config":{"next_node_key":"nowhere"}},{"node_key":"empty","node_type":"condition"}]'::jsonb);
  IF (SELECT count(*) FROM public.flow_nodes WHERE flow_id = a) <> 2 OR (SELECT entry_node_id FROM public.flows WHERE id = a) <> 'ghost' THEN ok := false; detail := detail || ' [incomplete draft rejected]'; END IF;
  IF (SELECT config FROM public.flow_nodes WHERE flow_id = a AND node_key = 'empty') <> '{}'::jsonb THEN ok := false; detail := detail || ' [missing config default]'; END IF;
  PERFORM public.qa_result('D04', ok, 'a draft with a dangling entry node, a dangling connection, no start/end and a node without config is saved (config defaults to {})' || detail);
END $$;

-- D05: the account/flow binding and argument validation write nothing
DO $$
DECLARE a uuid := 'a1000000-0000-4000-8000-0000000000f1'; b uuid := 'b2000000-0000-4000-8000-0000000000f1'; acct_a uuid; acct_b uuid; sa jsonb; sb jsonb; ok boolean := true; detail text := ''; c record; st text;
BEGIN
  SELECT account_id INTO acct_a FROM public.flows WHERE id = a; SELECT account_id INTO acct_b FROM public.flows WHERE id = b;
  sa := public.qa_flow_state(a); sb := public.qa_flow_state(b);
  FOR c IN SELECT * FROM (VALUES
      ('account B on flow A', acct_b, a, '{"name":"x"}', '[]', 'P0002'), ('account A on flow B', acct_a, b, '{"name":"x"}', '[]', 'P0002'),
      ('unknown flow', acct_a, gen_random_uuid(), '{"name":"x"}', '[]', 'P0002'), ('null account', NULL, a, '{"name":"x"}', '[]', '22023'),
      ('null flow', acct_a, NULL, '{"name":"x"}', '[]', '22023'), ('patch not an object', acct_a, a, '[1]', '[]', '22023'),
      ('nodes not an array', acct_a, a, '{"name":"x"}', '{"a":1}', '22023'), ('blank name', acct_a, a, '{"name":"   "}', '[]', '22023')
    ) v(label, acct, flow, patch, nodes, want) LOOP
    st := NULL;
    BEGIN PERFORM public.replace_flow_draft_atomic(c.acct, c.flow, c.patch::jsonb, c.nodes::jsonb); EXCEPTION WHEN OTHERS THEN st := SQLSTATE; END;
    IF st IS DISTINCT FROM c.want THEN ok := false; detail := detail || ' [' || c.label || ': ' || coalesce(st, 'accepted') || ']'; END IF;
  END LOOP;
  IF public.qa_flow_state(a) <> sa OR public.qa_flow_state(b) <> sb THEN ok := false; detail := detail || ' [a rejected call changed data]'; END IF;
  PERFORM public.qa_result('D05', ok, 'wrong account / foreign flow / unknown flow -> P0002, NULL ids, non-object patch, non-array nodes, blank name -> 22023; neither account''s flow or nodes changed' || detail);
END $$;

-- D06: privileges. Only service_role; no PUBLIC/anon/authenticated; no privilege escalation (SECURITY INVOKER)
DO $$
DECLARE a uuid := 'a1000000-0000-4000-8000-0000000000f1'; acct uuid; ok boolean := true; detail text := ''; r text; st text; sig text := 'public.replace_flow_draft_atomic(uuid,uuid,jsonb,jsonb)';
BEGIN
  SELECT account_id INTO acct FROM public.flows WHERE id = a;
  IF (SELECT prosecdef FROM pg_proc WHERE oid = sig::regprocedure) THEN ok := false; detail := detail || ' [SECURITY DEFINER]'; END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x WHERE p.oid = sig::regprocedure AND x.grantee = 0) THEN ok := false; detail := detail || ' [PUBLIC grant]'; END IF;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_function_privilege(r, sig, 'EXECUTE') THEN ok := false; detail := detail || ' [' || r || ' may EXECUTE]'; END IF;
    st := NULL; EXECUTE format('SET LOCAL ROLE %I', r);
    BEGIN PERFORM public.replace_flow_draft_atomic(acct, a, '{"name":"hijack"}'::jsonb, NULL); EXCEPTION WHEN OTHERS THEN st := SQLSTATE; END;
    RESET ROLE;
    IF st IS DISTINCT FROM '42501' THEN ok := false; detail := detail || ' [' || r || ' ran it: ' || coalesce(st, 'SUCCEEDED') || ']'; END IF;
  END LOOP;
  IF NOT has_function_privilege('service_role', sig, 'EXECUTE') THEN ok := false; detail := detail || ' [service_role cannot execute]'; END IF;
  SET LOCAL ROLE service_role;
  BEGIN PERFORM public.replace_flow_draft_atomic(acct, a, '{"name":"by service"}'::jsonb, NULL); EXCEPTION WHEN OTHERS THEN ok := false; detail := detail || ' [service_role: ' || SQLSTATE || ']'; END;
  RESET ROLE;
  IF (SELECT name FROM public.flows WHERE id = a) <> 'by service' OR EXISTS (SELECT 1 FROM public.flows WHERE name = 'hijack') THEN ok := false; detail := detail || ' [effects of the role calls]'; END IF;
  PERFORM public.qa_result('D06', ok, 'SECURITY INVOKER; no PUBLIC grant; anon and authenticated -> 42501 (nothing written); service_role executes it' || detail);
END $$;

-- D07: only the flow's own rows change: other flows, runs and the flow status are untouched
DO $$
DECLARE a uuid := 'a1000000-0000-4000-8000-0000000000f1'; b uuid := 'b2000000-0000-4000-8000-0000000000f1'; acct uuid; sb jsonb; ok boolean := true; detail text := ''; st0 text;
BEGIN
  SELECT account_id INTO acct FROM public.flows WHERE id = a; sb := public.qa_flow_state(b);
  -- make the flow live where the schema allows it (E4.1's publication guard may refuse a bare status change: then it simply stays a draft)
  BEGIN PERFORM set_config('app.flow_publication', 'on', true); UPDATE public.flows SET status = 'active' WHERE id = a; EXCEPTION WHEN OTHERS THEN NULL; END;
  PERFORM set_config('app.flow_publication', 'off', true);
  st0 := (SELECT status FROM public.flows WHERE id = a);
  INSERT INTO public.contacts (id, user_id, account_id, phone, name) VALUES ('a1000000-0000-4000-8000-0000000000c1', 'a1000000-0000-4000-8000-000000000001', acct, '+15550000001', 'QA contact');
  INSERT INTO public.flow_runs (flow_id, account_id, user_id, contact_id, status, current_node_key) VALUES (a, acct, 'a1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-0000000000c1', 'active', 'start');
  PERFORM public.replace_flow_draft_atomic(acct, a, '{"name":"Live flow edit"}'::jsonb, '[{"node_key":"s","node_type":"start","config":{}}]'::jsonb);
  IF (SELECT status FROM public.flows WHERE id = a) IS DISTINCT FROM st0 THEN ok := false; detail := detail || ' [status changed]'; END IF;
  IF (SELECT count(*) FROM public.flow_runs WHERE flow_id = a AND status = 'active') <> 1 THEN ok := false; detail := detail || ' [run touched]'; END IF;
  IF public.qa_flow_state(b) <> sb THEN ok := false; detail := detail || ' [another account''s flow changed]'; END IF;
  PERFORM public.qa_result('D07', ok, 'saving does not change flows.status, existing runs or any other flow (the legacy runner and its data are not touched)' || detail);
END $$;

DROP TRIGGER qa_fail_on_key ON public.flow_nodes;
