-- PR #30 audit round 2 (migrations 063 + 064). Same rolled-back transaction as the other suites.
-- Q14..Q16: late Inbox repair keeps temporal order (063). Q17..Q19: Retry-After above 86400 s (064, appended below).
DO $$ BEGIN
  PERFORM public.qa_synth_flow('57000000-0000-4000-8000-0000000000b0', '[{"node_key":"m1","node_type":"send_message","config":{"text":"one","next_node_key":"m2"}},{"node_key":"m2","node_type":"send_message","config":{"text":"two","next_node_key":"x"}},{"node_key":"x","node_type":"end"}]', 'm1');
END $$;
CREATE FUNCTION public.qa_pr30b_block_messages() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF current_setting('qa.pr30b_block', true) = '1' THEN RAISE EXCEPTION 'qa inbox outage' USING ERRCODE = 'P9997'; END IF; RETURN NEW; END $$;
CREATE TRIGGER qa_pr30b_block_messages BEFORE INSERT ON public.messages FOR EACH ROW EXECUTE FUNCTION public.qa_pr30b_block_messages();

-- a run whose first message (A) was confirmed during an Inbox outage and whose second (B) was confirmed afterwards.
-- Returns "run, effect A, effect B"
CREATE FUNCTION public.qa_pr30b_ab(n int, p_finish boolean DEFAULT true) RETURNS uuid[] LANGUAGE plpgsql AS $$
DECLARE rid uuid; ea uuid; eb uuid;
BEGIN
  rid := public.qa_flow_run_conv('57000000-0000-4000-8000-0000000000b0', n); PERFORM public.qa_lease(rid);
  PERFORM set_config('qa.pr30b_block', '1', true);
  ea := public.qa_eff_registered_accept(rid, 'w1', '{"kind":"text","text":"message A"}', 'wamid.Q14A' || n);
  PERFORM set_config('qa.pr30b_block', '', true);
  IF NOT (public.qa_eff_step(rid, 'w1', ea, 'm2')->>'committed')::bool THEN RAISE EXCEPTION 'qa_pr30b_ab: step A'; END IF;
  PERFORM pg_sleep(0.02);
  eb := public.qa_eff_registered_accept(rid, 'w1', '{"kind":"text","text":"message B"}', 'wamid.Q14B' || n);
  IF p_finish THEN PERFORM public.qa_finish_run(rid, 'w1', eb, 'completed'); END IF;
  RETURN ARRAY[rid, ea, eb];
END $$;

-- Q14: A confirmed without Inbox, B newer with Inbox, then A is repaired
DO $$
DECLARE ids uuid[]; run public.flow_runs%ROWTYPE; before_run jsonb; before_eff jsonb; r record; ok boolean := true; detail text := ''; conv public.conversations%ROWTYPE;
        fa timestamptz; fb timestamptz; ca timestamptz; cb timestamptz; order_txt text; n_before int;
BEGIN
  ids := public.qa_pr30b_ab(6101);
  SELECT * INTO run FROM public.flow_runs WHERE id = ids[1];
  SELECT finished_at INTO fa FROM public.flow_run_effects WHERE id = ids[2]; SELECT finished_at INTO fb FROM public.flow_run_effects WHERE id = ids[3];
  IF NOT (fa < fb) THEN ok := false; detail := detail || ' [setup: A is not older than B]'; END IF;
  SELECT * INTO conv FROM public.conversations WHERE id = run.conversation_id;
  IF conv.last_message_text <> 'message B' OR conv.last_message_at <> fb THEN ok := false; detail := detail || ' [setup: preview/last_message_at not B]'; END IF;
  before_run := to_jsonb(run); before_eff := (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM public.flow_run_effects e WHERE e.flow_run_id = ids[1]);
  SELECT * INTO r FROM public.repair_versioned_run_inbox(run.account_id, ids[1]);
  IF r.outcome <> 'created' THEN ok := false; detail := detail || ' [repair ' || coalesce(r.outcome, '?') || ']'; END IF;
  SELECT * INTO conv FROM public.conversations WHERE id = run.conversation_id;
  IF conv.last_message_text <> 'message B' THEN ok := false; detail := detail || ' [A replaced the preview]'; END IF;
  IF conv.last_message_at <> fb THEN ok := false; detail := detail || ' [last_message_at moved]'; END IF;
  SELECT created_at INTO ca FROM public.messages WHERE conversation_id = run.conversation_id AND message_id = 'wamid.Q14A6101';
  SELECT created_at INTO cb FROM public.messages WHERE conversation_id = run.conversation_id AND message_id = 'wamid.Q14B6101';
  IF ca IS DISTINCT FROM fa OR cb IS DISTINCT FROM fb THEN ok := false; detail := detail || ' [created_at is not the confirmation time]'; END IF;
  SELECT string_agg(content_text, ',' ORDER BY created_at) INTO order_txt FROM public.messages WHERE conversation_id = run.conversation_id;
  IF order_txt <> 'message A,message B' THEN ok := false; detail := detail || ' [order ' || coalesce(order_txt, 'null') || ']'; END IF;
  IF to_jsonb((SELECT x FROM public.flow_runs x WHERE id = ids[1])) <> before_run
     OR (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM public.flow_run_effects e WHERE e.flow_run_id = ids[1]) <> before_eff THEN ok := false; detail := detail || ' [repair changed the run or the effects]'; END IF;
  -- idempotent: a second repair neither duplicates nor moves anything
  SELECT count(*) INTO n_before FROM public.messages WHERE conversation_id = run.conversation_id;
  SELECT * INTO r FROM public.repair_versioned_run_inbox(run.account_id, ids[1]);
  IF r.outcome <> 'already_persisted' OR (SELECT count(*) FROM public.messages WHERE conversation_id = run.conversation_id) <> n_before
     OR (SELECT last_message_text FROM public.conversations WHERE id = run.conversation_id) <> 'message B' THEN ok := false; detail := detail || ' [second repair]'; END IF;
  PERFORM public.qa_result('Q14', ok, 'A confirmed without Inbox, B newer persisted, then A repaired: A is stored at its confirmation time (created_at = finished_at), the order is A,B, the preview and last_message_at stay B''s, the run and effects are byte-identical, and a second repair is a no-op' || detail);
END $$;

-- Q15: policy edges - a newer customer message, an empty preview, a tie
DO $$
DECLARE ids uuid[]; run public.flow_runs%ROWTYPE; r record; ok boolean := true; detail text := ''; conv public.conversations%ROWTYPE; fa timestamptz; cust timestamptz;
BEGIN
  -- (a) a customer message arrived after B: neither A nor B may replace it
  ids := public.qa_pr30b_ab(6102);
  SELECT * INTO run FROM public.flow_runs WHERE id = ids[1];
  cust := clock_timestamp();
  INSERT INTO public.messages (conversation_id, sender_type, content_type, content_text, message_id, status, created_at) VALUES (run.conversation_id, 'customer', 'text', 'customer reply', 'wamid.Q15C', 'delivered', cust);
  UPDATE public.conversations SET last_message_text = 'customer reply', last_message_at = cust WHERE id = run.conversation_id;
  PERFORM * FROM public.repair_versioned_run_inbox(run.account_id, ids[1]);
  SELECT * INTO conv FROM public.conversations WHERE id = run.conversation_id;
  IF conv.last_message_text <> 'customer reply' OR conv.last_message_at <> cust THEN ok := false; detail := detail || ' [(a) the customer preview was replaced]'; END IF;
  IF (SELECT string_agg(content_text, ',' ORDER BY created_at) FROM public.messages WHERE conversation_id = run.conversation_id) <> 'message A,message B,customer reply' THEN ok := false; detail := detail || ' [(a) order]'; END IF;
  -- (b) nothing in the conversation yet: the repaired message becomes the preview with its own time
  ids := public.qa_pr30b_ab(6103, false);
  SELECT * INTO run FROM public.flow_runs WHERE id = ids[1];
  DELETE FROM public.flow_run_effect_messages WHERE flow_run_id = ids[1]; DELETE FROM public.messages WHERE conversation_id = run.conversation_id;
  UPDATE public.conversations SET last_message_text = NULL, last_message_at = NULL WHERE id = run.conversation_id;
  PERFORM * FROM public.repair_versioned_run_inbox(run.account_id, ids[1]);
  SELECT finished_at INTO fa FROM public.flow_run_effects WHERE id = ids[3];
  SELECT * INTO conv FROM public.conversations WHERE id = run.conversation_id;
  IF conv.last_message_text <> 'message B' OR conv.last_message_at <> fa THEN ok := false; detail := detail || ' [(b) empty conversation: ' || coalesce(conv.last_message_text, 'null') || ']'; END IF;
  -- (c) tie: an existing preview with exactly the same time is kept
  ids := public.qa_pr30b_ab(6104, false);
  SELECT * INTO run FROM public.flow_runs WHERE id = ids[1];
  SELECT finished_at INTO fa FROM public.flow_run_effects WHERE id = ids[2];
  UPDATE public.conversations SET last_message_text = 'tied preview', last_message_at = fa WHERE id = run.conversation_id;
  PERFORM * FROM public.repair_versioned_run_inbox(run.account_id, ids[1]);
  IF (SELECT last_message_text FROM public.conversations WHERE id = run.conversation_id) <> 'tied preview' THEN ok := false; detail := detail || ' [(c) tie replaced the preview]'; END IF;
  PERFORM public.qa_result('Q15', ok, 'policy edges: a newer customer message keeps its preview and last_message_at (order A,B,customer); an empty conversation takes the repaired message''s own time; an equal timestamp keeps the existing preview' || detail);
END $$;

-- Q16: the ordering is what an account member sees through RLS; another account sees nothing
DO $$
DECLARE ids uuid[]; run public.flow_runs%ROWTYPE; ok boolean := true; detail text := ''; owner_id uuid; other_user uuid; seen text; n int;
BEGIN
  ids := public.qa_pr30b_ab(6105);
  SELECT * INTO run FROM public.flow_runs WHERE id = ids[1];
  PERFORM * FROM public.repair_versioned_run_inbox(run.account_id, ids[1]);
  owner_id := run.user_id; other_user := '10000000-0000-4000-8000-000000000002';
  PERFORM set_config('request.jwt.claim.sub', owner_id::text, true); SET LOCAL ROLE authenticated;
  SELECT string_agg(content_text, ',' ORDER BY created_at) INTO seen FROM public.messages WHERE conversation_id = run.conversation_id;
  RESET ROLE;
  IF seen IS DISTINCT FROM 'message A,message B' THEN ok := false; detail := detail || ' [owner sees ' || coalesce(seen, 'nothing') || ']'; END IF;
  PERFORM set_config('request.jwt.claim.sub', other_user::text, true); SET LOCAL ROLE authenticated;
  SELECT count(*) INTO n FROM public.messages WHERE conversation_id = run.conversation_id;
  RESET ROLE;
  IF n <> 0 THEN ok := false; detail := detail || ' [another account sees ' || n || ' messages]'; END IF;
  PERFORM public.qa_result('Q16', ok, 'RLS: the account member reads the repaired conversation in confirmation order A,B; a member of another account reads nothing' || detail);
END $$;


-- Q18: Retry-After above a day is honoured EXACTLY up to 7 days (604800 s); above that nothing is shortened or deferred
DO $$
DECLARE rid uuid; eid uuid; a uuid; d jsonb; e0 jsonb; run0 jsonb; ok boolean := true; detail text := ''; v int; secs numeric; ev jsonb; evn int;
BEGIN
  rid := public.qa_flow_run_conv('58000000-0000-4000-8000-0000000000a0', 6301); PERFORM public.qa_lease(rid);
  eid := (public.qa_eff_register(rid, 'w1', 'send_message', '{"kind":"text","text":"long wait"}')->>'effect_id')::uuid;
  FOREACH v IN ARRAY ARRAY[86400, 86401, 90000, 100000, 604799, 604800] LOOP
    a := (public.qa_eff_claim(rid, 'w1', eid)->>'claimed_attempt_id')::uuid;
    d := public.qa_defer(rid, 'w1', eid, a, v);
    SELECT extract(epoch FROM (retry_not_before - clock_timestamp())) INTO secs FROM public.flow_run_effects WHERE id = eid;
    IF NOT (d->>'deferred')::bool OR (d->>'wait_seconds')::int <> v OR secs > v OR secs < v - 5 THEN ok := false; detail := detail || ' [' || v || ' s: ' || d::text || ' / ' || coalesce(secs::text, 'null') || ']'; END IF;
    SELECT count(*) INTO evn FROM public.flow_run_events WHERE flow_run_id = rid AND event_type = 'effect_deferred' AND payload->>'wait_source' = 'retry_after' AND (payload->>'wait_seconds')::int = v;
    IF evn <> 1 THEN ok := false; detail := detail || ' [event ' || v || ']'; END IF;
    PERFORM public.qa_make_due(eid);
  END LOOP;
  -- above the limit: refused, state untouched (still claimed, no retry time, no event, no attempt consumed)
  FOREACH v IN ARRAY ARRAY[604801, 1000000, 2147483647] LOOP
    a := (public.qa_eff_claim(rid, 'w1', eid)->>'claimed_attempt_id')::uuid;
    e0 := (SELECT to_jsonb(x) FROM public.flow_run_effects x WHERE id = eid); run0 := to_jsonb((SELECT x FROM public.flow_runs x WHERE id = rid)); evn := (SELECT count(*) FROM public.flow_run_events WHERE flow_run_id = rid AND event_type = 'effect_deferred');
    d := public.qa_defer(rid, 'w1', eid, a, v);
    IF (d->>'deferred')::bool OR d->>'reason' <> 'retry_after_too_long' OR d->>'effect_state' <> 'claimed' THEN ok := false; detail := detail || ' [' || v || ' s not refused: ' || d::text || ']'; END IF;
    IF (SELECT to_jsonb(x) FROM public.flow_run_effects x WHERE id = eid) <> e0 OR to_jsonb((SELECT x FROM public.flow_runs x WHERE id = rid)) <> run0
       OR (SELECT count(*) FROM public.flow_run_events WHERE flow_run_id = rid AND event_type = 'effect_deferred') <> evn THEN ok := false; detail := detail || ' [' || v || ' s changed state]'; END IF;
    -- the caller can still settle the claimed attempt as failed (what the interpreter does)
    IF v = 604801 THEN
      d := public.qa_eff_settle(rid, 'w1', eid, a, 'failed', NULL, 'retry_after_exceeds_limit');
      IF NOT (d->>'settled')::bool OR (SELECT state || '/' || error_code FROM public.flow_run_effects WHERE id = eid) <> 'failed/retry_after_exceeds_limit' THEN ok := false; detail := detail || ' [settle failed: ' || d::text || ']'; END IF;
      EXIT;
    END IF;
  END LOOP;
  PERFORM public.qa_result('Q18', ok, 'defer honours 86400, 86401, 90000, 100000, 604799 and 604800 s EXACTLY (retry time, wait_seconds and event all equal the provider''s value, source retry_after); 604801 s is refused as retry_after_too_long with the effect still claimed and nothing changed (no retry time, no event, run identical) and can then be settled as failed' || detail);
END $$;

-- Q19: restart - a long persisted wait survives a new process (new owner/lease) and is enforced to the second
DO $$
DECLARE rid uuid; eid uuid; a uuid; d jsonb; c jsonb; ok boolean := true; detail text := ''; t1 timestamptz; t2 timestamptz;
BEGIN
  rid := public.qa_flow_run_conv('58000000-0000-4000-8000-0000000000a0', 6302); PERFORM public.qa_lease(rid);
  eid := (public.qa_eff_register(rid, 'w1', 'send_message', '{"kind":"text","text":"restart"}')->>'effect_id')::uuid;
  a := (public.qa_eff_claim(rid, 'w1', eid)->>'claimed_attempt_id')::uuid;
  d := public.qa_defer(rid, 'w1', eid, a, 100000);
  SELECT retry_not_before INTO t1 FROM public.flow_run_effects WHERE id = eid;
  -- the first process dies; its lease is taken over by another worker
  UPDATE public.flow_runs SET versioned_lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = rid;
  PERFORM * FROM public.reclaim_versioned_run_lease((SELECT account_id FROM public.flow_runs WHERE id = rid), rid, 'w2', 600);
  PERFORM public.qa_eff_recover(rid, 'w2');
  c := public.qa_eff_claim(rid, 'w2', eid);
  IF (c->>'claimed')::bool OR c->>'reason' <> 'retry_not_due' THEN ok := false; detail := detail || ' [a new process claimed before the persisted time: ' || c::text || ']'; END IF;
  SELECT retry_not_before INTO t2 FROM public.flow_run_effects WHERE id = eid;
  IF t2 IS DISTINCT FROM t1 THEN ok := false; detail := detail || ' [the persisted time moved]'; END IF;
  -- one second before the time: still held; at the time: claimable (attempt 2)
  UPDATE public.flow_run_effects SET retry_not_before = clock_timestamp() + interval '2 seconds' WHERE id = eid;
  IF (public.qa_eff_claim(rid, 'w2', eid)->>'claimed')::bool THEN ok := false; detail := detail || ' [claimed 2 s early]'; END IF;
  UPDATE public.flow_run_effects SET retry_not_before = clock_timestamp() - interval '1 second' WHERE id = eid;
  c := public.qa_eff_claim(rid, 'w2', eid);
  IF NOT (c->>'claimed')::bool OR (c->>'attempt_no')::int <> 2 THEN ok := false; detail := detail || ' [due claim: ' || c::text || ']'; END IF;
  PERFORM public.qa_result('Q19', ok, 'a 100000 s Retry-After (above a day) persists across a process death and lease takeover: the successor is refused retry_not_due with the time unchanged, still refused 2 s early, and claims attempt 2 only once due' || detail);
END $$;
DROP TRIGGER qa_pr30b_block_messages ON public.messages;
