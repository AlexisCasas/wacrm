-- E4.2B1.1 QA: T01 (valid versioned run) and T09 (conversation of another
-- contact in the same account is rejected).
-- Prerequisite: migrations 001..054 applied to an empty database (see
-- scripts/sql/run-e42b11-qa.sh). Fixtures are created with the real schema,
-- never with CREATE TABLE, so the script is safe on a fresh database only.
\set ON_ERROR_STOP on
BEGIN;

-- Fixtures: one user (the signup trigger provisions account + profile),
-- two contacts and one conversation per contact, plus a published flow.
INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
VALUES ('10000000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000',
        'authenticated','authenticated','qa-e42b11@example.test','{"full_name":"QA"}'::jsonb, now(), now());

SELECT account_id AS acct FROM public.profiles WHERE user_id='10000000-0000-4000-8000-000000000001' \gset

INSERT INTO public.contacts (id, user_id, account_id, phone, name) VALUES
 ('30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',:'acct','+15550000001','Contact A'),
 ('30000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001',:'acct','+15550000002','Contact B');
INSERT INTO public.conversations (id, user_id, account_id, contact_id) VALUES
 ('40000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',:'acct','30000000-0000-4000-8000-000000000001'),
 ('40000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001',:'acct','30000000-0000-4000-8000-000000000002');

INSERT INTO public.flows (id, user_id, account_id, name, trigger_type, entry_node_id)
VALUES ('50000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',:'acct','QA flow','manual','start');
INSERT INTO public.flow_nodes (flow_id, node_key, node_type, config) VALUES
 ('50000000-0000-4000-8000-000000000001','start','start','{"next":"end"}'),
 ('50000000-0000-4000-8000-000000000001','end','end','{}');

-- Publish through the real RPC (the only supported path to an active flow).
DO $$
DECLARE f public.flows%ROWTYPE; d jsonb;
BEGIN
  SELECT * INTO f FROM public.flows WHERE id='50000000-0000-4000-8000-000000000001';
  SELECT jsonb_build_object(
    'flow', jsonb_build_object('id',f.id,'name',f.name,'description',f.description,'trigger_type',f.trigger_type,
            'trigger_config',f.trigger_config,'entry_node_id',f.entry_node_id,'fallback_policy',f.fallback_policy),
    'nodes', COALESCE((SELECT jsonb_agg(jsonb_build_object('node_key',n.node_key,'node_type',n.node_type,'config',n.config,
            'position_x',n.position_x,'position_y',n.position_y) ORDER BY n.node_key)
            FROM public.flow_nodes n WHERE n.flow_id=f.id),'[]'::jsonb)) INTO d;
  PERFORM public.publish_flow_version(f.id, f.updated_at, '10000000-0000-4000-8000-000000000001', d);
END $$;

-- T01: the active version is resolved from flows, not supplied by the caller.
DO $$
DECLARE r record; run public.flow_runs%ROWTYPE; v uuid; acct uuid;
BEGIN
  SELECT account_id INTO acct FROM public.flows WHERE id='50000000-0000-4000-8000-000000000001';
  SELECT active_version_id INTO v FROM public.flows WHERE id='50000000-0000-4000-8000-000000000001';
  SELECT * INTO r FROM public.create_versioned_flow_run(acct,'50000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','{"answer":"ok"}');
  IF NOT (r.created AND r.flow_run_id IS NOT NULL AND r.reason IS NULL) THEN
    RAISE EXCEPTION 'T01 FAIL: unexpected result %', r; END IF;
  SELECT * INTO run FROM public.flow_runs WHERE id=r.flow_run_id;
  IF run.execution_mode <> 'versioned' OR run.status <> 'active'
     OR run.root_flow_version_id IS DISTINCT FROM v OR run.current_flow_version_id IS DISTINCT FROM v
     OR run.versioned_node_key <> 'start' OR run.current_node_key <> 'start'
     OR run.vars <> '{"answer":"ok"}'::jsonb
     OR run.conversation_id <> '40000000-0000-4000-8000-000000000001'
     OR run.versioned_checkpoint <> jsonb_build_object('cursor',jsonb_build_object('flow_version_id',v,'node_key','start'),'step',0)
  THEN RAISE EXCEPTION 'T01 FAIL: persisted run mismatch %', to_jsonb(run); END IF;
  RAISE NOTICE 'T01 PASS: run % created on version %', r.flow_run_id, v;
END $$;

-- T09: same account but another contact's conversation must be rejected,
-- and no run may be left behind for that contact.
DO $$
DECLARE acct uuid; n int;
BEGIN
  SELECT account_id INTO acct FROM public.flows WHERE id='50000000-0000-4000-8000-000000000001';
  BEGIN
    PERFORM * FROM public.create_versioned_flow_run(acct,'50000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000002','40000000-0000-4000-8000-000000000001','{}');
    RAISE EXCEPTION 'T09 FAIL: call unexpectedly succeeded';
  EXCEPTION WHEN no_data_found THEN
    IF SQLERRM <> 'conversation not found for contact in account' THEN
      RAISE EXCEPTION 'T09 FAIL: wrong message %', SQLERRM; END IF;
  END;
  SELECT count(*) INTO n FROM public.flow_runs WHERE contact_id='30000000-0000-4000-8000-000000000002';
  IF n <> 0 THEN RAISE EXCEPTION 'T09 FAIL: % leftover runs', n; END IF;
  RAISE NOTICE 'T09 PASS: cross-contact conversation rejected (P0002), no run created';
END $$;

ROLLBACK;
