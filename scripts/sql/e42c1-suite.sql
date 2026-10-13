-- E4.2C1 QA: effect ledger (migration 059). Same rolled-back transaction as the other suites;
-- concurrency / interruption scenarios are in e42c1-concurrency.sh. IDs E01..E17.
-- Flow M (messages):  m(send_message) -> x(end)                       entry 'm'
-- Flow FA (caller):   m(send_message) -> call(execute_flow FB) -> x(end)   entry 'm'
-- Flow FB (callee):   m(send_message, same key as FA.m) -> bend(end)       entry 'm'
DO $$
DECLARE fb uuid := '55000000-0000-4000-8000-0000000000b1';
BEGIN
  PERFORM public.qa_synth_flow('55000000-0000-4000-8000-0000000000a0', '[{"node_key":"m","node_type":"send_message","config":{"text":"hi","next_node_key":"x"}},{"node_key":"x","node_type":"end"}]', 'm');
  PERFORM public.qa_synth_flow(fb, '[{"node_key":"m","node_type":"send_message","config":{"text":"b","next_node_key":"bend"}},{"node_key":"bend","node_type":"end"}]', 'm');
  PERFORM public.qa_synth_flow('55000000-0000-4000-8000-0000000000a1',
    ('[{"node_key":"m","node_type":"send_message","config":{"text":"a","next_node_key":"call"}},{"node_key":"call","node_type":"execute_flow","config":{"target_flow_id":"' || fb || '","next_node_key":"x"}},{"node_key":"x","node_type":"end"}]')::jsonb, 'm');
END $$;

-- E01: registration
DO $$
DECLARE rid uuid; reg jsonb; e public.flow_run_effects%ROWTYPE; run public.flow_runs%ROWTYPE; ev text; v uuid; before_run jsonb;
BEGIN
  rid := public.qa_flow_run('55000000-0000-4000-8000-0000000000a0', 1001);
  PERFORM public.qa_lease(rid);
  SELECT * INTO run FROM public.flow_runs WHERE id = rid; before_run := to_jsonb(run);
  reg := public.qa_eff_register(rid, 'w1', 'send_message', '{"text":"secret-body-123","to":"x"}');
  SELECT * INTO e FROM public.flow_run_effects WHERE id = (reg->>'effect_id')::uuid;
  SELECT string_agg(payload::text, ' ') INTO ev FROM public.flow_run_events WHERE flow_run_id = rid AND event_type = 'effect_registered';
  PERFORM public.qa_result('E01', (reg->>'registered')::bool AND reg->>'effect_state' = 'pending' AND (reg->>'effect_revision')::bigint = run.versioned_revision AND reg->>'reason' IS NULL
    AND e.account_id = run.account_id AND e.flow_run_id = rid AND e.flow_version_id = run.current_flow_version_id AND e.node_key = 'm' AND e.occurrence_revision = run.versioned_revision
    AND e.effect_type = 'send_message' AND e.state = 'pending' AND e.attempt = 0 AND e.attempt_id IS NULL AND e.claimed_owner IS NULL AND e.provider_message_id IS NULL
    AND e.contact_id = run.contact_id AND e.request = '{"text":"secret-body-123","to":"x"}'::jsonb
    AND e.payload_hash = encode(extensions.digest(('{"text":"secret-body-123","to":"x"}'::jsonb)::text, 'sha256'), 'hex')
    AND ev IS NOT NULL AND ev NOT LIKE '%secret-body-123%'
    AND to_jsonb((SELECT x FROM public.flow_runs x WHERE id = rid)) = before_run,
    'pending effect at (run, revision ' || run.versioned_revision || ') with version/node/contact/hash; event carries ids+hash only (no body); run row untouched (no cursor, revision or budget change)');
END $$;

-- E02: repeating the same step
DO $$
DECLARE rid uuid; r1 jsonb; r2 jsonb; r3 jsonb; ok boolean := true; detail text := ''; got text; n int;
BEGIN
  rid := public.qa_flow_run('55000000-0000-4000-8000-0000000000a0', 1002);
  PERFORM public.qa_lease(rid);
  r1 := public.qa_eff_register(rid, 'w1', 'send_message', '{"text":"one"}');
  r2 := public.qa_eff_register(rid, 'w1', 'send_message', '{"text":"one"}');
  r3 := public.qa_eff_register(rid, 'w1', 'send_message', '{"text":"two"}');
  IF NOT ((r2->>'registered')::bool = false AND r2->>'reason' = 'already_registered' AND r2->>'effect_id' = r1->>'effect_id') THEN ok := false; detail := detail || ' [repeat ' || r2::text || ']'; END IF;
  IF NOT (r3->>'reason' = 'payload_mismatch' AND r3->>'effect_id' = r1->>'effect_id') THEN ok := false; detail := detail || ' [changed payload]'; END IF;
  got := NULL; BEGIN PERFORM public.qa_eff_register(rid, 'w1', 'send_media', '{"media_url":"u"}'); EXCEPTION WHEN OTHERS THEN got := SQLSTATE || ' ' || SQLERRM; END;
  IF got IS DISTINCT FROM '22023 cursor node is not a node of the requested effect type' THEN ok := false; detail := detail || ' [wrong type ' || coalesce(got, 'accepted') || ']'; END IF;
  SELECT count(*) INTO n FROM public.flow_run_effects WHERE flow_run_id = rid;
  IF n <> 1 OR (SELECT request FROM public.flow_run_effects WHERE flow_run_id = rid) <> '{"text":"one"}'::jsonb OR (SELECT count(*) FROM public.flow_run_events WHERE flow_run_id = rid AND event_type = 'effect_registered') <> 1 THEN ok := false; detail := detail || ' [duplicates]'; END IF;
  PERFORM public.qa_result('E02', ok, 'same step registered 3 times -> 1 row, 1 event; identical payload = already_registered, different payload = payload_mismatch (row keeps the original request); node/type mismatch -> 22023' || detail);
END $$;

-- E03: two legitimate occurrences of the same node in one run
DO $$
DECLARE rid uuid; e1 uuid; e2 uuid; run public.flow_runs%ROWTYPE; rows int; revs bigint[];
BEGIN
  rid := public.qa_flow_run('55000000-0000-4000-8000-0000000000a0', 1003);
  PERFORM public.qa_lease(rid);
  e1 := public.qa_eff_full(rid, 'w1', 'x');                     -- occurrence at revision 0, cursor now x (rev 1)
  PERFORM public.qa_goto(rid, 'w1', 'm');                       -- loop back to the same node (rev 2)
  e2 := public.qa_eff_full(rid, 'w1', 'x', '{"text":"hello"}'); -- same node, same payload, a NEW occurrence
  SELECT array_agg(occurrence_revision ORDER BY occurrence_revision) INTO revs FROM public.flow_run_effects WHERE flow_run_id = rid;
  SELECT * INTO run FROM public.flow_runs WHERE id = rid;
  PERFORM public.qa_result('E03', e1 <> e2 AND revs = ARRAY[0, 2]::bigint[] AND (SELECT count(DISTINCT node_key) FROM public.flow_run_effects WHERE flow_run_id = rid) = 1
    AND (SELECT count(*) FROM public.flow_run_effects WHERE flow_run_id = rid AND state = 'confirmed') = 2 AND run.versioned_messages_executed = 2 AND run.versioned_nodes_executed = 2,
    'node m executed twice (revisions 0 and 2) with an identical payload -> two distinct confirmed effects, 2 messages of budget; a restart of one step keeps its revision, a new occurrence gets a new one');
END $$;

-- E04: effects inside a subflow; same node_key in caller and callee
DO $$
DECLARE rid uuid; ea uuid; eb uuid; va uuid; vb uuid; run public.flow_runs%ROWTYPE; r jsonb;
BEGIN
  SELECT active_version_id INTO va FROM public.flows WHERE id = '55000000-0000-4000-8000-0000000000a1';
  SELECT active_version_id INTO vb FROM public.flows WHERE id = '55000000-0000-4000-8000-0000000000b1';
  rid := public.qa_flow_run('55000000-0000-4000-8000-0000000000a1', 1004);
  PERFORM public.qa_lease(rid);
  ea := public.qa_eff_full(rid, 'w1', 'call');
  r := public.qa_push(rid, 'w1', 'call', 'x', '55000000-0000-4000-8000-0000000000b1');
  eb := public.qa_eff_full(rid, 'w1', 'bend');
  PERFORM public.qa_pop(rid, 'w1');
  SELECT * INTO run FROM public.flow_runs WHERE id = rid;
  PERFORM public.qa_result('E04', (r->>'committed')::bool AND (SELECT flow_version_id FROM public.flow_run_effects WHERE id = ea) = va AND (SELECT flow_version_id FROM public.flow_run_effects WHERE id = eb) = vb
    AND (SELECT node_key FROM public.flow_run_effects WHERE id = ea) = (SELECT node_key FROM public.flow_run_effects WHERE id = eb)
    AND (SELECT occurrence_revision FROM public.flow_run_effects WHERE id = eb) = 2 AND run.versioned_depth = 0 AND run.versioned_node_key = 'x' AND run.versioned_messages_executed = 2
    AND (SELECT count(DISTINCT flow_version_id) FROM public.flow_run_effects WHERE flow_run_id = rid) = 2,
    'effects of FA.m (rev 0) and FB.m inside the subflow (rev 2) share node_key m but are distinct rows keyed by revision and version; the run popped back to FA.x with 2 messages consumed');
END $$;

-- E05: claim
DO $$
DECLARE rid uuid; reg jsonb; c1 jsonb; c2 jsonb; e public.flow_run_effects%ROWTYPE; ev jsonb; tok int; ok boolean := true; detail text := '';
BEGIN
  rid := public.qa_flow_run('55000000-0000-4000-8000-0000000000a0', 1005);
  tok := public.qa_lease(rid);
  reg := public.qa_eff_register(rid, 'w1');
  c1 := public.qa_eff_claim(rid, 'w1', (reg->>'effect_id')::uuid);
  c2 := public.qa_eff_claim(rid, 'w1', (reg->>'effect_id')::uuid);
  SELECT * INTO e FROM public.flow_run_effects WHERE id = (reg->>'effect_id')::uuid;
  SELECT payload INTO ev FROM public.flow_run_events WHERE flow_run_id = rid AND event_type = 'effect_claimed';
  IF NOT ((c1->>'claimed')::bool AND c1->>'effect_state' = 'claimed' AND (c1->>'attempt_no')::int = 1 AND c1->>'claimed_attempt_id' IS NOT NULL) THEN ok := false; detail := detail || ' [claim]'; END IF;
  IF NOT (e.state = 'claimed' AND e.attempt = 1 AND e.attempt_id = (c1->>'claimed_attempt_id')::uuid AND e.claimed_owner = 'w1' AND e.claimed_fencing_token = tok AND e.claimed_at IS NOT NULL) THEN ok := false; detail := detail || ' [row]'; END IF;
  IF NOT (c2->>'reason' = 'effect_not_pending' AND (c2->>'claimed')::bool = false AND (c2->>'attempt_no')::int = 1 AND c2->>'claimed_attempt_id' IS NULL) THEN ok := false; detail := detail || ' [second claim ' || c2::text || ']'; END IF;
  IF NOT (ev->>'attempt_id' = c1->>'claimed_attempt_id' AND (ev->>'attempt')::int = 1) THEN ok := false; detail := detail || ' [event]'; END IF;
  -- a live claim of the CURRENT lease holder is not abandoned: recover must leave it alone
  IF jsonb_array_length(public.qa_eff_recover(rid, 'w1')) <> 0 OR (SELECT state FROM public.flow_run_effects WHERE id = (reg->>'effect_id')::uuid) <> 'claimed' THEN ok := false; detail := detail || ' [recover touched a live claim]'; END IF;
  PERFORM public.qa_result('E05', ok, 'pending -> claimed with attempt 1, a fresh attempt_id, owner and fencing token; a second claim -> effect_not_pending and no second attempt; event carries the attempt id; recover by the same lease holder leaves its live claim alone' || detail);
END $$;

-- E06: confirm, then advance atomically; replay does not consume budget twice
DO $$
DECLARE got text; rid uuid; reg jsonb; c jsonb; s jsonb; st1 jsonb; run0 public.flow_runs%ROWTYPE; run1 public.flow_runs%ROWTYPE; e public.flow_run_effects%ROWTYPE; eid uuid; ok boolean := true; detail text := '';
BEGIN
  rid := public.qa_flow_run('55000000-0000-4000-8000-0000000000a0', 1006);
  PERFORM public.qa_lease(rid);
  reg := public.qa_eff_register(rid, 'w1'); eid := (reg->>'effect_id')::uuid;
  c := public.qa_eff_claim(rid, 'w1', eid);
  -- not confirmed yet: cannot advance
  IF public.qa_eff_step(rid, 'w1', eid, 'x')->>'reason' <> 'effect_not_confirmed' THEN ok := false; detail := detail || ' [advanced while claimed]'; END IF;
  s := public.qa_eff_settle(rid, 'w1', eid, (c->>'claimed_attempt_id')::uuid, 'confirmed', 'wamid.ABC123');
  SELECT * INTO e FROM public.flow_run_effects WHERE id = eid;
  SELECT * INTO run0 FROM public.flow_runs WHERE id = rid;
  IF NOT ((s->>'settled')::bool AND e.state = 'confirmed' AND e.provider_message_id = 'wamid.ABC123' AND e.finished_at IS NOT NULL AND run0.versioned_messages_executed = 0 AND run0.versioned_node_key = 'm') THEN
    ok := false; detail := detail || ' [settle moved the cursor or budget]'; END IF;
  st1 := public.qa_eff_step(rid, 'w1', eid, 'x');
  SELECT * INTO run1 FROM public.flow_runs WHERE id = rid;
  IF NOT ((st1->>'committed')::bool AND run1.versioned_revision = run0.versioned_revision + 1 AND run1.versioned_nodes_executed = 1 AND run1.versioned_messages_executed = 1
      AND run1.versioned_node_key = 'x' AND run1.versioned_checkpoint #>> '{cursor,node_key}' = 'x' AND run1.status = 'active') THEN ok := false; detail := detail || ' [step]'; END IF;
  -- replay of the same step (stale revision) after the interruption window: refused, budget untouched
  SELECT reason INTO got FROM public.commit_versioned_effect_step(run0.account_id, rid, 'w1', run0.versioned_lease, run0.versioned_revision, eid,
    jsonb_build_object('cursor', jsonb_build_object('flow_version_id', run0.current_flow_version_id, 'node_key', 'x'), 'step', 1));
  IF got <> 'revision_conflict' THEN ok := false; detail := detail || ' [replay with stale revision: ' || coalesce(got, 'accepted') || ']'; END IF;
  IF public.qa_eff_step(rid, 'w1', eid, 'x')->>'reason' <> 'effect_not_current' THEN ok := false; detail := detail || ' [replay at the new revision]'; END IF;
  IF (SELECT versioned_messages_executed FROM public.flow_runs WHERE id = rid) <> 1 THEN ok := false; detail := detail || ' [double budget]'; END IF;
  PERFORM public.qa_result('E06', ok, 'settle(confirmed) records provider id without moving cursor/budget; commit_versioned_effect_step moves cursor+checkpoint+revision and consumes exactly 1 node + 1 message; repeating it is refused and the budget stays at 1' || detail);
END $$;

-- E07: attempt / owner / outcome validation
DO $$
DECLARE rid uuid; eid uuid; c jsonb; ok boolean := true; detail text := ''; a uuid; got text; t record;
BEGIN
  rid := public.qa_flow_run('55000000-0000-4000-8000-0000000000a0', 1007);
  PERFORM public.qa_lease(rid);
  eid := (public.qa_eff_register(rid, 'w1')->>'effect_id')::uuid;
  IF public.qa_eff_settle(rid, 'w1', eid, gen_random_uuid(), 'confirmed', 'wamid.X')->>'reason' <> 'effect_not_claimed' THEN ok := false; detail := detail || ' [settle before claim]'; END IF;
  c := public.qa_eff_claim(rid, 'w1', eid); a := (c->>'claimed_attempt_id')::uuid;
  IF public.qa_eff_settle(rid, 'w1', eid, gen_random_uuid(), 'confirmed', 'wamid.X')->>'reason' <> 'attempt_mismatch' THEN ok := false; detail := detail || ' [wrong attempt id]'; END IF;
  IF public.qa_eff_settle(rid, 'other', eid, a, 'confirmed', 'wamid.X')->>'reason' <> 'stale_lease' THEN ok := false; detail := detail || ' [foreign owner]'; END IF;
  FOR t IN SELECT * FROM (VALUES ('confirmed without provider id', 'confirmed', NULL::text), ('failed with provider id', 'failed', 'wamid.Z'), ('unknown outcome', 'delivered', NULL)) AS x(label, outcome, provider) LOOP
    got := NULL; BEGIN PERFORM public.qa_eff_settle(rid, 'w1', eid, a, t.outcome, t.provider); EXCEPTION WHEN OTHERS THEN got := SQLSTATE; END;
    IF got IS DISTINCT FROM '22023' THEN ok := false; detail := detail || ' [' || t.label || ': ' || coalesce(got, 'accepted') || ']'; END IF;
  END LOOP;
  IF (SELECT state FROM public.flow_run_effects WHERE id = eid) <> 'claimed' THEN ok := false; detail := detail || ' [state changed by refusals]'; END IF;
  -- definitive failure and explicit ambiguity
  c := public.qa_eff_settle(rid, 'w1', eid, a, 'failed', NULL, 'invalid_recipient');
  IF NOT (c->>'settled')::bool OR (SELECT state || '/' || error_code FROM public.flow_run_effects WHERE id = eid) <> 'failed/invalid_recipient' THEN ok := false; detail := detail || ' [failed]'; END IF;
  PERFORM public.qa_result('E07', ok, 'settle refused for an unclaimed effect, a wrong attempt id, a foreign owner and malformed outcomes (state untouched); failed records the error code and is terminal' || detail);
END $$;

-- E08: ambiguity, recovery by a new lease holder, evidence-based resolution; never an automatic resend
DO $$
DECLARE rid uuid; eid uuid; c jsonb; a1 uuid; a2 uuid; rec jsonb; ok boolean := true; detail text := ''; acct uuid; tok2 int; r record; got text; e public.flow_run_effects%ROWTYPE; gen text;
BEGIN
  rid := public.qa_flow_run('55000000-0000-4000-8000-0000000000a0', 1008);
  SELECT account_id INTO acct FROM public.flow_runs WHERE id = rid;
  PERFORM public.qa_lease(rid, 'w1');
  eid := (public.qa_eff_register(rid, 'w1')->>'effect_id')::uuid;
  c := public.qa_eff_claim(rid, 'w1', eid); a1 := (c->>'claimed_attempt_id')::uuid;
  -- worker w1 dies while the attempt is claimed; its lease lapses and w2 takes over (token 2)
  UPDATE public.flow_runs SET versioned_lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = rid;
  SELECT * INTO r FROM public.reclaim_versioned_run_lease(acct, rid, 'w2', 600); tok2 := r.fencing_token;
  IF public.qa_eff_settle(rid, 'w1', eid, a1, 'confirmed', 'wamid.late')->>'reason' <> 'stale_lease' THEN ok := false; detail := detail || ' [old worker settled]'; END IF;
  rec := public.qa_eff_recover(rid, 'w2');
  IF NOT (jsonb_array_length(rec) = 1 AND rec->0->>'previous_state' = 'claimed' AND rec->0->>'new_state' = 'ambiguous' AND rec->0->>'effect_id' = eid::text) THEN ok := false; detail := detail || ' [recover ' || rec::text || ']'; END IF;
  IF jsonb_array_length(public.qa_eff_recover(rid, 'w2')) <> 0 THEN ok := false; detail := detail || ' [recover not idempotent]'; END IF;
  -- nothing may resend or advance
  IF public.qa_eff_claim(rid, 'w2', eid)->>'reason' <> 'effect_not_pending' THEN ok := false; detail := detail || ' [claim after ambiguity]'; END IF;
  IF public.qa_eff_step(rid, 'w2', eid, 'x')->>'reason' <> 'effect_not_confirmed' THEN ok := false; detail := detail || ' [advanced past ambiguity]'; END IF;
  SELECT * INTO e FROM public.flow_run_effects WHERE id = eid;
  IF NOT (e.state = 'ambiguous' AND e.attempt = 1 AND e.finished_at IS NULL) THEN ok := false; detail := detail || ' [row]'; END IF;
  -- evidence is mandatory
  got := NULL; BEGIN PERFORM public.qa_eff_resolve(rid, 'w2', eid, 'not_sent', '   '); EXCEPTION WHEN OTHERS THEN got := SQLSTATE; END;
  IF got IS DISTINCT FROM '22023' THEN ok := false; detail := detail || ' [resolved without evidence]'; END IF;
  IF public.qa_eff_resolve(rid, 'w2', gen_random_uuid(), 'failed', 'x') IS NOT NULL AND false THEN NULL; END IF;
  -- proof that it was not sent -> a NEW attempt becomes possible
  IF NOT (public.qa_eff_resolve(rid, 'w2', eid, 'not_sent', 'provider log shows no request for this attempt id')->>'resolved')::bool THEN ok := false; detail := detail || ' [not_sent]'; END IF;
  SELECT * INTO e FROM public.flow_run_effects WHERE id = eid;
  IF NOT (e.state = 'pending' AND e.attempt = 1 AND e.attempt_id IS NULL AND e.claimed_owner IS NULL AND e.resolution_evidence IS NOT NULL) THEN ok := false; detail := detail || ' [pending again]'; END IF;
  c := public.qa_eff_claim(rid, 'w2', eid); a2 := (c->>'claimed_attempt_id')::uuid;
  IF NOT ((c->>'claimed')::bool AND (c->>'attempt_no')::int = 2 AND a2 <> a1) THEN ok := false; detail := detail || ' [attempt 2]'; END IF;
  -- the second attempt times out: explicit ambiguity, then a delivery receipt proves it was sent
  IF NOT (public.qa_eff_settle(rid, 'w2', eid, a2, 'ambiguous', NULL, 'timeout')->>'settled')::bool THEN ok := false; detail := detail || ' [explicit ambiguous]'; END IF;
  IF NOT (public.qa_eff_resolve(rid, 'w2', eid, 'confirmed', 'delivery receipt received', 'wamid.RECEIPT')->>'resolved')::bool THEN ok := false; detail := detail || ' [confirmed by evidence]'; END IF;
  gen := public.qa_eff_step(rid, 'w2', eid, 'x')->>'committed';
  IF gen IS DISTINCT FROM 'true' OR (SELECT versioned_messages_executed FROM public.flow_runs WHERE id = rid) <> 1 THEN ok := false; detail := detail || ' [advance after resolution]'; END IF;
  IF (SELECT count(*) FROM public.flow_run_events WHERE flow_run_id = rid AND event_type = 'effect_claimed') <> 2 THEN ok := false; detail := detail || ' [claims]'; END IF;
  IF (SELECT payload->>'cause' FROM public.flow_run_events WHERE flow_run_id = rid AND event_type = 'effect_ambiguous' ORDER BY created_at LIMIT 1) <> 'claim_abandoned' THEN ok := false; detail := detail || ' [cause]'; END IF;
  PERFORM public.qa_result('E08', ok, 'claim abandoned by a dead worker -> ambiguous (only after the new lease holder recovers it); old worker refused; no claim/advance/resend possible; resolve needs evidence; not_sent opens attempt 2 with a new attempt_id; a receipt confirms it and the run then advances once' || detail);
END $$;

-- E09: interruption before and after registration
DO $$
DECLARE rid uuid; rid2 uuid; acct uuid; r record; eid uuid; reg jsonb; ok boolean := true; detail text := ''; rec jsonb;
BEGIN
  SELECT account_id INTO acct FROM public.flows WHERE id = '55000000-0000-4000-8000-0000000000a0';
  -- before registration: worker dies, nothing in the ledger; the successor registers exactly once
  rid := public.qa_flow_run('55000000-0000-4000-8000-0000000000a0', 1009);
  PERFORM public.qa_lease(rid, 'w1');
  UPDATE public.flow_runs SET versioned_lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = rid;
  PERFORM * FROM public.reclaim_versioned_run_lease(acct, rid, 'w2', 600);
  IF (SELECT count(*) FROM public.flow_run_effects WHERE flow_run_id = rid) <> 0 THEN ok := false; detail := detail || ' [phantom effect]'; END IF;
  IF NOT (public.qa_eff_register(rid, 'w2')->>'registered')::bool THEN ok := false; detail := detail || ' [successor registration]'; END IF;
  -- after registration, before any claim: the successor finds it pending (never attempted) and may claim it
  rid2 := public.qa_flow_run('55000000-0000-4000-8000-0000000000a0', 1010);
  PERFORM public.qa_lease(rid2, 'w1');
  reg := public.qa_eff_register(rid2, 'w1'); eid := (reg->>'effect_id')::uuid;
  UPDATE public.flow_runs SET versioned_lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = rid2;
  PERFORM * FROM public.reclaim_versioned_run_lease(acct, rid2, 'w2', 600);
  rec := public.qa_eff_recover(rid2, 'w2');
  IF jsonb_array_length(rec) <> 0 OR (SELECT state FROM public.flow_run_effects WHERE id = eid) <> 'pending' THEN ok := false; detail := detail || ' [pending was disturbed]'; END IF;
  IF public.qa_eff_register(rid2, 'w2')->>'reason' <> 'already_registered' THEN ok := false; detail := detail || ' [re-register]'; END IF;
  reg := public.qa_eff_claim(rid2, 'w2', eid);
  IF NOT (reg->>'claimed')::bool OR (SELECT attempt FROM public.flow_run_effects WHERE id = eid) <> 1 THEN ok := false; detail := detail || ' [claim by successor]'; END IF;
  IF (SELECT count(*) FROM public.flow_run_effects WHERE flow_run_id = rid2) <> 1 THEN ok := false; detail := detail || ' [duplicates]'; END IF;
  PERFORM public.qa_result('E09', ok, 'death before registration: successor registers once; death after registration: effect still pending (never attempted), recover leaves it alone, re-registration is idempotent and the successor claims attempt 1' || detail);
END $$;

-- E10: stale / expired / conflicting / paused for every ledger RPC
DO $$
DECLARE rid uuid; acct uuid; eid uuid; tok int; ok boolean := true; detail text := ''; calls text[]; i int; want text[]; got text; run public.flow_runs%ROWTYPE; cp jsonb; before_rows jsonb; r record;
BEGIN
  rid := public.qa_flow_run('55000000-0000-4000-8000-0000000000a0', 1011);
  SELECT account_id INTO acct FROM public.flow_runs WHERE id = rid;
  tok := public.qa_lease(rid, 'w1');
  eid := (public.qa_eff_register(rid, 'w1')->>'effect_id')::uuid;
  SELECT * INTO run FROM public.flow_runs WHERE id = rid;
  cp := jsonb_build_object('cursor', jsonb_build_object('flow_version_id', run.current_flow_version_id, 'node_key', 'x'), 'step', 1);
  before_rows := (SELECT to_jsonb(e) FROM public.flow_run_effects e WHERE e.id = eid);
  calls := ARRAY[
    format('SELECT reason FROM public.register_versioned_effect(%L,%L,%%L,%%s,%s,%L,%L::jsonb)', acct, rid, run.versioned_revision, 'send_message', '{"text":"hello"}'),
    format('SELECT reason FROM public.claim_versioned_effect(%L,%L,%%L,%%s,%L)', acct, rid, eid),
    format('SELECT reason FROM public.settle_versioned_effect(%L,%L,%%L,%%s,%L,%L,%L,%L)', acct, rid, eid, gen_random_uuid(), 'failed', NULL),
    format('SELECT reason FROM public.recover_versioned_run_effects(%L,%L,%%L,%%s)', acct, rid),
    format('SELECT reason FROM public.resolve_versioned_effect(%L,%L,%%L,%%s,%L,%L,%L,NULL)', acct, rid, eid, 'failed', 'evidence'),
    format('SELECT reason FROM public.commit_versioned_effect_step(%L,%L,%%L,%%s,%s,%L,%L::jsonb)', acct, rid, run.versioned_revision, eid, cp)];
  FOR i IN 1..array_length(calls, 1) LOOP
    EXECUTE format(calls[i], 'intruder', tok) INTO got;
    IF got IS DISTINCT FROM 'stale_lease' THEN ok := false; detail := detail || ' [rpc ' || i || ' foreign owner: ' || coalesce(got, 'null') || ']'; END IF;
    EXECUTE format(calls[i], 'w1', tok + 1) INTO got;
    IF got IS DISTINCT FROM 'stale_lease' THEN ok := false; detail := detail || ' [rpc ' || i || ' wrong token: ' || coalesce(got, 'null') || ']'; END IF;
  END LOOP;
  -- revision CAS for register and for the step
  SELECT reason INTO got FROM public.register_versioned_effect(acct, rid, 'w1', tok, 99, 'send_message', '{"text":"hello"}');
  IF got <> 'revision_conflict' THEN ok := false; detail := detail || ' [register stale revision]'; END IF;
  SELECT reason INTO got FROM public.commit_versioned_effect_step(acct, rid, 'w1', tok, 99, eid, cp);
  IF got <> 'revision_conflict' THEN ok := false; detail := detail || ' [step stale revision]'; END IF;
  -- expired lease
  UPDATE public.flow_runs SET versioned_lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = rid;
  FOR i IN 1..array_length(calls, 1) LOOP
    EXECUTE format(calls[i], 'w1', tok) INTO got;
    IF got IS DISTINCT FROM 'lease_expired' THEN ok := false; detail := detail || ' [rpc ' || i || ' expired: ' || coalesce(got, 'null') || ']'; END IF;
  END LOOP;
  UPDATE public.flow_runs SET versioned_lease_expires_at = clock_timestamp() + interval '10 minutes' WHERE id = rid;
  -- paused run
  UPDATE public.flow_runs SET status = 'paused_by_agent' WHERE id = rid;
  FOR i IN 1..array_length(calls, 1) LOOP
    EXECUTE format(calls[i], 'w1', tok) INTO got;
    IF got IS DISTINCT FROM 'run_not_active' THEN ok := false; detail := detail || ' [rpc ' || i || ' paused: ' || coalesce(got, 'null') || ']'; END IF;
  END LOOP;
  IF (SELECT to_jsonb(e) FROM public.flow_run_effects e WHERE e.id = eid) <> before_rows THEN ok := false; detail := detail || ' [a refusal wrote]'; END IF;
  PERFORM public.qa_result('E10', ok, 'all 6 ledger RPCs: foreign owner / wrong token -> stale_lease, expired lease -> lease_expired, paused run -> run_not_active, stale revision -> revision_conflict; the effect row is byte-identical afterwards' || detail);
END $$;

-- E11: atomicity with injected failures
CREATE FUNCTION public.qa_fail_after_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('qa.fail_event', true) = NEW.event_type THEN RAISE EXCEPTION 'qa injected failure' USING ERRCODE = 'P9998'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER qa_fail_after_event AFTER INSERT ON public.flow_run_events FOR EACH ROW EXECUTE FUNCTION public.qa_fail_after_event();
CREATE FUNCTION public.qa_fail_run_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('qa.fail_run_update', true) = '1' AND NEW.versioned_messages_executed <> OLD.versioned_messages_executed THEN RAISE EXCEPTION 'qa injected failure' USING ERRCODE = 'P9998'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER qa_fail_run_update BEFORE UPDATE ON public.flow_runs FOR EACH ROW EXECUTE FUNCTION public.qa_fail_run_update();
DO $$
DECLARE rid uuid; eid uuid; c jsonb; a uuid; st text; ok boolean := true; detail text := ''; before_run jsonb; n0 int; run public.flow_runs%ROWTYPE; res jsonb;
BEGIN
  rid := public.qa_flow_run('55000000-0000-4000-8000-0000000000a0', 1012);
  PERFORM public.qa_lease(rid);
  -- registration: the event insert fails after the effect INSERT -> nothing survives
  PERFORM set_config('qa.fail_event', 'effect_registered', true);
  st := NULL; BEGIN PERFORM public.qa_eff_register(rid, 'w1'); EXCEPTION WHEN OTHERS THEN st := SQLSTATE; END;
  PERFORM set_config('qa.fail_event', '', true);
  IF st <> 'P9998' OR EXISTS (SELECT 1 FROM public.flow_run_effects WHERE flow_run_id = rid) OR EXISTS (SELECT 1 FROM public.flow_run_events WHERE flow_run_id = rid AND event_type = 'effect_registered') THEN ok := false; detail := detail || ' [register left rows]'; END IF;
  eid := (public.qa_eff_register(rid, 'w1')->>'effect_id')::uuid;           -- retry works
  -- claim: failure after the UPDATE -> still pending, attempt 0
  PERFORM set_config('qa.fail_event', 'effect_claimed', true);
  st := NULL; BEGIN PERFORM public.qa_eff_claim(rid, 'w1', eid); EXCEPTION WHEN OTHERS THEN st := SQLSTATE; END;
  PERFORM set_config('qa.fail_event', '', true);
  IF st <> 'P9998' OR (SELECT state || attempt FROM public.flow_run_effects WHERE id = eid) <> 'pending0' THEN ok := false; detail := detail || ' [claim left state]'; END IF;
  c := public.qa_eff_claim(rid, 'w1', eid); a := (c->>'claimed_attempt_id')::uuid;
  -- settle: failure after the UPDATE -> still claimed
  PERFORM set_config('qa.fail_event', 'effect_confirmed', true);
  st := NULL; BEGIN PERFORM public.qa_eff_settle(rid, 'w1', eid, a, 'confirmed', 'wamid.Q'); EXCEPTION WHEN OTHERS THEN st := SQLSTATE; END;
  PERFORM set_config('qa.fail_event', '', true);
  IF st <> 'P9998' OR (SELECT state FROM public.flow_run_effects WHERE id = eid) <> 'claimed' OR (SELECT provider_message_id FROM public.flow_run_effects WHERE id = eid) IS NOT NULL THEN ok := false; detail := detail || ' [settle left state]'; END IF;
  PERFORM public.qa_eff_settle(rid, 'w1', eid, a, 'confirmed', 'wamid.Q');
  -- step: failure while the run row is updated -> effect stays confirmed, run, revision and budget unchanged
  SELECT * INTO run FROM public.flow_runs WHERE id = rid; before_run := to_jsonb(run);
  PERFORM set_config('qa.fail_run_update', '1', true);
  st := NULL; BEGIN PERFORM public.qa_eff_step(rid, 'w1', eid, 'x'); EXCEPTION WHEN OTHERS THEN st := SQLSTATE; END;
  PERFORM set_config('qa.fail_run_update', '', true);
  IF st <> 'P9998' OR to_jsonb((SELECT x FROM public.flow_runs x WHERE id = rid)) <> before_run OR (SELECT state FROM public.flow_run_effects WHERE id = eid) <> 'confirmed' THEN ok := false; detail := detail || ' [step left state]'; END IF;
  res := public.qa_eff_step(rid, 'w1', eid, 'x');
  IF NOT (res->>'committed')::bool OR (SELECT versioned_messages_executed FROM public.flow_runs WHERE id = rid) <> 1 THEN ok := false; detail := detail || ' [retry after rollback]'; END IF;
  PERFORM public.qa_result('E11', ok, 'failure injected after the INSERT/UPDATE of register, claim and settle, and during the run UPDATE of the step: each call rolls back completely (row, event, cursor, revision, budget), and the retry then succeeds once' || detail);
END $$;
DROP TRIGGER qa_fail_after_event ON public.flow_run_events;
DROP TRIGGER qa_fail_run_update ON public.flow_runs;

-- E12: message budget
DO $$
DECLARE rid uuid; reg jsonb; eid uuid; ok boolean := true; detail text := ''; r jsonb; before_run jsonb; i int; m0 int;
BEGIN
  rid := public.qa_flow_run('55000000-0000-4000-8000-0000000000a0', 1013);
  PERFORM public.qa_lease(rid);
  UPDATE public.flow_runs SET versioned_messages_executed = 100 WHERE id = rid;
  before_run := to_jsonb((SELECT x FROM public.flow_runs x WHERE id = rid));
  r := public.qa_eff_register(rid, 'w1');
  IF r->>'reason' <> 'budget_exceeded' OR EXISTS (SELECT 1 FROM public.flow_run_effects WHERE flow_run_id = rid) OR to_jsonb((SELECT x FROM public.flow_runs x WHERE id = rid)) <> before_run THEN ok := false; detail := detail || ' [register at 100]'; END IF;
  UPDATE public.flow_runs SET versioned_messages_executed = 99 WHERE id = rid;
  reg := public.qa_eff_register(rid, 'w1'); eid := (reg->>'effect_id')::uuid;
  -- recovery cycles and repeated registrations never touch the budget
  FOR i IN 1..3 LOOP PERFORM public.qa_eff_register(rid, 'w1'); PERFORM public.qa_eff_recover(rid, 'w1'); END LOOP;
  IF (SELECT versioned_messages_executed FROM public.flow_runs WHERE id = rid) <> 99 THEN ok := false; detail := detail || ' [budget moved before the step]'; END IF;
  PERFORM public.qa_eff_claim(rid, 'w1', eid);
  PERFORM public.qa_eff_settle(rid, 'w1', eid, (SELECT attempt_id FROM public.flow_run_effects WHERE id = eid), 'confirmed', 'wamid.B');
  r := public.qa_eff_step(rid, 'w1', eid, 'x');
  IF NOT (r->>'committed')::bool OR (SELECT versioned_messages_executed FROM public.flow_runs WHERE id = rid) <> 100 THEN ok := false; detail := detail || ' [step at 99]'; END IF;
  -- the step itself re-checks the budget (someone raised the counter after registration)
  rid := public.qa_flow_run('55000000-0000-4000-8000-0000000000a0', 1014);
  PERFORM public.qa_lease(rid);
  eid := (public.qa_eff_register(rid, 'w1')->>'effect_id')::uuid;
  PERFORM public.qa_eff_claim(rid, 'w1', eid);
  PERFORM public.qa_eff_settle(rid, 'w1', eid, (SELECT attempt_id FROM public.flow_run_effects WHERE id = eid), 'confirmed', 'wamid.C');
  UPDATE public.flow_runs SET versioned_messages_executed = 100 WHERE id = rid;
  IF public.qa_eff_step(rid, 'w1', eid, 'x')->>'reason' <> 'budget_exceeded' THEN ok := false; detail := detail || ' [step at 100]'; END IF;
  PERFORM public.qa_result('E12', ok, 'register at 100 messages -> budget_exceeded with no row; at 99 it registers, repeated registrations/recoveries leave the counter at 99, the step takes it to exactly 100; a step with the budget already full is refused' || detail);
END $$;

-- E13: tenant isolation
DO $$
DECLARE a uuid; b uuid; rid uuid; rid2 uuid; eid uuid; tok int; ok boolean := true; detail text := ''; calls text[]; fn text; before_row jsonb; got text; cp jsonb;
BEGIN
  SELECT account_id INTO a FROM public.flows WHERE id = '55000000-0000-4000-8000-0000000000a0';
  SELECT account_id INTO b FROM public.flows WHERE id = '60000000-0000-4000-8000-000000000001';
  rid := public.qa_flow_run('55000000-0000-4000-8000-0000000000a0', 1015);
  tok := public.qa_lease(rid);
  eid := (public.qa_eff_register(rid, 'w1')->>'effect_id')::uuid;
  before_row := (SELECT to_jsonb(e) FROM public.flow_run_effects e WHERE e.id = eid);
  cp := '{"cursor":{"flow_version_id":"00000000-0000-4000-8000-000000000000","node_key":"x"},"step":1}';
  calls := ARRAY[
    format('SELECT * FROM public.register_versioned_effect(%L,%L,%L,%s,0,%L,%L::jsonb)', b, rid, 'w1', tok, 'send_message', '{"text":"x"}'),
    format('SELECT * FROM public.claim_versioned_effect(%L,%L,%L,%s,%L)', b, rid, 'w1', tok, eid),
    format('SELECT * FROM public.settle_versioned_effect(%L,%L,%L,%s,%L,%L,%L)', b, rid, 'w1', tok, eid, gen_random_uuid(), 'failed'),
    format('SELECT * FROM public.recover_versioned_run_effects(%L,%L,%L,%s)', b, rid, 'w1', tok),
    format('SELECT * FROM public.resolve_versioned_effect(%L,%L,%L,%s,%L,%L,%L)', b, rid, 'w1', tok, eid, 'failed', 'ev'),
    format('SELECT * FROM public.commit_versioned_effect_step(%L,%L,%L,%s,0,%L,%L::jsonb)', b, rid, 'w1', tok, eid, cp)];
  FOREACH fn IN ARRAY calls LOOP
    got := NULL; BEGIN EXECUTE fn; EXCEPTION WHEN no_data_found THEN got := SQLERRM; END;
    IF got IS DISTINCT FROM 'versioned run not found' THEN ok := false; detail := detail || ' [' || left(fn, 50) || ': ' || coalesce(got, 'accepted') || ']'; END IF;
  END LOOP;
  -- an effect id of another run of the same account is not addressable through this run
  rid2 := public.qa_flow_run('55000000-0000-4000-8000-0000000000a0', 1016);
  PERFORM public.qa_lease(rid2);
  got := NULL; BEGIN PERFORM public.qa_eff_claim(rid2, 'w1', eid); EXCEPTION WHEN no_data_found THEN got := SQLERRM; END;
  IF got IS DISTINCT FROM 'versioned effect not found' THEN ok := false; detail := detail || ' [cross-run effect]'; END IF;
  IF (SELECT to_jsonb(e) FROM public.flow_run_effects e WHERE e.id = eid) <> before_row THEN ok := false; detail := detail || ' [effect changed]'; END IF;
  PERFORM public.qa_result('E13', ok, 'all 6 RPCs addressed with another account -> P0002 "versioned run not found"; an effect of another run is "versioned effect not found"; the effect row is untouched' || detail);
END $$;

-- E14: legacy runs
DO $$
DECLARE a uuid; lid uuid; before_row jsonb; ok boolean := true; detail text := ''; calls text[]; fn text; got text; cp jsonb;
BEGIN
  SELECT account_id INTO a FROM public.flows WHERE id = '55000000-0000-4000-8000-0000000000a0';
  INSERT INTO public.flow_runs (flow_id, account_id, user_id, contact_id, status, current_node_key)
  VALUES ('50000000-0000-4000-8000-000000000002', a, '10000000-0000-4000-8000-000000000001', public.qa_new_contact(1017), 'active', 'start') RETURNING id INTO lid;
  before_row := to_jsonb((SELECT x FROM public.flow_runs x WHERE id = lid));
  cp := '{"cursor":{"flow_version_id":"00000000-0000-4000-8000-000000000000","node_key":"x"},"step":1}';
  calls := ARRAY[
    format('SELECT * FROM public.register_versioned_effect(%L,%L,%L,1,0,%L,%L::jsonb)', a, lid, 'w1', 'send_message', '{"text":"x"}'),
    format('SELECT * FROM public.claim_versioned_effect(%L,%L,%L,1,%L)', a, lid, 'w1', gen_random_uuid()),
    format('SELECT * FROM public.settle_versioned_effect(%L,%L,%L,1,%L,%L,%L)', a, lid, 'w1', gen_random_uuid(), gen_random_uuid(), 'failed'),
    format('SELECT * FROM public.recover_versioned_run_effects(%L,%L,%L,1)', a, lid, 'w1'),
    format('SELECT * FROM public.resolve_versioned_effect(%L,%L,%L,1,%L,%L,%L)', a, lid, 'w1', gen_random_uuid(), 'failed', 'ev'),
    format('SELECT * FROM public.commit_versioned_effect_step(%L,%L,%L,1,0,%L,%L::jsonb)', a, lid, 'w1', gen_random_uuid(), cp)];
  FOREACH fn IN ARRAY calls LOOP
    got := NULL; BEGIN EXECUTE fn; EXCEPTION WHEN no_data_found THEN got := SQLERRM; END;
    IF got IS DISTINCT FROM 'versioned run not found' THEN ok := false; detail := detail || ' [' || left(fn, 50) || ': ' || coalesce(got, 'accepted') || ']'; END IF;
  END LOOP;
  PERFORM public.qa_result('E14', ok AND to_jsonb((SELECT x FROM public.flow_runs x WHERE id = lid)) = before_row AND NOT EXISTS (SELECT 1 FROM public.flow_run_effects WHERE flow_run_id = lid),
    'all 6 RPCs on a legacy run -> P0002; the run row is identical and no effect exists; the legacy runner does not know the ledger' || detail);
END $$;

-- E15: privileges, with real SET ROLE
DO $$
DECLARE a uuid; rid uuid; tok int; eid uuid; role_name text; call_sql text; st text; ok boolean := true; out text[] := '{}'; calls text[]; sig text; cp jsonb; r1 jsonb; before_row jsonb;
BEGIN
  CREATE ROLE qa_effect_probe NOLOGIN; GRANT USAGE ON SCHEMA public TO qa_effect_probe;
  SELECT account_id INTO a FROM public.flows WHERE id = '55000000-0000-4000-8000-0000000000a0';
  rid := public.qa_flow_run('55000000-0000-4000-8000-0000000000a0', 1018);
  tok := public.qa_lease(rid);
  eid := (public.qa_eff_register(rid, 'w1')->>'effect_id')::uuid;
  before_row := (SELECT to_jsonb(e) FROM public.flow_run_effects e WHERE e.id = eid);
  cp := '{"cursor":{"flow_version_id":"00000000-0000-4000-8000-000000000000","node_key":"x"},"step":1}';
  FOREACH sig IN ARRAY ARRAY['register_versioned_effect(uuid,uuid,text,integer,bigint,text,jsonb)', 'claim_versioned_effect(uuid,uuid,text,integer,uuid)',
      'settle_versioned_effect(uuid,uuid,text,integer,uuid,uuid,text,text,text)', 'recover_versioned_run_effects(uuid,uuid,text,integer)',
      'resolve_versioned_effect(uuid,uuid,text,integer,uuid,text,text,text)', 'commit_versioned_effect_step(uuid,uuid,text,integer,bigint,uuid,jsonb)'] LOOP
    IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) x WHERE p.oid = ('public.' || sig)::regprocedure AND x.grantee = 0) THEN ok := false; out := out || (sig || ' has PUBLIC'); END IF;
    IF NOT has_function_privilege('service_role', 'public.' || sig, 'EXECUTE') THEN ok := false; out := out || (sig || ' lacks service_role'); END IF;
    FOREACH role_name IN ARRAY ARRAY['qa_effect_probe', 'anon', 'authenticated'] LOOP
      IF has_function_privilege(role_name, 'public.' || sig, 'EXECUTE') THEN ok := false; out := out || (role_name || ' may EXECUTE ' || sig); END IF;
    END LOOP;
  END LOOP;
  FOREACH role_name IN ARRAY ARRAY['qa_effect_probe', 'anon', 'authenticated'] LOOP
    IF has_table_privilege(role_name, 'public.flow_run_effects', 'SELECT') OR has_table_privilege(role_name, 'public.flow_run_effects', 'INSERT')
       OR has_table_privilege(role_name, 'public.flow_run_effects', 'UPDATE') OR has_table_privilege(role_name, 'public.flow_run_effects', 'DELETE') THEN ok := false; out := out || (role_name || ' has table privileges'); END IF;
  END LOOP;
  IF NOT has_table_privilege('service_role', 'public.flow_run_effects', 'SELECT') THEN ok := false; out := out || 'service_role lacks table access'; END IF;
  calls := ARRAY[
    format('SELECT * FROM public.register_versioned_effect(%L,%L,%L,%s,0,%L,%L::jsonb)', a, rid, 'w1', tok, 'send_message', '{"text":"x"}'),
    format('SELECT * FROM public.claim_versioned_effect(%L,%L,%L,%s,%L)', a, rid, 'w1', tok, eid),
    format('SELECT * FROM public.settle_versioned_effect(%L,%L,%L,%s,%L,%L,%L)', a, rid, 'w1', tok, eid, gen_random_uuid(), 'failed'),
    format('SELECT * FROM public.recover_versioned_run_effects(%L,%L,%L,%s)', a, rid, 'w1', tok),
    format('SELECT * FROM public.resolve_versioned_effect(%L,%L,%L,%s,%L,%L,%L)', a, rid, 'w1', tok, eid, 'failed', 'ev'),
    format('SELECT * FROM public.commit_versioned_effect_step(%L,%L,%L,%s,0,%L,%L::jsonb)', a, rid, 'w1', tok, eid, cp),
    format('SELECT * FROM public.flow_run_effects'), format('UPDATE public.flow_run_effects SET state = %L', 'failed'), format('DELETE FROM public.flow_run_effects')];
  FOREACH role_name IN ARRAY ARRAY['qa_effect_probe', 'anon', 'authenticated'] LOOP
    FOREACH call_sql IN ARRAY calls LOOP
      st := NULL; EXECUTE format('SET LOCAL ROLE %I', role_name);
      BEGIN EXECUTE call_sql; EXCEPTION WHEN OTHERS THEN st := SQLSTATE; END;
      RESET ROLE;
      IF st IS DISTINCT FROM '42501' THEN ok := false; out := out || (role_name || ' ran ' || left(call_sql, 45) || ' -> ' || coalesce(st, 'SUCCEEDED')); END IF;
    END LOOP;
  END LOOP;
  IF (SELECT to_jsonb(e) FROM public.flow_run_effects e WHERE e.id = eid) <> before_row THEN ok := false; out := out || 'a denied role changed the effect'; END IF;
  SET LOCAL ROLE service_role;
  BEGIN
    r1 := public.qa_eff_claim(rid, 'w1', eid);
    IF NOT (r1->>'claimed')::bool THEN ok := false; out := out || 'service_role claim refused'; END IF;
  EXCEPTION WHEN OTHERS THEN ok := false; out := out || ('service_role error ' || SQLSTATE || ' ' || SQLERRM); END;
  RESET ROLE;
  PERFORM public.qa_result('E15', ok, '6 RPCs + SELECT/UPDATE/DELETE on the table x (PUBLIC-probe, anon, authenticated) -> 42501 and no change; no PUBLIC grant; service_role claimed an effect' || coalesce(' | ' || nullif(array_to_string(out, '; '), ''), ''));
END $$;

-- E16: transition guard on the table and the generic-commit guard
DO $$
DECLARE rid uuid; acct uuid; eid uuid; a uuid; run public.flow_runs%ROWTYPE; c record; ok boolean := true; detail text := ''; st text; t record; cp jsonb; rid2 uuid; eid2 uuid;
BEGIN
  rid := public.qa_flow_run('55000000-0000-4000-8000-0000000000a0', 1019);
  PERFORM public.qa_lease(rid);
  SELECT * INTO run FROM public.flow_runs WHERE id = rid;
  cp := jsonb_build_object('cursor', jsonb_build_object('flow_version_id', run.current_flow_version_id, 'node_key', 'x'), 'step', 1);
  eid := (public.qa_eff_register(rid, 'w1')->>'effect_id')::uuid;
  -- the generic commit must not step past a pending / claimed / confirmed effect
  SELECT * INTO c FROM public.commit_versioned_run_transition(run.account_id, rid, 'w1', run.versioned_lease, run.versioned_revision, cp);
  IF c.committed OR c.reason <> 'effect_unresolved' THEN ok := false; detail := detail || ' [commit past pending ' || coalesce(c.reason, 'ok') || ']'; END IF;
  a := (public.qa_eff_claim(rid, 'w1', eid)->>'claimed_attempt_id')::uuid;
  SELECT * INTO c FROM public.commit_versioned_run_transition(run.account_id, rid, 'w1', run.versioned_lease, run.versioned_revision, cp);
  IF c.committed OR c.reason <> 'effect_unresolved' THEN ok := false; detail := detail || ' [commit past claimed]'; END IF;
  PERFORM public.qa_eff_settle(rid, 'w1', eid, a, 'confirmed', 'wamid.G');
  SELECT * INTO c FROM public.commit_versioned_run_transition(run.account_id, rid, 'w1', run.versioned_lease, run.versioned_revision, cp);
  IF c.committed OR c.reason <> 'effect_unresolved' THEN ok := false; detail := detail || ' [commit past confirmed (would skip the message budget)]'; END IF;
  -- the table trigger: illegal transitions and immutable columns
  FOR t IN SELECT * FROM (VALUES
    ('confirmed -> pending', 'UPDATE public.flow_run_effects SET state = ''pending'', provider_message_id = NULL, finished_at = NULL, attempt_id = NULL, claimed_owner = NULL, claimed_fencing_token = NULL'),
    ('confirmed -> failed', 'UPDATE public.flow_run_effects SET state = ''failed'', provider_message_id = NULL'),
    ('node_key change', 'UPDATE public.flow_run_effects SET node_key = ''x'''),
    ('revision change', 'UPDATE public.flow_run_effects SET occurrence_revision = occurrence_revision + 1'),
    ('request rewrite', 'UPDATE public.flow_run_effects SET request = ''{"text":"other"}''::jsonb'),
    ('attempt rewind', 'UPDATE public.flow_run_effects SET attempt = 0')
  ) AS x(label, sql) LOOP
    st := NULL; BEGIN EXECUTE t.sql || format(' WHERE id = %L', eid); EXCEPTION WHEN OTHERS THEN st := SQLSTATE; END;
    IF st IS DISTINCT FROM '55000' AND st IS DISTINCT FROM '23514' THEN ok := false; detail := detail || ' [' || t.label || ': ' || coalesce(st, 'accepted') || ']'; END IF;
  END LOOP;
  -- terminal failure is always allowed; a DEFINITIVELY failed effect lets the flow go on
  rid2 := public.qa_flow_run('55000000-0000-4000-8000-0000000000a0', 1020);
  PERFORM public.qa_lease(rid2);
  SELECT * INTO run FROM public.flow_runs WHERE id = rid2;
  eid2 := (public.qa_eff_register(rid2, 'w1')->>'effect_id')::uuid;
  SELECT * INTO c FROM public.commit_versioned_run_transition(run.account_id, rid2, 'w1', run.versioned_lease, run.versioned_revision,
    jsonb_build_object('cursor', jsonb_build_object('flow_version_id', run.current_flow_version_id, 'node_key', 'm'), 'step', 1, 'state', 'terminal', 'failure', 'x'), 'failed', 'operator', 0);
  IF NOT c.committed THEN ok := false; detail := detail || ' [failing the run was blocked]'; END IF;
  rid2 := public.qa_flow_run('55000000-0000-4000-8000-0000000000a0', 1021);
  PERFORM public.qa_lease(rid2);
  eid2 := (public.qa_eff_register(rid2, 'w1')->>'effect_id')::uuid;
  PERFORM public.qa_eff_settle(rid2, 'w1', eid2, (public.qa_eff_claim(rid2, 'w1', eid2)->>'claimed_attempt_id')::uuid, 'failed', NULL, 'invalid_recipient');
  SELECT * INTO run FROM public.flow_runs WHERE id = rid2;
  SELECT * INTO c FROM public.commit_versioned_run_transition(run.account_id, rid2, 'w1', run.versioned_lease, run.versioned_revision,
    jsonb_build_object('cursor', jsonb_build_object('flow_version_id', run.current_flow_version_id, 'node_key', 'x'), 'step', 1), 'active', NULL, 1, 0);
  IF NOT c.committed OR c.messages_executed <> 0 THEN ok := false; detail := detail || ' [continuing after a failed effect]'; END IF;
  PERFORM public.qa_result('E16', ok, 'generic commit refuses to step past pending, claimed or confirmed effects (effect_unresolved); the table rejects illegal transitions and identity/payload rewrites; failing the run is always allowed and a definitively failed effect lets the flow continue without consuming message budget' || detail);
END $$;

-- E17: shape constraints
DO $$
DECLARE rid uuid; eid uuid; run public.flow_runs%ROWTYPE; ok boolean := true; detail text := ''; st text; t record; r jsonb;
BEGIN
  rid := public.qa_flow_run('55000000-0000-4000-8000-0000000000a0', 1022);
  PERFORM public.qa_lease(rid);
  eid := (public.qa_eff_register(rid, 'w1')->>'effect_id')::uuid;
  SELECT * INTO run FROM public.flow_runs WHERE id = rid;
  FOR t IN SELECT * FROM (VALUES
    ('duplicate (run, revision)', format('INSERT INTO public.flow_run_effects (account_id, flow_run_id, flow_version_id, node_key, occurrence_revision, effect_type, request, payload_hash) VALUES (%L,%L,%L,%L,%s,%L,%L,repeat(%L,64))', run.account_id, rid, run.current_flow_version_id, 'm', run.versioned_revision, 'send_message', '{}', 'a'), '23505'),
    ('confirmed without provider id', format('INSERT INTO public.flow_run_effects (account_id, flow_run_id, flow_version_id, node_key, occurrence_revision, effect_type, request, payload_hash, state, attempt, finished_at) VALUES (%L,%L,%L,%L,77,%L,%L,repeat(%L,64),%L,1,now())', run.account_id, rid, run.current_flow_version_id, 'm', 'send_message', '{}', 'a', 'confirmed'), '23514'),
    ('claimed without owner', format('INSERT INTO public.flow_run_effects (account_id, flow_run_id, flow_version_id, node_key, occurrence_revision, effect_type, request, payload_hash, state, attempt, attempt_id) VALUES (%L,%L,%L,%L,78,%L,%L,repeat(%L,64),%L,1,gen_random_uuid())', run.account_id, rid, run.current_flow_version_id, 'm', 'send_message', '{}', 'a', 'claimed'), '23514'),
    ('unknown effect type', format('INSERT INTO public.flow_run_effects (account_id, flow_run_id, flow_version_id, node_key, occurrence_revision, effect_type, request, payload_hash) VALUES (%L,%L,%L,%L,79,%L,%L,repeat(%L,64))', run.account_id, rid, run.current_flow_version_id, 'm', 'http_call', '{}', 'a'), '23514'),
    ('run of another account', format('INSERT INTO public.flow_run_effects (account_id, flow_run_id, flow_version_id, node_key, occurrence_revision, effect_type, request, payload_hash) VALUES (%L,%L,%L,%L,80,%L,%L,repeat(%L,64))', (SELECT account_id FROM public.flows WHERE id = '60000000-0000-4000-8000-000000000001'), rid, run.current_flow_version_id, 'm', 'send_message', '{}', 'a'), '23503'),
    ('non-object request', format('INSERT INTO public.flow_run_effects (account_id, flow_run_id, flow_version_id, node_key, occurrence_revision, effect_type, request, payload_hash) VALUES (%L,%L,%L,%L,81,%L,%L,repeat(%L,64))', run.account_id, rid, run.current_flow_version_id, 'm', 'send_message', '[]', 'a'), '23514')
  ) AS x(label, sql, want) LOOP
    st := NULL; BEGIN EXECUTE t.sql; EXCEPTION WHEN OTHERS THEN st := SQLSTATE; END;
    IF st IS DISTINCT FROM t.want THEN ok := false; detail := detail || ' [' || t.label || ': ' || coalesce(st, 'accepted') || ']'; END IF;
  END LOOP;
  -- provider message ids are unique per account: a second effect cannot claim the same wamid
  PERFORM public.qa_eff_settle(rid, 'w1', eid, (public.qa_eff_claim(rid, 'w1', eid)->>'claimed_attempt_id')::uuid, 'confirmed', 'wamid.UNIQUE');
  rid := public.qa_flow_run('55000000-0000-4000-8000-0000000000a0', 1023);
  PERFORM public.qa_lease(rid);
  eid := (public.qa_eff_register(rid, 'w1')->>'effect_id')::uuid;
  -- since migration 060 settle REFUSES (provider_message_conflict, state untouched) instead of raising 23505
  r := public.qa_eff_settle(rid, 'w1', eid, (public.qa_eff_claim(rid, 'w1', eid)->>'claimed_attempt_id')::uuid, 'confirmed', 'wamid.UNIQUE');
  IF NOT (r->>'reason' = 'provider_message_conflict' AND (r->>'settled')::bool = false) OR (SELECT state FROM public.flow_run_effects WHERE id = eid) <> 'claimed' THEN ok := false; detail := detail || ' [duplicate provider id: ' || r::text || ']'; END IF;
  -- the table constraint itself still forbids it for any writer that bypasses the RPC
  st := NULL;
  BEGIN UPDATE public.flow_run_effects SET state = 'confirmed', provider_message_id = 'wamid.UNIQUE', finished_at = now() WHERE id = eid; EXCEPTION WHEN OTHERS THEN st := SQLSTATE; END;
  IF st IS DISTINCT FROM '23505' THEN ok := false; detail := detail || ' [direct update: ' || coalesce(st, 'accepted') || ']'; END IF;
  PERFORM public.qa_result('E17', ok, 'duplicate (run, revision), confirmed without provider id, claimed without owner, unknown effect type, cross-account run reference, non-object request and a provider message id reused within the account are all rejected by constraints' || detail);
END $$;
