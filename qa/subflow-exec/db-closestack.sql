-- DB checks for the DRAFT migration 072 (frames closed when a run ends). One transaction, rolled back by the runner. IDs T21..T26.
\set ua 'a1000000-0000-4000-8000-000000000001'

-- T21 shape: only the intended trigger, with its WHEN clause, no privileges for end users
DO $$
DECLARE ok boolean := true; detail text := ''; def text;
BEGIN
  SELECT pg_get_triggerdef(t.oid) INTO def FROM pg_trigger t WHERE t.tgname = 'flow_runs_close_stack';
  IF def IS NULL OR def NOT ILIKE '%AFTER UPDATE OF status%' OR def NOT ILIKE '%WHEN%OLD.status%' THEN ok := false; detail := detail || ' [trigger ' || coalesce(def, 'missing') || ']'; END IF;
  IF has_function_privilege('anon', 'public.close_flow_run_stack()', 'EXECUTE') OR has_function_privilege('authenticated', 'public.close_flow_run_stack()', 'EXECUTE') THEN ok := false; detail := detail || ' [end users may execute]'; END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x WHERE p.oid = 'public.close_flow_run_stack()'::regprocedure AND x.grantee = 0) THEN ok := false; detail := detail || ' [PUBLIC grant]'; END IF;
  PERFORM public.qa_result('T21', ok, 'one AFTER UPDATE OF status trigger limited by a WHEN clause (active -> not active); the function is not executable by end users' || detail);
END $$;

-- T22..T25: every way a run can end while it sits inside a called flow
DO $$
DECLARE ok boolean := true; detail text := ''; a uuid := public.qa_acct('a1000000-0000-4000-8000-000000000001'::uuid); fb uuid; fc uuid; fa uuid; r uuid; ev jsonb; i int; st text; why text; ok_all boolean := true; d2 text := '';
BEGIN
  PERFORM public.qa_enable(a, true, true); fb := public.qa_simple(a, 'a1000000-0000-4000-8000-000000000001'::uuid, 'B'); fc := public.qa_simple(a, 'a1000000-0000-4000-8000-000000000001'::uuid, 'C'); fa := public.qa_caller(a, 'a1000000-0000-4000-8000-000000000001'::uuid, 'A', fb, fc);
  FOR i IN 1..5 LOOP
    r := public.qa_run(fa, 'call1'); PERFORM public.qa_push(r, 'call1', fb, 'mid');
    IF (SELECT count(*) FROM public.flow_run_subflow_frames WHERE flow_run_id = r) <> 1 THEN ok_all := false; d2 := d2 || ' [no frame before ' || i || ']'; CONTINUE; END IF;
    -- 1 engine "End the whole execution" inside B, 2 agent takes over, 3 contact blocked, 4 engine failure, 5 stale-run timeout
    IF i = 1 THEN UPDATE public.flow_runs SET status = 'completed', ended_at = now(), end_reason = 'end_node' WHERE id = r;
    ELSIF i = 2 THEN UPDATE public.flow_runs SET status = 'paused_by_agent', ended_at = now(), end_reason = 'agent_replied' WHERE id = r;
    ELSIF i = 3 THEN UPDATE public.flow_runs SET status = 'paused_by_agent', ended_at = now(), end_reason = 'contact_blocked' WHERE id = r;
    ELSIF i = 4 THEN UPDATE public.flow_runs SET status = 'failed', ended_at = now(), end_reason = 'send_text_failed' WHERE id = r;
    ELSE UPDATE public.flow_runs SET status = 'timed_out', ended_at = now(), end_reason = 'stale' WHERE id = r; END IF;
    IF EXISTS (SELECT 1 FROM public.flow_run_subflow_frames WHERE flow_run_id = r) THEN ok_all := false; d2 := d2 || ' [frame left after ' || i || ']'; END IF;
    SELECT payload INTO ev FROM public.flow_run_events WHERE flow_run_id = r AND payload->>'reason' = 'stack_closed_on_end';
    IF ev IS NULL OR jsonb_array_length(ev->'frames') <> 1 OR ev->'frames'->0->>'callee_flow_id' <> fb::text OR ev->'frames'->0->>'return_node_key' <> 'mid' OR ev->>'end_reason' IS NULL THEN ok_all := false; d2 := d2 || ' [evidence missing/wrong after ' || i || ': ' || coalesce(ev::text, 'null') || ']'; END IF;
    -- a later write to the ended run must not archive again
    UPDATE public.flow_runs SET end_reason = end_reason || '' WHERE id = r; UPDATE public.flow_runs SET status = 'failed' WHERE id = r AND status <> 'failed';
    IF (SELECT count(*) FROM public.flow_run_events WHERE flow_run_id = r AND payload->>'reason' = 'stack_closed_on_end') <> 1 THEN ok_all := false; d2 := d2 || ' [archived twice at ' || i || ']'; END IF;
  END LOOP;
  PERFORM public.qa_result('T22', ok_all, 'a run that ends INSIDE a called flow (engine end, agent takeover, blocked contact, failure, timeout) loses its frame and the frame is archived once in the run''s own events (depth, caller, callee, return node, policy, end status and reason)' || d2);
END $$;

-- T23 active runs keep their frames; unrelated runs and runs without frames write nothing; nested depth 3 archives all frames in order
DO $$
DECLARE ok boolean := true; detail text := ''; a uuid := public.qa_acct('a1000000-0000-4000-8000-000000000001'::uuid); u uuid := 'a1000000-0000-4000-8000-000000000001'; fb uuid; fc uuid; fa uuid; r uuid; plain uuid; rp uuid; n1 uuid; n2 uuid; n3 uuid; root uuid; rr uuid; ev jsonb;
BEGIN
  PERFORM public.qa_enable(a, true, true); fb := public.qa_simple(a, u, 'B2'); fc := public.qa_simple(a, u, 'C2'); fa := public.qa_caller(a, u, 'A2', fb, fc); r := public.qa_run(fa, 'call1'); PERFORM public.qa_push(r, 'call1', fb, 'mid');
  UPDATE public.flow_runs SET current_node_key = 'start', last_advanced_at = now() WHERE id = r; UPDATE public.flow_runs SET vars = vars || '{"x":1}' WHERE id = r;
  IF (SELECT count(*) FROM public.flow_run_subflow_frames WHERE flow_run_id = r) <> 1 THEN ok := false; detail := detail || ' [active run lost its frame]'; END IF;
  plain := public.qa_simple(a, u, 'plain'); rp := public.qa_run(plain, 'start'); UPDATE public.flow_runs SET status = 'completed', ended_at = now(), end_reason = 'end_node' WHERE id = rp;
  IF EXISTS (SELECT 1 FROM public.flow_run_events WHERE flow_run_id = rp AND payload->>'reason' = 'stack_closed_on_end') THEN ok := false; detail := detail || ' [event written for a run without frames]'; END IF;
  -- a run that returned normally (frame already popped) ends without any archive event
  PERFORM public.qa_pop(r, fb); UPDATE public.flow_runs SET status = 'completed', ended_at = now(), end_reason = 'end_node' WHERE id = r;
  IF EXISTS (SELECT 1 FROM public.flow_run_events WHERE flow_run_id = r AND payload->>'reason' = 'stack_closed_on_end') THEN ok := false; detail := detail || ' [event for a run that had returned]'; END IF;
  -- three nested frames
  n3 := public.qa_simple(a, u, 'M3'); n2 := public.qa_mkflow(a, u, 'M2', jsonb_build_array(jsonb_build_object('k','start','t','start','c',jsonb_build_object('next_node_key','call')), jsonb_build_object('k','call','t','execute_flow','c',jsonb_build_object('target_flow_id',n3,'next_node_key','ret')), jsonb_build_object('k','ret','t','end','c','{}'::jsonb)));
  n1 := public.qa_mkflow(a, u, 'M1', jsonb_build_array(jsonb_build_object('k','start','t','start','c',jsonb_build_object('next_node_key','call')), jsonb_build_object('k','call','t','execute_flow','c',jsonb_build_object('target_flow_id',n2,'next_node_key','ret')), jsonb_build_object('k','ret','t','end','c','{}'::jsonb)));
  root := public.qa_mkflow(a, u, 'MR', jsonb_build_array(jsonb_build_object('k','start','t','start','c',jsonb_build_object('next_node_key','call')), jsonb_build_object('k','call','t','execute_flow','c',jsonb_build_object('target_flow_id',n1,'next_node_key','ret')), jsonb_build_object('k','ret','t','end','c','{}'::jsonb)));
  rr := public.qa_run(root, 'call'); PERFORM public.qa_push(rr, 'call', n1, 'ret'); PERFORM public.qa_push(rr, 'call', n2, 'ret'); PERFORM public.qa_push(rr, 'call', n3, 'ret');
  UPDATE public.flow_runs SET status = 'failed', ended_at = now(), end_reason = 'x' WHERE id = rr; SELECT payload INTO ev FROM public.flow_run_events WHERE flow_run_id = rr AND payload->>'reason' = 'stack_closed_on_end';
  IF jsonb_array_length(ev->'frames') <> 3 OR (ev->'frames'->0->>'depth') <> '1' OR (ev->'frames'->2->>'depth') <> '3' OR EXISTS (SELECT 1 FROM public.flow_run_subflow_frames WHERE flow_run_id = rr) THEN ok := false; detail := detail || ' [3 frames: ' || coalesce(ev::text, 'null') || ']'; END IF;
  PERFORM public.qa_result('T23', ok, 'a run that is still active keeps its frame through other updates; runs without frames or that already returned write nothing; three nested frames are archived in depth order' || detail);
END $$;

-- T24 existing frames of ended runs (the pilot evidence) are never touched by the migration itself: simulate one created BEFORE the trigger existed
DO $$
DECLARE ok boolean := true; detail text := ''; a uuid := public.qa_acct('a1000000-0000-4000-8000-000000000001'::uuid); u uuid := 'a1000000-0000-4000-8000-000000000001'; fb uuid; fc uuid; fa uuid; r uuid; n int;
BEGIN
  PERFORM public.qa_enable(a, true, true); fb := public.qa_simple(a, u, 'B3'); fc := public.qa_simple(a, u, 'C3'); fa := public.qa_caller(a, u, 'A3', fb, fc); r := public.qa_run(fa, 'call1'); PERFORM public.qa_push(r, 'call1', fb, 'mid');
  ALTER TABLE public.flow_runs DISABLE TRIGGER flow_runs_close_stack;
  UPDATE public.flow_runs SET status = 'completed', ended_at = now(), end_reason = 'end_node' WHERE id = r;       -- ends the way it did in the pilot: frame stays
  ALTER TABLE public.flow_runs ENABLE TRIGGER flow_runs_close_stack;
  SELECT count(*) INTO n FROM public.flow_run_subflow_frames WHERE flow_run_id = r; IF n <> 1 THEN ok := false; detail := detail || ' [precondition]'; END IF;
  UPDATE public.flow_runs SET end_reason = 'end_node' WHERE id = r; UPDATE public.flow_runs SET ended_at = ended_at WHERE id = r;
  SELECT count(*) INTO n FROM public.flow_run_subflow_frames WHERE flow_run_id = r; IF n <> 1 THEN ok := false; detail := detail || ' [historic frame deleted by an unrelated update]'; END IF;
  PERFORM public.qa_result('T24', ok, 'frames that already sit on ended runs (the pilot evidence) are not removed: the trigger fires only on the active -> ended transition, there is no backfill' || detail);
END $$;
