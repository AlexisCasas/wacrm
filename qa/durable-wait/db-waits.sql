-- DB checks for migration 069 (durable waits). One transaction, rolled back by the runner. IDs W01..W11.
-- Uses qa/flows-safe-save/fixtures.sql: account A flow a1..f1 (3 nodes), account B flow b2..f1.
-- W01 shape, privileges, index
DO $$
DECLARE ok boolean := true; detail text := ''; sig text; role_name text;
BEGIN
  IF (SELECT count(*) FROM information_schema.columns WHERE table_name = 'flow_runs' AND column_name IN ('wait_until','wait_node_key','wait_claim_token','wait_claimed_at')) <> 4 THEN ok := false; detail := detail || ' [columns]'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_flow_runs_waiting_due') THEN ok := false; detail := detail || ' [index]'; END IF;
  FOREACH sig IN ARRAY ARRAY['public.schedule_flow_wait(uuid,uuid,text,timestamptz)', 'public.claim_due_flow_waits(uuid[],integer,integer)', 'public.consume_flow_wait(uuid,uuid,uuid,text)'] LOOP
    FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF has_function_privilege(role_name, sig, 'EXECUTE') THEN ok := false; detail := detail || ' [' || role_name || ' may execute ' || sig || ']'; END IF;
    END LOOP;
    IF NOT has_function_privilege('service_role', sig, 'EXECUTE') THEN ok := false; detail := detail || ' [service_role cannot execute ' || sig || ']'; END IF;
    IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x WHERE p.oid = sig::regprocedure AND x.grantee = 0) THEN ok := false; detail := detail || ' [PUBLIC grant ' || sig || ']'; END IF;
  END LOOP;
  PERFORM public.qa_result('W01', ok, '4 nullable wait columns, partial index, the three functions are service_role only (no PUBLIC / anon / authenticated)' || detail);
END $$;

-- W02 scheduling
DO $$
DECLARE r uuid := public.qa_wait_run(1); other uuid := public.qa_wait_run(2); a uuid; b uuid; ok boolean := true; detail text := ''; w jsonb; st text; paused uuid := public.qa_wait_run(3);
BEGIN
  SELECT account_id INTO a FROM public.flows WHERE id = 'a1000000-0000-4000-8000-0000000000f1'; SELECT account_id INTO b FROM public.flows WHERE id = 'b2000000-0000-4000-8000-0000000000f1';
  IF NOT public.schedule_flow_wait(a, r, 'pause', clock_timestamp() + interval '13 minutes') THEN ok := false; detail := detail || ' [schedule refused]'; END IF;
  w := public.qa_wait_row(r);
  IF w->>'wait_node_key' <> 'pause' OR w->>'current_node_key' <> 'pause' OR w->>'status' <> 'active' OR w->>'wait_claim_token' IS NOT NULL THEN ok := false; detail := detail || ' [row ' || w::text || ']'; END IF;
  IF public.schedule_flow_wait(a, r, 'pause', clock_timestamp() + interval '1 hour') THEN ok := false; detail := detail || ' [second schedule accepted]'; END IF;
  IF public.schedule_flow_wait(b, other, 'pause', clock_timestamp() + interval '1 hour') THEN ok := false; detail := detail || ' [wrong account accepted]'; END IF;
  UPDATE public.flow_runs SET status = 'paused_by_agent' WHERE id = paused;
  IF public.schedule_flow_wait(a, paused, 'pause', clock_timestamp() + interval '1 hour') THEN ok := false; detail := detail || ' [non-active run accepted]'; END IF;
  FOR st IN SELECT unnest(ARRAY['22023']) LOOP
    BEGIN PERFORM public.schedule_flow_wait(a, other, 'pause', clock_timestamp() + interval '32 days'); ok := false; detail := detail || ' [32 days accepted]'; EXCEPTION WHEN OTHERS THEN IF SQLSTATE <> st THEN ok := false; detail := detail || ' [32 days: ' || SQLSTATE || ']'; END IF; END;
    BEGIN PERFORM public.schedule_flow_wait(NULL, other, 'pause', clock_timestamp()); ok := false; EXCEPTION WHEN OTHERS THEN IF SQLSTATE <> st THEN ok := false; detail := detail || ' [null account]'; END IF; END;
    BEGIN PERFORM public.schedule_flow_wait(a, other, ' ', clock_timestamp()); ok := false; EXCEPTION WHEN OTHERS THEN IF SQLSTATE <> st THEN ok := false; detail := detail || ' [blank node]'; END IF; END;
  END LOOP;
  PERFORM public.qa_result('W02', ok, 'an active run parks at its delay node (status stays active, current node = the wait node); a second wait, another account, a non-active run -> false; NULL / blank / more than 31 days -> 22023' || detail);
END $$;

-- W03 the 13-minute case and claiming
DO $$
DECLARE a uuid; b uuid; r uuid := public.qa_wait_run(10); rb uuid := public.qa_wait_run(11, 'b2000000-0000-4000-8000-0000000000f1'); ok boolean := true; detail text := ''; n int; c record; tok uuid;
BEGIN
  SELECT account_id INTO a FROM public.flows WHERE id = 'a1000000-0000-4000-8000-0000000000f1'; SELECT account_id INTO b FROM public.flows WHERE id = 'b2000000-0000-4000-8000-0000000000f1';
  PERFORM public.schedule_flow_wait(a, r, 'pause', clock_timestamp() + interval '13 minutes');
  PERFORM public.schedule_flow_wait(b, rb, 'pause', clock_timestamp() + interval '13 minutes');
  -- 12 minutes 59 seconds in: not due for anybody
  UPDATE public.flow_runs SET wait_until = clock_timestamp() + interval '1 second' WHERE id IN (r, rb);
  SELECT count(*) INTO n FROM public.claim_due_flow_waits(ARRAY[a, b]); IF n <> 0 THEN ok := false; detail := detail || ' [claimed before the time: ' || n || ']'; END IF;
  -- 13 minutes: due. Only the accounts passed in are served
  UPDATE public.flow_runs SET wait_until = clock_timestamp() - interval '1 second' WHERE id IN (r, rb);
  SELECT count(*) INTO n FROM public.claim_due_flow_waits(NULL); IF n <> 0 THEN ok := false; detail := detail || ' [NULL account list claimed]'; END IF;
  SELECT count(*) INTO n FROM public.claim_due_flow_waits('{}'::uuid[]); IF n <> 0 THEN ok := false; detail := detail || ' [empty account list claimed]'; END IF;
  SELECT * INTO c FROM public.claim_due_flow_waits(ARRAY[a]);
  IF c.run_id IS DISTINCT FROM r OR c.account_id <> a OR c.node_key <> 'pause' OR c.claim_token IS NULL THEN ok := false; detail := detail || ' [claim of account A: ' || coalesce(c.run_id::text, 'none') || ']'; END IF;
  IF (public.qa_wait_row(rb)->>'wait_claim_token') IS NOT NULL THEN ok := false; detail := detail || ' [account B run claimed by an A-only worker]'; END IF;
  SELECT count(*) INTO n FROM public.claim_due_flow_waits(ARRAY[a, b]); IF n <> 1 THEN ok := false; detail := detail || ' [second claim: expected only B (' || n || ')]'; END IF;
  SELECT count(*) INTO n FROM public.claim_due_flow_waits(ARRAY[a, b]); IF n <> 0 THEN ok := false; detail := detail || ' [leased runs claimed again: ' || n || ']'; END IF;
  PERFORM public.qa_result('W03', ok, 'a 13-minute wait is not claimable one second early and is claimable once due; only the accounts given are served (NULL / empty list claim nothing); a leased run is not handed out twice' || detail);
END $$;

-- W04 consuming the wait: exactly the token holder, exactly once
DO $$
DECLARE a uuid; b uuid; r uuid := public.qa_wait_run(20); ok boolean := true; detail text := ''; c record; w jsonb;
BEGIN
  SELECT account_id INTO a FROM public.flows WHERE id = 'a1000000-0000-4000-8000-0000000000f1'; SELECT account_id INTO b FROM public.flows WHERE id = 'b2000000-0000-4000-8000-0000000000f1';
  PERFORM public.schedule_flow_wait(a, r, 'pause', clock_timestamp() + interval '1 hour');
  IF public.consume_flow_wait(a, r, gen_random_uuid(), 'after') THEN ok := false; detail := detail || ' [consumed with no claim before the time]'; END IF;
  UPDATE public.flow_runs SET wait_until = clock_timestamp() - interval '1 second' WHERE id = r;
  SELECT * INTO c FROM public.claim_due_flow_waits(ARRAY[a]);
  IF public.consume_flow_wait(a, r, gen_random_uuid(), 'after') THEN ok := false; detail := detail || ' [wrong token accepted]'; END IF;
  IF public.consume_flow_wait(b, r, c.claim_token, 'after') THEN ok := false; detail := detail || ' [wrong account accepted]'; END IF;
  IF NOT public.consume_flow_wait(a, r, c.claim_token, 'after') THEN ok := false; detail := detail || ' [holder refused]'; END IF;
  w := public.qa_wait_row(r);
  IF w->>'current_node_key' <> 'after' OR w->>'wait_until' IS NOT NULL OR w->>'wait_node_key' IS NOT NULL OR w->>'wait_claim_token' IS NOT NULL OR w->>'status' <> 'active' THEN ok := false; detail := detail || ' [row after consume ' || w::text || ']'; END IF;
  IF public.consume_flow_wait(a, r, c.claim_token, 'after') THEN ok := false; detail := detail || ' [second consume accepted: duplicate resume]'; END IF;
  IF (SELECT count(*) FROM public.claim_due_flow_waits(ARRAY[a, b])) <> 0 THEN ok := false; detail := detail || ' [a resumed run is claimable again]'; END IF;
  PERFORM public.qa_result('W04', ok, 'consume works only for the current token holder of the right account once the time has come; it moves the run to the next node and clears the wait in one step; a second consume (duplicate resume) and a re-claim are impossible' || detail);
END $$;

-- W05 a crashed worker: the lease expires, another worker takes over, the old token is dead
DO $$
DECLARE a uuid; r uuid := public.qa_wait_run(30); ok boolean := true; detail text := ''; c1 record; c2 record;
BEGIN
  SELECT account_id INTO a FROM public.flows WHERE id = 'a1000000-0000-4000-8000-0000000000f1';
  PERFORM public.schedule_flow_wait(a, r, 'pause', clock_timestamp() + interval '1 hour');
  UPDATE public.flow_runs SET wait_until = clock_timestamp() - interval '1 minute' WHERE id = r;
  SELECT * INTO c1 FROM public.claim_due_flow_waits(ARRAY[a], 10, 300);
  IF (SELECT count(*) FROM public.claim_due_flow_waits(ARRAY[a], 10, 300)) <> 0 THEN ok := false; detail := detail || ' [reclaimed inside the lease]'; END IF;
  UPDATE public.flow_runs SET wait_claimed_at = clock_timestamp() - interval '10 minutes' WHERE id = r;   -- the first worker died 10 minutes ago
  SELECT * INTO c2 FROM public.claim_due_flow_waits(ARRAY[a], 10, 300);
  IF c2.run_id IS DISTINCT FROM r OR c2.claim_token = c1.claim_token THEN ok := false; detail := detail || ' [no takeover / same token]'; END IF;
  IF public.consume_flow_wait(a, r, c1.claim_token, 'after') THEN ok := false; detail := detail || ' [the dead worker resumed the run]'; END IF;
  IF NOT public.consume_flow_wait(a, r, c2.claim_token, 'after') THEN ok := false; detail := detail || ' [the new holder was refused]'; END IF;
  PERFORM public.qa_result('W05', ok, 'after the lease expires another worker takes the run over; the first worker''s token stops working (it can never resume), the new holder resumes once' || detail);
END $$;

-- W06 cancellation: an agent takes over / the contact is blocked / the run ends while waiting
DO $$
DECLARE a uuid; ok boolean := true; detail text := ''; r1 uuid := public.qa_wait_run(40); r2 uuid := public.qa_wait_run(41); r3 uuid := public.qa_wait_run(42); c record; s text;
BEGIN
  SELECT account_id INTO a FROM public.flows WHERE id = 'a1000000-0000-4000-8000-0000000000f1';
  PERFORM public.schedule_flow_wait(a, r1, 'pause', clock_timestamp() + interval '1 hour'); PERFORM public.schedule_flow_wait(a, r2, 'pause', clock_timestamp() + interval '1 hour'); PERFORM public.schedule_flow_wait(a, r3, 'pause', clock_timestamp() + interval '1 hour');
  UPDATE public.flow_runs SET wait_until = clock_timestamp() - interval '1 second' WHERE id IN (r1, r2, r3);
  -- r1: cancelled BEFORE it is claimed (agent took over)
  UPDATE public.flow_runs SET status = 'paused_by_agent', end_reason = 'agent_reply' WHERE id = r1;
  -- r2: cancelled AFTER being claimed but before the consume (contact blocked in between)
  SELECT * INTO c FROM public.claim_due_flow_waits(ARRAY[a], 10) WHERE run_id = r2;
  UPDATE public.flow_runs SET status = 'paused_by_agent', end_reason = 'contact_blocked' WHERE id = r2;
  IF c.claim_token IS NULL THEN ok := false; detail := detail || ' [r2 not claimed]'; END IF;
  IF public.consume_flow_wait(a, r2, c.claim_token, 'after') THEN ok := false; detail := detail || ' [a cancelled run was resumed]'; END IF;
  -- r3: ended by the stale sweep
  UPDATE public.flow_runs SET status = 'timed_out' WHERE id = r3;
  FOR s IN SELECT r.status FROM public.flow_runs r WHERE r.id IN (r1, r2, r3) LOOP IF s = 'active' THEN ok := false; detail := detail || ' [still active]'; END IF; END LOOP;
  IF (SELECT count(*) FROM public.claim_due_flow_waits(ARRAY[a], 10) WHERE run_id IN (r1, r2, r3)) <> 0 THEN ok := false; detail := detail || ' [a cancelled run is claimable]'; END IF;
  IF public.consume_flow_wait(a, r1, gen_random_uuid(), 'after') THEN ok := false; detail := detail || ' [r1 consume]'; END IF;
  PERFORM public.qa_result('W06', ok, 'a run paused by an agent, ended by a contact block or timed out while waiting can never be claimed or resumed, even with a token obtained before the cancellation' || detail);
END $$;

-- W07 guards: node shape, activation, bypass, legacy delay untouched
DO $$
DECLARE a uuid := 'a1000000-0000-4000-8000-0000000000f1'; ok boolean := true; detail text := ''; c record; st text; act uuid := gen_random_uuid(); acct uuid;
BEGIN
  SELECT account_id INTO acct FROM public.flows WHERE id = a; UPDATE public.flows SET status = 'draft' WHERE id = a;
  -- valid durable waits are stored in a draft (incl. exactly 30 days)
  FOR c IN SELECT * FROM (VALUES ('13 minutes', '{"amount":13,"unit":"minutes","next_node_key":"end"}'), ('seconds', '{"amount":45,"unit":"seconds"}'), ('hours', '{"amount":2,"unit":"hours"}'), ('days', '{"amount":3,"unit":"days"}'), ('30 days', '{"amount":30,"unit":"days"}'), ('720 hours', '{"amount":720,"unit":"hours"}')) v(label, cfg) LOOP
    BEGIN INSERT INTO public.flow_nodes (flow_id, node_key, node_type, config) VALUES (a, 'w-' || c.label, 'delay', c.cfg::jsonb); EXCEPTION WHEN OTHERS THEN ok := false; detail := detail || ' [' || c.label || ' refused: ' || SQLSTATE || ']'; END;
  END LOOP;
  -- malformed ones are refused with 22023
  FOR c IN SELECT * FROM (VALUES ('unit', '{"amount":5,"unit":"weeks"}'), ('amount 0', '{"amount":0,"unit":"minutes"}'), ('fraction', '{"amount":1.5,"unit":"hours"}'), ('string', '{"amount":"5","unit":"minutes"}'), ('missing amount', '{"unit":"minutes"}'), ('31 days', '{"amount":31,"unit":"days"}'), ('721 hours', '{"amount":721,"unit":"hours"}'), ('negative', '{"amount":-5,"unit":"minutes"}'), ('2600000 s', '{"amount":2592001,"unit":"seconds"}')) v(label, cfg) LOOP
    st := NULL; BEGIN INSERT INTO public.flow_nodes (flow_id, node_key, node_type, config) VALUES (a, 'bad-' || c.label, 'delay', c.cfg::jsonb); EXCEPTION WHEN OTHERS THEN st := SQLSTATE; END;
    IF st IS DISTINCT FROM '22023' THEN ok := false; detail := detail || ' [' || c.label || ': ' || coalesce(st, 'accepted') || ']'; END IF;
  END LOOP;
  -- the flow holding durable waits cannot be activated; with the operator switch it can
  st := NULL; BEGIN UPDATE public.flows SET status = 'active' WHERE id = a; EXCEPTION WHEN OTHERS THEN st := SQLSTATE; END;
  IF st IS DISTINCT FROM '0A000' OR (SELECT status FROM public.flows WHERE id = a) <> 'draft' THEN ok := false; detail := detail || ' [activation: ' || coalesce(st, 'accepted') || ']'; END IF;
  PERFORM set_config('app.allow_durable_wait_activation', 'on', true); PERFORM set_config('app.flow_publication', 'on', true);
  BEGIN UPDATE public.flows SET status = 'active' WHERE id = a; EXCEPTION WHEN OTHERS THEN ok := false; detail := detail || ' [operator switch: ' || SQLSTATE || ']'; END;
  PERFORM set_config('app.allow_durable_wait_activation', 'off', true);
  -- active flow: no new durable wait without the switch; the legacy 30-second delay is untouched either way
  st := NULL; BEGIN INSERT INTO public.flow_nodes (flow_id, node_key, node_type, config) VALUES (a, 'late', 'delay', '{"amount":5,"unit":"minutes"}'); EXCEPTION WHEN OTHERS THEN st := SQLSTATE; END;
  IF st IS DISTINCT FROM '0A000' THEN ok := false; detail := detail || ' [durable wait into an active flow: ' || coalesce(st, 'accepted') || ']'; END IF;
  BEGIN INSERT INTO public.flow_nodes (flow_id, node_key, node_type, config) VALUES (a, 'legacy-delay', 'delay', '{"seconds":10,"next_node_key":"end"}'); EXCEPTION WHEN OTHERS THEN ok := false; detail := detail || ' [legacy delay into an active flow: ' || SQLSTATE || ']'; END;
  UPDATE public.flows SET status = 'draft' WHERE id = a; PERFORM set_config('app.flow_publication', 'off', true);
  PERFORM public.qa_result('W07', ok, 'durable waits of 13 minutes / seconds / hours / days / exactly 30 days are stored in drafts; unit, 0, fractions, strings, missing, > 30 days -> 22023; a flow holding one cannot be activated (0A000) nor receive one while active, except with the operator switch; the legacy delay is unaffected' || detail);
END $$;

-- W08 tenancy through RLS: another account sees nothing of a waiting run and cannot touch the functions
DO $$
DECLARE a uuid; r uuid := public.qa_wait_run(60); ok boolean := true; detail text := ''; n int; st text;
BEGIN
  SELECT account_id INTO a FROM public.flows WHERE id = 'a1000000-0000-4000-8000-0000000000f1';
  PERFORM public.schedule_flow_wait(a, r, 'pause', clock_timestamp() + interval '1 hour');
  PERFORM set_config('request.jwt.claim.sub', 'b2000000-0000-4000-8000-000000000002', true); PERFORM set_config('request.jwt.claims', '{"sub":"b2000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO n FROM public.flow_runs WHERE id = r; IF n <> 0 THEN ok := false; detail := detail || ' [B reads A''s waiting run]'; END IF;
  st := NULL; BEGIN UPDATE public.flow_runs SET wait_until = now() - interval '1 day' WHERE id = r; GET DIAGNOSTICS n = ROW_COUNT; IF n <> 0 THEN ok := false; detail := detail || ' [B moved A''s wait]'; END IF; EXCEPTION WHEN OTHERS THEN st := SQLSTATE; END;
  st := NULL; BEGIN PERFORM public.claim_due_flow_waits(ARRAY[a]); EXCEPTION WHEN OTHERS THEN st := SQLSTATE; END; IF st IS DISTINCT FROM '42501' THEN ok := false; detail := detail || ' [authenticated claimed: ' || coalesce(st, 'allowed') || ']'; END IF;
  RESET ROLE;
  IF (public.qa_wait_row(r)->>'wait_until') IS NULL THEN ok := false; detail := detail || ' [wait lost]'; END IF;
  PERFORM public.qa_result('W08', ok, 'a user of another account cannot read or alter the waiting run and cannot call the scheduler functions (42501)' || detail);
END $$;

-- W09 ordinary flow runs and legacy delay are unaffected by the new columns
DO $$
DECLARE a uuid; r uuid := public.qa_wait_run(70); ok boolean := true; detail text := ''; w jsonb;
BEGIN
  SELECT account_id INTO a FROM public.flows WHERE id = 'a1000000-0000-4000-8000-0000000000f1'; w := public.qa_wait_row(r);
  IF w->>'wait_until' IS NOT NULL OR w->>'wait_node_key' IS NOT NULL OR w->>'wait_claim_token' IS NOT NULL THEN ok := false; detail := detail || ' [new runs start with a wait]'; END IF;
  UPDATE public.flow_runs SET current_node_key = 'm1', last_advanced_at = now(), status = 'completed', ended_at = now(), end_reason = 'end_node' WHERE id = r;
  BEGIN UPDATE public.flow_runs SET wait_until = now() WHERE id = r; ok := false; detail := detail || ' [half-set wait accepted]'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE public.flow_runs SET wait_claim_token = gen_random_uuid(), wait_claimed_at = now() WHERE id = r; ok := false; detail := detail || ' [claim without wait accepted]'; EXCEPTION WHEN check_violation THEN NULL; END;
  PERFORM public.qa_result('W09', ok, 'runs created and completed the usual way never carry wait data; the CHECK rejects half-set waits and claims without a wait' || detail);
END $$;
