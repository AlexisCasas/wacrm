-- DB checks for migration 071 (global execution default). One transaction, rolled back by the runner. IDs T15..T20.

-- T15 shape and privileges: one row, everything OFF, nobody but a privileged operator can change it
DO $$
DECLARE ok boolean := true; detail text := ''; r text; sig text;
BEGIN
  IF (SELECT count(*) FROM public.flow_execution_defaults) <> 1 THEN ok := false; detail := detail || ' [rows <> 1]'; END IF;
  IF EXISTS (SELECT 1 FROM public.flow_execution_defaults WHERE subflow_execution OR durable_wait_execution) THEN ok := false; detail := detail || ' [the migration enabled something]'; END IF;
  BEGIN INSERT INTO public.flow_execution_defaults (singleton) VALUES (false); ok := false; detail := detail || ' [second row / false singleton accepted]'; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN INSERT INTO public.flow_execution_defaults DEFAULT VALUES; ok := false; detail := detail || ' [duplicate singleton accepted]'; EXCEPTION WHEN unique_violation THEN NULL; END;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.flow_execution_defaults'::regclass) THEN ok := false; detail := detail || ' [no RLS]'; END IF;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_table_privilege(r, 'public.flow_execution_defaults', 'INSERT') OR has_table_privilege(r, 'public.flow_execution_defaults', 'UPDATE') OR has_table_privilege(r, 'public.flow_execution_defaults', 'DELETE') OR has_table_privilege(r, 'public.flow_execution_defaults', 'TRUNCATE') THEN ok := false; detail := detail || ' [' || r || ' can write]'; END IF;
  END LOOP;
  IF has_table_privilege('anon', 'public.flow_execution_defaults', 'SELECT') OR has_table_privilege('authenticated', 'public.flow_execution_defaults', 'SELECT') THEN ok := false; detail := detail || ' [end users can read]'; END IF;
  IF NOT has_table_privilege('service_role', 'public.flow_execution_defaults', 'SELECT') THEN ok := false; detail := detail || ' [service_role cannot read]'; END IF;
  FOREACH sig IN ARRAY ARRAY['public.flow_execution_enabled(uuid,text)', 'public.enabled_execution_account_ids(text)', 'public.push_flow_subflow(uuid,uuid,text,uuid,text,jsonb,text)'] LOOP
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP IF has_function_privilege(r, sig, 'EXECUTE') THEN ok := false; detail := detail || ' [' || r || ' may execute ' || sig || ']'; END IF; END LOOP;
    IF NOT has_function_privilege('service_role', sig, 'EXECUTE') THEN ok := false; detail := detail || ' [service_role cannot execute ' || sig || ']'; END IF;
    IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x WHERE p.oid = sig::regprocedure AND x.grantee = 0) THEN ok := false; detail := detail || ' [PUBLIC grant ' || sig || ']'; END IF;
  END LOOP;
  PERFORM public.qa_result('T15', ok, 'defaults table: ONE row, both switches OFF, singleton enforced, RLS on, end users cannot read it, not even service_role can write it; the functions are service_role only (no PUBLIC)' || detail);
END $$;

-- T16 flow_execution_enabled: the account's own row wins, otherwise the global default; a company that registers later inherits the default
DO $$
DECLARE ok boolean := true; detail text := ''; a uuid := public.qa_acct('a1000000-0000-4000-8000-000000000001'::uuid); b uuid := public.qa_acct('b2000000-0000-4000-8000-000000000002'::uuid); fresh uuid; u uuid := gen_random_uuid();
BEGIN
  DELETE FROM public.flow_execution_enablement; UPDATE public.flow_execution_defaults SET subflow_execution = false, durable_wait_execution = false;   -- earlier blocks of this transaction enabled things
  IF public.flow_execution_enabled(a, 'subflow') OR public.flow_execution_enabled(a, 'durable_wait') THEN ok := false; detail := detail || ' [on by default]'; END IF;
  UPDATE public.flow_execution_defaults SET subflow_execution = true;
  IF NOT public.flow_execution_enabled(a, 'subflow') OR NOT public.flow_execution_enabled(b, 'subflow') THEN ok := false; detail := detail || ' [default ON not applied to existing accounts]'; END IF;
  IF public.flow_execution_enabled(a, 'durable_wait') THEN ok := false; detail := detail || ' [kinds are independent]'; END IF;
  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) VALUES (u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'later-co@example.test', '{"full_name":"Later Co"}'::jsonb, now(), now());
  SELECT account_id INTO fresh FROM public.profiles WHERE user_id = u;
  IF fresh IS NULL OR NOT public.flow_execution_enabled(fresh, 'subflow') THEN ok := false; detail := detail || ' [a company created AFTER the switch did not inherit it]'; END IF;
  PERFORM public.qa_enable(b, false, false);                                          -- B opts out individually
  IF public.flow_execution_enabled(b, 'subflow') THEN ok := false; detail := detail || ' [row false did not override the default]'; END IF;
  UPDATE public.flow_execution_defaults SET subflow_execution = false; PERFORM public.qa_enable(a, true, false);
  IF NOT public.flow_execution_enabled(a, 'subflow') OR public.flow_execution_enabled(fresh, 'subflow') THEN ok := false; detail := detail || ' [row true / default false]'; END IF;
  IF public.flow_execution_enabled(NULL, 'subflow') THEN ok := false; detail := detail || ' [NULL account enabled]'; END IF;
  BEGIN PERFORM public.flow_execution_enabled(a, 'f06'); ok := false; detail := detail || ' [unknown kind accepted]'; EXCEPTION WHEN OTHERS THEN IF SQLSTATE <> '22023' THEN ok := false; detail := detail || ' [kind code ' || SQLSTATE || ']'; END IF; END;
  PERFORM public.qa_result('T16', ok, 'enabled = the account row when it exists (it can switch an account off or on), else the global default; a company created AFTER the switch inherits it; kinds are independent; unknown kind -> 22023' || detail);
END $$;

-- T17 the guards and push follow it
DO $$
DECLARE ok boolean := true; detail text := ''; a uuid := public.qa_acct('a1000000-0000-4000-8000-000000000001'::uuid); u uuid := gen_random_uuid(); co uuid; cu uuid; fb uuid; fc uuid; fa uuid; wait_flow uuid; r uuid;
BEGIN
  DELETE FROM public.flow_execution_enablement; UPDATE public.flow_execution_defaults SET subflow_execution = false, durable_wait_execution = false;   -- earlier blocks of this transaction enabled things
  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) VALUES (u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'guard-co@example.test', '{"full_name":"Guard Co"}'::jsonb, now(), now());
  SELECT account_id INTO co FROM public.profiles WHERE user_id = u; cu := u;
  UPDATE public.flow_execution_defaults SET subflow_execution = false, durable_wait_execution = false;
  fb := public.qa_simple(co, cu, 'B'); fc := public.qa_simple(co, cu, 'C');
  BEGIN fa := public.qa_caller(co, cu, 'A', fb, fc); ok := false; detail := detail || ' [activated with default OFF]'; EXCEPTION WHEN OTHERS THEN IF SQLSTATE <> '0A000' THEN ok := false; detail := detail || ' [code ' || SQLSTATE || ']'; END IF; END;
  UPDATE public.flow_execution_defaults SET subflow_execution = true, durable_wait_execution = true;
  fa := public.qa_caller(co, cu, 'A', fb, fc);                                           -- the new company activates with NO row of its own
  IF (SELECT status FROM public.flows WHERE id = fa) <> 'active' THEN ok := false; detail := detail || ' [not active under default ON]'; END IF;
  wait_flow := public.qa_mkflow(co, cu, 'W', jsonb_build_array(jsonb_build_object('k','start','t','start','c',jsonb_build_object('next_node_key','w')), jsonb_build_object('k','w','t','delay','c',jsonb_build_object('amount',13,'unit','minutes','next_node_key','end')), jsonb_build_object('k','end','t','end','c','{}'::jsonb)));
  IF (SELECT status FROM public.flows WHERE id = wait_flow) <> 'active' THEN ok := false; detail := detail || ' [wait flow not active under default ON]'; END IF;
  r := public.qa_run(fa, 'call1');
  IF (public.qa_push(r, 'call1', fb, 'mid')->>'ok') <> 'true' THEN ok := false; detail := detail || ' [push refused under default ON]'; END IF;
  PERFORM public.qa_pop(r, fb);
  UPDATE public.flow_execution_defaults SET subflow_execution = false;                   -- switching it back OFF stops new calls immediately
  IF (public.qa_push(r, 'call1', fb, 'mid')->>'reason') <> 'subflow_execution_not_enabled' THEN ok := false; detail := detail || ' [push allowed after switching OFF]'; END IF;
  UPDATE public.flow_execution_defaults SET subflow_execution = true; PERFORM public.qa_enable(co, false, false);
  IF (public.qa_push(r, 'call1', fb, 'mid')->>'reason') <> 'subflow_execution_not_enabled' THEN ok := false; detail := detail || ' [row false did not stop push]'; END IF;
  PERFORM public.qa_result('T17', ok, 'activation and push follow the global default for a company with no row of its own; OFF again stops new calls at once; a row set to false overrides the default; the 068/069 triggers still raise 0A000 when it is OFF' || detail);
END $$;

-- T18 the list a scheduler asks for
DO $$
DECLARE ok boolean := true; detail text := ''; a uuid := public.qa_acct('a1000000-0000-4000-8000-000000000001'::uuid); b uuid := public.qa_acct('b2000000-0000-4000-8000-000000000002'::uuid); ids uuid[];
BEGIN
  DELETE FROM public.flow_execution_enablement; UPDATE public.flow_execution_defaults SET subflow_execution = false, durable_wait_execution = false;   -- earlier blocks of this transaction enabled things
  ids := public.enabled_execution_account_ids('durable_wait'); IF cardinality(ids) <> 0 THEN ok := false; detail := detail || ' [default OFF returned accounts]'; END IF;
  UPDATE public.flow_execution_defaults SET durable_wait_execution = true; ids := public.enabled_execution_account_ids('durable_wait');
  IF NOT (a = ANY (ids) AND b = ANY (ids)) THEN ok := false; detail := detail || ' [default ON missed accounts]'; END IF;
  PERFORM public.qa_enable(b, false, false); ids := public.enabled_execution_account_ids('durable_wait'); IF b = ANY (ids) OR NOT (a = ANY (ids)) THEN ok := false; detail := detail || ' [opt-out not honoured]'; END IF;
  UPDATE public.flow_execution_defaults SET durable_wait_execution = false; ids := public.enabled_execution_account_ids('durable_wait'); IF cardinality(ids) <> 0 THEN ok := false; detail := detail || ' [row false counted]'; END IF;
  PERFORM public.qa_enable(a, false, true); ids := public.enabled_execution_account_ids('durable_wait'); IF ids IS DISTINCT FROM ARRAY[a] THEN ok := false; detail := detail || ' [only A expected]'; END IF;
  PERFORM public.qa_result('T18', ok, 'enabled_execution_account_ids: none by default; every account under default ON minus the ones switched off; exactly the accounts with their own ON row when the default is OFF' || detail);
END $$;

-- T19 tenancy through RLS: a user sees none of another company's flows, frames or switches, and cannot call the new functions
DO $$
DECLARE ok boolean := true; detail text := ''; a uuid := public.qa_acct('a1000000-0000-4000-8000-000000000001'::uuid); b uuid := public.qa_acct('b2000000-0000-4000-8000-000000000002'::uuid); fb uuid; fc uuid; fa uuid; r uuid; n int; st text; own int;
BEGIN
  PERFORM public.qa_enable(a); fb := public.qa_simple(a, 'a1000000-0000-4000-8000-000000000001'::uuid, 'B'); fc := public.qa_simple(a, 'a1000000-0000-4000-8000-000000000001'::uuid, 'C'); fa := public.qa_caller(a, 'a1000000-0000-4000-8000-000000000001'::uuid, 'A', fb, fc); r := public.qa_run(fa, 'call1'); PERFORM public.qa_push(r, 'call1', fb, 'mid');
  PERFORM set_config('request.jwt.claim.sub', 'b2000000-0000-4000-8000-000000000002', true); PERFORM set_config('request.jwt.claims', '{"sub":"b2000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO n FROM public.flows WHERE account_id = a; IF n <> 0 THEN ok := false; detail := detail || ' [B reads A''s flows]'; END IF;
  SELECT count(*) INTO n FROM public.flow_nodes WHERE flow_id IN (fa, fb, fc); IF n <> 0 THEN ok := false; detail := detail || ' [B reads A''s nodes]'; END IF;
  SELECT count(*) INTO n FROM public.flow_runs WHERE id = r; IF n <> 0 THEN ok := false; detail := detail || ' [B reads A''s run]'; END IF;
  st := NULL; BEGIN PERFORM count(*) FROM public.flow_run_subflow_frames; EXCEPTION WHEN OTHERS THEN st := SQLSTATE; END; IF st IS DISTINCT FROM '42501' THEN ok := false; detail := detail || ' [frames readable: ' || coalesce(st, 'ok') || ']'; END IF;
  st := NULL; BEGIN PERFORM count(*) FROM public.flow_execution_enablement; EXCEPTION WHEN OTHERS THEN st := SQLSTATE; END; IF st IS DISTINCT FROM '42501' THEN ok := false; detail := detail || ' [enablement readable]'; END IF;
  st := NULL; BEGIN PERFORM count(*) FROM public.flow_execution_defaults; EXCEPTION WHEN OTHERS THEN st := SQLSTATE; END; IF st IS DISTINCT FROM '42501' THEN ok := false; detail := detail || ' [defaults readable]'; END IF;
  st := NULL; BEGIN PERFORM public.push_flow_subflow(a, r, 'call1', fb, 'mid'); EXCEPTION WHEN OTHERS THEN st := SQLSTATE; END; IF st IS DISTINCT FROM '42501' THEN ok := false; detail := detail || ' [push callable by an end user]'; END IF;
  st := NULL; BEGIN PERFORM public.enabled_execution_account_ids('subflow'); EXCEPTION WHEN OTHERS THEN st := SQLSTATE; END; IF st IS DISTINCT FROM '42501' THEN ok := false; detail := detail || ' [list callable by an end user]'; END IF;
  st := NULL; BEGIN UPDATE public.flow_execution_defaults SET subflow_execution = true; EXCEPTION WHEN OTHERS THEN st := SQLSTATE; END; IF st IS DISTINCT FROM '42501' THEN ok := false; detail := detail || ' [end user changed the default]'; END IF;
  RESET ROLE;
  PERFORM public.qa_result('T19', ok, 'a user of company B sees none of company A''s flows, nodes, runs or frames, cannot read either enablement table, cannot call push / the account list, and cannot change the global default' || detail);
END $$;

-- T20 a user of a NON-enabled company cannot activate a flow that runs another flow or waits, not even by updating the row directly through the API role
DO $$
DECLARE ok boolean := true; detail text := ''; ub uuid := 'b2000000-0000-4000-8000-000000000002'; b uuid := public.qa_acct('b2000000-0000-4000-8000-000000000002'::uuid); a uuid := public.qa_acct('a1000000-0000-4000-8000-000000000001'::uuid);
  target uuid; caller uuid; waiter uuid; st text; own text;
BEGIN
  DELETE FROM public.flow_execution_enablement; UPDATE public.flow_execution_defaults SET subflow_execution = false, durable_wait_execution = false;
  PERFORM public.qa_enable(a);                                                      -- ONLY company A is enabled
  target := public.qa_simple(b, ub, 'target');
  caller := public.qa_caller(a, 'a1000000-0000-4000-8000-000000000001'::uuid, 'A-caller', public.qa_simple(a, 'a1000000-0000-4000-8000-000000000001'::uuid, 'x'), public.qa_simple(a, 'a1000000-0000-4000-8000-000000000001'::uuid, 'y'));   -- enabled company: works
  IF (SELECT status FROM public.flows WHERE id = caller) <> 'active' THEN ok := false; detail := detail || ' [pilot could not activate]'; END IF;
  -- company B authors drafts freely (authoring is global) ...
  caller := public.qa_caller(b, ub, 'B-caller', target, target, 'draft'); waiter := public.qa_mkflow(b, ub, 'B-waiter', jsonb_build_array(jsonb_build_object('k','start','t','start','c',jsonb_build_object('next_node_key','w')), jsonb_build_object('k','w','t','delay','c',jsonb_build_object('amount',13,'unit','minutes','next_node_key','end')), jsonb_build_object('k','end','t','end','c','{}'::jsonb)), 'draft');
  -- ... but cannot activate them, acting as the API role with its own session
  PERFORM set_config('request.jwt.claim.sub', ub::text, true); PERFORM set_config('request.jwt.claims', '{"sub":"b2000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  st := NULL; BEGIN UPDATE public.flows SET status = 'active' WHERE id = caller; EXCEPTION WHEN OTHERS THEN st := SQLSTATE; END;
  IF st IS DISTINCT FROM '0A000' THEN ok := false; detail := detail || ' [B activated a subflow flow: ' || coalesce(st, 'accepted') || ']'; END IF;
  st := NULL; BEGIN UPDATE public.flows SET status = 'active' WHERE id = waiter; EXCEPTION WHEN OTHERS THEN st := SQLSTATE; END;
  IF st IS DISTINCT FROM '0A000' THEN ok := false; detail := detail || ' [B activated a durable-wait flow: ' || coalesce(st, 'accepted') || ']'; END IF;
  st := NULL; BEGIN INSERT INTO public.flow_execution_enablement (account_id, subflow_execution, durable_wait_execution) VALUES (b, true, true); EXCEPTION WHEN OTHERS THEN st := SQLSTATE; END;
  IF st IS DISTINCT FROM '42501' THEN ok := false; detail := detail || ' [B enabled itself: ' || coalesce(st, 'accepted') || ']'; END IF;
  st := NULL; BEGIN UPDATE public.flow_execution_enablement SET subflow_execution = true; EXCEPTION WHEN OTHERS THEN st := SQLSTATE; END;
  IF st IS DISTINCT FROM '42501' THEN ok := false; detail := detail || ' [B edited the switches]'; END IF;
  RESET ROLE;
  IF (SELECT count(*) FROM public.flow_execution_enablement WHERE account_id = b) <> 0 OR (SELECT status FROM public.flows WHERE id = caller) <> 'draft' THEN ok := false; detail := detail || ' [state changed]'; END IF;
  PERFORM public.qa_result('T20', ok, 'with ONE company enabled, a user of another company can author drafts but cannot activate a flow that runs another flow or waits (0A000), and cannot enable itself or edit the switches (42501)' || detail);
END $$;
