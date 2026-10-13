-- PR #30 audit fix P1 (Inbox repair for ended runs, migration 061). Same rolled-back transaction as the other suites;
-- the concurrent case is in e42pr30-concurrency.sh. IDs Q01..Q05.
DO $$ BEGIN
  PERFORM public.qa_synth_flow('57000000-0000-4000-8000-0000000000a0', '[{"node_key":"m","node_type":"send_message","config":{"text":"hi","next_node_key":"x"}},{"node_key":"x","node_type":"end"}]', 'm');
END $$;
CREATE FUNCTION public.qa_pr30_block_messages() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF current_setting('qa.pr30_block', true) = '1' THEN RAISE EXCEPTION 'qa inbox outage' USING ERRCODE = 'P9997'; END IF; RETURN NEW; END $$;
CREATE TRIGGER qa_pr30_block_messages BEFORE INSERT ON public.messages FOR EACH ROW EXECUTE FUNCTION public.qa_pr30_block_messages();

-- Q01: outage -> confirmed -> the run advances and ends -> the Inbox returns -> repair creates the message once
DO $$
DECLARE rid uuid; eid uuid; run public.flow_runs%ROWTYPE; before_run jsonb; before_eff jsonb; r record; ok boolean := true; detail text := ''; n int; status_i text; ev int; msg public.messages%ROWTYPE;
BEGIN
  FOREACH status_i IN ARRAY ARRAY['completed', 'failed'] LOOP
    rid := public.qa_flow_run_conv('57000000-0000-4000-8000-0000000000a0', 5001 + (CASE status_i WHEN 'completed' THEN 0 ELSE 1 END));
    PERFORM public.qa_lease(rid);
    PERFORM set_config('qa.pr30_block', '1', true);
    eid := public.qa_eff_registered_accept(rid, 'w1', '{"kind":"text","text":"sent during the outage"}', 'wamid.Q01' || status_i);
    PERFORM set_config('qa.pr30_block', '', true);
    PERFORM public.qa_finish_run(rid, 'w1', eid, status_i);
    SELECT * INTO run FROM public.flow_runs WHERE id = rid;
    IF run.status <> status_i OR run.versioned_lease_owner IS NOT NULL THEN ok := false; detail := detail || ' [' || status_i || ': run not ended]'; END IF;
    SELECT count(*) INTO n FROM public.messages WHERE conversation_id = run.conversation_id; IF n <> 0 THEN ok := false; detail := detail || ' [message exists during the outage]'; END IF;
    -- the lease-based reconcile cannot help any more (this is the audit finding)
    SELECT * INTO r FROM public.reconcile_versioned_effect_messages(run.account_id, rid, 'w1', run.versioned_lease);
    IF r.reason IS DISTINCT FROM 'run_not_active' AND r.reason IS DISTINCT FROM 'stale_lease' THEN ok := false; detail := detail || ' [lease reconcile unexpectedly worked: ' || coalesce(r.reason, 'null') || ']'; END IF;
    -- repair: no lease, no gate, run untouched
    before_run := to_jsonb((SELECT x FROM public.flow_runs x WHERE id = rid));
    before_eff := (SELECT to_jsonb(e) FROM public.flow_run_effects e WHERE e.id = eid);
    SELECT * INTO r FROM public.repair_versioned_run_inbox(run.account_id, rid);
    IF r.outcome <> 'created' OR r.effect_id <> eid OR r.message_id IS NULL THEN ok := false; detail := detail || ' [' || status_i || ': repair ' || coalesce(r.outcome, '?') || ']'; END IF;
    SELECT * INTO msg FROM public.messages WHERE id = r.message_id;
    IF NOT (msg.conversation_id = run.conversation_id AND msg.sender_type = 'bot' AND msg.content_type = 'text' AND msg.content_text = 'sent during the outage'
            AND msg.message_id = 'wamid.Q01' || status_i AND msg.status = 'sent') THEN ok := false; detail := detail || ' [' || status_i || ': message shape]'; END IF;
    IF (SELECT count(*) FROM public.flow_run_effect_messages WHERE effect_id = eid AND message_id = r.message_id) <> 1 THEN ok := false; detail := detail || ' [link]'; END IF;
    IF to_jsonb((SELECT x FROM public.flow_runs x WHERE id = rid)) <> before_run OR (SELECT to_jsonb(e) FROM public.flow_run_effects e WHERE e.id = eid) <> before_eff THEN ok := false; detail := detail || ' [' || status_i || ': repair changed the run or the effect]'; END IF;
    -- idempotent
    SELECT * INTO r FROM public.repair_versioned_run_inbox(run.account_id, rid);
    IF r.outcome <> 'already_persisted' OR (SELECT count(*) FROM public.messages WHERE conversation_id = run.conversation_id) <> 1 OR (SELECT count(*) FROM public.flow_run_effect_messages WHERE flow_run_id = rid) <> 1 THEN ok := false; detail := detail || ' [' || status_i || ': second repair duplicated]'; END IF;
    IF (SELECT last_message_text FROM public.conversations WHERE id = run.conversation_id) <> 'sent during the outage' THEN ok := false; detail := detail || ' [preview]'; END IF;
  END LOOP;
  PERFORM public.qa_result('Q01', ok, 'Inbox outage -> effect confirmed -> run advanced and ended (completed AND failed) -> Inbox back: the lease-based reconcile is refused, repair_versioned_run_inbox (no lease) creates the message (sent) and its link once, leaves the run and the effect byte-identical, and a second repair changes nothing' || detail);
END $$;

-- Q02: a persistent failure is reported, leaves no partial state and exposes no message text
DO $$
DECLARE rid uuid; eid uuid; run public.flow_runs%ROWTYPE; before_run jsonb; r record; ok boolean := true; detail text := ''; ev jsonb; evs int;
BEGIN
  rid := public.qa_flow_run_conv('57000000-0000-4000-8000-0000000000a0', 5003);
  PERFORM public.qa_lease(rid);
  PERFORM set_config('qa.pr30_block', '1', true);
  eid := public.qa_eff_registered_accept(rid, 'w1', '{"kind":"text","text":"confidential body"}', 'wamid.Q02');
  PERFORM public.qa_finish_run(rid, 'w1', eid, 'completed');
  SELECT * INTO run FROM public.flow_runs WHERE id = rid;
  before_run := to_jsonb(run);
  FOR i IN 1..2 LOOP
    SELECT * INTO r FROM public.repair_versioned_run_inbox(run.account_id, rid);
    IF r.outcome <> 'failed' OR r.reason <> 'P9997' OR r.message_id IS NOT NULL THEN ok := false; detail := detail || ' [attempt ' || i || ': ' || coalesce(r.outcome, '?') || '/' || coalesce(r.reason, '?') || ']'; END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM public.messages WHERE conversation_id = run.conversation_id) OR EXISTS (SELECT 1 FROM public.flow_run_effect_messages WHERE flow_run_id = rid) THEN ok := false; detail := detail || ' [partial Inbox state]'; END IF;
  IF to_jsonb((SELECT x FROM public.flow_runs x WHERE id = rid)) <> before_run THEN ok := false; detail := detail || ' [run changed]'; END IF;
  SELECT count(*) INTO evs FROM public.flow_run_events WHERE flow_run_id = rid AND event_type = 'error' AND payload->>'reason' = 'inbox_repair_failed';
  IF evs <> 2 THEN ok := false; detail := detail || ' [error events: ' || evs || ']'; END IF;
  SELECT payload INTO ev FROM public.flow_run_events WHERE flow_run_id = rid AND payload->>'reason' = 'inbox_repair_failed' LIMIT 1;
  IF ev->>'effect_id' <> eid::text OR ev->>'sqlstate' <> 'P9997' OR (SELECT string_agg(payload::text, ' ') FROM public.flow_run_events WHERE flow_run_id = rid) LIKE '%confidential%' THEN ok := false; detail := detail || ' [event content]'; END IF;
  PERFORM set_config('qa.pr30_block', '', true);
  SELECT * INTO r FROM public.repair_versioned_run_inbox(run.account_id, rid);
  IF r.outcome <> 'created' THEN ok := false; detail := detail || ' [repair after the outage ended: ' || coalesce(r.outcome, '?') || ']'; END IF;
  PERFORM public.qa_result('Q02', ok, 'while the Inbox is still down repair reports outcome=failed with the SQLSTATE (twice), writes only id-only error events (no message text), leaves no message/link and the run untouched; when the Inbox is back the same call creates the message' || detail);
END $$;

-- Q03: isolation
DO $$
DECLARE rid uuid; rid2 uuid; eid uuid; eid2 uuid; run public.flow_runs%ROWTYPE; run2 public.flow_runs%ROWTYPE; acct_b uuid; lid uuid; ok boolean := true; detail text := ''; got text; before_row jsonb; r record; n int; conv_b uuid;
BEGIN
  SELECT account_id INTO acct_b FROM public.flows WHERE id = '60000000-0000-4000-8000-000000000001';
  PERFORM set_config('qa.pr30_block', '1', true);
  rid := public.qa_flow_run_conv('57000000-0000-4000-8000-0000000000a0', 5004); PERFORM public.qa_lease(rid);
  eid := public.qa_eff_registered_accept(rid, 'w1', '{"kind":"text","text":"run one"}', 'wamid.Q03A');
  rid2 := public.qa_flow_run_conv('57000000-0000-4000-8000-0000000000a0', 5005); PERFORM public.qa_lease(rid2);
  eid2 := public.qa_eff_registered_accept(rid2, 'w1', '{"kind":"text","text":"run two"}', 'wamid.Q03B');
  PERFORM set_config('qa.pr30_block', '', true);
  SELECT * INTO run FROM public.flow_runs WHERE id = rid; SELECT * INTO run2 FROM public.flow_runs WHERE id = rid2;
  -- another account addresses the run
  got := NULL; BEGIN PERFORM * FROM public.repair_versioned_run_inbox(acct_b, rid); EXCEPTION WHEN no_data_found THEN got := SQLERRM; END;
  IF got IS DISTINCT FROM 'versioned run not found' THEN ok := false; detail := detail || ' [cross-account ' || coalesce(got, 'accepted') || ']'; END IF;
  -- a legacy run
  INSERT INTO public.flow_runs (flow_id, account_id, user_id, contact_id, status, current_node_key)
  VALUES ('50000000-0000-4000-8000-000000000002', run.account_id, '10000000-0000-4000-8000-000000000001', public.qa_new_contact(5006), 'active', 'start') RETURNING id INTO lid;
  before_row := to_jsonb((SELECT x FROM public.flow_runs x WHERE id = lid));
  got := NULL; BEGIN PERFORM * FROM public.repair_versioned_run_inbox(run.account_id, lid); EXCEPTION WHEN no_data_found THEN got := SQLERRM; END;
  IF got IS DISTINCT FROM 'versioned run not found' OR to_jsonb((SELECT x FROM public.flow_runs x WHERE id = lid)) <> before_row THEN ok := false; detail := detail || ' [legacy]'; END IF;
  -- repairing run one never touches run two
  PERFORM * FROM public.repair_versioned_run_inbox(run.account_id, rid);
  SELECT count(*) INTO n FROM public.messages WHERE conversation_id = run2.conversation_id; IF n <> 0 THEN ok := false; detail := detail || ' [repair leaked into another run]'; END IF;
  SELECT count(*) INTO n FROM public.messages WHERE conversation_id = run.conversation_id; IF n <> 1 THEN ok := false; detail := detail || ' [own run not repaired]'; END IF;
  -- an effect pointing at a conversation of another account is skipped, not written
  SELECT id INTO conv_b FROM public.conversations WHERE account_id = acct_b LIMIT 1;
  IF conv_b IS NULL THEN
    INSERT INTO public.conversations (id, user_id, account_id, contact_id) VALUES ('82000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', acct_b, '70000000-0000-4000-8000-000000000001') ON CONFLICT DO NOTHING;
    conv_b := '82000000-0000-4000-8000-000000000001';
  END IF;
  ALTER TABLE public.flow_run_effects DISABLE TRIGGER flow_run_effects_guard;
  UPDATE public.flow_run_effects SET conversation_id = conv_b WHERE id = eid2;
  ALTER TABLE public.flow_run_effects ENABLE TRIGGER flow_run_effects_guard;
  SELECT * INTO r FROM public.repair_versioned_run_inbox(run2.account_id, rid2);
  IF r.outcome <> 'skipped' OR EXISTS (SELECT 1 FROM public.messages WHERE message_id = 'wamid.Q03B') THEN ok := false; detail := detail || ' [foreign conversation written: ' || coalesce(r.outcome, '?') || ']'; END IF;
  -- a wamid that is already stored in the conversation is linked, never duplicated or overwritten
  PERFORM public.qa_result('Q03', ok, 'repair: another account and a legacy run -> P0002 (legacy row identical); repairing one run never creates messages for another; an effect whose conversation belongs to another account is skipped and nothing is written' || detail);
END $$;

-- Q04: privileges
DO $$
DECLARE rid uuid; run public.flow_runs%ROWTYPE; ok boolean := true; detail text := ''; st text; role_name text; before_n int;
BEGIN
  CREATE ROLE qa_repair_probe NOLOGIN; GRANT USAGE ON SCHEMA public TO qa_repair_probe;
  rid := public.qa_flow_run_conv('57000000-0000-4000-8000-0000000000a0', 5007);
  SELECT * INTO run FROM public.flow_runs WHERE id = rid;
  IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) x WHERE p.proname = 'repair_versioned_run_inbox' AND x.grantee = 0) THEN ok := false; detail := detail || ' [PUBLIC grant]'; END IF;
  IF NOT has_function_privilege('service_role', 'public.repair_versioned_run_inbox(uuid,uuid)', 'EXECUTE') THEN ok := false; detail := detail || ' [service_role lacks EXECUTE]'; END IF;
  FOREACH role_name IN ARRAY ARRAY['qa_repair_probe', 'anon', 'authenticated'] LOOP
    IF has_function_privilege(role_name, 'public.repair_versioned_run_inbox(uuid,uuid)', 'EXECUTE') THEN ok := false; detail := detail || ' [' || role_name || ' may EXECUTE]'; END IF;
    st := NULL; EXECUTE format('SET LOCAL ROLE %I', role_name);
    BEGIN PERFORM * FROM public.repair_versioned_run_inbox(run.account_id, rid); EXCEPTION WHEN OTHERS THEN st := SQLSTATE; END;
    RESET ROLE;
    IF st IS DISTINCT FROM '42501' THEN ok := false; detail := detail || ' [' || role_name || ' ran it: ' || coalesce(st, 'SUCCEEDED') || ']'; END IF;
  END LOOP;
  SET LOCAL ROLE service_role;
  BEGIN PERFORM * FROM public.repair_versioned_run_inbox(run.account_id, rid); EXCEPTION WHEN OTHERS THEN ok := false; detail := detail || ' [service_role error ' || SQLSTATE || ']'; END;
  RESET ROLE;
  st := NULL; BEGIN PERFORM * FROM public.repair_versioned_run_inbox(NULL, rid); EXCEPTION WHEN OTHERS THEN st := SQLSTATE; END;
  IF st IS DISTINCT FROM '22023' THEN ok := false; detail := detail || ' [null account: ' || coalesce(st, 'accepted') || ']'; END IF;
  PERFORM public.qa_result('Q04', ok, 'repair_versioned_run_inbox: no PUBLIC grant; PUBLIC-probe / anon / authenticated -> 42501; service_role runs it; NULL arguments -> 22023' || detail);
END $$;
DROP TRIGGER qa_pr30_block_messages ON public.messages;
