-- E4.2B1.2 QA: lease / fencing / CAS RPCs of migration 055. Runs in the same
-- rolled-back transaction as the B1.1 suites (helpers + fixtures loaded).
-- Concurrency scenarios are in e42b12-concurrency.sh. Result ids: L01..L21.

-- L01: a free run can be leased once; owner, token, expiry come from the server clock.
DO $$
DECLARE a uuid; rid uuid; r record; run public.flow_runs%ROWTYPE;
BEGIN
  SELECT account_id INTO a FROM public.flows WHERE id='50000000-0000-4000-8000-000000000001';
  rid := public.qa_new_run(101);
  SELECT * INTO r FROM public.acquire_versioned_run_lease(a, rid, 'worker-1', 30);
  SELECT * INTO run FROM public.flow_runs WHERE id = rid;
  PERFORM public.qa_result('L01', r.acquired AND r.fencing_token = 1 AND r.reason IS NULL AND r.revision = 0
    AND run.versioned_lease_owner = 'worker-1' AND run.versioned_lease = 1 AND run.versioned_lease_expires_at = r.lease_expires_at
    AND r.lease_expires_at BETWEEN clock_timestamp() + interval '25 s' AND clock_timestamp() + interval '31 s',
    'acquired token=1 owner=worker-1 expiry=' || r.lease_expires_at);
  -- L02: a live lease is never stolen, and the failed attempt changes nothing.
  DECLARE before_row jsonb := to_jsonb(run); r2 record; r3 record;
  BEGIN
    SELECT * INTO r2 FROM public.acquire_versioned_run_lease(a, rid, 'worker-2', 30);
    SELECT * INTO r3 FROM public.reclaim_versioned_run_lease(a, rid, 'worker-2', 30);
    PERFORM public.qa_result('L02', NOT r2.acquired AND r2.reason = 'lease_held' AND NOT r3.acquired AND r3.reason = 'lease_held'
      AND to_jsonb((SELECT x FROM public.flow_runs x WHERE id = rid)) = before_row,
      'acquire and reclaim of a live lease -> lease_held, row untouched');
  END;
END $$;

-- L04/L05: renewal needs the live owner and token.
DO $$
DECLARE a uuid; rid uuid; r record; r2 record; r3 record; r4 record; e1 timestamptz; run public.flow_runs%ROWTYPE;
BEGIN
  SELECT account_id INTO a FROM public.flows WHERE id='50000000-0000-4000-8000-000000000001';
  rid := public.qa_new_run(102);
  SELECT * INTO r FROM public.acquire_versioned_run_lease(a, rid, 'w1', 5);
  SELECT * INTO r2 FROM public.renew_versioned_run_lease(a, rid, 'w1', r.fencing_token, 600);
  SELECT * INTO run FROM public.flow_runs WHERE id = rid;
  PERFORM public.qa_result('L04', r2.renewed AND r2.reason IS NULL AND r2.lease_expires_at > r.lease_expires_at + interval '500 s'
    AND run.versioned_lease_expires_at = r2.lease_expires_at AND run.versioned_lease = r.fencing_token,
    'renewed 5s -> 600s lease, token unchanged (' || r.fencing_token || ')');
  e1 := run.versioned_lease_expires_at;
  SELECT * INTO r3 FROM public.renew_versioned_run_lease(a, rid, 'intruder', r.fencing_token, 600);
  SELECT * INTO r4 FROM public.renew_versioned_run_lease(a, rid, 'w1', r.fencing_token + 1, 600);
  PERFORM public.qa_result('L05', NOT r3.renewed AND r3.reason = 'stale_lease' AND NOT r4.renewed AND r4.reason = 'stale_lease'
    AND (SELECT versioned_lease_expires_at FROM public.flow_runs WHERE id = rid) = e1,
    'foreign owner and wrong token -> stale_lease, expiry unchanged');
END $$;

-- L06: release needs owner+token; the token survives so it keeps growing.
DO $$
DECLARE a uuid; rid uuid; r record; rel_bad record; rel_old record; rel record; r2 record; run public.flow_runs%ROWTYPE;
BEGIN
  SELECT account_id INTO a FROM public.flows WHERE id='50000000-0000-4000-8000-000000000001';
  rid := public.qa_new_run(103);
  SELECT * INTO r FROM public.acquire_versioned_run_lease(a, rid, 'w1', 60);
  SELECT * INTO rel_bad FROM public.release_versioned_run_lease(a, rid, 'other', r.fencing_token);
  SELECT * INTO rel_old FROM public.release_versioned_run_lease(a, rid, 'w1', 99);
  SELECT * INTO rel FROM public.release_versioned_run_lease(a, rid, 'w1', r.fencing_token);
  SELECT * INTO run FROM public.flow_runs WHERE id = rid;
  SELECT * INTO r2 FROM public.acquire_versioned_run_lease(a, rid, 'w2', 60);
  PERFORM public.qa_result('L06', NOT rel_bad.released AND rel_bad.reason = 'stale_lease' AND NOT rel_old.released AND rel_old.reason = 'stale_lease'
    AND rel.released AND run.versioned_lease_owner IS NULL AND run.versioned_lease_expires_at IS NULL AND run.versioned_lease = 1
    AND r2.acquired AND r2.fencing_token = 2,
    'foreign/old-token release refused; owner release clears owner+expiry, keeps token 1; next acquire gets token 2');
END $$;

-- L07/L13: expired lease can be neither renewed nor committed nor re-acquired; real server clock first.
DO $$
DECLARE a uuid; v uuid; rid uuid; r record; ra record; rr record; rc record; before_row jsonb;
BEGIN
  SELECT account_id, active_version_id INTO a, v FROM public.flows WHERE id='50000000-0000-4000-8000-000000000001';
  rid := public.qa_new_run(104);
  SELECT * INTO r FROM public.acquire_versioned_run_lease(a, rid, 'w1', 1);
  PERFORM pg_sleep(1.3);  -- real expiry on the PostgreSQL clock, not a rewritten column
  before_row := to_jsonb((SELECT x FROM public.flow_runs x WHERE id = rid));
  SELECT * INTO ra FROM public.acquire_versioned_run_lease(a, rid, 'w2', 30);
  SELECT * INTO rr FROM public.renew_versioned_run_lease(a, rid, 'w1', r.fencing_token, 30);
  SELECT * INTO rc FROM public.commit_versioned_run_transition(a, rid, 'w1', r.fencing_token, 0,
    jsonb_build_object('cursor', jsonb_build_object('flow_version_id', v, 'node_key', 'end'), 'step', 1));
  PERFORM public.qa_result('L07', NOT ra.acquired AND ra.reason = 'lease_expired' AND NOT rr.renewed AND rr.reason = 'lease_expired'
    AND to_jsonb((SELECT x FROM public.flow_runs x WHERE id = rid)) = before_row,
    'after 1s ttl: acquire -> lease_expired, renew -> lease_expired, row untouched');
  PERFORM public.qa_result('L13', NOT rc.committed AND rc.reason = 'lease_expired' AND rc.revision = 0,
    'CAS by the owner of an expired lease -> lease_expired, revision stays 0');
END $$;

-- L08/L09/L10: reclaim, invalidation of the old writer, monotonic fencing.
DO $$
DECLARE a uuid; v uuid; rid uuid; r1 record; r2 record; r3 record; r4 record; old_ren record; old_rel record; old_cas record; rec_none record; before_row jsonb; toks int[];
  cp jsonb;
BEGIN
  SELECT account_id, active_version_id INTO a, v FROM public.flows WHERE id='50000000-0000-4000-8000-000000000001';
  cp := jsonb_build_object('cursor', jsonb_build_object('flow_version_id', v, 'node_key', 'end'), 'step', 1);
  rid := public.qa_new_run(105);
  SELECT * INTO rec_none FROM public.reclaim_versioned_run_lease(a, rid, 'w2', 30);
  SELECT * INTO r1 FROM public.acquire_versioned_run_lease(a, rid, 'w1', 30);
  UPDATE public.flow_runs SET versioned_lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = rid;
  SELECT * INTO r2 FROM public.reclaim_versioned_run_lease(a, rid, 'w2', 30);
  before_row := to_jsonb((SELECT x FROM public.flow_runs x WHERE id = rid));
  SELECT * INTO old_ren FROM public.renew_versioned_run_lease(a, rid, 'w1', r1.fencing_token, 30);
  SELECT * INTO old_rel FROM public.release_versioned_run_lease(a, rid, 'w1', r1.fencing_token);
  SELECT * INTO old_cas FROM public.commit_versioned_run_transition(a, rid, 'w1', r1.fencing_token, 0, cp);
  PERFORM public.qa_result('L08', NOT rec_none.acquired AND rec_none.reason = 'no_lease' AND r2.acquired AND r2.fencing_token = r1.fencing_token + 1
    AND (SELECT versioned_lease_owner FROM public.flow_runs WHERE id = rid) = 'w2',
    'reclaim without lease -> no_lease; reclaim of expired lease -> acquired, token ' || r1.fencing_token || '->' || r2.fencing_token);
  PERFORM public.qa_result('L09', NOT old_ren.renewed AND old_ren.reason = 'stale_lease' AND NOT old_rel.released AND old_rel.reason = 'stale_lease'
    AND NOT old_cas.committed AND old_cas.reason = 'stale_lease' AND to_jsonb((SELECT x FROM public.flow_runs x WHERE id = rid)) = before_row,
    'old owner (token ' || r1.fencing_token || ') refused on renew, release and CAS; row untouched');
  -- release, acquire, expire, reclaim: tokens must keep climbing
  SELECT * INTO r3 FROM public.release_versioned_run_lease(a, rid, 'w2', r2.fencing_token);
  SELECT * INTO r4 FROM public.acquire_versioned_run_lease(a, rid, 'w3', 30);
  UPDATE public.flow_runs SET versioned_lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = rid;
  toks := ARRAY[r1.fencing_token, r2.fencing_token, r4.fencing_token, (SELECT fencing_token FROM public.reclaim_versioned_run_lease(a, rid, 'w4', 30))];
  PERFORM public.qa_result('L10', toks = ARRAY[1,2,3,4], 'fencing tokens across acquire/reclaim/release/acquire/reclaim: ' || array_to_string(toks, ','));
END $$;

-- L11/L12: CAS persists cursor + checkpoint + revision atomically; stale revision is refused.
DO $$
DECLARE a uuid; v uuid; rid uuid; r record; c1 record; c2 record; c3 record; run public.flow_runs%ROWTYPE; cp jsonb; cp2 jsonb; before_row jsonb;
BEGIN
  SELECT account_id, active_version_id INTO a, v FROM public.flows WHERE id='50000000-0000-4000-8000-000000000001';
  cp := jsonb_build_object('cursor', jsonb_build_object('flow_version_id', v, 'node_key', 'end'), 'step', 1, 'note', 'persisted');
  cp2 := jsonb_build_object('cursor', jsonb_build_object('flow_version_id', v, 'node_key', 'start'), 'step', 2);
  rid := public.qa_new_run(106);
  SELECT * INTO r FROM public.acquire_versioned_run_lease(a, rid, 'w1', 60);
  SELECT * INTO c1 FROM public.commit_versioned_run_transition(a, rid, 'w1', r.fencing_token, 0, cp);
  SELECT * INTO run FROM public.flow_runs WHERE id = rid;
  PERFORM public.qa_result('L11', c1.committed AND c1.revision = 1 AND c1.reason IS NULL AND run.versioned_revision = 1
    AND run.versioned_checkpoint = cp AND run.versioned_node_key = 'end' AND run.current_node_key = 'end' AND run.current_flow_version_id = v
    AND run.root_flow_version_id = v AND run.status = 'active' AND run.versioned_lease_owner = 'w1' AND run.versioned_lease = r.fencing_token,
    'revision 0->1; checkpoint, versioned_node_key, current_node_key, current_flow_version_id all moved together; lease kept');
  before_row := to_jsonb(run);
  SELECT * INTO c2 FROM public.commit_versioned_run_transition(a, rid, 'w1', r.fencing_token, 0, cp2);   -- stale revision
  SELECT * INTO c3 FROM public.commit_versioned_run_transition(a, rid, 'w1', r.fencing_token, 5, cp2);   -- future revision
  PERFORM public.qa_result('L12', NOT c2.committed AND c2.reason = 'revision_conflict' AND c2.revision = 1
    AND NOT c3.committed AND c3.reason = 'revision_conflict' AND to_jsonb((SELECT x FROM public.flow_runs x WHERE id = rid)) = before_row,
    'expected revision 0 and 5 vs actual 1 -> revision_conflict, row untouched');
END $$;

-- L14/L15: paused, failed and finished runs are rejected and cannot be reactivated.
DO $$
DECLARE a uuid; v uuid; rid uuid; r record; ra record; rn record; rc record; cp jsonb; st text; msg text; fin record; fin2 record; fin3 record; run public.flow_runs%ROWTYPE; i int; ok boolean := true; detail text := '';
BEGIN
  SELECT account_id, active_version_id INTO a, v FROM public.flows WHERE id='50000000-0000-4000-8000-000000000001';
  cp := jsonb_build_object('cursor', jsonb_build_object('flow_version_id', v, 'node_key', 'end'), 'step', 1);
  -- L14: agent pauses the run while a worker holds a lease
  rid := public.qa_new_run(107);
  SELECT * INTO r FROM public.acquire_versioned_run_lease(a, rid, 'w1', 60);
  UPDATE public.flow_runs SET status = 'paused_by_agent' WHERE id = rid;
  SELECT * INTO ra FROM public.acquire_versioned_run_lease(a, rid, 'w2', 60);
  SELECT * INTO rn FROM public.renew_versioned_run_lease(a, rid, 'w1', r.fencing_token, 60);
  SELECT * INTO rc FROM public.commit_versioned_run_transition(a, rid, 'w1', r.fencing_token, 0, cp);
  BEGIN UPDATE public.flow_runs SET status = 'active' WHERE id = rid; EXCEPTION WHEN OTHERS THEN st := SQLSTATE; END;
  PERFORM public.qa_result('L14', ra.reason = 'run_not_active' AND rn.reason = 'run_not_active' AND rc.reason = 'run_not_active'
    AND NOT ra.acquired AND NOT rn.renewed AND NOT rc.committed AND st = '55000'
    AND (SELECT status FROM public.flow_runs WHERE id = rid) = 'paused_by_agent',
    'paused run: acquire/renew/CAS -> run_not_active; direct reactivation blocked (55000)');
  -- L15: terminal CAS ends the run and releases the lease; everything afterwards is refused
  FOR i IN 1..2 LOOP
    rid := public.qa_new_run(107 + i);
    SELECT * INTO r FROM public.acquire_versioned_run_lease(a, rid, 'w1', 60);
    SELECT * INTO fin FROM public.commit_versioned_run_transition(a, rid, 'w1', r.fencing_token, 0, cp, CASE i WHEN 1 THEN 'completed' ELSE 'failed' END, 'qa');
    SELECT * INTO run FROM public.flow_runs WHERE id = rid;
    SELECT * INTO fin2 FROM public.commit_versioned_run_transition(a, rid, 'w1', r.fencing_token, 1, cp);
    SELECT * INTO fin3 FROM public.acquire_versioned_run_lease(a, rid, 'w2', 60);
    st := NULL;
    BEGIN UPDATE public.flow_runs SET status = 'active' WHERE id = rid; EXCEPTION WHEN OTHERS THEN st := SQLSTATE; END;
    IF NOT (fin.committed AND run.status = CASE i WHEN 1 THEN 'completed' ELSE 'failed' END AND run.ended_at IS NOT NULL AND run.end_reason = 'qa'
        AND run.versioned_lease_owner IS NULL AND run.versioned_lease = r.fencing_token
        AND fin2.reason = 'run_not_active' AND fin3.reason = 'run_not_active' AND st = '55000') THEN
      ok := false; detail := detail || ' iteration ' || i || ' wrong';
    END IF;
  END LOOP;
  PERFORM public.qa_result('L15', ok, 'completed and failed runs: ended_at set, lease released, later CAS/acquire -> run_not_active, reactivation blocked' || detail);
END $$;

-- L16/L17: account isolation and legacy runs.
DO $$
DECLARE a uuid; b uuid; v uuid; rid uuid; lid uuid; r record; before_row jsonb; fn text; ok boolean := true; detail text := ''; cp jsonb;
  calls text[];
BEGIN
  SELECT account_id, active_version_id INTO a, v FROM public.flows WHERE id='50000000-0000-4000-8000-000000000001';
  SELECT account_id INTO b FROM public.flows WHERE id='60000000-0000-4000-8000-000000000001';
  cp := jsonb_build_object('cursor', jsonb_build_object('flow_version_id', v, 'node_key', 'end'), 'step', 1);
  rid := public.qa_new_run(110);
  SELECT * INTO r FROM public.acquire_versioned_run_lease(a, rid, 'w1', 60);
  before_row := to_jsonb((SELECT x FROM public.flow_runs x WHERE id = rid));
  -- L16: account B can touch none of account A's run, with the real owner/token.
  calls := ARRAY[
    format('SELECT * FROM public.acquire_versioned_run_lease(%L,%L,%L,30)', b, rid, 'w1'),
    format('SELECT * FROM public.reclaim_versioned_run_lease(%L,%L,%L,30)', b, rid, 'w1'),
    format('SELECT * FROM public.renew_versioned_run_lease(%L,%L,%L,%s,30)', b, rid, 'w1', r.fencing_token),
    format('SELECT * FROM public.release_versioned_run_lease(%L,%L,%L,%s)', b, rid, 'w1', r.fencing_token),
    format('SELECT * FROM public.commit_versioned_run_transition(%L,%L,%L,%s,0,%L::jsonb)', b, rid, 'w1', r.fencing_token, cp)];
  FOREACH fn IN ARRAY calls LOOP
    BEGIN EXECUTE fn; ok := false; detail := detail || ' [no error: ' || left(fn, 40) || ']';
    EXCEPTION WHEN no_data_found THEN IF SQLERRM <> 'versioned run not found' THEN ok := false; detail := detail || ' [msg ' || SQLERRM || ']'; END IF; END;
  END LOOP;
  PERFORM public.qa_result('L16', ok AND to_jsonb((SELECT x FROM public.flow_runs x WHERE id = rid)) = before_row,
    'all 5 RPCs with a foreign account -> P0002 "versioned run not found", row untouched' || detail);
  -- L17: a legacy run is invisible to every RPC and stays byte-for-byte identical.
  INSERT INTO public.flow_runs (flow_id, account_id, user_id, contact_id, status, current_node_key)
  VALUES ('50000000-0000-4000-8000-000000000002', a, '10000000-0000-4000-8000-000000000001', public.qa_new_contact(111), 'active', 'start') RETURNING id INTO lid;
  before_row := to_jsonb((SELECT x FROM public.flow_runs x WHERE id = lid));
  ok := true; detail := '';
  calls := ARRAY[
    format('SELECT * FROM public.acquire_versioned_run_lease(%L,%L,%L,30)', a, lid, 'w1'),
    format('SELECT * FROM public.reclaim_versioned_run_lease(%L,%L,%L,30)', a, lid, 'w1'),
    format('SELECT * FROM public.renew_versioned_run_lease(%L,%L,%L,1,30)', a, lid, 'w1'),
    format('SELECT * FROM public.release_versioned_run_lease(%L,%L,%L,1)', a, lid, 'w1'),
    format('SELECT * FROM public.commit_versioned_run_transition(%L,%L,%L,1,0,%L::jsonb)', a, lid, 'w1', cp)];
  FOREACH fn IN ARRAY calls LOOP
    BEGIN EXECUTE fn; ok := false; detail := detail || ' [no error: ' || left(fn, 40) || ']';
    EXCEPTION WHEN no_data_found THEN IF SQLERRM <> 'versioned run not found' THEN ok := false; detail := detail || ' [msg ' || SQLERRM || ']'; END IF; END;
  END LOOP;
  PERFORM public.qa_result('L17', ok AND to_jsonb((SELECT x FROM public.flow_runs x WHERE id = lid)) = before_row
    AND (SELECT versioned_lease_owner IS NULL AND versioned_lease = 0 AND versioned_revision = 0 FROM public.flow_runs WHERE id = lid),
    'all 5 RPCs on a legacy run -> P0002, row identical, lease columns at defaults' || detail);
END $$;

-- L18/L19: invalid input is refused and a raised error leaves no partial write.
DO $$
DECLARE a uuid; v uuid; rid uuid; r record; before_row jsonb; cp_bad jsonb; ok boolean := true; detail text := ''; t record; got text;
BEGIN
  SELECT account_id, active_version_id INTO a, v FROM public.flows WHERE id='50000000-0000-4000-8000-000000000001';
  rid := public.qa_new_run(112);
  SELECT * INTO r FROM public.acquire_versioned_run_lease(a, rid, 'w1', 60);
  before_row := to_jsonb((SELECT x FROM public.flow_runs x WHERE id = rid));
  FOR t IN SELECT * FROM (VALUES
    ('ttl 0',            format('SELECT * FROM public.acquire_versioned_run_lease(%L,%L,%L,0)', a, rid, 'w'), 'invalid versioned run request'),
    ('ttl too large',    format('SELECT * FROM public.renew_versioned_run_lease(%L,%L,%L,%s,3601)', a, rid, 'w1', r.fencing_token), 'invalid versioned run request'),
    ('empty owner',      format('SELECT * FROM public.acquire_versioned_run_lease(%L,%L,%L,30)', a, rid, ''), 'invalid versioned run request'),
    ('null token',       format('SELECT * FROM public.release_versioned_run_lease(%L,%L,%L,NULL)', a, rid, 'w1'), 'invalid versioned run request'),
    ('checkpoint array', format('SELECT * FROM public.commit_versioned_run_transition(%L,%L,%L,%s,0,%L::jsonb)', a, rid, 'w1', r.fencing_token, '[]'), 'invalid versioned run request'),
    ('no step',          format('SELECT * FROM public.commit_versioned_run_transition(%L,%L,%L,%s,0,%L::jsonb)', a, rid, 'w1', r.fencing_token,
                                jsonb_build_object('cursor', jsonb_build_object('flow_version_id', v, 'node_key', 'end'))), 'invalid versioned run request'),
    ('negative step',   format('SELECT * FROM public.commit_versioned_run_transition(%L,%L,%L,%s,0,%L::jsonb)', a, rid, 'w1', r.fencing_token,
                                jsonb_build_object('cursor', jsonb_build_object('flow_version_id', v, 'node_key', 'end'), 'step', -1)), 'invalid versioned run request'),
    ('bad version uuid', format('SELECT * FROM public.commit_versioned_run_transition(%L,%L,%L,%s,0,%L::jsonb)', a, rid, 'w1', r.fencing_token,
                                jsonb_build_object('cursor', jsonb_build_object('flow_version_id', 'nope', 'node_key', 'end'), 'step', 1)), 'invalid versioned run request'),
    ('unknown node',    format('SELECT * FROM public.commit_versioned_run_transition(%L,%L,%L,%s,0,%L::jsonb)', a, rid, 'w1', r.fencing_token,
                                jsonb_build_object('cursor', jsonb_build_object('flow_version_id', v, 'node_key', 'ghost'), 'step', 1)), 'checkpoint cursor is not a node of a published version'),
    ('foreign version', format('SELECT * FROM public.commit_versioned_run_transition(%L,%L,%L,%s,0,%L::jsonb)', a, rid, 'w1', r.fencing_token,
                                jsonb_build_object('cursor', jsonb_build_object('flow_version_id', (SELECT active_version_id FROM public.flows WHERE id='60000000-0000-4000-8000-000000000001'), 'node_key', 'end'), 'step', 1)), 'checkpoint cursor is not a node of a published version'),
    ('status timed_out', format('SELECT * FROM public.commit_versioned_run_transition(%L,%L,%L,%s,0,%L::jsonb,%L)', a, rid, 'w1', r.fencing_token,
                                jsonb_build_object('cursor', jsonb_build_object('flow_version_id', v, 'node_key', 'end'), 'step', 1), 'timed_out'), 'invalid versioned run request')
  ) AS x(label, sql, msg) LOOP
    got := NULL;
    BEGIN EXECUTE t.sql; EXCEPTION WHEN OTHERS THEN got := SQLERRM; END;
    IF got IS DISTINCT FROM t.msg THEN ok := false; detail := detail || ' [' || t.label || ': ' || coalesce(got, 'no error') || ']'; END IF;
  END LOOP;
  PERFORM public.qa_result('L18', ok, '11 invalid requests rejected with the expected errors' || detail);
  PERFORM public.qa_result('L19', to_jsonb((SELECT x FROM public.flow_runs x WHERE id = rid)) = before_row,
    'after 11 rejected calls the run row is byte-identical (rollback: no partial writes)');
END $$;

-- L20: effective privileges, using real SET ROLE for every RPC.
CREATE ROLE qa_lease_probe NOLOGIN;
GRANT USAGE ON SCHEMA public TO qa_lease_probe;
DO $$
DECLARE a uuid; v uuid; rid uuid; role_name text; call_sql text; st text; ok boolean := true; out text[] := '{}'; calls text[]; sig text;
  r1 record; r2 record; r3 record; r4 record; r5 record; fns text[];
BEGIN
  SELECT account_id, active_version_id INTO a, v FROM public.flows WHERE id='50000000-0000-4000-8000-000000000001';
  rid := public.qa_new_run(113);
  fns := ARRAY['acquire_versioned_run_lease(uuid,uuid,text,integer)','reclaim_versioned_run_lease(uuid,uuid,text,integer)',
    'renew_versioned_run_lease(uuid,uuid,text,integer,integer)','release_versioned_run_lease(uuid,uuid,text,integer)',
    'commit_versioned_run_transition(uuid,uuid,text,integer,bigint,jsonb,text,text,integer,integer)'];
  FOREACH sig IN ARRAY fns LOOP
    IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) x WHERE p.oid = ('public.' || sig)::regprocedure AND x.grantee = 0) THEN ok := false; out := out || (sig || ' has PUBLIC'); END IF;
    IF NOT has_function_privilege('service_role', 'public.' || sig, 'EXECUTE') THEN ok := false; out := out || (sig || ' lacks service_role'); END IF;
    FOREACH role_name IN ARRAY ARRAY['qa_lease_probe','anon','authenticated'] LOOP
      IF has_function_privilege(role_name, 'public.' || sig, 'EXECUTE') THEN ok := false; out := out || (role_name || ' may EXECUTE ' || sig); END IF;
    END LOOP;
  END LOOP;
  calls := ARRAY[
    format('SELECT * FROM public.acquire_versioned_run_lease(%L,%L,%L,30)', a, rid, 'w1'),
    format('SELECT * FROM public.reclaim_versioned_run_lease(%L,%L,%L,30)', a, rid, 'w1'),
    format('SELECT * FROM public.renew_versioned_run_lease(%L,%L,%L,1,30)', a, rid, 'w1'),
    format('SELECT * FROM public.release_versioned_run_lease(%L,%L,%L,1)', a, rid, 'w1'),
    format('SELECT * FROM public.commit_versioned_run_transition(%L,%L,%L,1,0,%L::jsonb)', a, rid, 'w1',
           jsonb_build_object('cursor', jsonb_build_object('flow_version_id', v, 'node_key', 'end'), 'step', 1))];
  FOREACH role_name IN ARRAY ARRAY['qa_lease_probe','anon','authenticated'] LOOP
    FOREACH call_sql IN ARRAY calls LOOP
      st := NULL;
      EXECUTE format('SET LOCAL ROLE %I', role_name);
      BEGIN EXECUTE call_sql; EXCEPTION WHEN OTHERS THEN st := SQLSTATE; END;
      RESET ROLE;
      IF st IS DISTINCT FROM '42501' THEN ok := false; out := out || (role_name || ' ran ' || split_part(substr(call_sql, 22), '(', 1) || ' -> ' || coalesce(st, 'SUCCEEDED')); END IF;
    END LOOP;
  END LOOP;
  IF (SELECT versioned_lease_owner IS NOT NULL OR versioned_lease <> 0 OR versioned_revision <> 0 FROM public.flow_runs WHERE id = rid) THEN
    ok := false; out := out || 'a denied role changed the run'; END IF;
  -- service_role runs the whole life cycle
  SET LOCAL ROLE service_role;
  BEGIN
    SELECT * INTO r1 FROM public.acquire_versioned_run_lease(a, rid, 'svc', 60);
    SELECT * INTO r2 FROM public.renew_versioned_run_lease(a, rid, 'svc', r1.fencing_token, 60);
    SELECT * INTO r3 FROM public.commit_versioned_run_transition(a, rid, 'svc', r1.fencing_token, 0,
      jsonb_build_object('cursor', jsonb_build_object('flow_version_id', v, 'node_key', 'end'), 'step', 1));
    SELECT * INTO r4 FROM public.release_versioned_run_lease(a, rid, 'svc', r1.fencing_token);
    SELECT * INTO r5 FROM public.reclaim_versioned_run_lease(a, rid, 'svc', 60);
    IF NOT (r1.acquired AND r2.renewed AND r3.committed AND r4.released AND r5.reason = 'no_lease') THEN ok := false; out := out || 'service_role lifecycle wrong'; END IF;
  EXCEPTION WHEN OTHERS THEN ok := false; out := out || ('service_role error ' || SQLSTATE || ' ' || SQLERRM); END;
  RESET ROLE;
  PERFORM public.qa_result('L20', ok, '5 RPCs x (PUBLIC-probe, anon, authenticated) -> 42501 and no change; no PUBLIC grant in ACL; service_role ran acquire/renew/CAS/release/reclaim' || coalesce(' | ' || nullif(array_to_string(out, '; '), ''), ''));
END $$;

-- L21: schema guards (defence in depth against buggy service-role writes).
DO $$
DECLARE a uuid; rid uuid; lid uuid; r record; s1 text; s2 text; s3 text; s4 text; s5 text;
BEGIN
  SELECT account_id INTO a FROM public.flows WHERE id='50000000-0000-4000-8000-000000000001';
  rid := public.qa_new_run(114);
  SELECT * INTO r FROM public.acquire_versioned_run_lease(a, rid, 'w1', 60);
  INSERT INTO public.flow_runs (flow_id, account_id, user_id, contact_id, status)
  VALUES ('50000000-0000-4000-8000-000000000002', a, '10000000-0000-4000-8000-000000000001', public.qa_new_contact(115), 'active') RETURNING id INTO lid;
  BEGIN UPDATE public.flow_runs SET versioned_lease_expires_at = NULL WHERE id = rid; EXCEPTION WHEN OTHERS THEN s1 := SQLSTATE; END;           -- owner without expiry
  BEGIN UPDATE public.flow_runs SET versioned_lease_owner = 'x', versioned_lease_expires_at = now() WHERE id = lid; EXCEPTION WHEN OTHERS THEN s2 := SQLSTATE; END;  -- lease on legacy run
  BEGIN UPDATE public.flow_runs SET versioned_lease = 0 WHERE id = rid; EXCEPTION WHEN OTHERS THEN s3 := SQLSTATE; END;                         -- token goes backwards
  BEGIN UPDATE public.flow_runs SET versioned_revision = -1 WHERE id = rid; EXCEPTION WHEN OTHERS THEN s4 := SQLSTATE; END;                     -- negative revision
  BEGIN UPDATE public.flow_runs SET execution_mode = 'legacy', root_flow_version_id = NULL, current_flow_version_id = NULL, versioned_node_key = NULL, versioned_lease_owner = NULL, versioned_lease_expires_at = NULL WHERE id = rid; EXCEPTION WHEN OTHERS THEN s5 := SQLSTATE; END;
  PERFORM public.qa_result('L21', s1 = '23514' AND s2 = '23514' AND s3 = '55000' AND s4 IN ('23514','55000') AND s5 = '55000',
    'owner-without-expiry 23514, lease on legacy run 23514, token decrease 55000, negative revision ' || s4 || ', execution_mode flip 55000');
END $$;
