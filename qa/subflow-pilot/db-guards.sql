-- DB checks for migration 068 (execute_flow authoring guards). One transaction, rolled back by the runner. IDs G01..G08.
-- Uses qa/flows-safe-save/fixtures.sql: flow A (account A, 3 nodes) and flow B (account B).
DO $$
DECLARE a uuid := 'a1000000-0000-4000-8000-0000000000f1'; b uuid := 'b2000000-0000-4000-8000-0000000000f1'; acct_a uuid; a2 uuid; ok boolean := true; detail text := ''; st text;
BEGIN
  SELECT account_id INTO acct_a FROM public.flows WHERE id = a;
  UPDATE public.flows SET status = 'draft' WHERE id = a;   -- the safe-save suite (D07) leaves flow A active
  INSERT INTO public.flows (user_id, account_id, name, trigger_type) SELECT user_id, account_id, 'Flow A2', 'manual' FROM public.flows WHERE id = a RETURNING id INTO a2;
  PERFORM set_config('qa.a2', a2::text, true);
  -- G01 the type is accepted, unknown types are still refused
  BEGIN INSERT INTO public.flow_nodes (flow_id, node_key, node_type, config) VALUES (a, 'g01', 'execute_flow', '{}'); EXCEPTION WHEN OTHERS THEN ok := false; detail := detail || ' [execute_flow refused: ' || SQLSTATE || ']'; END;
  st := NULL; BEGIN INSERT INTO public.flow_nodes (flow_id, node_key, node_type) VALUES (a, 'g01b', 'run_flow'); EXCEPTION WHEN OTHERS THEN st := SQLSTATE; END;
  IF st IS DISTINCT FROM '23514' THEN ok := false; detail := detail || ' [unknown type: ' || coalesce(st, 'accepted') || ']'; END IF;
  PERFORM public.qa_result('G01', ok, 'node_type CHECK accepts execute_flow (same list as E4''s 058) and still refuses unknown types' || detail);
END $$;

-- G02 valid references and unfinished drafts are stored
DO $$
DECLARE a uuid := 'a1000000-0000-4000-8000-0000000000f1'; a2 uuid := current_setting('qa.a2')::uuid; ok boolean := true; detail text := ''; c jsonb;
BEGIN
  FOREACH c IN ARRAY ARRAY[jsonb_build_object('target_flow_id', a2, 'next_node_key', 'end'), '{"target_flow_id":"","next_node_key":""}'::jsonb, '{"target_flow_id":null}'::jsonb, '{}'::jsonb] LOOP
    BEGIN INSERT INTO public.flow_nodes (flow_id, node_key, node_type, config) VALUES (a, 'g02-' || md5(c::text), 'execute_flow', c); EXCEPTION WHEN OTHERS THEN ok := false; detail := detail || ' [' || c::text || ': ' || SQLSTATE || ']'; END;
  END LOOP;
  BEGIN UPDATE public.flow_nodes SET config = jsonb_build_object('target_flow_id', a2, 'next_node_key', 'start') WHERE flow_id = a AND node_key = 'g01'; EXCEPTION WHEN OTHERS THEN ok := false; detail := detail || ' [update to a valid target: ' || SQLSTATE || ']'; END;
  PERFORM public.qa_result('G02', ok, 'a target that is another flow of the same account is stored (insert and update); an empty / null / missing target is stored (unfinished draft)' || detail);
END $$;

-- G03 invalid references are refused and leave nothing behind
DO $$
DECLARE a uuid := 'a1000000-0000-4000-8000-0000000000f1'; b uuid := 'b2000000-0000-4000-8000-0000000000f1'; ok boolean := true; detail text := ''; r record; st text; n0 int;
BEGIN
  SELECT count(*) INTO n0 FROM public.flow_nodes WHERE flow_id = a;
  IF NOT EXISTS (SELECT 1 FROM public.flow_nodes WHERE flow_id = a AND node_type <> 'execute_flow') THEN RAISE EXCEPTION 'G03 setup: no plain node to retype'; END IF;
  FOR r IN SELECT * FROM (VALUES
      ('flow of another account', jsonb_build_object('target_flow_id', b), '23503'),
      ('unknown flow', jsonb_build_object('target_flow_id', gen_random_uuid()), '23503'),
      ('the flow itself', jsonb_build_object('target_flow_id', a), '23503'),
      ('malformed id', '{"target_flow_id":"not-a-uuid"}'::jsonb, '23503'),
      ('numeric id', '{"target_flow_id":42}'::jsonb, '22023'),
      ('array config', '[1]'::jsonb, '22023')) v(label, cfg, want) LOOP
    st := NULL;
    BEGIN INSERT INTO public.flow_nodes (flow_id, node_key, node_type, config) VALUES (a, 'g03', 'execute_flow', r.cfg); EXCEPTION WHEN OTHERS THEN st := SQLSTATE; END;
    IF st IS DISTINCT FROM r.want THEN ok := false; detail := detail || ' [' || r.label || ': ' || coalesce(st, 'accepted') || ']'; END IF;
  END LOOP;
  st := NULL; BEGIN UPDATE public.flow_nodes SET config = jsonb_build_object('target_flow_id', b) WHERE flow_id = a AND node_key = 'g01'; EXCEPTION WHEN OTHERS THEN st := SQLSTATE; END;
  IF st IS DISTINCT FROM '23503' THEN ok := false; detail := detail || ' [update to another account: ' || coalesce(st, 'accepted') || ']'; END IF;
  st := NULL; BEGIN UPDATE public.flow_nodes SET node_type = 'execute_flow', config = jsonb_build_object('target_flow_id', b) WHERE id = (SELECT id FROM public.flow_nodes WHERE flow_id = a AND node_type <> 'execute_flow' ORDER BY node_key LIMIT 1); EXCEPTION WHEN OTHERS THEN st := SQLSTATE; END;
  IF st IS DISTINCT FROM '23503' THEN ok := false; detail := detail || ' [type change to a foreign target: ' || coalesce(st, 'accepted') || ']'; END IF;
  IF (SELECT count(*) FROM public.flow_nodes WHERE flow_id = a) <> n0 THEN ok := false; detail := detail || ' [rows changed]'; END IF;
  PERFORM public.qa_result('G03', ok, 'another account''s flow, an unknown flow, the flow itself, a malformed id -> 23503; non-string id or non-object config -> 22023; updates and type changes are checked too; nothing written' || detail);
END $$;

-- G04 / G05 never in an active flow, never activated
DO $$
DECLARE a uuid := 'a1000000-0000-4000-8000-0000000000f1'; a2 uuid := current_setting('qa.a2')::uuid; ok boolean := true; detail text := ''; st text;
BEGIN
  -- Activate the way the schema allows: plain UPDATE without E4.1; the publication path (app.flow_publication = on,
  -- what publish_flow_version uses) when E4.1's 052 is present. Either way THIS guard must refuse a flow with the node.
  PERFORM set_config('app.flow_publication', 'on', true);
  -- G05: a flow holding the node cannot become active (flow A has execute_flow rows from G01/G02)
  st := NULL; BEGIN UPDATE public.flows SET status = 'active' WHERE id = a; EXCEPTION WHEN OTHERS THEN st := SQLSTATE; END;
  IF st IS DISTINCT FROM '0A000' OR (SELECT status FROM public.flows WHERE id = a) <> 'draft' THEN ok := false; detail := detail || ' [activation: ' || coalesce(st, 'accepted') || ']'; END IF;
  -- other flows still activate normally, and an active flow cannot receive the node (G04)
  BEGIN UPDATE public.flows SET status = 'active' WHERE id = a2; EXCEPTION WHEN OTHERS THEN ok := false; detail := detail || ' [plain activation broken: ' || SQLSTATE || ']'; END;
  st := NULL; BEGIN INSERT INTO public.flow_nodes (flow_id, node_key, node_type, config) VALUES (a2, 'g04', 'execute_flow', '{}'); EXCEPTION WHEN OTHERS THEN st := SQLSTATE; END;
  IF st IS DISTINCT FROM '0A000' THEN ok := false; detail := detail || ' [node into active flow: ' || coalesce(st, 'accepted') || ']'; END IF;
  st := NULL; BEGIN INSERT INTO public.flows (user_id, account_id, name, trigger_type, status) SELECT user_id, account_id, 'born active', 'manual', 'active' FROM public.flows WHERE id = a; EXCEPTION WHEN OTHERS THEN st := SQLSTATE; END;
  IF st IS NOT NULL THEN ok := false; detail := detail || ' [insert of an active flow without nodes: ' || st || ']'; END IF;
  UPDATE public.flows SET status = 'draft' WHERE id = a2;
  PERFORM set_config('app.flow_publication', 'off', true);
  PERFORM public.qa_result('G04', ok, 'a flow with execute_flow cannot be set active, also through E4.1''s publication path when present (0A000, stays draft); flows without it activate normally; an active flow cannot receive an execute_flow node (0A000)' || detail);
END $$;

-- G06 through the atomic save (067): a valid graph saves, an invalid reference rolls the whole save back
DO $$
DECLARE a uuid := 'a1000000-0000-4000-8000-0000000000f1'; a2 uuid := current_setting('qa.a2')::uuid; b uuid := 'b2000000-0000-4000-8000-0000000000f1'; acct uuid; before_s jsonb; ok boolean := true; detail text := ''; st text;
BEGIN
  SELECT account_id INTO acct FROM public.flows WHERE id = a;
  PERFORM public.replace_flow_draft_atomic(acct, a, '{"name":"Flow A connected"}'::jsonb, jsonb_build_array(
    jsonb_build_object('node_key','start','node_type','start','config',jsonb_build_object('next_node_key','call')),
    jsonb_build_object('node_key','call','node_type','execute_flow','config',jsonb_build_object('target_flow_id',a2,'next_node_key','end')),
    jsonb_build_object('node_key','end','node_type','end','config','{}'::jsonb)));
  IF (SELECT config->>'target_flow_id' FROM public.flow_nodes WHERE flow_id = a AND node_key = 'call') IS DISTINCT FROM a2::text THEN ok := false; detail := detail || ' [valid save]'; END IF;
  before_s := public.qa_flow_state(a);
  st := NULL;
  BEGIN PERFORM public.replace_flow_draft_atomic(acct, a, '{"name":"MUST NOT PERSIST"}'::jsonb, jsonb_build_array(
    jsonb_build_object('node_key','start','node_type','start','config','{}'::jsonb),
    jsonb_build_object('node_key','call','node_type','execute_flow','config',jsonb_build_object('target_flow_id',b,'next_node_key','end'))));
  EXCEPTION WHEN OTHERS THEN st := SQLSTATE; END;
  IF st IS DISTINCT FROM '23503' OR public.qa_flow_state(a) <> before_s THEN ok := false; detail := detail || ' [invalid save: ' || coalesce(st, 'accepted') || ']'; END IF;
  PERFORM public.qa_result('G06', ok, 'replace_flow_draft_atomic stores a connected graph; a save pointing at another account''s flow fails with 23503 and the previous version (header, nodes, references) is intact' || detail);
END $$;

-- G07 a real user session (RLS, as PostgREST would run it) cannot bypass the guards
DO $$
DECLARE a uuid := 'a1000000-0000-4000-8000-0000000000f1'; b uuid := 'b2000000-0000-4000-8000-0000000000f1'; ok boolean := true; detail text := ''; st text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', 'b2000000-0000-4000-8000-000000000002', true);
  PERFORM set_config('request.jwt.claims', '{"sub":"b2000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  st := NULL; BEGIN INSERT INTO public.flow_nodes (flow_id, node_key, node_type, config) VALUES (b, 'x', 'execute_flow', jsonb_build_object('target_flow_id', a)); EXCEPTION WHEN OTHERS THEN st := SQLSTATE; END;
  IF st IS DISTINCT FROM '23503' THEN ok := false; detail := detail || ' [B pointing at A: ' || coalesce(st, 'accepted') || ']'; END IF;
  st := NULL; BEGIN INSERT INTO public.flow_nodes (flow_id, node_key, node_type, config) VALUES (b, 'y', 'execute_flow', '{}'); EXCEPTION WHEN OTHERS THEN st := SQLSTATE; END;
  st := NULL; BEGIN UPDATE public.flows SET status = 'active' WHERE id = b; EXCEPTION WHEN OTHERS THEN st := SQLSTATE; END;
  RESET ROLE;
  IF st IS DISTINCT FROM '0A000' AND (SELECT status FROM public.flows WHERE id = b) = 'active' THEN ok := false; detail := detail || ' [B activated a flow with the node]'; END IF;
  IF EXISTS (SELECT 1 FROM public.flow_nodes WHERE flow_id = b AND node_key = 'x') THEN ok := false; detail := detail || ' [cross-account reference stored]'; END IF;
  PERFORM public.qa_result('G07', ok, 'as an authenticated user of account B (RLS session, the PostgREST path): a reference to account A''s flow is refused (23503) and a flow holding the node cannot be activated' || detail);
END $$;

-- G08 the triggers only run for execute_flow rows / activations (WHEN clauses) and their functions are not callable by users
DO $$
DECLARE ok boolean := true; detail text := '';
BEGIN
  IF (SELECT count(*) FROM pg_trigger WHERE tgname IN ('flow_nodes_guard_execute_flow', 'flows_guard_execute_flow_activation') AND tgqual IS NOT NULL) <> 2 THEN ok := false; detail := detail || ' [WHEN clause missing]'; END IF;
  IF has_function_privilege('authenticated', 'public.guard_execute_flow_node()', 'EXECUTE') OR has_function_privilege('anon', 'public.guard_execute_flow_activation()', 'EXECUTE') THEN ok := false; detail := detail || ' [guard callable by users]'; END IF;
  PERFORM public.qa_result('G08', ok, 'both triggers carry WHEN clauses (other node types and non-activation updates never call them); guard functions are not executable by anon/authenticated' || detail);
END $$;
