-- E4.2B1.3 QA: execution-budget counters in commit_versioned_run_transition
-- (migration 056). Same rolled-back transaction as the other suites. IDs L25..L28.

DO $$
DECLARE a uuid; v uuid; rid uuid; r record; c record; run public.flow_runs%ROWTYPE; cp jsonb; before_row jsonb; ok boolean := true; detail text := ''; st text; n int;
BEGIN
  SELECT account_id, active_version_id INTO a, v FROM public.flows WHERE id='50000000-0000-4000-8000-000000000001';
  cp := jsonb_build_object('cursor', jsonb_build_object('flow_version_id', v, 'node_key', 'end'), 'step', 1);

  -- L25: counters, cursor, checkpoint and revision move in the same atomic commit.
  rid := public.qa_new_run(401);
  SELECT * INTO r FROM public.acquire_versioned_run_lease(a, rid, 'w1', 60);
  SELECT * INTO c FROM public.commit_versioned_run_transition(a, rid, 'w1', r.fencing_token, 0, cp, 'active', NULL, 1, 2);
  SELECT * INTO run FROM public.flow_runs WHERE id = rid;
  PERFORM public.qa_result('L25', c.committed AND c.revision = 1 AND c.nodes_executed = 1 AND c.messages_executed = 2
    AND run.versioned_nodes_executed = 1 AND run.versioned_messages_executed = 2 AND run.versioned_revision = 1
    AND run.versioned_checkpoint = cp AND run.versioned_node_key = 'end',
    'deltas (1 node, 2 messages) added with the cursor/checkpoint in one commit; result echoes the new totals');
  -- a refused commit (stale revision) must not move the counters
  before_row := to_jsonb(run);
  SELECT * INTO c FROM public.commit_versioned_run_transition(a, rid, 'w1', r.fencing_token, 0, cp, 'active', NULL, 1, 1);
  IF c.committed OR c.reason <> 'revision_conflict' OR c.nodes_executed <> 1 OR to_jsonb((SELECT x FROM public.flow_runs x WHERE id = rid)) <> before_row THEN
    ok := false; detail := detail || ' [counters moved on revision_conflict]'; END IF;

  -- L26: the budget is enforced inside PostgreSQL; a refusal writes nothing.
  rid := public.qa_new_run(402);
  SELECT * INTO r FROM public.acquire_versioned_run_lease(a, rid, 'w1', 60);
  UPDATE public.flow_runs SET versioned_nodes_executed = 499, versioned_messages_executed = 99 WHERE id = rid;
  before_row := to_jsonb((SELECT x FROM public.flow_runs x WHERE id = rid));
  SELECT * INTO c FROM public.commit_versioned_run_transition(a, rid, 'w1', r.fencing_token, 0, cp, 'active', NULL, 2, 0);
  IF c.committed OR c.reason <> 'budget_exceeded' OR c.nodes_executed <> 499 THEN ok := false; detail := detail || ' [nodes 499+2 accepted]'; END IF;
  SELECT * INTO c FROM public.commit_versioned_run_transition(a, rid, 'w1', r.fencing_token, 0, cp, 'active', NULL, 0, 2);
  IF c.committed OR c.reason <> 'budget_exceeded' OR c.messages_executed <> 99 THEN ok := false; detail := detail || ' [messages 99+2 accepted]'; END IF;
  IF to_jsonb((SELECT x FROM public.flow_runs x WHERE id = rid)) <> before_row THEN ok := false; detail := detail || ' [refused commit wrote]'; END IF;
  SELECT * INTO c FROM public.commit_versioned_run_transition(a, rid, 'w1', r.fencing_token, 0, cp, 'active', NULL, 1, 1);
  IF NOT c.committed OR c.nodes_executed <> 500 OR c.messages_executed <> 100 THEN ok := false; detail := detail || ' [exact fit refused]'; END IF;
  PERFORM public.qa_result('L26', ok, 'nodes 499+2 and messages 99+2 -> budget_exceeded with the row byte-identical; the exact fit (500/100) commits' || detail);

  -- L27: invalid deltas are request errors.
  ok := true; detail := '';
  rid := public.qa_new_run(403);
  SELECT * INTO r FROM public.acquire_versioned_run_lease(a, rid, 'w1', 60);
  FOR n IN SELECT unnest(ARRAY[-1, 501]) LOOP
    st := NULL; BEGIN PERFORM * FROM public.commit_versioned_run_transition(a, rid, 'w1', r.fencing_token, 0, cp, 'active', NULL, n, 0); EXCEPTION WHEN OTHERS THEN st := SQLSTATE; END;
    IF st IS DISTINCT FROM '22023' THEN ok := false; detail := detail || ' [nodes_delta ' || n || ' -> ' || coalesce(st, 'accepted') || ']'; END IF;
  END LOOP;
  FOR n IN SELECT unnest(ARRAY[-1, 101]) LOOP
    st := NULL; BEGIN PERFORM * FROM public.commit_versioned_run_transition(a, rid, 'w1', r.fencing_token, 0, cp, 'active', NULL, 0, n); EXCEPTION WHEN OTHERS THEN st := SQLSTATE; END;
    IF st IS DISTINCT FROM '22023' THEN ok := false; detail := detail || ' [messages_delta ' || n || ' -> ' || coalesce(st, 'accepted') || ']'; END IF;
  END LOOP;
  PERFORM public.qa_result('L27', ok AND (SELECT versioned_revision = 0 AND versioned_nodes_executed = 0 FROM public.flow_runs WHERE id = rid),
    'nodes_delta -1/501 and messages_delta -1/101 -> 22023, run untouched' || detail);

  -- L28: one commit function (the 055 8-arg version is gone) and 8-arg callers still work via DEFAULTs.
  rid := public.qa_new_run(404);
  SELECT * INTO r FROM public.acquire_versioned_run_lease(a, rid, 'w1', 60);
  SELECT * INTO c FROM public.commit_versioned_run_transition(a, rid, 'w1', r.fencing_token, 0, cp);
  PERFORM public.qa_result('L28', to_regprocedure('public.commit_versioned_run_transition(uuid,uuid,text,integer,bigint,jsonb,text,text)') IS NULL
    AND (SELECT count(*) FROM pg_proc WHERE proname = 'commit_versioned_run_transition') = 1
    AND c.committed AND c.nodes_executed = 0 AND c.messages_executed = 0,
    'single 10-argument overload; a call without deltas commits with counters unchanged');
END $$;
