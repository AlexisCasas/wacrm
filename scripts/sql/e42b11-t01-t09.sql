-- E4.2B1.1 QA, regression block: T01 (valid versioned run) and T09 (a
-- conversation of another contact in the same account is rejected).
-- Runs inside a transaction after helpers + fixtures; the runner rolls back.

-- T01: the active version is resolved from flows, not supplied by the caller.
DO $$
DECLARE r record; run public.flow_runs%ROWTYPE; v uuid; acct uuid;
BEGIN
  SELECT account_id, active_version_id INTO acct, v FROM public.flows WHERE id='50000000-0000-4000-8000-000000000001';
  SELECT * INTO r FROM public.create_versioned_flow_run(acct,'50000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','{"answer":"ok"}');
  IF NOT (r.created AND r.flow_run_id IS NOT NULL AND r.reason IS NULL) THEN
    PERFORM public.qa_result('T01', false, 'unexpected result ' || to_jsonb(r)::text); END IF;
  SELECT * INTO run FROM public.flow_runs WHERE id=r.flow_run_id;
  PERFORM public.qa_result('T01',
    run.execution_mode = 'versioned' AND run.status = 'active'
    AND run.root_flow_version_id = v AND run.current_flow_version_id = v
    AND run.versioned_node_key = 'start' AND run.current_node_key = 'start'
    AND run.vars = '{"answer":"ok"}'::jsonb
    AND run.conversation_id = '40000000-0000-4000-8000-000000000001'
    AND run.versioned_checkpoint = jsonb_build_object('cursor',jsonb_build_object('flow_version_id',v,'node_key','start'),'step',0),
    'run ' || r.flow_run_id || ' created on version ' || v);
END $$;

-- T09: same account but another contact's conversation must be rejected,
-- and no run may be left behind for that contact.
DO $$
DECLARE acct uuid; n int;
BEGIN
  SELECT account_id INTO acct FROM public.flows WHERE id='50000000-0000-4000-8000-000000000001';
  PERFORM public.qa_expect_error('T09', public.qa_call(acct,'50000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000002','40000000-0000-4000-8000-000000000001'),
    'P0002','conversation not found for contact in account');
  SELECT count(*) INTO n FROM public.flow_runs WHERE contact_id='30000000-0000-4000-8000-000000000002';
  IF n <> 0 THEN PERFORM public.qa_result('T09', false, n || ' leftover runs'); END IF;
END $$;
