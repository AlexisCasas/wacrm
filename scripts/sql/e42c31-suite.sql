-- E4.2C3.1 QA: Inbox persistence of confirmed effects (migration 060). Same rolled-back transaction as the other
-- suites; races and interruptions are in e42c31-concurrency.sh. IDs P01..P12.
-- PT: m(send_message) -> x(end)        PM: m(send_media image) -> x(end)
DO $$
BEGIN
  PERFORM public.qa_synth_flow('56000000-0000-4000-8000-0000000000a0', '[{"node_key":"m","node_type":"send_message","config":{"text":"hi","next_node_key":"x"}},{"node_key":"x","node_type":"end"}]', 'm');
  PERFORM public.qa_synth_flow('56000000-0000-4000-8000-0000000000a1', '[{"node_key":"m","node_type":"send_media","config":{"media_type":"image","media_url":"https://example.test/p.png","next_node_key":"x"}},{"node_key":"x","node_type":"end"}]', 'm');
END $$;

-- P01: an accepted text message appears in the Inbox in the same transaction as the confirmation
DO $$
DECLARE rid uuid; run public.flow_runs%ROWTYPE; reg jsonb; eid uuid; s jsonb; m public.messages%ROWTYPE; l public.flow_run_effect_messages%ROWTYPE; cv public.conversations%ROWTYPE; e public.flow_run_effects%ROWTYPE; n int;
BEGIN
  rid := public.qa_flow_run_conv('56000000-0000-4000-8000-0000000000a0', 3001);
  PERFORM public.qa_lease(rid);
  SELECT * INTO run FROM public.flow_runs WHERE id = rid;
  reg := public.qa_eff_register(rid, 'w1', 'send_message', '{"kind":"text","text":"Hola Ana"}'); eid := (reg->>'effect_id')::uuid;
  SELECT count(*) INTO n FROM public.messages WHERE conversation_id = run.conversation_id;
  IF n <> 0 THEN RAISE EXCEPTION 'unexpected messages before confirmation'; END IF;
  PERFORM public.qa_eff_claim(rid, 'w1', eid);
  SELECT count(*) INTO n FROM public.messages WHERE conversation_id = run.conversation_id;
  IF n <> 0 THEN RAISE EXCEPTION 'a merely claimed effect must not create a message'; END IF;
  s := public.qa_eff_settle(rid, 'w1', eid, (SELECT attempt_id FROM public.flow_run_effects WHERE id = eid), 'confirmed', 'wamid.P01ACCEPTED');
  SELECT * INTO e FROM public.flow_run_effects WHERE id = eid;
  SELECT * INTO l FROM public.flow_run_effect_messages WHERE effect_id = eid;
  SELECT * INTO m FROM public.messages WHERE id = l.message_id;
  SELECT * INTO cv FROM public.conversations WHERE id = run.conversation_id;
  PERFORM public.qa_result('P01', (s->>'settled')::bool AND e.state = 'confirmed'
    AND m.conversation_id = run.conversation_id AND m.sender_type = 'bot' AND m.content_type = 'text' AND m.content_text = 'Hola Ana' AND m.media_url IS NULL
    AND m.message_id = 'wamid.P01ACCEPTED' AND m.status = 'sent' AND m.ai_generated = false
    AND l.account_id = run.account_id AND l.flow_run_id = rid AND l.conversation_id = run.conversation_id AND l.provider_message_id = 'wamid.P01ACCEPTED' AND l.attempt = 1 AND l.attempt_id = e.attempt_id
    AND cv.last_message_text = 'Hola Ana' AND cv.last_message_at IS NOT NULL
    AND (SELECT count(*) FROM public.messages WHERE conversation_id = run.conversation_id) = 1,
    'settle(confirmed) created exactly one Inbox message in the same statement: bot/text, wamid stored, status sent (not delivered), conversation preview updated, link row with run, attempt and attempt id');
END $$;

-- P02: media message
DO $$
DECLARE rid uuid; run public.flow_runs%ROWTYPE; eid uuid; m public.messages%ROWTYPE; cv public.conversations%ROWTYPE; rid2 uuid; run2 public.flow_runs%ROWTYPE; eid2 uuid; m2 public.messages%ROWTYPE; cv2 public.conversations%ROWTYPE;
BEGIN
  rid := public.qa_flow_run_conv('56000000-0000-4000-8000-0000000000a1', 3002);
  PERFORM public.qa_lease(rid);
  SELECT * INTO run FROM public.flow_runs WHERE id = rid;
  eid := (public.qa_eff_register(rid, 'w1', 'send_media', '{"kind":"media","media_type":"image","media_url":"https://example.test/p.png","caption":"Look!"}')->>'effect_id')::uuid;
  PERFORM public.qa_eff_accept(rid, 'w1', eid, 'wamid.P02MEDIA');
  SELECT mm.* INTO m FROM public.messages mm JOIN public.flow_run_effect_messages l ON l.message_id = mm.id WHERE l.effect_id = eid;
  SELECT * INTO cv FROM public.conversations WHERE id = run.conversation_id;
  rid2 := public.qa_flow_run_conv('56000000-0000-4000-8000-0000000000a1', 3003);
  PERFORM public.qa_lease(rid2);
  SELECT * INTO run2 FROM public.flow_runs WHERE id = rid2;
  eid2 := (public.qa_eff_register(rid2, 'w1', 'send_media', '{"kind":"media","media_type":"document","media_url":"https://example.test/d.pdf","filename":"d.pdf"}')->>'effect_id')::uuid;
  PERFORM public.qa_eff_accept(rid2, 'w1', eid2, 'wamid.P02DOC');
  SELECT mm.* INTO m2 FROM public.messages mm JOIN public.flow_run_effect_messages l ON l.message_id = mm.id WHERE l.effect_id = eid2;
  SELECT * INTO cv2 FROM public.conversations WHERE id = run2.conversation_id;
  PERFORM public.qa_result('P02', m.content_type = 'image' AND m.content_text = 'Look!' AND m.media_url = 'https://example.test/p.png' AND m.message_id = 'wamid.P02MEDIA' AND m.status = 'sent' AND cv.last_message_text = 'Look!'
    AND m2.content_type = 'document' AND m2.content_text IS NULL AND m2.media_url = 'https://example.test/d.pdf' AND cv2.last_message_text = '[document]',
    'media: content_type = media kind, caption in content_text, media_url kept (same shape as the legacy sender); preview is the caption or [kind]');
END $$;

-- P03: idempotence: a second confirmation, a repeated persist and reconcile never duplicate the message
DO $$
DECLARE rid uuid; run public.flow_runs%ROWTYPE; eid uuid; ok boolean := true; detail text := ''; s2 jsonb; rec jsonb; v1 uuid; v2 uuid; n_msg int; n_link int; tok int; r record; acct uuid;
BEGIN
  rid := public.qa_flow_run_conv('56000000-0000-4000-8000-0000000000a0', 3004);
  tok := public.qa_lease(rid);
  SELECT * INTO run FROM public.flow_runs WHERE id = rid;
  eid := (public.qa_eff_register(rid, 'w1', 'send_message', '{"kind":"text","text":"once"}')->>'effect_id')::uuid;
  PERFORM public.qa_eff_accept(rid, 'w1', eid, 'wamid.P03ONCE');
  s2 := public.qa_eff_settle(rid, 'w1', eid, (SELECT attempt_id FROM public.flow_run_effects WHERE id = eid), 'confirmed', 'wamid.P03ONCE');
  IF s2->>'reason' <> 'effect_not_claimed' THEN ok := false; detail := detail || ' [second settle ' || s2::text || ']'; END IF;
  v1 := public.persist_versioned_effect_message(eid); v2 := public.persist_versioned_effect_message(eid);
  IF v1 IS NULL OR v1 <> v2 THEN ok := false; detail := detail || ' [persist not idempotent]'; END IF;
  SELECT * INTO r FROM public.reconcile_versioned_effect_messages(run.account_id, rid, 'w1', tok);
  IF r.outcome <> 'already_persisted' OR r.message_id <> v1 THEN ok := false; detail := detail || ' [reconcile ' || coalesce(r.outcome, '?') || ']'; END IF;
  SELECT count(*) INTO n_msg FROM public.messages WHERE conversation_id = run.conversation_id;
  SELECT count(*) INTO n_link FROM public.flow_run_effect_messages WHERE flow_run_id = rid;
  IF n_msg <> 1 OR n_link <> 1 THEN ok := false; detail := detail || ' [rows ' || n_msg || '/' || n_link || ']'; END IF;
  -- the schema itself forbids a second link for the same effect, and a second effect reusing the message
  BEGIN INSERT INTO public.flow_run_effect_messages (effect_id, account_id, flow_run_id, message_id, conversation_id, provider_message_id, attempt) VALUES (eid, run.account_id, rid, v1, run.conversation_id, 'wamid.X', 1);
  EXCEPTION WHEN unique_violation THEN NULL; WHEN OTHERS THEN ok := false; detail := detail || ' [second link ' || SQLSTATE || ']'; END;
  PERFORM public.qa_result('P03', ok, 'second confirmation -> effect_not_claimed; persist called twice and reconcile -> the same single message; 1 message and 1 link row; a second link for the same effect is a unique violation' || detail);
END $$;

-- P04: ambiguous / failed / pending / claimed effects are never shown as sent; evidence makes them appear once
DO $$
DECLARE rid uuid; run public.flow_runs%ROWTYPE; eid uuid; a uuid; ok boolean := true; detail text := ''; acct uuid; n int; cv public.conversations%ROWTYPE; rid2 uuid; eid2 uuid; before_preview text;
BEGIN
  rid := public.qa_flow_run_conv('56000000-0000-4000-8000-0000000000a0', 3005);
  PERFORM public.qa_lease(rid);
  SELECT * INTO run FROM public.flow_runs WHERE id = rid;
  SELECT last_message_text INTO before_preview FROM public.conversations WHERE id = run.conversation_id;
  eid := (public.qa_eff_register(rid, 'w1', 'send_message', '{"kind":"text","text":"maybe"}')->>'effect_id')::uuid;
  SELECT count(*) INTO n FROM public.messages WHERE conversation_id = run.conversation_id; IF n <> 0 THEN ok := false; detail := detail || ' [pending shown]'; END IF;
  a := (public.qa_eff_claim(rid, 'w1', eid)->>'claimed_attempt_id')::uuid;
  PERFORM public.qa_eff_settle(rid, 'w1', eid, a, 'ambiguous', NULL, 'timeout');
  SELECT count(*) INTO n FROM public.messages WHERE conversation_id = run.conversation_id; IF n <> 0 THEN ok := false; detail := detail || ' [ambiguous shown]'; END IF;
  SELECT * INTO cv FROM public.conversations WHERE id = run.conversation_id;
  IF cv.last_message_text IS DISTINCT FROM before_preview THEN ok := false; detail := detail || ' [preview changed by an ambiguous effect]'; END IF;
  PERFORM public.qa_eff_resolve(rid, 'w1', eid, 'not_sent', 'provider log: nothing arrived');
  SELECT count(*) INTO n FROM public.messages WHERE conversation_id = run.conversation_id; IF n <> 0 THEN ok := false; detail := detail || ' [not_sent shown]'; END IF;
  a := (public.qa_eff_claim(rid, 'w1', eid)->>'claimed_attempt_id')::uuid;
  PERFORM public.qa_eff_settle(rid, 'w1', eid, a, 'ambiguous', NULL, 'timeout');
  -- evidence arrives: a delivery receipt carrying the wamid. The message appears exactly once, status still 'sent'.
  IF NOT (public.qa_eff_resolve(rid, 'w1', eid, 'confirmed', 'synthetic status webhook matched the attempt', 'wamid.P04RECEIPT')->>'resolved')::bool THEN ok := false; detail := detail || ' [resolve]'; END IF;
  SELECT count(*) INTO n FROM public.messages WHERE conversation_id = run.conversation_id AND message_id = 'wamid.P04RECEIPT' AND status = 'sent' AND content_text = 'maybe'; IF n <> 1 THEN ok := false; detail := detail || ' [message after evidence: ' || n || ']'; END IF;
  -- a definitive failure leaves no trace in the Inbox
  rid2 := public.qa_flow_run_conv('56000000-0000-4000-8000-0000000000a0', 3006);
  PERFORM public.qa_lease(rid2);
  eid2 := (public.qa_eff_register(rid2, 'w1', 'send_message', '{"kind":"text","text":"nope"}')->>'effect_id')::uuid;
  PERFORM public.qa_eff_settle(rid2, 'w1', eid2, (public.qa_eff_claim(rid2, 'w1', eid2)->>'claimed_attempt_id')::uuid, 'failed', NULL, 'invalid_recipient');
  SELECT count(*) INTO n FROM public.messages WHERE conversation_id = (SELECT conversation_id FROM public.flow_runs WHERE id = rid2); IF n <> 0 THEN ok := false; detail := detail || ' [failed shown]'; END IF;
  PERFORM public.qa_result('P04', ok, 'pending, claimed, ambiguous, not_sent and failed effects create no message and do not touch the preview; an ambiguous effect confirmed by evidence (wamid from a receipt) appears exactly once, still status sent' || detail);
END $$;

-- P05: a provider message id can be used by one effect only; messages already stored are linked, not duplicated
DO $$
DECLARE rid1 uuid; rid2 uuid; e1 uuid; e2 uuid; ok boolean := true; detail text := ''; s jsonb; rs jsonb; n int; run2 public.flow_runs%ROWTYPE; pre uuid; rid3 uuid; run3 public.flow_runs%ROWTYPE; e3 uuid; cv_before text; cv_after text; l public.flow_run_effect_messages%ROWTYPE;
BEGIN
  rid1 := public.qa_flow_run_conv('56000000-0000-4000-8000-0000000000a0', 3007);
  PERFORM public.qa_lease(rid1);
  e1 := (public.qa_eff_register(rid1, 'w1', 'send_message', '{"kind":"text","text":"first"}')->>'effect_id')::uuid;
  PERFORM public.qa_eff_accept(rid1, 'w1', e1, 'wamid.P05SHARED');
  rid2 := public.qa_flow_run_conv('56000000-0000-4000-8000-0000000000a0', 3008);
  PERFORM public.qa_lease(rid2);
  SELECT * INTO run2 FROM public.flow_runs WHERE id = rid2;
  e2 := (public.qa_eff_register(rid2, 'w1', 'send_message', '{"kind":"text","text":"second"}')->>'effect_id')::uuid;
  s := public.qa_eff_accept(rid2, 'w1', e2, 'wamid.P05SHARED');
  IF NOT (s->>'reason' = 'provider_message_conflict' AND (s->>'settled')::bool = false AND s->>'effect_state' = 'claimed') THEN ok := false; detail := detail || ' [settle conflict ' || s::text || ']'; END IF;
  IF (SELECT state FROM public.flow_run_effects WHERE id = e2) <> 'claimed' OR (SELECT provider_message_id FROM public.flow_run_effects WHERE id = e2) IS NOT NULL THEN ok := false; detail := detail || ' [conflict changed the effect]'; END IF;
  IF EXISTS (SELECT 1 FROM public.messages WHERE conversation_id = run2.conversation_id) THEN ok := false; detail := detail || ' [message created on conflict]'; END IF;
  -- as an explicit ambiguous result it is recorded, and resolving with the same id conflicts too
  PERFORM public.qa_eff_settle(rid2, 'w1', e2, (SELECT attempt_id FROM public.flow_run_effects WHERE id = e2), 'ambiguous', NULL, 'wamid_conflict');
  rs := public.qa_eff_resolve(rid2, 'w1', e2, 'confirmed', 'receipt', 'wamid.P05SHARED');
  IF rs->>'reason' <> 'provider_message_conflict' OR (SELECT state FROM public.flow_run_effects WHERE id = e2) <> 'ambiguous' THEN ok := false; detail := detail || ' [resolve conflict ' || rs::text || ']'; END IF;
  -- a message row that the status webhook (or anything else) already stored for this wamid is linked, never duplicated
  rid3 := public.qa_flow_run_conv('56000000-0000-4000-8000-0000000000a0', 3009);
  PERFORM public.qa_lease(rid3);
  SELECT * INTO run3 FROM public.flow_runs WHERE id = rid3;
  INSERT INTO public.messages (conversation_id, sender_type, content_type, content_text, message_id, status) VALUES (run3.conversation_id, 'bot', 'text', 'pre-existing', 'wamid.P05PRE', 'delivered') RETURNING id INTO pre;
  UPDATE public.conversations SET last_message_text = 'before' WHERE id = run3.conversation_id;
  e3 := (public.qa_eff_register(rid3, 'w1', 'send_message', '{"kind":"text","text":"pre-existing"}')->>'effect_id')::uuid;
  PERFORM public.qa_eff_accept(rid3, 'w1', e3, 'wamid.P05PRE');
  SELECT * INTO l FROM public.flow_run_effect_messages WHERE effect_id = e3;
  SELECT count(*) INTO n FROM public.messages WHERE conversation_id = run3.conversation_id;
  SELECT last_message_text INTO cv_after FROM public.conversations WHERE id = run3.conversation_id;
  IF l.message_id <> pre OR n <> 1 OR (SELECT status FROM public.messages WHERE id = pre) <> 'delivered' OR cv_after <> 'before' THEN ok := false; detail := detail || ' [pre-existing row was duplicated or altered]'; END IF;
  PERFORM public.qa_result('P05', ok, 'a wamid used by another effect: settle/resolve refuse with provider_message_conflict and change nothing (an explicit ambiguous settle is recorded); a message row already stored for the wamid is linked once, left untouched (status delivered kept) and the preview is not overwritten' || detail);
END $$;

-- P06: tenant isolation
DO $$
DECLARE rid uuid; run public.flow_runs%ROWTYPE; eid uuid; ok boolean := true; detail text := ''; conv_b uuid; contact_b uuid; n int; ev int;
BEGIN
  rid := public.qa_flow_run_conv('56000000-0000-4000-8000-0000000000a0', 3010);
  PERFORM public.qa_lease(rid);
  SELECT * INTO run FROM public.flow_runs WHERE id = rid;
  eid := (public.qa_eff_register(rid, 'w1', 'send_message', '{"kind":"text","text":"leak?"}')->>'effect_id')::uuid;
  SELECT id INTO conv_b FROM public.conversations WHERE account_id = (SELECT account_id FROM public.flows WHERE id = '60000000-0000-4000-8000-000000000001') LIMIT 1;
  IF conv_b IS NULL THEN
    contact_b := '70000000-0000-4000-8000-000000000001';
    INSERT INTO public.conversations (id, user_id, account_id, contact_id) VALUES ('81000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', (SELECT account_id FROM public.flows WHERE id = '60000000-0000-4000-8000-000000000001'), contact_b) ON CONFLICT DO NOTHING;
    conv_b := '81000000-0000-4000-8000-000000000001';
  END IF;
  -- corrupt the effect on purpose (identity guard lifted for the test) so it points at another account's conversation
  ALTER TABLE public.flow_run_effects DISABLE TRIGGER flow_run_effects_guard;
  UPDATE public.flow_run_effects SET conversation_id = conv_b WHERE id = eid;
  ALTER TABLE public.flow_run_effects ENABLE TRIGGER flow_run_effects_guard;
  PERFORM public.qa_eff_accept(rid, 'w1', eid, 'wamid.P06ISOLATED');
  IF (SELECT state FROM public.flow_run_effects WHERE id = eid) <> 'confirmed' THEN ok := false; detail := detail || ' [confirmation was blocked]'; END IF;
  SELECT count(*) INTO n FROM public.messages WHERE message_id = 'wamid.P06ISOLATED'; IF n <> 0 THEN ok := false; detail := detail || ' [message written into another account]'; END IF;
  IF EXISTS (SELECT 1 FROM public.flow_run_effect_messages WHERE effect_id = eid) THEN ok := false; detail := detail || ' [link created]'; END IF;
  -- same for a conversation of the right account but ANOTHER contact
  ALTER TABLE public.flow_run_effects DISABLE TRIGGER flow_run_effects_guard;
  UPDATE public.flow_run_effects SET conversation_id = '40000000-0000-4000-8000-000000000002' WHERE id = eid;
  ALTER TABLE public.flow_run_effects ENABLE TRIGGER flow_run_effects_guard;
  IF public.persist_versioned_effect_message(eid) IS NOT NULL THEN ok := false; detail := detail || ' [message written for a conversation of another contact]'; END IF;
  PERFORM public.qa_result('P06', ok, 'an effect whose conversation belongs to another account, or to another contact of the same account, is never written to the Inbox; the confirmation itself is not blocked' || detail);
END $$;

-- P07: an Inbox failure never undoes a confirmation and is repaired by reconcile
CREATE FUNCTION public.qa_block_messages() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF current_setting('qa.block_messages', true) = '1' THEN RAISE EXCEPTION 'qa inbox outage' USING ERRCODE = 'P9997'; END IF; RETURN NEW; END $$;
CREATE TRIGGER qa_block_messages BEFORE INSERT ON public.messages FOR EACH ROW EXECUTE FUNCTION public.qa_block_messages();
DO $$
DECLARE rid uuid; run public.flow_runs%ROWTYPE; eid uuid; ok boolean := true; detail text := ''; tok int; r record; s jsonb; ev jsonb; step jsonb;
BEGIN
  rid := public.qa_flow_run_conv('56000000-0000-4000-8000-0000000000a0', 3011);
  tok := public.qa_lease(rid);
  SELECT * INTO run FROM public.flow_runs WHERE id = rid;
  eid := (public.qa_eff_register(rid, 'w1', 'send_message', '{"kind":"text","text":"during outage"}')->>'effect_id')::uuid;
  PERFORM set_config('qa.block_messages', '1', true);
  s := public.qa_eff_accept(rid, 'w1', eid, 'wamid.P07OUTAGE');
  PERFORM set_config('qa.block_messages', '', true);
  IF NOT (s->>'settled')::bool OR (SELECT state FROM public.flow_run_effects WHERE id = eid) <> 'confirmed' THEN ok := false; detail := detail || ' [confirmation undone by the Inbox failure]'; END IF;
  IF EXISTS (SELECT 1 FROM public.messages WHERE conversation_id = run.conversation_id) OR EXISTS (SELECT 1 FROM public.flow_run_effect_messages WHERE effect_id = eid) THEN ok := false; detail := detail || ' [partial Inbox state]'; END IF;
  SELECT payload INTO ev FROM public.flow_run_events WHERE flow_run_id = rid AND event_type = 'error' AND payload->>'reason' = 'inbox_persist_failed';
  IF ev IS NULL OR ev->>'effect_id' <> eid::text OR ev->>'sqlstate' <> 'P9997' OR ev::text LIKE '%during outage%' THEN ok := false; detail := detail || ' [error event ' || coalesce(ev::text, 'missing') || ']'; END IF;
  -- the run can still advance (the provider has the message) and the repair creates the message exactly once
  step := public.qa_eff_step(rid, 'w1', eid, 'x');
  IF NOT (step->>'committed')::bool THEN ok := false; detail := detail || ' [advance]'; END IF;
  SELECT * INTO r FROM public.reconcile_versioned_effect_messages(run.account_id, rid, 'w1', tok);
  IF r.outcome <> 'created' OR r.message_id IS NULL THEN ok := false; detail := detail || ' [reconcile ' || coalesce(r.outcome, '?') || ']'; END IF;
  SELECT * INTO r FROM public.reconcile_versioned_effect_messages(run.account_id, rid, 'w1', tok);
  IF r.outcome <> 'already_persisted' OR (SELECT count(*) FROM public.messages WHERE conversation_id = run.conversation_id) <> 1 THEN ok := false; detail := detail || ' [reconcile not idempotent]'; END IF;
  PERFORM public.qa_result('P07', ok, 'Inbox outage during confirmation: the effect stays confirmed, an id-only error event is written (no message text), the run advances, reconcile creates the message once and a second reconcile changes nothing' || detail);
END $$;
DROP TRIGGER qa_block_messages ON public.messages;

-- P08: gates and grants of reconcile; stale worker; legacy run; effect without a conversation
DO $$
DECLARE rid uuid; run public.flow_runs%ROWTYPE; tok int; ok boolean := true; detail text := ''; got text; lid uuid; acct uuid; before_row jsonb; rid2 uuid; eid2 uuid; n int; ev int; role_name text; st text; sig text;
BEGIN
  CREATE ROLE qa_inbox_probe NOLOGIN; GRANT USAGE ON SCHEMA public TO qa_inbox_probe;
  rid := public.qa_flow_run_conv('56000000-0000-4000-8000-0000000000a0', 3012);
  tok := public.qa_lease(rid);
  SELECT * INTO run FROM public.flow_runs WHERE id = rid;
  SELECT reason INTO got FROM public.reconcile_versioned_effect_messages(run.account_id, rid, 'intruder', tok);   IF got <> 'stale_lease' THEN ok := false; detail := detail || ' [foreign owner ' || coalesce(got, 'null') || ']'; END IF;
  SELECT reason INTO got FROM public.reconcile_versioned_effect_messages(run.account_id, rid, 'w1', tok + 1);    IF got <> 'stale_lease' THEN ok := false; detail := detail || ' [wrong token]'; END IF;
  UPDATE public.flow_runs SET versioned_lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = rid;
  SELECT reason INTO got FROM public.reconcile_versioned_effect_messages(run.account_id, rid, 'w1', tok);        IF got <> 'lease_expired' THEN ok := false; detail := detail || ' [expired]'; END IF;
  UPDATE public.flow_runs SET versioned_lease_expires_at = clock_timestamp() + interval '10 minutes', status = 'paused_by_agent' WHERE id = rid;
  SELECT reason INTO got FROM public.reconcile_versioned_effect_messages(run.account_id, rid, 'w1', tok);        IF got <> 'run_not_active' THEN ok := false; detail := detail || ' [paused]'; END IF;
  -- another account, legacy run
  SELECT account_id INTO acct FROM public.flows WHERE id = '60000000-0000-4000-8000-000000000001';
  got := NULL; BEGIN PERFORM * FROM public.reconcile_versioned_effect_messages(acct, rid, 'w1', tok); EXCEPTION WHEN no_data_found THEN got := SQLERRM; END;
  IF got IS DISTINCT FROM 'versioned run not found' THEN ok := false; detail := detail || ' [cross-account]'; END IF;
  INSERT INTO public.flow_runs (flow_id, account_id, user_id, contact_id, status, current_node_key)
  VALUES ('50000000-0000-4000-8000-000000000002', run.account_id, '10000000-0000-4000-8000-000000000001', public.qa_new_contact(3013), 'active', 'start') RETURNING id INTO lid;
  before_row := to_jsonb((SELECT x FROM public.flow_runs x WHERE id = lid));
  got := NULL; BEGIN PERFORM * FROM public.reconcile_versioned_effect_messages(run.account_id, lid, 'w1', 1); EXCEPTION WHEN no_data_found THEN got := SQLERRM; END;
  IF got IS DISTINCT FROM 'versioned run not found' OR to_jsonb((SELECT x FROM public.flow_runs x WHERE id = lid)) <> before_row THEN ok := false; detail := detail || ' [legacy]'; END IF;
  -- an effect on a run WITHOUT a conversation has no Inbox representation: no message, no error event
  rid2 := public.qa_flow_run('56000000-0000-4000-8000-0000000000a0', 3014);
  PERFORM public.qa_lease(rid2);
  eid2 := (public.qa_eff_register(rid2, 'w1', 'send_message', '{"kind":"text","text":"no conversation"}')->>'effect_id')::uuid;
  PERFORM public.qa_eff_accept(rid2, 'w1', eid2, 'wamid.P08NOCONV');
  SELECT count(*) INTO n FROM public.messages WHERE message_id = 'wamid.P08NOCONV';
  SELECT count(*) INTO ev FROM public.flow_run_events WHERE flow_run_id = rid2 AND event_type = 'error';
  IF n <> 0 OR ev <> 0 OR (SELECT state FROM public.flow_run_effects WHERE id = eid2) <> 'confirmed' THEN ok := false; detail := detail || ' [no-conversation effect]'; END IF;
  -- privileges
  FOREACH sig IN ARRAY ARRAY['reconcile_versioned_effect_messages(uuid,uuid,text,integer)', 'persist_versioned_effect_message(uuid)', 'try_persist_versioned_effect_message(uuid)'] LOOP
    FOREACH role_name IN ARRAY ARRAY['qa_inbox_probe', 'anon', 'authenticated'] LOOP
      IF has_function_privilege(role_name, 'public.' || sig, 'EXECUTE') THEN ok := false; detail := detail || ' [' || role_name || ' may EXECUTE ' || sig || ']'; END IF;
    END LOOP;
  END LOOP;
  IF NOT has_function_privilege('service_role', 'public.reconcile_versioned_effect_messages(uuid,uuid,text,integer)', 'EXECUTE') THEN ok := false; detail := detail || ' [service_role lacks reconcile]'; END IF;
  FOREACH role_name IN ARRAY ARRAY['qa_inbox_probe', 'anon', 'authenticated'] LOOP
    IF has_table_privilege(role_name, 'public.flow_run_effect_messages', 'SELECT') OR has_table_privilege(role_name, 'public.flow_run_effect_messages', 'INSERT') OR has_table_privilege(role_name, 'public.flow_run_effect_messages', 'UPDATE') THEN ok := false; detail := detail || ' [' || role_name || ' table access]'; END IF;
    st := NULL; EXECUTE format('SET LOCAL ROLE %I', role_name);
    BEGIN PERFORM * FROM public.reconcile_versioned_effect_messages(run.account_id, rid, 'w1', tok); EXCEPTION WHEN OTHERS THEN st := SQLSTATE; END;
    RESET ROLE;
    IF st IS DISTINCT FROM '42501' THEN ok := false; detail := detail || ' [' || role_name || ' ran reconcile: ' || coalesce(st, 'SUCCEEDED') || ']'; END IF;
  END LOOP;
  PERFORM public.qa_result('P08', ok, 'reconcile: foreign owner / wrong token -> stale_lease, expired -> lease_expired, paused -> run_not_active, other account and legacy run -> P0002 (legacy row identical); an effect without a conversation creates nothing and no error; no grants for PUBLIC/anon/authenticated on the functions or the link table' || detail);
END $$;

-- P09: the Inbox shows the message to the conversation's owner and to nobody else (real RLS)
DO $$
DECLARE rid uuid; run public.flow_runs%ROWTYPE; eid uuid; ok boolean := true; detail text := ''; n_owner int; n_other int; owner uuid := '10000000-0000-4000-8000-000000000001'; other uuid := '10000000-0000-4000-8000-000000000002';
BEGIN
  rid := public.qa_flow_run_conv('56000000-0000-4000-8000-0000000000a0', 3015);
  PERFORM public.qa_lease(rid);
  SELECT * INTO run FROM public.flow_runs WHERE id = rid;
  eid := (public.qa_eff_register(rid, 'w1', 'send_message', '{"kind":"text","text":"visible to the owner"}')->>'effect_id')::uuid;
  PERFORM public.qa_eff_accept(rid, 'w1', eid, 'wamid.P09RLS');
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', owner, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', owner::text, true);
  SELECT count(*) INTO n_owner FROM public.messages WHERE message_id = 'wamid.P09RLS';
  PERFORM set_config('request.jwt.claims', json_build_object('sub', other, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', other::text, true);
  SELECT count(*) INTO n_other FROM public.messages WHERE message_id = 'wamid.P09RLS';
  RESET ROLE;
  IF n_owner <> 1 THEN ok := false; detail := detail || ' [owner sees ' || n_owner || ']'; END IF;
  IF n_other <> 0 THEN ok := false; detail := detail || ' [another account sees ' || n_other || ']'; END IF;
  PERFORM public.qa_result('P09', ok, 'through the Inbox RLS (authenticated role + JWT) the conversation owner sees the persisted message once and a user of another account sees nothing' || detail);
END $$;
