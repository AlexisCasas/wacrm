-- E4.2B1.1 QA, functional + security block: T02-T08, T10, T11, T15-T18.
-- T12-T14 (concurrency) live in e42b11-t12-t14.sh. Runs inside a
-- transaction after helpers + fixtures; the runner rolls back.
CREATE TEMP TABLE qa_ctx AS
  SELECT account_id AS acct, active_version_id AS ver FROM public.flows WHERE id='50000000-0000-4000-8000-000000000001';
GRANT SELECT ON qa_ctx TO PUBLIC;

-- T02: every persisted field of a valid run.
DO $$
DECLARE r record; run public.flow_runs%ROWTYPE; c qa_ctx%ROWTYPE; bad text[] := '{}';
BEGIN
  SELECT * INTO c FROM qa_ctx;
  SELECT * INTO r FROM public.create_versioned_flow_run(c.acct,'50000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000003','40000000-0000-4000-8000-000000000003','{"k":[1,2],"n":null}');
  SELECT * INTO run FROM public.flow_runs WHERE id = r.flow_run_id;
  IF r.created IS NOT TRUE THEN bad := bad || 'created'; END IF;
  IF r.reason IS NOT NULL THEN bad := bad || 'reason'; END IF;
  IF run.flow_id <> '50000000-0000-4000-8000-000000000001' THEN bad := bad || 'flow_id'; END IF;
  IF run.account_id <> c.acct THEN bad := bad || 'account_id'; END IF;
  IF run.user_id <> '10000000-0000-4000-8000-000000000001' THEN bad := bad || 'user_id(flow owner)'; END IF;
  IF run.contact_id <> '30000000-0000-4000-8000-000000000003' THEN bad := bad || 'contact_id'; END IF;
  IF run.conversation_id <> '40000000-0000-4000-8000-000000000003' THEN bad := bad || 'conversation_id'; END IF;
  IF run.status <> 'active' THEN bad := bad || 'status'; END IF;
  IF run.current_node_key <> 'start' THEN bad := bad || 'current_node_key'; END IF;
  IF run.vars <> '{"k":[1,2],"n":null}'::jsonb THEN bad := bad || 'vars'; END IF;
  IF run.execution_mode <> 'versioned' THEN bad := bad || 'execution_mode'; END IF;
  IF run.root_flow_version_id <> c.ver OR run.current_flow_version_id <> c.ver THEN bad := bad || 'version ids'; END IF;
  IF run.versioned_node_key <> 'start' THEN bad := bad || 'versioned_node_key'; END IF;
  IF run.versioned_nodes_executed <> 0 OR run.versioned_messages_executed <> 0 OR run.versioned_depth <> 0 OR run.versioned_lease <> 0 THEN bad := bad || 'counters'; END IF;
  IF run.versioned_checkpoint <> jsonb_build_object('cursor',jsonb_build_object('flow_version_id',c.ver,'node_key','start'),'step',0) THEN bad := bad || 'checkpoint'; END IF;
  IF run.reprompt_count <> 0 OR run.last_prompt_message_id IS NOT NULL OR run.ended_at IS NOT NULL OR run.end_reason IS NOT NULL THEN bad := bad || 'legacy/end fields'; END IF;
  IF run.started_at IS NULL OR run.last_advanced_at IS NULL THEN bad := bad || 'timestamps'; END IF;
  PERFORM public.qa_result('T02', cardinality(bad) = 0,
    CASE WHEN cardinality(bad) = 0 THEN '19 persisted fields verified on run ' || run.id ELSE 'wrong: ' || array_to_string(bad, ',') END);
END $$;

-- T03-T05: flow state must be active + published.
DO $$
DECLARE a uuid; BEGIN SELECT acct INTO a FROM qa_ctx;
  PERFORM public.qa_expect_error('T03', public.qa_call(a,'50000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000004',NULL),
    'P0002','active published flow not found');
  PERFORM public.qa_expect_error('T04', public.qa_call(a,'50000000-0000-4000-8000-000000000003','30000000-0000-4000-8000-000000000004',NULL),
    'P0002','active published flow not found');
  PERFORM public.qa_expect_error('T05', public.qa_call(a,'50000000-0000-4000-8000-000000000004','30000000-0000-4000-8000-000000000004',NULL),
    'P0002','active published flow not found');
END $$;

-- T06-T08: cross-account isolation.
DO $$
DECLARE a uuid; b uuid; BEGIN SELECT acct INTO a FROM qa_ctx;
  SELECT account_id INTO b FROM public.flows WHERE id='60000000-0000-4000-8000-000000000001';
  PERFORM public.qa_expect_error('T06', public.qa_call(a,'60000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000004',NULL),
    'P0002','active published flow not found');
  PERFORM public.qa_expect_error('T07', public.qa_call(a,'50000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000001',NULL),
    'P0002','contact not found in account');
  -- conversation row of account B whose contact_id is A's contact: only the account predicate can reject it.
  PERFORM public.qa_expect_error('T08', public.qa_call(a,'50000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000008','80000000-0000-4000-8000-000000000002'),
    'P0002','conversation not found for contact in account');
END $$;

-- T10: a valid contact + conversation pair is accepted (and so is no conversation).
DO $$
DECLARE a uuid; r record; r2 record; BEGIN SELECT acct INTO a FROM qa_ctx;
  SELECT * INTO r FROM public.create_versioned_flow_run(a,'50000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000004','40000000-0000-4000-8000-000000000004');
  SELECT * INTO r2 FROM public.create_versioned_flow_run(a,'50000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000005',NULL);
  PERFORM public.qa_result('T10', r.created AND r2.created
    AND (SELECT conversation_id FROM public.flow_runs WHERE id=r.flow_run_id) = '40000000-0000-4000-8000-000000000004'
    AND (SELECT conversation_id FROM public.flow_runs WHERE id=r2.flow_run_id) IS NULL,
    'valid pair accepted (run ' || r.flow_run_id || '); NULL conversation accepted (run ' || r2.flow_run_id || ')');
END $$;

-- T11: invalid snapshot / request.
DO $$
DECLARE a uuid; BEGIN SELECT acct INTO a FROM qa_ctx;
  PERFORM public.qa_expect_error('T11', public.qa_call(a,'50000000-0000-4000-8000-000000000005','30000000-0000-4000-8000-000000000006',NULL),
    '22023','published definition has no entry cursor');
  PERFORM public.qa_expect_error('T11b-null-entry', public.qa_call(a,'50000000-0000-4000-8000-000000000006','30000000-0000-4000-8000-000000000006',NULL),
    '22023','published definition has no entry cursor');
  PERFORM public.qa_expect_error('T11c-vars-not-object', public.qa_call(a,'50000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000006',NULL,'[1]'),
    '22023','invalid versioned run request');
  PERFORM public.qa_expect_error('T11d-null-contact',
    format('SELECT * FROM public.create_versioned_flow_run(%L,%L,NULL,NULL,''{}''::jsonb)', a, '50000000-0000-4000-8000-000000000001'),
    '22023','invalid versioned run request');
  IF EXISTS (SELECT 1 FROM public.flow_runs WHERE contact_id='30000000-0000-4000-8000-000000000006') THEN
    PERFORM public.qa_result('T11', false, 'run left behind for invalid snapshot'); END IF;
END $$;

-- T15: errors leave nothing behind, and a created run rolls back with its transaction.
DO $$
DECLARE a uuid; before_n int; after_n int; ec int; r record; leaked int;
BEGIN
  SELECT acct INTO a FROM qa_ctx;
  SELECT count(*) INTO before_n FROM public.flow_runs;
  SELECT execution_count INTO ec FROM public.flows WHERE id='50000000-0000-4000-8000-000000000001';
  -- (a) rejected calls insert nothing
  BEGIN PERFORM * FROM public.create_versioned_flow_run(a,'50000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000006','80000000-0000-4000-8000-000000000001');
  EXCEPTION WHEN no_data_found THEN NULL; END;
  SELECT count(*) INTO after_n FROM public.flow_runs;
  IF after_n <> before_n THEN PERFORM public.qa_result('T15', false, 'rejected call changed flow_runs ' || before_n || '->' || after_n); END IF;
  -- (b) success followed by a later failure in the same sub-transaction vanishes completely
  BEGIN
    SELECT * INTO r FROM public.create_versioned_flow_run(a,'50000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000007',NULL);
    IF NOT r.created THEN PERFORM public.qa_result('T15', false, 'setup run not created'); END IF;
    RAISE EXCEPTION 'qa forced failure' USING ERRCODE = 'P9999';
  EXCEPTION WHEN SQLSTATE 'P9999' THEN NULL; END;
  SELECT count(*) INTO leaked FROM public.flow_runs WHERE contact_id='30000000-0000-4000-8000-000000000007' OR id = r.flow_run_id;
  SELECT count(*) INTO after_n FROM public.flow_runs;
  PERFORM public.qa_result('T15', leaked = 0 AND after_n = before_n
    AND (SELECT execution_count FROM public.flows WHERE id='50000000-0000-4000-8000-000000000001') = ec,
    'flow_runs count unchanged (' || before_n || '), no leaked run after forced failure, execution_count unchanged');
END $$;

-- T16: effective privileges, exercised with real SET ROLE (not just ACL reads).
CREATE ROLE qa_public_probe NOLOGIN;
GRANT USAGE ON SCHEMA public TO qa_public_probe;
DO $$
DECLARE a uuid; r record; role_name text; st text; msg text; out text[] := '{}'; ok boolean := true;
  call_sql text;
BEGIN
  SELECT acct INTO a FROM qa_ctx;
  -- (a) ACL: no PUBLIC grant, anon/authenticated absent, service_role present
  IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) x WHERE p.proname='create_versioned_flow_run' AND x.grantee = 0) THEN
    ok := false; out := out || 'ACL has PUBLIC'; END IF;
  FOREACH role_name IN ARRAY ARRAY['qa_public_probe','anon','authenticated'] LOOP
    IF has_function_privilege(role_name, 'public.create_versioned_flow_run(uuid,uuid,uuid,uuid,jsonb)', 'EXECUTE') THEN
      ok := false; out := out || (role_name || ' has EXECUTE per ACL'); END IF;
  END LOOP;
  IF NOT has_function_privilege('service_role', 'public.create_versioned_flow_run(uuid,uuid,uuid,uuid,jsonb)', 'EXECUTE') THEN
    ok := false; out := out || 'service_role lacks EXECUTE'; END IF;
  -- (b) real calls under each role
  FOREACH role_name IN ARRAY ARRAY['qa_public_probe','anon','authenticated'] LOOP
    st := NULL; msg := NULL;
    EXECUTE format('SET LOCAL ROLE %I', role_name);
    BEGIN
      PERFORM * FROM public.create_versioned_flow_run(a,'50000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000008',NULL);
    EXCEPTION WHEN OTHERS THEN st := SQLSTATE; msg := SQLERRM; END;
    RESET ROLE;
    IF st IS DISTINCT FROM '42501' THEN ok := false; out := out || (role_name || ' call -> ' || coalesce(st,'SUCCEEDED'));
    ELSE out := out || (role_name || ' denied 42501'); END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM public.flow_runs WHERE contact_id='30000000-0000-4000-8000-000000000008') THEN
    ok := false; out := out || 'denied roles created a run'; END IF;
  SET LOCAL ROLE service_role;
  BEGIN
    SELECT * INTO r FROM public.create_versioned_flow_run(a,'50000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000008',NULL);
    IF r.created IS NOT TRUE THEN ok := false; out := out || 'service_role call did not create'; ELSE out := out || ('service_role created ' || r.flow_run_id::text); END IF;
  EXCEPTION WHEN OTHERS THEN ok := false; out := out || ('service_role error ' || SQLSTATE || ' ' || SQLERRM); END;
  RESET ROLE;
  PERFORM public.qa_result('T16', ok, array_to_string(out, '; '));
END $$;

-- T17: legacy runs keep their defaults and cannot masquerade as versioned.
DO $$
DECLARE a uuid; run public.flow_runs%ROWTYPE; rid uuid; r record; st text;
BEGIN
  SELECT acct INTO a FROM qa_ctx;
  INSERT INTO public.flow_runs (flow_id, account_id, user_id, contact_id, status, current_node_key)
  VALUES ('50000000-0000-4000-8000-000000000002', a, '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000006', 'active', 'start')
  RETURNING id INTO rid;
  SELECT * INTO run FROM public.flow_runs WHERE id = rid;
  BEGIN
    UPDATE public.flow_runs SET root_flow_version_id = (SELECT ver FROM qa_ctx) WHERE id = rid;
  EXCEPTION WHEN check_violation THEN st := SQLSTATE; END;
  SELECT * INTO r FROM public.create_versioned_flow_run(a,'50000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000006',NULL);
  PERFORM public.qa_result('T17',
    run.execution_mode = 'legacy' AND run.root_flow_version_id IS NULL AND run.current_flow_version_id IS NULL
    AND run.versioned_node_key IS NULL AND run.versioned_nodes_executed = 0 AND run.versioned_messages_executed = 0
    AND run.versioned_depth = 0 AND run.versioned_checkpoint IS NULL AND run.versioned_lease = 0
    AND st = '23514' AND r.created = false AND r.reason = 'active_run_exists',
    'legacy defaults intact; legacy row with a version id rejected (23514); versioned create against a contact with an active legacy run -> active_run_exists');
END $$;

-- T18: creation only inserts an idle run: no frames, events, messages or node execution.
DO $$
DECLARE a uuid; r record; run public.flow_runs%ROWTYPE; m0 int; ec0 int; le0 timestamptz;
BEGIN
  SELECT acct INTO a FROM qa_ctx;
  SELECT count(*) INTO m0 FROM public.messages;
  SELECT execution_count, last_executed_at INTO ec0, le0 FROM public.flows WHERE id='50000000-0000-4000-8000-000000000001';
  SELECT * INTO r FROM public.create_versioned_flow_run(a,'50000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000007',NULL);
  SELECT * INTO run FROM public.flow_runs WHERE id = r.flow_run_id;
  PERFORM public.qa_result('T18', r.created
    AND NOT EXISTS (SELECT 1 FROM public.flow_run_call_frames WHERE flow_run_id = run.id)
    AND NOT EXISTS (SELECT 1 FROM public.flow_run_events WHERE flow_run_id = run.id)
    AND (SELECT count(*) FROM public.messages) = m0
    AND run.versioned_nodes_executed = 0 AND run.versioned_messages_executed = 0 AND run.versioned_depth = 0
    AND run.versioned_checkpoint->>'step' = '0' AND run.last_prompt_message_id IS NULL
    AND (SELECT execution_count FROM public.flows WHERE id='50000000-0000-4000-8000-000000000001') = ec0
    AND (SELECT last_executed_at FROM public.flows WHERE id='50000000-0000-4000-8000-000000000001') IS NOT DISTINCT FROM le0,
    'no call frames, no events, no messages, counters 0, flow execution stats untouched');
END $$;
