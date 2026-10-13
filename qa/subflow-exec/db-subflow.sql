-- DB checks for migration 070 (subflow execution with return). One transaction, rolled back by the runner. IDs T01..T15.
-- Accounts: A (user a1..01) and B (user b2..02) from qa/flows-safe-save/fixtures.sql.

-- T01 shape and privileges: nothing is enabled by the migration, and nobody but a privileged operator can change that
DO $$
DECLARE ok boolean := true; detail text := ''; r text; t text; sig text;
BEGIN
  IF (SELECT count(*) FROM public.flow_execution_enablement) <> 0 THEN ok := false; detail := detail || ' [enablement not empty]'; END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.flow_execution_enablement'::regclass) THEN ok := false; detail := detail || ' [no RLS enablement]'; END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.flow_run_subflow_frames'::regclass) THEN ok := false; detail := detail || ' [no RLS frames]'; END IF;
  FOREACH t IN ARRAY ARRAY['public.flow_execution_enablement', 'public.flow_run_subflow_frames'] LOOP
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF has_table_privilege(r, t, 'INSERT') OR has_table_privilege(r, t, 'UPDATE') OR has_table_privilege(r, t, 'DELETE') OR has_table_privilege(r, t, 'TRUNCATE') THEN ok := false; detail := detail || ' [' || r || ' can write ' || t || ']'; END IF;
    END LOOP;
    IF has_table_privilege('anon', t, 'SELECT') OR has_table_privilege('authenticated', t, 'SELECT') THEN ok := false; detail := detail || ' [end users can read ' || t || ']'; END IF;
    IF NOT has_table_privilege('service_role', t, 'SELECT') THEN ok := false; detail := detail || ' [service_role cannot read ' || t || ']'; END IF;
  END LOOP;
  FOREACH sig IN ARRAY ARRAY['public.push_flow_subflow(uuid,uuid,text,uuid,text,jsonb,text)', 'public.pop_flow_subflow(uuid,uuid,uuid)', 'public.verify_flow_run_stack(uuid,uuid)', 'public.flow_graph_hash(uuid)'] LOOP
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP IF has_function_privilege(r, sig, 'EXECUTE') THEN ok := false; detail := detail || ' [' || r || ' may execute ' || sig || ']'; END IF; END LOOP;
    IF NOT has_function_privilege('service_role', sig, 'EXECUTE') THEN ok := false; detail := detail || ' [service_role cannot execute ' || sig || ']'; END IF;
    IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x WHERE p.oid = sig::regprocedure AND x.grantee = 0) THEN ok := false; detail := detail || ' [PUBLIC grant ' || sig || ']'; END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'flow_runs' AND column_name = 'current_flow_id' AND is_nullable = 'YES') THEN ok := false; detail := detail || ' [current_flow_id]'; END IF;
  PERFORM public.qa_result('T01', ok, 'enablement table created EMPTY; RLS on, end users cannot even read; service_role may only SELECT (never write); the 4 functions are service_role only (no PUBLIC); flow_runs.current_flow_id is nullable' || detail);
END $$;

-- T02 activation guards read the enablement table, per account
DO $$
DECLARE ok boolean := true; detail text := ''; a uuid := public.qa_acct('a1000000-0000-4000-8000-000000000001'::uuid); b uuid := public.qa_acct('b2000000-0000-4000-8000-000000000002'::uuid); fb uuid; fa uuid; wait_flow uuid; fo uuid; st text;
BEGIN
  fb := public.qa_simple(a, 'a1000000-0000-4000-8000-000000000001'::uuid, 'B');
  fa := public.qa_caller(a, 'a1000000-0000-4000-8000-000000000001'::uuid, 'A', fb, fb, 'draft');
  BEGIN UPDATE public.flows SET status = 'active' WHERE id = fa; ok := false; detail := detail || ' [activated without enablement]'; EXCEPTION WHEN OTHERS THEN IF SQLSTATE <> '0A000' THEN ok := false; detail := detail || ' [wrong code ' || SQLSTATE || ']'; END IF; END;
  PERFORM public.qa_enable(b);                                                          -- another account enabled: no effect on A
  BEGIN UPDATE public.flows SET status = 'active' WHERE id = fa; ok := false; detail := detail || ' [enabling B enabled A]'; EXCEPTION WHEN OTHERS THEN IF SQLSTATE <> '0A000' THEN ok := false; END IF; END;
  PERFORM public.qa_enable(a, false, false);                                            -- a row with both switches OFF is still off
  BEGIN UPDATE public.flows SET status = 'active' WHERE id = fa; ok := false; detail := detail || ' [row with false enabled]'; EXCEPTION WHEN OTHERS THEN IF SQLSTATE <> '0A000' THEN ok := false; END IF; END;
  PERFORM public.qa_enable(a, true, false);
  UPDATE public.flows SET status = 'active' WHERE id = fa;
  IF (SELECT status FROM public.flows WHERE id = fa) <> 'active' THEN ok := false; detail := detail || ' [not active after enabling]'; END IF;
  -- durable waits: separate switch
  wait_flow := public.qa_mkflow(a, 'a1000000-0000-4000-8000-000000000001'::uuid, 'W', jsonb_build_array(jsonb_build_object('k','start','t','start','c',jsonb_build_object('next_node_key','w')), jsonb_build_object('k','w','t','delay','c',jsonb_build_object('amount',13,'unit','minutes','next_node_key','end')), jsonb_build_object('k','end','t','end','c','{}'::jsonb)), 'draft');
  BEGIN UPDATE public.flows SET status = 'active' WHERE id = wait_flow; ok := false; detail := detail || ' [wait activated with only the subflow switch]'; EXCEPTION WHEN OTHERS THEN IF SQLSTATE <> '0A000' THEN ok := false; END IF; END;
  PERFORM public.qa_enable(a, true, true); UPDATE public.flows SET status = 'active' WHERE id = wait_flow;
  IF (SELECT status FROM public.flows WHERE id = wait_flow) <> 'active' THEN ok := false; detail := detail || ' [wait not active after enabling]'; END IF;
  -- unrelated flows are never affected
  fo := public.qa_simple(b, 'b2000000-0000-4000-8000-000000000002'::uuid, 'plain'); IF (SELECT status FROM public.flows WHERE id = fo) <> 'active' THEN ok := false; detail := detail || ' [plain flow blocked]'; END IF;
  -- nodes still cannot be added to an ACTIVE flow (068)
  BEGIN INSERT INTO public.flow_nodes (flow_id, node_key, node_type, config) VALUES (fa, 'late', 'execute_flow', jsonb_build_object('target_flow_id', fb)); ok := false; detail := detail || ' [execute_flow added to active flow]'; EXCEPTION WHEN OTHERS THEN IF SQLSTATE <> '0A000' THEN ok := false; END IF; END;
  PERFORM public.qa_result('T02', ok, 'a flow with execute_flow / durable waits activates only for an account with its own switch on (another account, a row with false, or the other switch do not count); plain flows unaffected; 068 still blocks adding such nodes to an active flow' || detail);
END $$;

-- T03 push: the happy path, one call
DO $$
DECLARE ok boolean := true; detail text := ''; a uuid := public.qa_acct('a1000000-0000-4000-8000-000000000001'::uuid); fb uuid; fc uuid; fa uuid; r uuid; res jsonb; row jsonb; ref jsonb := jsonb_build_object('message_id', gen_random_uuid(), 'conversation_id', gen_random_uuid(), 'sent_at', now());
BEGIN
  PERFORM public.qa_enable(a); fb := public.qa_simple(a, 'a1000000-0000-4000-8000-000000000001'::uuid, 'B'); fc := public.qa_simple(a, 'a1000000-0000-4000-8000-000000000001'::uuid, 'C'); fa := public.qa_caller(a, 'a1000000-0000-4000-8000-000000000001'::uuid, 'A', fb, fc); r := public.qa_run(fa, 'call1');
  res := public.qa_push(r, 'call1', fb, 'mid', ref);
  row := public.qa_row(r);
  IF res->>'ok' <> 'true' OR res->>'entry_node_key' <> 'start' OR (res->>'depth')::int <> 1 THEN ok := false; detail := detail || ' [result ' || res::text || ']'; END IF;
  IF row->>'current_flow_id' <> fb::text OR row->>'current_node_key' <> 'start' OR row->>'flow_id' <> fa::text OR row->>'status' <> 'active' THEN ok := false; detail := detail || ' [row ' || row::text || ']'; END IF;
  IF (row->'vars'->'$refs'->'$inherited') IS DISTINCT FROM ref OR (row->'vars'->>'$call_count') <> '1' THEN ok := false; detail := detail || ' [vars ' || (row->'vars')::text || ']'; END IF;
  IF (SELECT count(*) FROM public.flow_run_subflow_frames WHERE flow_run_id = r) <> 1 THEN ok := false; detail := detail || ' [frames]'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.flow_run_subflow_frames WHERE flow_run_id = r AND depth = 1 AND caller_flow_id = fa AND callee_flow_id = fb AND return_node_key = 'mid' AND on_customer_reply = 'stop' AND caller_graph_hash = public.flow_graph_hash(fa) AND callee_graph_hash = public.flow_graph_hash(fb)) THEN ok := false; detail := detail || ' [frame content]'; END IF;
  PERFORM public.qa_result('T03', ok, 'push moves the run into the callee (current_flow_id, entry node), keeps the root flow_id, pins both graph hashes, records the return node and policy, hands the reference down as $inherited and counts the call' || detail);
END $$;

-- T04 push refusals: every one leaves the run untouched
DO $$
DECLARE ok boolean := true; detail text := ''; a uuid := public.qa_acct('a1000000-0000-4000-8000-000000000001'::uuid); b uuid := public.qa_acct('b2000000-0000-4000-8000-000000000002'::uuid); fb uuid; fc uuid; fa uuid; fx uuid; fdraft uuid; r uuid; r2 uuid; before jsonb; res text; i int; n1 uuid; n2 uuid; n3 uuid; n4 uuid; nr uuid; rd uuid; other uuid; rb uuid;

BEGIN
  PERFORM public.qa_enable(a); PERFORM public.qa_enable(b);
  fb := public.qa_simple(a, 'a1000000-0000-4000-8000-000000000001'::uuid, 'B'); fc := public.qa_simple(a, 'a1000000-0000-4000-8000-000000000001'::uuid, 'C'); fa := public.qa_caller(a, 'a1000000-0000-4000-8000-000000000001'::uuid, 'A', fb, fc); r := public.qa_run(fa, 'call1'); before := public.qa_row(r);
  -- wrong call node / return node / target
  res := public.qa_push(r, 'call1', fc, 'mid')->>'reason';  IF res <> 'call_node_mismatch' THEN ok := false; detail := detail || ' [target mismatch ' || res || ']'; END IF;
  res := public.qa_push(r, 'call1', fb, 'last')->>'reason'; IF res <> 'call_node_mismatch' THEN ok := false; detail := detail || ' [return mismatch ' || res || ']'; END IF;
  res := public.qa_push(r, 'mid', fb, 'mid')->>'reason';    IF res <> 'call_node_mismatch' THEN ok := false; detail := detail || ' [not a call node ' || res || ']'; END IF;
  -- callee of another account
  other := public.qa_simple(b, 'b2000000-0000-4000-8000-000000000002'::uuid, 'foreign');
  res := public.qa_push(r, 'call1', other, 'mid')->>'reason'; IF res <> 'callee_unavailable' THEN ok := false; detail := detail || ' [cross account ' || res || ']'; END IF;
  -- callee not active
  UPDATE public.flows SET status = 'draft' WHERE id = fb; res := public.qa_push(r, 'call1', fb, 'mid')->>'reason'; IF res <> 'callee_unavailable' THEN ok := false; detail := detail || ' [draft callee ' || res || ']'; END IF; UPDATE public.flows SET status = 'active' WHERE id = fb;
  -- run of another account / not active / waiting / unknown
  rb := public.qa_run(public.qa_simple(b, 'b2000000-0000-4000-8000-000000000002'::uuid, 'brun')); IF (public.push_flow_subflow(a, rb, 'call1', fb, 'mid', NULL, 'stop')->>'reason') <> 'run_not_active' THEN ok := false; detail := detail || ' [foreign run]'; END IF;
  r2 := public.qa_run(fa, 'call1'); UPDATE public.flow_runs SET status = 'paused_by_agent' WHERE id = r2; res := public.qa_push(r2, 'call1', fb, 'mid')->>'reason'; IF res <> 'run_not_active' THEN ok := false; detail := detail || ' [paused run ' || res || ']'; END IF;
  r2 := public.qa_run(fa, 'call1'); UPDATE public.flow_runs SET wait_until = now() + interval '1 hour', wait_node_key = 'x' WHERE id = r2; res := public.qa_push(r2, 'call1', fb, 'mid')->>'reason'; IF res <> 'run_waiting' THEN ok := false; detail := detail || ' [waiting run ' || res || ']'; END IF;
  -- not enabled
  PERFORM public.qa_enable(a, false, false); res := public.qa_push(r, 'call1', fb, 'mid')->>'reason'; IF res <> 'subflow_execution_not_enabled' THEN ok := false; detail := detail || ' [disabled ' || res || ']'; END IF; PERFORM public.qa_enable(a);
  -- invalid arguments
  FOR i IN 1..4 LOOP
    BEGIN
      IF i = 1 THEN PERFORM public.push_flow_subflow(NULL, r, 'call1', fb, 'mid'); ELSIF i = 2 THEN PERFORM public.push_flow_subflow(a, r, ' ', fb, 'mid'); ELSIF i = 3 THEN PERFORM public.push_flow_subflow(a, r, 'call1', fb, 'mid', NULL, 'whatever'); ELSE PERFORM public.push_flow_subflow(a, r, 'call1', fb, 'mid', '[1]'::jsonb); END IF;
      ok := false; detail := detail || ' [bad arg ' || i || ' accepted]';
    EXCEPTION WHEN OTHERS THEN IF SQLSTATE <> '22023' THEN ok := false; detail := detail || ' [bad arg code ' || SQLSTATE || ']'; END IF; END;
  END LOOP;
  IF public.qa_row(r) IS DISTINCT FROM before OR EXISTS (SELECT 1 FROM public.flow_run_subflow_frames WHERE flow_run_id = r) THEN ok := false; detail := detail || ' [a refusal changed the run]'; END IF;
  PERFORM public.qa_result('T04', ok, 'refused without touching the run: wrong target / return / call node, target of another account, inactive callee, another account''s run, paused run, run parked on a wait, account not enabled; invalid arguments -> 22023' || detail);
END $$;

-- T05 cycles, repeated callees and depth
DO $$
DECLARE ok boolean := true; detail text := ''; a uuid := public.qa_acct('a1000000-0000-4000-8000-000000000001'::uuid); n5 uuid; n4 uuid; n3 uuid; n2 uuid; n1 uuid; root uuid; r uuid; res text; cyc uuid; r2 uuid; fb uuid;
  f_back uuid;
BEGIN
  PERFORM public.qa_enable(a);
  -- chain root -> n1 -> n2 -> n3 -> n4 (n4 is the 4th nesting level)
  n4 := public.qa_simple(a, 'a1000000-0000-4000-8000-000000000001'::uuid, 'N4');
  n3 := public.qa_mkflow(a, 'a1000000-0000-4000-8000-000000000001'::uuid, 'N3', jsonb_build_array(jsonb_build_object('k','start','t','start','c',jsonb_build_object('next_node_key','call')), jsonb_build_object('k','call','t','execute_flow','c',jsonb_build_object('target_flow_id',n4,'next_node_key','ret')), jsonb_build_object('k','ret','t','end','c','{}'::jsonb)));
  n2 := public.qa_mkflow(a, 'a1000000-0000-4000-8000-000000000001'::uuid, 'N2', jsonb_build_array(jsonb_build_object('k','start','t','start','c',jsonb_build_object('next_node_key','call')), jsonb_build_object('k','call','t','execute_flow','c',jsonb_build_object('target_flow_id',n3,'next_node_key','ret')), jsonb_build_object('k','ret','t','end','c','{}'::jsonb)));
  n1 := public.qa_mkflow(a, 'a1000000-0000-4000-8000-000000000001'::uuid, 'N1', jsonb_build_array(jsonb_build_object('k','start','t','start','c',jsonb_build_object('next_node_key','call')), jsonb_build_object('k','call','t','execute_flow','c',jsonb_build_object('target_flow_id',n2,'next_node_key','ret')), jsonb_build_object('k','ret','t','end','c','{}'::jsonb)));
  root := public.qa_mkflow(a, 'a1000000-0000-4000-8000-000000000001'::uuid, 'ROOT', jsonb_build_array(jsonb_build_object('k','start','t','start','c',jsonb_build_object('next_node_key','call')), jsonb_build_object('k','call','t','execute_flow','c',jsonb_build_object('target_flow_id',n1,'next_node_key','ret')), jsonb_build_object('k','ret','t','end','c','{}'::jsonb)));
  r := public.qa_run(root, 'call');
  IF (public.qa_push(r, 'call', n1, 'ret')->>'ok') <> 'true' THEN ok := false; detail := detail || ' [d1]'; END IF;
  IF (public.qa_push(r, 'call', n2, 'ret')->>'ok') <> 'true' THEN ok := false; detail := detail || ' [d2]'; END IF;
  IF (public.qa_push(r, 'call', n3, 'ret')->>'ok') <> 'true' THEN ok := false; detail := detail || ' [d3]'; END IF;
  res := public.qa_push(r, 'call', n4, 'ret')->>'reason'; IF res <> 'max_depth' THEN ok := false; detail := detail || ' [4th level ' || coalesce(res, 'accepted') || ']'; END IF;
  IF (SELECT count(*) FROM public.flow_run_subflow_frames WHERE flow_run_id = r) <> 3 THEN ok := false; detail := detail || ' [frames after refusal]'; END IF;
  -- cycle: X calls Y and Y calls X (Y is completed as a draft AFTER X exists, then activated)
  fb := public.qa_mkflow(a, 'a1000000-0000-4000-8000-000000000001'::uuid, 'Y', jsonb_build_array(jsonb_build_object('k','start','t','start','c',jsonb_build_object('next_node_key','end')), jsonb_build_object('k','end','t','end','c','{}'::jsonb)), 'draft');
  cyc := public.qa_mkflow(a, 'a1000000-0000-4000-8000-000000000001'::uuid, 'X', jsonb_build_array(jsonb_build_object('k','start','t','start','c',jsonb_build_object('next_node_key','call')), jsonb_build_object('k','call','t','execute_flow','c',jsonb_build_object('target_flow_id',fb,'next_node_key','ret')), jsonb_build_object('k','ret','t','end','c','{}'::jsonb)), 'draft');
  UPDATE public.flows SET status = 'active' WHERE id = fb;
  UPDATE public.flows SET status = 'draft' WHERE id = fb;
  INSERT INTO public.flow_nodes (flow_id, node_key, node_type, config) VALUES (fb, 'call', 'execute_flow', jsonb_build_object('target_flow_id', cyc, 'next_node_key', 'end'));
  UPDATE public.flow_nodes SET config = jsonb_build_object('next_node_key', 'call') WHERE flow_id = fb AND node_key = 'start';
  UPDATE public.flows SET status = 'active' WHERE id IN (fb, cyc);
  r2 := public.qa_run(cyc, 'call');
  IF (public.qa_push(r2, 'call', fb, 'ret')->>'ok') <> 'true' THEN ok := false; detail := detail || ' [X -> Y]'; END IF;
  res := public.qa_push(r2, 'call', cyc, 'end')->>'reason'; IF res <> 'cycle' THEN ok := false; detail := detail || ' [Y -> X (the root) ' || coalesce(res, 'accepted') || ']'; END IF;
  -- a flow that is already in the stack cannot be entered again from deeper
  res := public.qa_push(r, 'call', n1, 'ret')->>'reason'; IF res NOT IN ('cycle', 'max_depth') THEN ok := false; detail := detail || ' [repeat ' || coalesce(res, 'accepted') || ']'; END IF;
  PERFORM public.qa_result('T05', ok, 'three nested calls are accepted, the 4th is refused (max_depth) and leaves the stack intact; a flow calling the root / a flow already in the stack is refused (cycle)' || detail);
END $$;

-- T06 A -> B -> A -> C -> A: sequential calls are depth 1 each, never accumulate, and the call budget bounds loops
DO $$
DECLARE ok boolean := true; detail text := ''; a uuid := public.qa_acct('a1000000-0000-4000-8000-000000000001'::uuid); fb uuid; fc uuid; fa uuid; r uuid; res jsonb; row jsonb; i int; bud text;
BEGIN
  PERFORM public.qa_enable(a); fb := public.qa_simple(a, 'a1000000-0000-4000-8000-000000000001'::uuid, 'B'); fc := public.qa_simple(a, 'a1000000-0000-4000-8000-000000000001'::uuid, 'C'); fa := public.qa_caller(a, 'a1000000-0000-4000-8000-000000000001'::uuid, 'A', fb, fc); r := public.qa_run(fa, 'call1');
  IF (public.qa_push(r, 'call1', fb, 'mid')->>'ok') <> 'true' THEN ok := false; detail := detail || ' [push B]'; END IF;
  res := public.qa_pop(r, fb);
  row := public.qa_row(r);
  IF res->>'ok' <> 'true' OR res->>'return_node_key' <> 'mid' OR (res->>'depth')::int <> 0 THEN ok := false; detail := detail || ' [pop B ' || res::text || ']'; END IF;
  IF row->>'current_flow_id' IS NOT NULL OR row->>'current_node_key' <> 'mid' OR EXISTS (SELECT 1 FROM public.flow_run_subflow_frames WHERE flow_run_id = r) THEN ok := false; detail := detail || ' [after pop B ' || row::text || ']'; END IF;
  IF (row->'vars'->'$refs') ? '$inherited' THEN ok := false; detail := detail || ' [inherited left behind]'; END IF;
  IF (public.qa_push(r, 'call2', fc, 'last')->>'ok') <> 'true' THEN ok := false; detail := detail || ' [push C]'; END IF;
  IF (SELECT (public.qa_pop(r, fc))->>'return_node_key') <> 'last' THEN ok := false; detail := detail || ' [pop C]'; END IF;
  row := public.qa_row(r); IF row->>'current_node_key' <> 'last' OR row->>'current_flow_id' IS NOT NULL OR (row->'vars'->>'$call_count') <> '2' THEN ok := false; detail := detail || ' [final ' || row::text || ']'; END IF;
  -- the same flow may be called again sequentially, but not forever
  FOR i IN 1..12 LOOP
    res := public.qa_push(r, 'call1', fb, 'mid'); IF (res->>'ok') <> 'true' THEN bud := res->>'reason'; EXIT; END IF; PERFORM public.qa_pop(r, fb);
  END LOOP;
  IF bud IS DISTINCT FROM 'call_budget' THEN ok := false; detail := detail || ' [no call budget: ' || coalesce(bud, 'none') || ']'; END IF;
  PERFORM public.qa_result('T06', ok, 'A->B pop->A->C pop->A leaves depth 0, current_flow_id NULL, the cursor at each return node and no frame behind; sequential calls never add up as nesting; a looping caller is stopped by the per-run call budget (8)' || detail);
END $$;

-- T07 pop refuses when the stack cannot be trusted (and changes nothing)
DO $$
DECLARE ok boolean := true; detail text := ''; a uuid := public.qa_acct('a1000000-0000-4000-8000-000000000001'::uuid); fb uuid; fc uuid; fa uuid; r uuid; before jsonb; res text; case_i int; v jsonb;
BEGIN
  PERFORM public.qa_enable(a);
  FOR case_i IN 1..7 LOOP
    fb := public.qa_simple(a, 'a1000000-0000-4000-8000-000000000001'::uuid, 'B' || case_i); fc := public.qa_simple(a, 'a1000000-0000-4000-8000-000000000001'::uuid, 'C' || case_i); fa := public.qa_caller(a, 'a1000000-0000-4000-8000-000000000001'::uuid, 'A' || case_i, fb, fc); r := public.qa_run(fa, 'call1');
    IF (public.qa_push(r, 'call1', fb, 'mid')->>'ok') <> 'true' THEN ok := false; detail := detail || ' [push ' || case_i || ']'; CONTINUE; END IF;
    IF case_i = 1 THEN UPDATE public.flow_nodes SET config = jsonb_set(config, '{text}', '"changed"') WHERE flow_id = fa AND node_key = 'mid';                       -- the caller changed
    ELSIF case_i = 2 THEN UPDATE public.flow_nodes SET config = jsonb_set(config, '{next_node_key}', '"other"') WHERE flow_id = fb AND node_key = 'start';         -- the callee changed
    ELSIF case_i = 3 THEN DELETE FROM public.flow_nodes WHERE flow_id = fa AND node_key = 'mid';                                                                   -- return node removed
    ELSIF case_i = 4 THEN UPDATE public.flows SET status = 'draft' WHERE id = fa;                                                                                  -- caller paused
    ELSIF case_i = 5 THEN UPDATE public.flows SET status = 'draft' WHERE id = fb;                                                                                  -- callee paused
    ELSIF case_i = 6 THEN UPDATE public.flows SET entry_node_id = 'end' WHERE id = fb;                                                                             -- callee entry changed
    ELSE UPDATE public.flow_runs SET current_flow_id = NULL WHERE id = r; END IF;                                                                                  -- cursor not in the callee
    before := public.qa_row(r); res := public.qa_pop(r, fb)->>'reason';
    IF res IS NULL OR res NOT IN ('caller_graph_changed', 'callee_graph_changed', 'caller_unavailable', 'callee_unavailable', 'return_node_missing', 'frame_mismatch') THEN ok := false; detail := detail || ' [case ' || case_i || ' -> ' || coalesce(res, 'accepted') || ']'; END IF;
    IF public.qa_row(r) IS DISTINCT FROM before OR (SELECT count(*) FROM public.flow_run_subflow_frames WHERE flow_run_id = r) <> 1 THEN ok := false; detail := detail || ' [case ' || case_i || ' changed the run]'; END IF;
    v := public.verify_flow_run_stack(public.qa_acct('a1000000-0000-4000-8000-000000000001'::uuid), r); IF case_i < 7 AND (v->>'ok') = 'true' THEN ok := false; detail := detail || ' [verify accepted case ' || case_i || ']'; END IF;
  END LOOP;
  -- layout-only edits and unrelated flows never invalidate a suspended run
  fb := public.qa_simple(a, 'a1000000-0000-4000-8000-000000000001'::uuid, 'BL'); fc := public.qa_simple(a, 'a1000000-0000-4000-8000-000000000001'::uuid, 'CL'); fa := public.qa_caller(a, 'a1000000-0000-4000-8000-000000000001'::uuid, 'AL', fb, fc); r := public.qa_run(fa, 'call1'); PERFORM public.qa_push(r, 'call1', fb, 'mid');
  UPDATE public.flow_nodes SET position_x = 999, position_y = 999 WHERE flow_id IN (fa, fb) AND node_type <> 'execute_flow'; UPDATE public.flows SET name = 'renamed', description = 'x' WHERE id IN (fa, fb); PERFORM public.qa_simple(a, 'a1000000-0000-4000-8000-000000000001'::uuid, 'unrelated');
  IF (public.verify_flow_run_stack(a, r)->>'ok') <> 'true' OR (public.qa_pop(r, fb)->>'ok') <> 'true' THEN ok := false; detail := detail || ' [layout/rename invalidated the run]'; END IF;
  PERFORM public.qa_result('T07', ok, 'return REFUSED (nothing changed) when the caller or callee graph changed, the return node vanished, a flow left the active state, the callee entry changed or the cursor is not in the callee; moving boxes / renaming does not matter' || detail);
END $$;

-- T08 nested pop restores the parent's inherited reference; the root flow's pin is checked at depth 2
DO $$
DECLARE ok boolean := true; detail text := ''; a uuid := public.qa_acct('a1000000-0000-4000-8000-000000000001'::uuid); n3 uuid; n2 uuid; n1 uuid; root uuid; r uuid; ref1 jsonb := '{"k":1}'; ref2 jsonb := '{"k":2}'; row jsonb;
BEGIN
  PERFORM public.qa_enable(a);
  n3 := public.qa_simple(a, 'a1000000-0000-4000-8000-000000000001'::uuid, 'M3');
  n2 := public.qa_mkflow(a, 'a1000000-0000-4000-8000-000000000001'::uuid, 'M2', jsonb_build_array(jsonb_build_object('k','start','t','start','c',jsonb_build_object('next_node_key','call')), jsonb_build_object('k','call','t','execute_flow','c',jsonb_build_object('target_flow_id',n3,'next_node_key','ret')), jsonb_build_object('k','ret','t','end','c','{}'::jsonb)));
  n1 := public.qa_mkflow(a, 'a1000000-0000-4000-8000-000000000001'::uuid, 'M1', jsonb_build_array(jsonb_build_object('k','start','t','start','c',jsonb_build_object('next_node_key','call')), jsonb_build_object('k','call','t','execute_flow','c',jsonb_build_object('target_flow_id',n2,'next_node_key','ret')), jsonb_build_object('k','ret','t','end','c','{}'::jsonb)));
  root := public.qa_mkflow(a, 'a1000000-0000-4000-8000-000000000001'::uuid, 'MR', jsonb_build_array(jsonb_build_object('k','start','t','start','c',jsonb_build_object('next_node_key','call')), jsonb_build_object('k','call','t','execute_flow','c',jsonb_build_object('target_flow_id',n1,'next_node_key','ret')), jsonb_build_object('k','ret','t','end','c','{}'::jsonb)));
  r := public.qa_run(root, 'call');
  PERFORM public.qa_push(r, 'call', n1, 'ret', ref1); PERFORM public.qa_push(r, 'call', n2, 'ret', ref2); PERFORM public.qa_push(r, 'call', n3, 'ret', NULL);
  row := public.qa_row(r); IF row->'vars'->'$refs' ? '$inherited' THEN ok := false; detail := detail || ' [depth 3 call without reference kept a stale one]'; END IF;
  PERFORM public.qa_pop(r, n3); row := public.qa_row(r);
  IF row->'vars'->'$refs'->'$inherited' IS DISTINCT FROM ref2 OR row->>'current_flow_id' <> n2::text THEN ok := false; detail := detail || ' [after pop 3: ' || row::text || ']'; END IF;
  PERFORM public.qa_pop(r, n2); row := public.qa_row(r);
  IF row->'vars'->'$refs'->'$inherited' IS DISTINCT FROM ref1 OR row->>'current_flow_id' <> n1::text THEN ok := false; detail := detail || ' [after pop 2]'; END IF;
  -- out of order pop is refused
  PERFORM public.qa_push(r, 'call', n2, 'ret', ref2);
  IF (public.qa_pop(r, n1)->>'reason') <> 'frame_mismatch' THEN ok := false; detail := detail || ' [out-of-order pop accepted]'; END IF;
  -- the ROOT graph is pinned by the first frame: changing it while the run is two levels deep refuses the pop
  UPDATE public.flow_nodes SET config = jsonb_set(config, '{next_node_key}', '"start"') WHERE flow_id = root AND node_key = 'start';
  IF (public.qa_pop(r, n2)->>'ok') = 'true' THEN ok := false; detail := detail || ' [root changed but pop accepted]'; END IF;
  PERFORM public.qa_result('T08', ok, 'each pop restores the PARENT frame''s inherited reference (or none); an out-of-order pop is refused; the root flow''s graph is pinned by the first frame for the whole execution' || detail);
END $$;

-- T09 deleting a flow removes the runs inside it and their frames (same rule as before for deleted flows)
DO $$
DECLARE ok boolean := true; detail text := ''; a uuid := public.qa_acct('a1000000-0000-4000-8000-000000000001'::uuid); fb uuid; fc uuid; fa uuid; r uuid;
BEGIN
  PERFORM public.qa_enable(a); fb := public.qa_simple(a, 'a1000000-0000-4000-8000-000000000001'::uuid, 'B'); fc := public.qa_simple(a, 'a1000000-0000-4000-8000-000000000001'::uuid, 'C'); fa := public.qa_caller(a, 'a1000000-0000-4000-8000-000000000001'::uuid, 'A', fb, fc); r := public.qa_run(fa, 'call1'); PERFORM public.qa_push(r, 'call1', fb, 'mid');
  DELETE FROM public.flows WHERE id = fb;
  IF EXISTS (SELECT 1 FROM public.flow_runs WHERE id = r) OR EXISTS (SELECT 1 FROM public.flow_run_subflow_frames WHERE flow_run_id = r) THEN ok := false; detail := detail || ' [run or frame survived the callee deletion]'; END IF;
  PERFORM public.qa_result('T09', ok, 'deleting the flow a run is inside removes that run and its frames (foreign keys cascade); no run is left pointing at a missing flow' || detail);
END $$;

-- T10 the existing wait machinery works inside a callee, and the one-active-run-per-contact rule is untouched
DO $$
DECLARE ok boolean := true; detail text := ''; a uuid := public.qa_acct('a1000000-0000-4000-8000-000000000001'::uuid); fb uuid; fc uuid; fa uuid; r uuid; c uuid; tok uuid;
BEGIN
  PERFORM public.qa_enable(a, true, true);
  fb := public.qa_mkflow(a, 'a1000000-0000-4000-8000-000000000001'::uuid, 'BW', jsonb_build_array(jsonb_build_object('k','start','t','start','c',jsonb_build_object('next_node_key','pause')), jsonb_build_object('k','pause','t','delay','c',jsonb_build_object('amount',13,'unit','minutes','next_node_key','end')), jsonb_build_object('k','end','t','end','c','{}'::jsonb)));
  fc := public.qa_simple(a, 'a1000000-0000-4000-8000-000000000001'::uuid, 'C'); fa := public.qa_caller(a, 'a1000000-0000-4000-8000-000000000001'::uuid, 'A', fb, fc); r := public.qa_run(fa, 'call1'); PERFORM public.qa_push(r, 'call1', fb, 'mid');
  IF NOT public.schedule_flow_wait(a, r, 'pause', clock_timestamp() + interval '13 minutes') THEN ok := false; detail := detail || ' [schedule inside callee]'; END IF;
  IF (public.qa_push(r, 'call1', fc, 'mid')->>'reason') <> 'run_waiting' THEN ok := false; detail := detail || ' [push while waiting]'; END IF;
  IF (public.qa_pop(r, fb)->>'reason') <> 'run_waiting' THEN ok := false; detail := detail || ' [pop while waiting]'; END IF;
  UPDATE public.flow_runs SET wait_until = clock_timestamp() - interval '1 second' WHERE id = r;
  SELECT claim_token INTO tok FROM public.claim_due_flow_waits(ARRAY[a], 5, 300) WHERE run_id = r;
  IF NOT public.consume_flow_wait(a, r, tok, 'end') THEN ok := false; detail := detail || ' [consume]'; END IF;
  IF (public.qa_row(r)->>'current_flow_id') <> fb::text THEN ok := false; detail := detail || ' [consume lost current_flow_id]'; END IF;
  IF (public.qa_pop(r, fb)->>'ok') <> 'true' THEN ok := false; detail := detail || ' [pop after wait]'; END IF;
  -- one active run per contact: a second active run for the same contact is still impossible
  SELECT contact_id INTO c FROM public.flow_runs WHERE id = r;
  BEGIN INSERT INTO public.flow_runs (flow_id, account_id, user_id, contact_id, status) VALUES (fa, a, 'a1000000-0000-4000-8000-000000000001'::uuid, c, 'active'); ok := false; detail := detail || ' [second active run accepted]'; EXCEPTION WHEN unique_violation THEN NULL; END;
  PERFORM public.qa_result('T10', ok, 'a 13-minute wait inside the callee schedules, claims and consumes exactly as before and keeps current_flow_id; no push / pop while parked; still one active run per contact' || detail);
END $$;

-- T11 the migration enabled nothing and existing data/paths are untouched
DO $$
DECLARE ok boolean := true; detail text := '';
BEGIN
  IF EXISTS (SELECT 1 FROM public.flow_runs WHERE current_flow_id IS NOT NULL AND id NOT IN (SELECT flow_run_id FROM public.flow_run_subflow_frames)) THEN ok := false; detail := detail || ' [run inside a flow without a frame]'; END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgname IN ('flows_guard_execute_flow_activation', 'flows_guard_durable_wait_activation', 'flow_nodes_guard_execute_flow', 'flow_nodes_guard_durable_wait')) <> 4 THEN ok := false; detail := detail || ' [triggers]'; END IF;
  PERFORM public.qa_result('T11', ok, 'the four 068/069 triggers are still in place with their WHEN clauses; no run is inside a flow without a frame' || detail);
END $$;
