-- PR #30 audit fix P2 (temporary rejections, migration 062). Same rolled-back transaction as the other suites;
-- races are in e42pr30-concurrency.sh. IDs Q06..Q11.
DO $$ BEGIN
  PERFORM public.qa_synth_flow('58000000-0000-4000-8000-0000000000a0', '[{"node_key":"m","node_type":"send_message","config":{"text":"hi","next_node_key":"x"}},{"node_key":"x","node_type":"end"}]', 'm');
END $$;
CREATE FUNCTION public.qa_defer(p_run uuid, p_owner text, p_effect uuid, p_attempt uuid, p_after int DEFAULT NULL, p_code text DEFAULT 'rate_limited') RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE run public.flow_runs%ROWTYPE; r record;
BEGIN
  SELECT * INTO run FROM public.flow_runs WHERE id = p_run;
  SELECT * INTO r FROM public.defer_versioned_effect(run.account_id, p_run, p_owner, run.versioned_lease, p_effect, p_attempt, p_after, p_code);
  RETURN to_jsonb(r);
END $$;
CREATE FUNCTION public.qa_make_due(p_effect uuid) RETURNS void LANGUAGE sql AS $$
  UPDATE public.flow_run_effects SET retry_not_before = clock_timestamp() - interval '1 second' WHERE id = p_effect
$$;

-- Q06: Retry-After is honoured and persisted; nothing moves; the retry happens once it is due
DO $$
DECLARE rid uuid; eid uuid; a1 uuid; a2 uuid; d jsonb; e public.flow_run_effects%ROWTYPE; run0 jsonb; run1 jsonb; c jsonb; ok boolean := true; detail text := ''; run public.flow_runs%ROWTYPE; secs numeric; ev jsonb; s jsonb;
BEGIN
  rid := public.qa_flow_run_conv('58000000-0000-4000-8000-0000000000a0', 7001);
  PERFORM public.qa_lease(rid);
  eid := (public.qa_eff_register(rid, 'w1', 'send_message', '{"kind":"text","text":"rate limited once"}')->>'effect_id')::uuid;
  a1 := (public.qa_eff_claim(rid, 'w1', eid)->>'claimed_attempt_id')::uuid;
  SELECT to_jsonb(x) INTO run0 FROM public.flow_runs x WHERE id = rid;
  d := public.qa_defer(rid, 'w1', eid, a1, 120);
  SELECT * INTO e FROM public.flow_run_effects WHERE id = eid;
  secs := extract(epoch FROM (e.retry_not_before - clock_timestamp()));
  IF NOT ((d->>'deferred')::bool AND d->>'effect_state' = 'pending' AND (d->>'wait_seconds')::int = 120) THEN ok := false; detail := detail || ' [defer ' || d::text || ']'; END IF;
  IF NOT (e.state = 'pending' AND e.attempt = 1 AND e.attempt_id IS NULL AND e.claimed_owner IS NULL AND e.claimed_fencing_token IS NULL AND e.error_code = 'rate_limited' AND secs BETWEEN 115 AND 121) THEN ok := false; detail := detail || ' [row ' || coalesce(secs::text, '?') || 's]'; END IF;
  SELECT payload INTO ev FROM public.flow_run_events WHERE flow_run_id = rid AND event_type = 'effect_deferred';
  IF ev IS NULL OR ev->>'wait_source' <> 'retry_after' OR (ev->>'wait_seconds')::int <> 120 OR ev::text LIKE '%rate limited once%' THEN ok := false; detail := detail || ' [event ' || coalesce(ev::text, 'missing') || ']'; END IF;
  SELECT to_jsonb(x) INTO run1 FROM public.flow_runs x WHERE id = rid;
  IF run1 <> run0 THEN ok := false; detail := detail || ' [deferral changed the run: cursor, revision or budget]'; END IF;
  SELECT * INTO run FROM public.flow_runs WHERE id = rid;
  IF EXISTS (SELECT 1 FROM public.messages WHERE conversation_id = run.conversation_id) OR EXISTS (SELECT 1 FROM public.flow_run_effect_messages WHERE flow_run_id = rid) THEN ok := false; detail := detail || ' [Inbox row for a refused attempt]'; END IF;
  -- not due: refused, nothing changes
  c := public.qa_eff_claim(rid, 'w1', eid);
  IF c->>'reason' <> 'retry_not_due' OR (c->>'claimed')::bool OR (SELECT to_jsonb(x) FROM public.flow_run_effects x WHERE id = eid) <> to_jsonb(e) THEN ok := false; detail := detail || ' [claim before the due time: ' || c::text || ']'; END IF;
  -- the generic commit still cannot step past the (pending, deferred) effect
  IF (SELECT reason FROM public.commit_versioned_run_transition(run.account_id, rid, 'w1', run.versioned_lease, run.versioned_revision,
        jsonb_build_object('cursor', jsonb_build_object('flow_version_id', run.current_flow_version_id, 'node_key', 'x'), 'step', 9))) <> 'effect_unresolved' THEN ok := false; detail := detail || ' [advanced past a deferred effect]'; END IF;
  -- due: second attempt, new attempt id, deadline cleared
  PERFORM public.qa_make_due(eid);
  c := public.qa_eff_claim(rid, 'w1', eid); a2 := (c->>'claimed_attempt_id')::uuid;
  SELECT * INTO e FROM public.flow_run_effects WHERE id = eid;
  IF NOT ((c->>'claimed')::bool AND (c->>'attempt_no')::int = 2 AND a2 <> a1 AND e.retry_not_before IS NULL) THEN ok := false; detail := detail || ' [second attempt ' || c::text || ']'; END IF;
  s := public.qa_eff_settle(rid, 'w1', eid, a2, 'confirmed', 'wamid.Q06OK');
  IF NOT (s->>'settled')::bool THEN ok := false; detail := detail || ' [settle]'; END IF;
  IF (SELECT count(*) FROM public.messages WHERE conversation_id = run.conversation_id) <> 1 THEN ok := false; detail := detail || ' [Inbox]'; END IF;
  s := public.qa_eff_step(rid, 'w1', eid, 'x');
  IF NOT (s->>'committed')::bool OR (SELECT versioned_messages_executed FROM public.flow_runs WHERE id = rid) <> 1 THEN ok := false; detail := detail || ' [budget after the retry]'; END IF;
  PERFORM public.qa_result('Q06', ok, 'defer(120s): effect back to pending with a persisted retry time (~120 s, PostgreSQL clock), attempt 1 kept, no claim data, id-only event with wait_source retry_after; run row (cursor, revision, budget) byte-identical; no Inbox row; claim before the time -> retry_not_due and nothing changes; generic commit still refused; once due: attempt 2 with a new attempt id, confirmed, ONE message, message budget exactly 1' || detail);
END $$;

-- Q07: no usable Retry-After -> bounded exponential backoff by attempt
DO $$
DECLARE rid uuid; eid uuid; a uuid; d jsonb; waits int[] := '{}'; ok boolean := true; detail text := ''; i int; src text; inputs int[] := ARRAY[NULL, 0, -5, NULL, 0]; x int; run public.flow_runs%ROWTYPE;
BEGIN
  rid := public.qa_flow_run_conv('58000000-0000-4000-8000-0000000000a0', 7002);
  PERFORM public.qa_lease(rid);
  eid := (public.qa_eff_register(rid, 'w1', 'send_message', '{"kind":"text","text":"backoff"}')->>'effect_id')::uuid;
  FOR i IN 1..7 LOOP
    a := (public.qa_eff_claim(rid, 'w1', eid)->>'claimed_attempt_id')::uuid;
    d := public.qa_defer(rid, 'w1', eid, a, CASE WHEN i <= 5 THEN inputs[i] ELSE NULL END);
    waits := waits || (d->>'wait_seconds')::int;
    PERFORM public.qa_make_due(eid);
  END LOOP;
  IF waits <> ARRAY[30, 60, 120, 240, 480, 900, 900] THEN ok := false; detail := detail || ' [waits ' || array_to_string(waits, ',') || ']'; END IF;
  IF (SELECT count(*) FROM public.flow_run_events WHERE flow_run_id = rid AND event_type = 'effect_deferred' AND payload->>'wait_source' = 'backoff') <> 7 THEN ok := false; detail := detail || ' [wait_source]'; END IF;
  -- boundaries of a valid Retry-After
  a := (public.qa_eff_claim(rid, 'w1', eid)->>'claimed_attempt_id')::uuid;
  d := public.qa_defer(rid, 'w1', eid, a, 1); IF (d->>'wait_seconds')::int <> 1 THEN ok := false; detail := detail || ' [1s]'; END IF;
  PERFORM public.qa_make_due(eid);
  a := (public.qa_eff_claim(rid, 'w1', eid)->>'claimed_attempt_id')::uuid;
  d := public.qa_defer(rid, 'w1', eid, a, 86400); IF (d->>'wait_seconds')::int <> 86400 THEN ok := false; detail := detail || ' [86400s]'; END IF;
  SELECT * INTO run FROM public.flow_runs WHERE id = rid;
  IF run.versioned_messages_executed <> 0 OR run.versioned_revision <> 0 THEN ok := false; detail := detail || ' [budget or revision moved by 9 deferrals]'; END IF;
  PERFORM public.qa_result('Q07', ok, 'missing / 0 / negative Retry-After falls back to backoff 30,60,120,240,480,900,900 s (attempt-based, capped); 1 s and 86400 s are honoured as given (values above a day: Q18); nine deferrals consumed no budget and moved no revision' || detail);
END $$;

-- Q08: who may defer, and what a refusal leaves behind
DO $$
DECLARE rid uuid; eid uuid; a uuid; ok boolean := true; detail text := ''; before_eff jsonb; got text; run public.flow_runs%ROWTYPE; acct_b uuid; lid uuid; tok int; r jsonb; rid2 uuid;
BEGIN
  SELECT account_id INTO acct_b FROM public.flows WHERE id = '60000000-0000-4000-8000-000000000001';
  rid := public.qa_flow_run_conv('58000000-0000-4000-8000-0000000000a0', 7003);
  tok := public.qa_lease(rid);
  SELECT * INTO run FROM public.flow_runs WHERE id = rid;
  eid := (public.qa_eff_register(rid, 'w1', 'send_message', '{"kind":"text","text":"who may defer"}')->>'effect_id')::uuid;
  -- not claimed yet
  r := public.qa_defer(rid, 'w1', eid, gen_random_uuid()); IF r->>'reason' <> 'effect_not_claimed' THEN ok := false; detail := detail || ' [pending]'; END IF;
  a := (public.qa_eff_claim(rid, 'w1', eid)->>'claimed_attempt_id')::uuid;
  before_eff := (SELECT to_jsonb(x) FROM public.flow_run_effects x WHERE id = eid);
  r := public.qa_defer(rid, 'w1', eid, gen_random_uuid()); IF r->>'reason' <> 'attempt_mismatch' THEN ok := false; detail := detail || ' [wrong attempt]'; END IF;
  SELECT reason INTO got FROM public.defer_versioned_effect(run.account_id, rid, 'intruder', tok, eid, a, 60, 'x'); IF got <> 'stale_lease' THEN ok := false; detail := detail || ' [foreign owner]'; END IF;
  SELECT reason INTO got FROM public.defer_versioned_effect(run.account_id, rid, 'w1', tok + 1, eid, a, 60, 'x'); IF got <> 'stale_lease' THEN ok := false; detail := detail || ' [wrong token]'; END IF;
  UPDATE public.flow_runs SET versioned_lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = rid;
  SELECT reason INTO got FROM public.defer_versioned_effect(run.account_id, rid, 'w1', tok, eid, a, 60, 'x'); IF got <> 'lease_expired' THEN ok := false; detail := detail || ' [expired]'; END IF;
  UPDATE public.flow_runs SET versioned_lease_expires_at = clock_timestamp() + interval '10 minutes' WHERE id = rid;
  IF (SELECT to_jsonb(x) FROM public.flow_run_effects x WHERE id = eid) <> before_eff THEN ok := false; detail := detail || ' [a refusal changed the effect]'; END IF;
  -- other account, legacy run, bad arguments
  got := NULL; BEGIN PERFORM * FROM public.defer_versioned_effect(acct_b, rid, 'w1', tok, eid, a, 60, 'x'); EXCEPTION WHEN no_data_found THEN got := SQLERRM; END;
  IF got IS DISTINCT FROM 'versioned run not found' THEN ok := false; detail := detail || ' [cross-account]'; END IF;
  INSERT INTO public.flow_runs (flow_id, account_id, user_id, contact_id, status, current_node_key)
  VALUES ('50000000-0000-4000-8000-000000000002', run.account_id, '10000000-0000-4000-8000-000000000001', public.qa_new_contact(7004), 'active', 'start') RETURNING id INTO lid;
  got := NULL; BEGIN PERFORM * FROM public.defer_versioned_effect(run.account_id, lid, 'w1', 1, gen_random_uuid(), gen_random_uuid(), 60, 'x'); EXCEPTION WHEN no_data_found THEN got := SQLERRM; END;
  IF got IS DISTINCT FROM 'versioned run not found' THEN ok := false; detail := detail || ' [legacy]'; END IF;
  got := NULL; BEGIN PERFORM * FROM public.defer_versioned_effect(run.account_id, rid, 'w1', tok, eid, a, 60, repeat('x', 65)); EXCEPTION WHEN OTHERS THEN got := SQLSTATE; END;
  IF got IS DISTINCT FROM '22023' THEN ok := false; detail := detail || ' [long error code]'; END IF;
  -- terminal / ambiguous effects cannot be deferred
  PERFORM public.qa_eff_settle(rid, 'w1', eid, a, 'ambiguous', NULL, 'timeout');
  r := public.qa_defer(rid, 'w1', eid, a); IF r->>'reason' <> 'effect_not_claimed' OR (SELECT state FROM public.flow_run_effects WHERE id = eid) <> 'ambiguous' THEN ok := false; detail := detail || ' [ambiguous was deferred: ' || r::text || ']'; END IF;
  rid2 := public.qa_flow_run_conv('58000000-0000-4000-8000-0000000000a0', 7005); PERFORM public.qa_lease(rid2);
  eid := public.qa_eff_registered_accept(rid2, 'w1', '{"kind":"text","text":"done"}', 'wamid.Q08DONE');
  r := public.qa_defer(rid2, 'w1', eid, (SELECT attempt_id FROM public.flow_run_effects WHERE id = eid)); IF r->>'reason' <> 'effect_not_claimed' OR (SELECT state FROM public.flow_run_effects WHERE id = eid) <> 'confirmed' THEN ok := false; detail := detail || ' [confirmed was deferred]'; END IF;
  -- a paused run
  rid2 := public.qa_flow_run_conv('58000000-0000-4000-8000-0000000000a0', 7010); tok := public.qa_lease(rid2);
  eid := (public.qa_eff_register(rid2, 'w1', 'send_message', '{"kind":"text","text":"paused"}')->>'effect_id')::uuid;
  a := (public.qa_eff_claim(rid2, 'w1', eid)->>'claimed_attempt_id')::uuid;
  UPDATE public.flow_runs SET status = 'paused_by_agent' WHERE id = rid2;
  SELECT reason INTO got FROM public.defer_versioned_effect(run.account_id, rid2, 'w1', tok, eid, a, 60, 'x'); IF got <> 'run_not_active' OR (SELECT state FROM public.flow_run_effects WHERE id = eid) <> 'claimed' THEN ok := false; detail := detail || ' [paused]'; END IF;
  PERFORM public.qa_result('Q08', ok, 'defer refused (state untouched) for a pending effect, a wrong attempt id, a foreign owner, a wrong token, an expired lease and a paused run; other account and legacy run -> P0002; over-long error code -> 22023; an ambiguous or confirmed effect can NEVER be re-opened by a deferral' || detail);
END $$;

-- Q09: the table guard
DO $$
DECLARE rid uuid; eid uuid; a uuid; ok boolean := true; detail text := ''; st text;
BEGIN
  rid := public.qa_flow_run_conv('58000000-0000-4000-8000-0000000000a0', 7006);
  PERFORM public.qa_lease(rid);
  eid := (public.qa_eff_register(rid, 'w1', 'send_message', '{"kind":"text","text":"guard"}')->>'effect_id')::uuid;
  a := (public.qa_eff_claim(rid, 'w1', eid)->>'claimed_attempt_id')::uuid;
  -- claimed -> pending without a retry time is still illegal
  st := NULL; BEGIN UPDATE public.flow_run_effects SET state = 'pending', attempt_id = NULL, claimed_owner = NULL, claimed_fencing_token = NULL, claimed_at = NULL WHERE id = eid; EXCEPTION WHEN OTHERS THEN st := SQLSTATE; END;
  IF st IS DISTINCT FROM '55000' THEN ok := false; detail := detail || ' [claimed->pending without retry time: ' || coalesce(st, 'accepted') || ']'; END IF;
  -- a retry time outside pending is rejected
  st := NULL; BEGIN UPDATE public.flow_run_effects SET retry_not_before = now() + interval '1 hour' WHERE id = eid; EXCEPTION WHEN OTHERS THEN st := SQLSTATE; END;
  IF st IS DISTINCT FROM '23514' THEN ok := false; detail := detail || ' [retry time on a claimed effect: ' || coalesce(st, 'accepted') || ']'; END IF;
  -- the legal path
  PERFORM public.qa_defer(rid, 'w1', eid, a, 30);
  IF (SELECT state FROM public.flow_run_effects WHERE id = eid) <> 'pending' THEN ok := false; detail := detail || ' [legal deferral failed]'; END IF;
  -- pending (deferred) can only go to claimed; it cannot be confirmed or failed directly
  st := NULL; BEGIN UPDATE public.flow_run_effects SET state = 'failed', finished_at = now() WHERE id = eid; EXCEPTION WHEN OTHERS THEN st := SQLSTATE; END;
  IF st IS DISTINCT FROM '55000' THEN ok := false; detail := detail || ' [pending->failed: ' || coalesce(st, 'accepted') || ']'; END IF;
  -- the attempt counter cannot be edited by a deferral
  st := NULL; BEGIN UPDATE public.flow_run_effects SET attempt = attempt + 1 WHERE id = eid; EXCEPTION WHEN OTHERS THEN st := SQLSTATE; END;
  IF st IS DISTINCT FROM '55000' THEN ok := false; detail := detail || ' [attempt edited]'; END IF;
  PERFORM public.qa_result('Q09', ok, 'table guard: claimed->pending is legal only with a persisted retry time; a retry time on any other state violates a CHECK; a deferred effect cannot jump to failed/confirmed and its attempt counter cannot be edited' || detail);
END $$;

-- Q10: crash safety: a claim that was never deferred is NOT silently re-opened
DO $$
DECLARE rid uuid; eid uuid; a uuid; ok boolean := true; detail text := ''; acct uuid; tok2 int; r record; rec jsonb;
BEGIN
  rid := public.qa_flow_run_conv('58000000-0000-4000-8000-0000000000a0', 7007);
  SELECT account_id INTO acct FROM public.flow_runs WHERE id = rid;
  PERFORM public.qa_lease(rid, 'w1');
  eid := (public.qa_eff_register(rid, 'w1', 'send_message', '{"kind":"text","text":"crash before defer"}')->>'effect_id')::uuid;
  a := (public.qa_eff_claim(rid, 'w1', eid)->>'claimed_attempt_id')::uuid;
  -- w1 got a 429 but died before recording it: its lease lapses and w2 takes over
  UPDATE public.flow_runs SET versioned_lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = rid;
  SELECT * INTO r FROM public.reclaim_versioned_run_lease(acct, rid, 'w2', 600);
  IF public.qa_defer(rid, 'w1', eid, a)->>'reason' <> 'stale_lease' THEN ok := false; detail := detail || ' [old worker deferred]'; END IF;
  rec := public.qa_eff_recover(rid, 'w2');
  IF NOT (jsonb_array_length(rec) = 1 AND rec->0->>'new_state' = 'ambiguous') THEN ok := false; detail := detail || ' [recover ' || rec::text || ']'; END IF;
  IF public.qa_eff_claim(rid, 'w2', eid)->>'reason' <> 'effect_not_pending' THEN ok := false; detail := detail || ' [claimed after ambiguity]'; END IF;
  -- a deferred (pending) effect is not touched by recovery and keeps its retry time
  rid := public.qa_flow_run_conv('58000000-0000-4000-8000-0000000000a0', 7008);
  PERFORM public.qa_lease(rid, 'w1');
  eid := (public.qa_eff_register(rid, 'w1', 'send_message', '{"kind":"text","text":"deferred then crash"}')->>'effect_id')::uuid;
  a := (public.qa_eff_claim(rid, 'w1', eid)->>'claimed_attempt_id')::uuid;
  PERFORM public.qa_defer(rid, 'w1', eid, a, 300);
  UPDATE public.flow_runs SET versioned_lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = rid;
  SELECT * INTO r FROM public.reclaim_versioned_run_lease(acct, rid, 'w2', 600);
  IF jsonb_array_length(public.qa_eff_recover(rid, 'w2')) <> 0 THEN ok := false; detail := detail || ' [recover touched a deferred effect]'; END IF;
  IF (SELECT state FROM public.flow_run_effects WHERE id = eid) <> 'pending' OR (SELECT retry_not_before FROM public.flow_run_effects WHERE id = eid) < clock_timestamp() + interval '290 seconds' THEN ok := false; detail := detail || ' [deferred state lost after the restart]'; END IF;
  IF public.qa_eff_claim(rid, 'w2', eid)->>'reason' <> 'retry_not_due' THEN ok := false; detail := detail || ' [successor claimed before the persisted time]'; END IF;
  PERFORM public.qa_result('Q10', ok, 'death after a 429 but BEFORE the deferral was recorded: the old worker is refused, recovery makes the claim ambiguous (never resent); death AFTER it was recorded: recovery leaves the effect pending and the successor is still refused until the persisted time' || detail);
END $$;

-- Q11: privileges
DO $$
DECLARE rid uuid; eid uuid; a uuid; run public.flow_runs%ROWTYPE; tok int; ok boolean := true; detail text := ''; st text; role_name text; r record;
BEGIN
  CREATE ROLE qa_defer_probe NOLOGIN; GRANT USAGE ON SCHEMA public TO qa_defer_probe;
  rid := public.qa_flow_run_conv('58000000-0000-4000-8000-0000000000a0', 7009);
  tok := public.qa_lease(rid); SELECT * INTO run FROM public.flow_runs WHERE id = rid;
  eid := (public.qa_eff_register(rid, 'w1', 'send_message', '{"kind":"text","text":"grants"}')->>'effect_id')::uuid;
  a := (public.qa_eff_claim(rid, 'w1', eid)->>'claimed_attempt_id')::uuid;
  IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) x WHERE p.proname = 'defer_versioned_effect' AND x.grantee = 0) THEN ok := false; detail := detail || ' [PUBLIC grant]'; END IF;
  FOREACH role_name IN ARRAY ARRAY['qa_defer_probe', 'anon', 'authenticated'] LOOP
    IF has_function_privilege(role_name, 'public.defer_versioned_effect(uuid,uuid,text,integer,uuid,uuid,integer,text)', 'EXECUTE') THEN ok := false; detail := detail || ' [' || role_name || ' may EXECUTE]'; END IF;
    st := NULL; EXECUTE format('SET LOCAL ROLE %I', role_name);
    BEGIN PERFORM * FROM public.defer_versioned_effect(run.account_id, rid, 'w1', tok, eid, a, 60, 'x'); EXCEPTION WHEN OTHERS THEN st := SQLSTATE; END;
    RESET ROLE;
    IF st IS DISTINCT FROM '42501' THEN ok := false; detail := detail || ' [' || role_name || ' ran it: ' || coalesce(st, 'SUCCEEDED') || ']'; END IF;
  END LOOP;
  IF (SELECT state FROM public.flow_run_effects WHERE id = eid) <> 'claimed' THEN ok := false; detail := detail || ' [a denied role changed the effect]'; END IF;
  SET LOCAL ROLE service_role;
  BEGIN SELECT * INTO r FROM public.defer_versioned_effect(run.account_id, rid, 'w1', tok, eid, a, 60, 'rate_limited'); IF NOT r.deferred THEN ok := false; detail := detail || ' [service_role refused]'; END IF;
  EXCEPTION WHEN OTHERS THEN ok := false; detail := detail || ' [service_role error ' || SQLSTATE || ']'; END;
  RESET ROLE;
  PERFORM public.qa_result('Q11', ok, 'defer_versioned_effect: no PUBLIC grant; PUBLIC-probe / anon / authenticated -> 42501 with the effect untouched; service_role defers' || detail);
END $$;
