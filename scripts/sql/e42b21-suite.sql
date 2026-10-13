-- E4.2B2.1 QA: subflow call frames (migration 057). Same rolled-back transaction as the other suites;
-- concurrency / interruption scenarios are in e42b21-concurrency.sh. IDs: S01..S17.
-- Flow A (root):  call(execute_flow) -> x -> end        entry 'call'
-- Flow B (callee): x(start) -> bcall(execute_flow) -> bend(end)   entry 'x'   (same key 'x' as in A!)
-- Flow C (leaf):   cx(start) -> cend(end)                           entry 'cx'

CREATE TEMP TABLE qa_s (name text PRIMARY KEY, id uuid);
GRANT SELECT ON qa_s TO PUBLIC;
DO $$
DECLARE va uuid; vb uuid; vc uuid;
BEGIN
  va := public.qa_synth_flow('52000000-0000-4000-8000-0000000000a1', '[{"node_key":"call","node_type":"execute_flow","config":{"target_flow_id":"52000000-0000-4000-8000-0000000000b1","next_node_key":"x"}},{"node_key":"callg","node_type":"execute_flow","config":{"target_flow_id":"52000000-0000-4000-8000-0000000000d1","next_node_key":"x"}},{"node_key":"x","node_type":"send_message"},{"node_key":"end","node_type":"end"}]', 'call');
  vb := public.qa_synth_flow('52000000-0000-4000-8000-0000000000b1', '[{"node_key":"x","node_type":"start"},{"node_key":"bcall","node_type":"execute_flow","config":{"target_flow_id":"52000000-0000-4000-8000-0000000000c1","next_node_key":"bend"}},{"node_key":"bend","node_type":"end"}]', 'x');
  vc := public.qa_synth_flow('52000000-0000-4000-8000-0000000000c1', '[{"node_key":"cx","node_type":"start"},{"node_key":"cend","node_type":"end"}]', 'cx');
  INSERT INTO qa_s VALUES ('va', va), ('vb', vb), ('vc', vc);
END $$;

-- S01/S04/S05: push A -> B on the same run.
DO $$
DECLARE a uuid; rid uuid; r jsonb; before_run public.flow_runs%ROWTYPE; run public.flow_runs%ROWTYPE; fr public.flow_run_call_frames%ROWTYPE;
  va uuid; vb uuid; runs_before int; tok int;
BEGIN
  SELECT id INTO va FROM qa_s WHERE name = 'va'; SELECT id INTO vb FROM qa_s WHERE name = 'vb';
  SELECT account_id INTO a FROM public.flows WHERE id = '52000000-0000-4000-8000-0000000000a1';
  rid := public.qa_flow_run('52000000-0000-4000-8000-0000000000a1', 501);
  tok := public.qa_lease(rid);
  SELECT * INTO before_run FROM public.flow_runs WHERE id = rid;
  SELECT count(*) INTO runs_before FROM public.flow_runs;
  r := public.qa_push(rid, 'w1', 'call', 'x', '52000000-0000-4000-8000-0000000000b1');
  SELECT * INTO run FROM public.flow_runs WHERE id = rid;
  SELECT * INTO fr FROM public.flow_run_call_frames WHERE flow_run_id = rid;
  PERFORM public.qa_result('S01', (r->>'committed')::bool AND (r->>'revision')::bigint = before_run.versioned_revision + 1 AND (r->>'new_depth')::int = 1
    AND r->>'cursor_flow_version_id' = vb::text AND r->>'cursor_node_key' = 'x' AND (r->>'nodes_executed')::int = before_run.versioned_nodes_executed + 1
    AND run.current_flow_version_id = vb AND run.versioned_node_key = 'x' AND run.current_node_key = 'x' AND run.versioned_depth = 1
    AND run.versioned_nodes_executed = 1 AND run.versioned_revision = before_run.versioned_revision + 1
    AND run.root_flow_version_id = va AND run.status = 'active' AND run.versioned_lease_owner = 'w1' AND run.versioned_lease = tok
    AND run.versioned_checkpoint = jsonb_build_object('cursor', jsonb_build_object('flow_version_id', vb, 'node_key', 'x'), 'step', 1, 'state', 'pending', 'failure', NULL,
         'confirmed', jsonb_build_object('flow_version_id', va, 'node_key', 'call', 'step', 0))
    AND public.qa_stack_ok(rid),
    'A->B: cursor moved to (B, x), depth 1, 1 node consumed, revision +1, checkpoint {pending, confirmed=A.call@0}, lease kept, root version unchanged');
  PERFORM public.qa_result('S04', fr.caller_flow_id = '52000000-0000-4000-8000-0000000000a1' AND fr.caller_flow_version_id = va AND fr.call_node_key = 'call'
    AND fr.return_node_key = 'x' AND fr.depth = 1 AND fr.callee_flow_id = '52000000-0000-4000-8000-0000000000b1' AND fr.callee_flow_version_id = vb
    AND fr.account_id = a AND fr.flow_run_id = rid,
    'frame persisted: caller A@version, call node, return node x, depth 1, callee B pinned version');
  PERFORM public.qa_result('S05', run.id = before_run.id AND (SELECT count(*) FROM public.flow_runs) = runs_before AND run.contact_id = before_run.contact_id
    AND run.conversation_id IS NOT DISTINCT FROM before_run.conversation_id AND run.vars = before_run.vars AND run.flow_id = before_run.flow_id AND run.user_id = before_run.user_id,
    'same flow_run row (no new run), same contact/conversation/vars/root flow');
END $$;

-- S02/S03: pop, then A -> B -> C and the reverse path; the root completes only without frames.
DO $$
DECLARE a uuid; rid uuid; r jsonb; va uuid; vb uuid; vc uuid; run public.flow_runs%ROWTYPE; ok boolean := true; detail text := ''; c record;
BEGIN
  SELECT id INTO va FROM qa_s WHERE name = 'va'; SELECT id INTO vb FROM qa_s WHERE name = 'vb'; SELECT id INTO vc FROM qa_s WHERE name = 'vc';
  SELECT account_id INTO a FROM public.flows WHERE id = '52000000-0000-4000-8000-0000000000a1';
  -- S02: A -> B, B reaches its END, pop
  rid := public.qa_flow_run('52000000-0000-4000-8000-0000000000a1', 502);
  PERFORM public.qa_lease(rid);
  PERFORM public.qa_push(rid, 'w1', 'call', 'x', '52000000-0000-4000-8000-0000000000b1');
  PERFORM public.qa_goto(rid, 'w1', 'bend');
  r := public.qa_pop(rid, 'w1');
  SELECT * INTO run FROM public.flow_runs WHERE id = rid;
  PERFORM public.qa_result('S02', (r->>'committed')::bool AND (r->>'new_depth')::int = 0 AND r->>'cursor_flow_version_id' = va::text AND r->>'cursor_node_key' = 'x'
    AND run.current_flow_version_id = va AND run.versioned_node_key = 'x' AND run.versioned_depth = 0 AND run.status = 'active' AND run.ended_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM public.flow_run_call_frames WHERE flow_run_id = rid)
    AND run.versioned_nodes_executed = 2 AND run.versioned_checkpoint #>> '{confirmed,node_key}' = 'bend' AND run.versioned_checkpoint #>> '{confirmed,flow_version_id}' = vb::text
    AND public.qa_stack_ok(rid),
    'pop B->A: cursor back at (A, x), depth 0, frame removed, run still ACTIVE (END of the subflow did not complete the root); nodes: call node + subflow END = 2');
  -- S03: A -> B -> C, then back C -> B -> A, finishing the root with END without frames
  rid := public.qa_flow_run('52000000-0000-4000-8000-0000000000a1', 503);
  PERFORM public.qa_lease(rid);
  PERFORM public.qa_push(rid, 'w1', 'call', 'x', '52000000-0000-4000-8000-0000000000b1');
  IF NOT public.qa_stack_ok(rid) THEN ok := false; detail := detail || ' [after push1]'; END IF;
  PERFORM public.qa_goto(rid, 'w1', 'bcall');
  PERFORM public.qa_push(rid, 'w1', 'bcall', 'bend', '52000000-0000-4000-8000-0000000000c1');
  SELECT * INTO run FROM public.flow_runs WHERE id = rid;
  IF run.versioned_depth <> 2 OR run.current_flow_version_id <> vc OR NOT public.qa_stack_ok(rid) OR (SELECT count(*) FROM public.flow_run_call_frames WHERE flow_run_id = rid) <> 2 THEN ok := false; detail := detail || ' [depth 2 wrong]'; END IF;
  IF (SELECT callee_flow_version_id FROM public.flow_run_call_frames WHERE flow_run_id = rid AND depth = 1) <> vb OR (SELECT callee_flow_version_id FROM public.flow_run_call_frames WHERE flow_run_id = rid AND depth = 2) <> vc THEN ok := false; detail := detail || ' [frame versions]'; END IF;
  PERFORM public.qa_goto(rid, 'w1', 'cend');
  r := public.qa_pop(rid, 'w1');                                         -- C -> B
  SELECT * INTO run FROM public.flow_runs WHERE id = rid;
  IF NOT ((r->>'committed')::bool AND run.versioned_depth = 1 AND run.current_flow_version_id = vb AND run.versioned_node_key = 'bend' AND public.qa_stack_ok(rid)) THEN ok := false; detail := detail || ' [pop C->B]'; END IF;
  r := public.qa_pop(rid, 'w1');                                         -- B (its END) -> A
  SELECT * INTO run FROM public.flow_runs WHERE id = rid;
  IF NOT ((r->>'committed')::bool AND run.versioned_depth = 0 AND run.current_flow_version_id = va AND run.versioned_node_key = 'x' AND run.status = 'active' AND public.qa_stack_ok(rid)) THEN ok := false; detail := detail || ' [pop B->A]'; END IF;
  PERFORM public.qa_goto(rid, 'w1', 'end');
  SELECT * INTO run FROM public.flow_runs WHERE id = rid;
  SELECT * INTO c FROM public.commit_versioned_run_transition(a, rid, 'w1', run.versioned_lease, run.versioned_revision,
    jsonb_build_object('cursor', jsonb_build_object('flow_version_id', va, 'node_key', 'end'), 'step', 99, 'state', 'terminal'), 'completed', 'end_node', 1);
  SELECT * INTO run FROM public.flow_runs WHERE id = rid;
  IF NOT (c.committed AND run.status = 'completed') THEN ok := false; detail := detail || ' [root completion]'; END IF;
  PERFORM public.qa_result('S03', ok AND (SELECT count(*) FROM public.flow_runs WHERE contact_id = run.contact_id) = 1,
    'A->B->C depth 2 (frames pin B and C versions), C->B->A in inverse order with the invariant true after every step, then root END without frames completed the one run' || detail);
END $$;

-- S06/S07: the version pinned on entry survives republication; same node_key in different versions.
DO $$
DECLARE a uuid; rid uuid; rid2 uuid; vg1 uuid; vg2 uuid; va uuid; run public.flow_runs%ROWTYPE; r jsonb; fr public.flow_run_call_frames%ROWTYPE;
BEGIN
  SELECT id INTO va FROM qa_s WHERE name = 'va';
  vg1 := public.qa_synth_flow('52000000-0000-4000-8000-0000000000d1', '[{"node_key":"x","node_type":"start"},{"node_key":"gcall","node_type":"execute_flow"},{"node_key":"gend","node_type":"end"}]', 'x');
  rid := public.qa_flow_run('52000000-0000-4000-8000-0000000000a1', 504);
  PERFORM public.qa_lease(rid);
  PERFORM public.qa_goto(rid, 'w1', 'callg');
  PERFORM public.qa_push(rid, 'w1', 'callg', 'x', '52000000-0000-4000-8000-0000000000d1');
  -- republish B with a different graph (v2: entry 'x' now is followed by 'newend'; 'gend' is gone)
  vg2 := public.qa_synth_flow('52000000-0000-4000-8000-0000000000d1', '[{"node_key":"x","node_type":"start"},{"node_key":"newend","node_type":"end"}]', 'x');
  PERFORM public.qa_result('S06a-precondition', vg2 <> vg1 AND (SELECT active_version_id FROM public.flows WHERE id = '52000000-0000-4000-8000-0000000000d1') = vg2, 'G republished: v2 is active');
  SELECT * INTO fr FROM public.flow_run_call_frames WHERE flow_run_id = rid;
  PERFORM public.qa_goto(rid, 'w1', 'gcall');   -- still resolves in the PINNED v1 (v2 has no 'gcall')
  PERFORM public.qa_goto(rid, 'w1', 'gend');
  r := public.qa_pop(rid, 'w1');
  SELECT * INTO run FROM public.flow_runs WHERE id = rid;
  PERFORM public.qa_result('S06', fr.callee_flow_version_id = vg1 AND (r->>'committed')::bool AND run.current_flow_version_id = va AND run.versioned_node_key = 'x',
    'frame kept G v1 after G was republished; the run walked v1-only nodes (gcall, gend) and returned to A');
  -- a NEW run entering B after the republication gets v2
  rid2 := public.qa_flow_run('52000000-0000-4000-8000-0000000000a1', 505);
  PERFORM public.qa_lease(rid2);
  PERFORM public.qa_goto(rid2, 'w1', 'callg');
  r := public.qa_push(rid2, 'w1', 'callg', 'x', '52000000-0000-4000-8000-0000000000d1');
  PERFORM public.qa_result('S06b', (r->>'committed')::bool AND r->>'cursor_flow_version_id' = vg2::text
    AND (SELECT callee_flow_version_id FROM public.flow_run_call_frames WHERE flow_run_id = rid2) = vg2,
    'a later run entering G pins the new version v2');
  -- S07: key 'x' exists in A, B v1 and B v2; cursors are (version, key) pairs and never confused
  PERFORM public.qa_goto(rid2, 'w1', 'newend');
  r := public.qa_pop(rid2, 'w1');
  SELECT * INTO run FROM public.flow_runs WHERE id = rid2;
  PERFORM public.qa_result('S07', run.current_flow_version_id = va AND run.versioned_node_key = 'x' AND vg1 <> vg2 AND va <> vg1
    AND (SELECT count(DISTINCT v) FROM (VALUES (va), (vg1), (vg2)) t(v)) = 3,
    'node_key x lives in 3 versions (A, G v1, G v2); push entered (G v2, x) and pop returned to (A, x) - cursor identity is version+key');
END $$;

-- S08: cross-account isolation
DO $$
DECLARE a uuid; b uuid; rid uuid; before_row jsonb; tok int; run public.flow_runs%ROWTYPE;
BEGIN
  SELECT account_id INTO a FROM public.flows WHERE id = '52000000-0000-4000-8000-0000000000a1';
  SELECT account_id INTO b FROM public.flows WHERE id = '60000000-0000-4000-8000-000000000001';
  rid := public.qa_flow_run('52000000-0000-4000-8000-0000000000a1', 506);
  tok := public.qa_lease(rid);
  before_row := to_jsonb((SELECT x FROM public.flow_runs x WHERE id = rid));
  SELECT * INTO run FROM public.flow_runs WHERE id = rid;
  -- target flow of another account
  PERFORM public.qa_expect_error('S08a', format('SELECT * FROM public.push_versioned_run_subflow(%L,%L,%L,%s,0,%L,%L,%L)', a, rid, 'w1', tok, 'call', 'x', '60000000-0000-4000-8000-000000000001'),
    'P0002', 'active published flow not found');
  -- run addressed with the wrong account
  PERFORM public.qa_expect_error('S08b', format('SELECT * FROM public.push_versioned_run_subflow(%L,%L,%L,%s,0,%L,%L,%L)', b, rid, 'w1', tok, 'call', 'x', '52000000-0000-4000-8000-0000000000b1'),
    'P0002', 'versioned run not found');
  PERFORM public.qa_expect_error('S08c', format('SELECT * FROM public.pop_versioned_run_subflow(%L,%L,%L,%s,0)', b, rid, 'w1', tok), 'P0002', 'versioned run not found');
  PERFORM public.qa_result('S08', to_jsonb((SELECT x FROM public.flow_runs x WHERE id = rid)) = before_row AND NOT EXISTS (SELECT 1 FROM public.flow_run_call_frames WHERE flow_run_id = rid),
    'foreign target flow, foreign account on push and on pop -> P0002; run row and frames untouched');
END $$;

-- S09: invalid targets and continuation
DO $$
DECLARE a uuid; rid uuid; tok int; before_row jsonb; ok boolean := true; detail text := ''; t record; got text;
BEGIN
  SELECT account_id INTO a FROM public.flows WHERE id = '52000000-0000-4000-8000-0000000000a1';
  rid := public.qa_flow_run('52000000-0000-4000-8000-0000000000a1', 507);
  tok := public.qa_lease(rid);
  before_row := to_jsonb((SELECT x FROM public.flow_runs x WHERE id = rid));
  FOR t IN SELECT * FROM (VALUES
    ('draft target',       '50000000-0000-4000-8000-000000000002', 'x', 'active published flow not found'),
    ('archived target',    '50000000-0000-4000-8000-000000000003', 'x', 'active published flow not found'),
    ('no version target',  '50000000-0000-4000-8000-000000000004', 'x', 'active published flow not found'),
    ('unknown flow',       '52000000-0000-4000-8000-0000000000ff', 'x', 'active published flow not found'),
    ('bad entry cursor',   '50000000-0000-4000-8000-000000000005', 'x', 'published definition has no entry cursor'),
    ('null entry cursor',  '50000000-0000-4000-8000-000000000006', 'x', 'published definition has no entry cursor'),
    ('missing return node','52000000-0000-4000-8000-0000000000b1', 'ghost', 'return node not found in caller version')
  ) AS x(label, target, ret, msg) LOOP
    got := NULL;
    BEGIN PERFORM * FROM public.push_versioned_run_subflow(a, rid, 'w1', tok, 0, 'call', t.ret, t.target::uuid);
    EXCEPTION WHEN OTHERS THEN got := SQLERRM; END;
    IF got IS DISTINCT FROM t.msg THEN ok := false; detail := detail || ' [' || t.label || ': ' || coalesce(got, 'accepted') || ']'; END IF;
  END LOOP;
  PERFORM public.qa_result('S09', ok AND to_jsonb((SELECT x FROM public.flow_runs x WHERE id = rid)) = before_row AND NOT EXISTS (SELECT 1 FROM public.flow_run_call_frames WHERE flow_run_id = rid),
    '7 invalid pushes (draft, archived, unpublished, unknown, bad/null entry, missing return node) rejected; no frame, run byte-identical' || detail);
END $$;

-- S10: recursion by flow identity (own flows E and F so earlier republications do not interfere)
DO $$
DECLARE a uuid; rid uuid; r jsonb; ok boolean := true; detail text := ''; before_row jsonb;
BEGIN
  PERFORM public.qa_synth_flow('54000000-0000-4000-8000-0000000000e1', '[{"node_key":"ecall","node_type":"execute_flow","config":{"target_flow_id":"54000000-0000-4000-8000-0000000000f1","next_node_key":"eend"}},{"node_key":"eend","node_type":"end"}]', 'ecall');
  PERFORM public.qa_synth_flow('54000000-0000-4000-8000-0000000000f1', '[{"node_key":"fcall","node_type":"execute_flow","config":{"target_flow_id":"54000000-0000-4000-8000-0000000000e1","next_node_key":"fend"}},{"node_key":"fend","node_type":"end"}]', 'fcall');
  -- direct self-call: E -> E
  rid := public.qa_flow_run('54000000-0000-4000-8000-0000000000e1', 508);
  PERFORM public.qa_lease(rid);
  before_row := to_jsonb((SELECT x FROM public.flow_runs x WHERE id = rid));
  r := public.qa_push(rid, 'w1', 'ecall', 'eend', '54000000-0000-4000-8000-0000000000e1');
  IF r->>'reason' <> 'recursion_detected' OR (r->>'committed')::bool OR to_jsonb((SELECT x FROM public.flow_runs x WHERE id = rid)) <> before_row THEN ok := false; detail := detail || ' [self call]'; END IF;
  -- E -> F -> E
  r := public.qa_push(rid, 'w1', 'ecall', 'eend', '54000000-0000-4000-8000-0000000000f1');
  IF NOT (r->>'committed')::bool THEN ok := false; detail := detail || ' [E->F refused: ' || coalesce(r->>'reason', '?') || ']'; END IF;
  before_row := to_jsonb((SELECT x FROM public.flow_runs x WHERE id = rid));
  r := public.qa_push(rid, 'w1', 'fcall', 'fend', '54000000-0000-4000-8000-0000000000e1');
  IF r->>'reason' <> 'recursion_detected' OR NOT public.qa_stack_ok(rid) OR to_jsonb((SELECT x FROM public.flow_runs x WHERE id = rid)) <> before_row THEN ok := false; detail := detail || ' [E->F->E ' || coalesce(r->>'reason','?') || ']'; END IF;
  -- F -> F while nested
  r := public.qa_push(rid, 'w1', 'fcall', 'fend', '54000000-0000-4000-8000-0000000000f1');
  IF r->>'reason' <> 'recursion_detected' THEN ok := false; detail := detail || ' [F->F]'; END IF;
  -- recursion judged by flow id, not version: republish E (new version) and try F -> E again
  PERFORM public.qa_synth_flow('54000000-0000-4000-8000-0000000000e1', '[{"node_key":"ecall","node_type":"execute_flow","config":{"target_flow_id":"54000000-0000-4000-8000-0000000000f1","next_node_key":"eend"}},{"node_key":"eend","node_type":"end"},{"node_key":"extra","node_type":"end"}]', 'ecall');
  r := public.qa_push(rid, 'w1', 'fcall', 'fend', '54000000-0000-4000-8000-0000000000e1');
  IF r->>'reason' <> 'recursion_detected' THEN ok := false; detail := detail || ' [E v2 via F]'; END IF;
  PERFORM public.qa_result('S10', ok AND (SELECT versioned_depth FROM public.flow_runs WHERE id = rid) = 1, 'E->E, E->F->E, F->F and F->E(E republished: new version) all -> recursion_detected with no write; stack stays at depth 1' || detail);
END $$;

-- S11/S12: depth 8 and the node budget.
DO $$
DECLARE a uuid; rid uuid; i int; r jsonb; ok boolean := true; detail text := ''; fid uuid; nxt uuid; rid2 uuid; before_row jsonb; run public.flow_runs%ROWTYPE;
BEGIN
  SELECT account_id INTO a FROM public.flows WHERE id = '52000000-0000-4000-8000-0000000000a1';
  -- chain D0..D9; every flow's entry node is its call node 'dcall'
  FOR i IN 0..9 LOOP
    PERFORM public.qa_synth_flow(('53000000-0000-4000-8000-00000000000' || i)::uuid, jsonb_build_array(
      jsonb_build_object('node_key', 'dcall', 'node_type', 'execute_flow', 'config', jsonb_build_object('target_flow_id', '53000000-0000-4000-8000-00000000000' || (i + 1), 'next_node_key', 'dret')),
      jsonb_build_object('node_key', 'dret', 'node_type', 'end')), 'dcall');
  END LOOP;
  rid := public.qa_flow_run('53000000-0000-4000-8000-000000000000', 510);
  PERFORM public.qa_lease(rid);
  FOR i IN 1..8 LOOP
    r := public.qa_push(rid, 'w1', 'dcall', 'dret', ('53000000-0000-4000-8000-00000000000' || i)::uuid);
    IF NOT (r->>'committed')::bool OR (r->>'new_depth')::int <> i OR NOT public.qa_stack_ok(rid) THEN ok := false; detail := detail || ' [push ' || i || ': ' || coalesce(r->>'reason','?') || ']'; END IF;
  END LOOP;
  before_row := to_jsonb((SELECT x FROM public.flow_runs x WHERE id = rid));
  r := public.qa_push(rid, 'w1', 'dcall', 'dret', '53000000-0000-4000-8000-000000000009');
  IF r->>'reason' <> 'depth_exceeded' OR (r->>'committed')::bool OR to_jsonb((SELECT x FROM public.flow_runs x WHERE id = rid)) <> before_row
     OR (SELECT count(*) FROM public.flow_run_call_frames WHERE flow_run_id = rid) <> 8 THEN ok := false; detail := detail || ' [9th push]'; END IF;
  PERFORM public.qa_result('S11', ok, '8 nested calls accepted (depth 1..8, invariant after each); the 9th -> depth_exceeded, 8 frames intact, run byte-identical' || detail);

  -- S12: node budget (shared with B1.3: 500)
  ok := true; detail := '';
  rid2 := public.qa_flow_run('52000000-0000-4000-8000-0000000000a1', 511);
  PERFORM public.qa_lease(rid2);
  UPDATE public.flow_runs SET versioned_nodes_executed = 500 WHERE id = rid2;
  before_row := to_jsonb((SELECT x FROM public.flow_runs x WHERE id = rid2));
  r := public.qa_push(rid2, 'w1', 'call', 'x', '52000000-0000-4000-8000-0000000000b1');
  IF r->>'reason' <> 'budget_exceeded' OR to_jsonb((SELECT x FROM public.flow_runs x WHERE id = rid2)) <> before_row THEN ok := false; detail := detail || ' [push at 500]'; END IF;
  UPDATE public.flow_runs SET versioned_nodes_executed = 499 WHERE id = rid2;
  r := public.qa_push(rid2, 'w1', 'call', 'x', '52000000-0000-4000-8000-0000000000b1');
  IF NOT (r->>'committed')::bool OR (r->>'nodes_executed')::int <> 500 THEN ok := false; detail := detail || ' [push at 499]'; END IF;
  PERFORM public.qa_goto(rid2, 'w1', 'bend');   -- goto consumes no node (delta 0)
  r := public.qa_pop(rid2, 'w1');
  IF r->>'reason' <> 'budget_exceeded' OR (SELECT versioned_depth FROM public.flow_runs WHERE id = rid2) <> 1 THEN ok := false; detail := detail || ' [pop at 500]'; END IF;
  PERFORM public.qa_result('S12', ok, 'push at 500 nodes -> budget_exceeded (no write); at 499 it consumes the last node; the pop (END node) is then refused at 500 and the frame stays' || detail);
END $$;

-- S13: lease / fencing / revision / run state, for push and pop
DO $$
DECLARE a uuid; rid uuid; tok int; ok boolean := true; detail text := ''; r jsonb; before_row jsonb; run public.flow_runs%ROWTYPE; row2 public.flow_runs%ROWTYPE; res record; op text; reasons text[];
  want text; got text; label text;
BEGIN
  SELECT account_id INTO a FROM public.flows WHERE id = '52000000-0000-4000-8000-0000000000a1';
  -- PUSH on a run at its call node
  rid := public.qa_flow_run('52000000-0000-4000-8000-0000000000a1', 512);
  tok := public.qa_lease(rid);
  before_row := to_jsonb((SELECT x FROM public.flow_runs x WHERE id = rid));
  SELECT * INTO res FROM public.push_versioned_run_subflow(a, rid, 'intruder', tok, 0, 'call', 'x', '52000000-0000-4000-8000-0000000000b1');
  IF res.reason <> 'stale_lease' THEN ok := false; detail := detail || ' [push foreign owner ' || coalesce(res.reason, 'ok') || ']'; END IF;
  SELECT * INTO res FROM public.push_versioned_run_subflow(a, rid, 'w1', tok + 1, 0, 'call', 'x', '52000000-0000-4000-8000-0000000000b1');
  IF res.reason <> 'stale_lease' THEN ok := false; detail := detail || ' [push wrong token ' || coalesce(res.reason, 'ok') || ']'; END IF;
  SELECT * INTO res FROM public.push_versioned_run_subflow(a, rid, 'w1', tok, 7, 'call', 'x', '52000000-0000-4000-8000-0000000000b1');
  IF res.reason <> 'revision_conflict' THEN ok := false; detail := detail || ' [push stale revision ' || coalesce(res.reason, 'ok') || ']'; END IF;
  UPDATE public.flow_runs SET versioned_lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = rid;
  SELECT * INTO res FROM public.push_versioned_run_subflow(a, rid, 'w1', tok, 0, 'call', 'x', '52000000-0000-4000-8000-0000000000b1');
  IF res.reason <> 'lease_expired' THEN ok := false; detail := detail || ' [push expired ' || coalesce(res.reason, 'ok') || ']'; END IF;
  IF to_jsonb((SELECT x FROM public.flow_runs x WHERE id = rid)) - 'versioned_lease_expires_at' <> before_row - 'versioned_lease_expires_at' THEN ok := false; detail := detail || ' [push refusal wrote]'; END IF;
  -- reclaim by a new owner invalidates the old fencing token for push AND pop
  SELECT * INTO res FROM public.reclaim_versioned_run_lease(a, rid, 'w2', 600);
  SELECT * INTO res FROM public.push_versioned_run_subflow(a, rid, 'w1', tok, 0, 'call', 'x', '52000000-0000-4000-8000-0000000000b1');
  IF res.reason <> 'stale_lease' THEN ok := false; detail := detail || ' [old fencing push ' || coalesce(res.reason, 'ok') || ']'; END IF;
  r := public.qa_push(rid, 'w2', 'call', 'x', '52000000-0000-4000-8000-0000000000b1');
  IF NOT (r->>'committed')::bool THEN ok := false; detail := detail || ' [new owner push]'; END IF;
  SELECT * INTO res FROM public.pop_versioned_run_subflow(a, rid, 'w1', tok, (SELECT versioned_revision FROM public.flow_runs WHERE id = rid));
  IF res.reason <> 'stale_lease' THEN ok := false; detail := detail || ' [old fencing pop ' || coalesce(res.reason, 'ok') || ']'; END IF;
  SELECT * INTO res FROM public.pop_versioned_run_subflow(a, rid, 'w2', (SELECT versioned_lease FROM public.flow_runs WHERE id = rid), 99);
  IF res.reason <> 'revision_conflict' THEN ok := false; detail := detail || ' [pop stale revision ' || coalesce(res.reason, 'ok') || ']'; END IF;
  UPDATE public.flow_runs SET versioned_lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = rid;
  r := public.qa_pop(rid, 'w2');
  IF r->>'reason' <> 'lease_expired' THEN ok := false; detail := detail || ' [pop expired ' || coalesce(r->>'reason', 'ok') || ']'; END IF;
  -- paused and finished runs
  FOREACH label IN ARRAY ARRAY['paused_by_agent', 'completed', 'failed'] LOOP
    rid := public.qa_flow_run('52000000-0000-4000-8000-0000000000a1', 513 + array_position(ARRAY['paused_by_agent', 'completed', 'failed'], label));
    tok := public.qa_lease(rid);
    PERFORM public.qa_push(rid, 'w1', 'call', 'x', '52000000-0000-4000-8000-0000000000b1');
    UPDATE public.flow_runs SET status = label WHERE id = rid;
    before_row := to_jsonb((SELECT x FROM public.flow_runs x WHERE id = rid));
    IF public.qa_push(rid, 'w1', 'call', 'x', '52000000-0000-4000-8000-0000000000c1')->>'reason' <> 'run_not_active'
       OR public.qa_pop(rid, 'w1')->>'reason' <> 'run_not_active'
       OR to_jsonb((SELECT x FROM public.flow_runs x WHERE id = rid)) <> before_row
       OR (SELECT count(*) FROM public.flow_run_call_frames WHERE flow_run_id = rid) <> 1 THEN ok := false; detail := detail || ' [' || label || ']'; END IF;
  END LOOP;
  PERFORM public.qa_result('S13', ok, 'push and pop: foreign owner, wrong/old token (after takeover), stale revision, expired lease, paused/completed/failed runs -> stale_lease / revision_conflict / lease_expired / run_not_active, nothing written' || detail);
END $$;

-- S14: preconditions
DO $$
DECLARE a uuid; rid uuid; ok boolean := true; detail text := ''; r jsonb; before_row jsonb;
BEGIN
  SELECT account_id INTO a FROM public.flows WHERE id = '52000000-0000-4000-8000-0000000000a1';
  rid := public.qa_flow_run('52000000-0000-4000-8000-0000000000a1', 520);
  PERFORM public.qa_lease(rid);
  before_row := to_jsonb((SELECT x FROM public.flow_runs x WHERE id = rid));
  IF public.qa_pop(rid, 'w1')->>'reason' <> 'no_frame' THEN ok := false; detail := detail || ' [pop without frame]'; END IF;
  IF public.qa_push(rid, 'w1', 'x', 'x', '52000000-0000-4000-8000-0000000000b1')->>'reason' <> 'cursor_mismatch' THEN ok := false; detail := detail || ' [push not at call node]'; END IF;
  IF to_jsonb((SELECT x FROM public.flow_runs x WHERE id = rid)) <> before_row THEN ok := false; detail := detail || ' [wrote]'; END IF;
  PERFORM public.qa_push(rid, 'w1', 'call', 'x', '52000000-0000-4000-8000-0000000000b1');
  before_row := to_jsonb((SELECT x FROM public.flow_runs x WHERE id = rid));
  IF public.qa_pop(rid, 'w1')->>'reason' <> 'cursor_not_at_end' THEN ok := false; detail := detail || ' [pop away from END]'; END IF;
  IF to_jsonb((SELECT x FROM public.flow_runs x WHERE id = rid)) <> before_row THEN ok := false; detail := detail || ' [pop wrote]'; END IF;
  PERFORM public.qa_result('S14', ok, 'pop without a frame -> no_frame; push away from the call node -> cursor_mismatch; pop while the callee is not at an END node -> cursor_not_at_end; nothing written' || detail);
END $$;

-- S15: the generic commit cannot desynchronise cursor and frames
DO $$
DECLARE a uuid; rid uuid; run public.flow_runs%ROWTYPE; c record; ok boolean := true; detail text := ''; vb uuid; va uuid; got text; before_row jsonb;
BEGIN
  SELECT id INTO va FROM qa_s WHERE name = 'va'; SELECT id INTO vb FROM qa_s WHERE name = 'vb';
  SELECT account_id INTO a FROM public.flows WHERE id = '52000000-0000-4000-8000-0000000000a1';
  rid := public.qa_flow_run('52000000-0000-4000-8000-0000000000a1', 521);
  PERFORM public.qa_lease(rid);
  PERFORM public.qa_push(rid, 'w1', 'call', 'x', '52000000-0000-4000-8000-0000000000b1');
  PERFORM public.qa_goto(rid, 'w1', 'bend');
  SELECT * INTO run FROM public.flow_runs WHERE id = rid;
  before_row := to_jsonb(run);
  -- completing the root while a frame exists is refused
  SELECT * INTO c FROM public.commit_versioned_run_transition(a, rid, 'w1', run.versioned_lease, run.versioned_revision,
    jsonb_build_object('cursor', jsonb_build_object('flow_version_id', vb, 'node_key', 'bend'), 'step', 9, 'state', 'terminal'), 'completed', 'end_node', 1);
  IF c.committed OR c.reason <> 'call_frames_active' OR to_jsonb((SELECT x FROM public.flow_runs x WHERE id = rid)) <> before_row THEN ok := false; detail := detail || ' [completed with frames ' || coalesce(c.reason, 'ok') || ']'; END IF;
  -- moving the cursor to another flow version through the generic commit is refused
  got := NULL;
  BEGIN PERFORM * FROM public.commit_versioned_run_transition(a, rid, 'w1', run.versioned_lease, run.versioned_revision,
      jsonb_build_object('cursor', jsonb_build_object('flow_version_id', va, 'node_key', 'x'), 'step', 9));
  EXCEPTION WHEN OTHERS THEN got := SQLSTATE || ' ' || SQLERRM; END;
  IF got IS DISTINCT FROM '22023 cursor can only change flow version through call frames' THEN ok := false; detail := detail || ' [cross-version commit ' || coalesce(got, 'accepted') || ']'; END IF;
  -- failing the run with frames is still allowed (frames are kept as evidence)
  SELECT * INTO c FROM public.commit_versioned_run_transition(a, rid, 'w1', run.versioned_lease, run.versioned_revision,
    jsonb_build_object('cursor', jsonb_build_object('flow_version_id', vb, 'node_key', 'bend'), 'step', 9, 'state', 'terminal', 'failure', 'x'), 'failed', 'x', 0);
  IF NOT c.committed THEN ok := false; detail := detail || ' [fail with frames]'; END IF;
  PERFORM public.qa_result('S15', ok, 'with a live frame: completed -> call_frames_active, cross-version cursor move -> 22023, failed is still allowed; END without frames completes (S03)' || detail);
END $$;

-- S16: atomicity. A trigger that raises on the run UPDATE fires AFTER the frame INSERT inside push/pop;
-- the whole call must roll back (no frame, same cursor, same counters).
CREATE FUNCTION public.qa_fail_depth_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('qa.fail_depth', true) = NEW.versioned_depth::text THEN RAISE EXCEPTION 'qa injected failure' USING ERRCODE = 'P9998'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER qa_fail_depth BEFORE UPDATE ON public.flow_runs FOR EACH ROW EXECUTE FUNCTION public.qa_fail_depth_update();
DO $$
DECLARE a uuid; rid uuid; before_row jsonb; ok boolean := true; detail text := ''; st text; r jsonb;
BEGIN
  SELECT account_id INTO a FROM public.flows WHERE id = '52000000-0000-4000-8000-0000000000a1';
  rid := public.qa_flow_run('52000000-0000-4000-8000-0000000000a1', 522);
  PERFORM public.qa_lease(rid);
  before_row := to_jsonb((SELECT x FROM public.flow_runs x WHERE id = rid));
  PERFORM set_config('qa.fail_depth', '1', true);
  BEGIN r := public.qa_push(rid, 'w1', 'call', 'x', '52000000-0000-4000-8000-0000000000b1'); st := 'no error';
  EXCEPTION WHEN OTHERS THEN st := SQLSTATE; END;
  PERFORM set_config('qa.fail_depth', '', true);
  IF st <> 'P9998' THEN ok := false; detail := detail || ' [push did not fail: ' || st || ']'; END IF;
  IF to_jsonb((SELECT x FROM public.flow_runs x WHERE id = rid)) <> before_row OR EXISTS (SELECT 1 FROM public.flow_run_call_frames WHERE flow_run_id = rid) THEN ok := false; detail := detail || ' [push left partial state]'; END IF;
  -- same for pop: failure while the frame DELETE has already run
  r := public.qa_push(rid, 'w1', 'call', 'x', '52000000-0000-4000-8000-0000000000b1');
  PERFORM public.qa_goto(rid, 'w1', 'bend');
  before_row := to_jsonb((SELECT x FROM public.flow_runs x WHERE id = rid));
  PERFORM set_config('qa.fail_depth', '0', true);
  BEGIN r := public.qa_pop(rid, 'w1'); st := 'no error'; EXCEPTION WHEN OTHERS THEN st := SQLSTATE; END;
  PERFORM set_config('qa.fail_depth', '', true);
  IF st <> 'P9998' THEN ok := false; detail := detail || ' [pop did not fail: ' || st || ']'; END IF;
  IF to_jsonb((SELECT x FROM public.flow_runs x WHERE id = rid)) <> before_row OR (SELECT count(*) FROM public.flow_run_call_frames WHERE flow_run_id = rid) <> 1 OR NOT public.qa_stack_ok(rid) THEN ok := false; detail := detail || ' [pop left partial state]'; END IF;
  PERFORM public.qa_result('S16', ok, 'failure injected after the frame INSERT (push) and after the frame DELETE (pop): no frame/cursor/counter change survives, invariant intact' || detail);
END $$;
DROP TRIGGER qa_fail_depth ON public.flow_runs;

-- S17: effective privileges with real SET ROLE
DO $$
DECLARE a uuid; rid uuid; tok int; role_name text; call_sql text; st text; ok boolean := true; out text[] := '{}'; calls text[]; sig text; r1 record; r2 record; before_row jsonb;
BEGIN
  SELECT account_id INTO a FROM public.flows WHERE id = '52000000-0000-4000-8000-0000000000a1';
  CREATE ROLE qa_frame_probe NOLOGIN; GRANT USAGE ON SCHEMA public TO qa_frame_probe;
  rid := public.qa_flow_run('52000000-0000-4000-8000-0000000000a1', 523);
  tok := public.qa_lease(rid);
  before_row := to_jsonb((SELECT x FROM public.flow_runs x WHERE id = rid));
  FOREACH sig IN ARRAY ARRAY['push_versioned_run_subflow(uuid,uuid,text,integer,bigint,text,text,uuid)', 'pop_versioned_run_subflow(uuid,uuid,text,integer,bigint)'] LOOP
    IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) x WHERE p.oid = ('public.' || sig)::regprocedure AND x.grantee = 0) THEN ok := false; out := out || (sig || ' has PUBLIC'); END IF;
    IF NOT has_function_privilege('service_role', 'public.' || sig, 'EXECUTE') THEN ok := false; out := out || (sig || ' lacks service_role'); END IF;
    FOREACH role_name IN ARRAY ARRAY['qa_frame_probe', 'anon', 'authenticated'] LOOP
      IF has_function_privilege(role_name, 'public.' || sig, 'EXECUTE') THEN ok := false; out := out || (role_name || ' may EXECUTE ' || sig); END IF;
    END LOOP;
  END LOOP;
  calls := ARRAY[
    format('SELECT * FROM public.push_versioned_run_subflow(%L,%L,%L,%s,0,%L,%L,%L)', a, rid, 'w1', tok, 'call', 'x', '52000000-0000-4000-8000-0000000000b1'),
    format('SELECT * FROM public.pop_versioned_run_subflow(%L,%L,%L,%s,0)', a, rid, 'w1', tok)];
  FOREACH role_name IN ARRAY ARRAY['qa_frame_probe', 'anon', 'authenticated'] LOOP
    FOREACH call_sql IN ARRAY calls LOOP
      st := NULL; EXECUTE format('SET LOCAL ROLE %I', role_name);
      BEGIN EXECUTE call_sql; EXCEPTION WHEN OTHERS THEN st := SQLSTATE; END;
      RESET ROLE;
      IF st IS DISTINCT FROM '42501' THEN ok := false; out := out || (role_name || ' ran ' || left(call_sql, 45) || ' -> ' || coalesce(st, 'SUCCEEDED')); END IF;
    END LOOP;
  END LOOP;
  IF to_jsonb((SELECT x FROM public.flow_runs x WHERE id = rid)) <> before_row THEN ok := false; out := out || 'denied role changed the run'; END IF;
  SET LOCAL ROLE service_role;
  BEGIN
    SELECT * INTO r1 FROM public.push_versioned_run_subflow(a, rid, 'w1', tok, 0, 'call', 'x', '52000000-0000-4000-8000-0000000000b1');
    IF NOT r1.committed THEN ok := false; out := out || 'service_role push refused'; END IF;
  EXCEPTION WHEN OTHERS THEN ok := false; out := out || ('service_role push error ' || SQLSTATE || ' ' || SQLERRM); END;
  RESET ROLE;
  PERFORM public.qa_goto(rid, 'w1', 'bend');
  SET LOCAL ROLE service_role;
  BEGIN
    SELECT * INTO r2 FROM public.pop_versioned_run_subflow(a, rid, 'w1', tok, (SELECT versioned_revision FROM public.flow_runs WHERE id = rid));
    IF NOT r2.committed THEN ok := false; out := out || 'service_role pop refused'; END IF;
  EXCEPTION WHEN OTHERS THEN ok := false; out := out || ('service_role pop error ' || SQLSTATE || ' ' || SQLERRM); END;
  RESET ROLE;
  PERFORM public.qa_result('S17', ok, 'push/pop x (PUBLIC-probe, anon, authenticated) -> 42501 and no change; no PUBLIC grant in ACL; service_role pushed and popped' || coalesce(' | ' || nullif(array_to_string(out, '; '), ''), ''));
END $$;

-- S24: defence in depth in push (migration 058): the call must come from a published execute_flow node
-- whose config names this exact target and continuation.
DO $$
DECLARE rid uuid; before_row jsonb; ok boolean := true; detail text := ''; t record; got text;
BEGIN
  rid := public.qa_flow_run('52000000-0000-4000-8000-0000000000a1', 524);
  PERFORM public.qa_lease(rid);
  before_row := to_jsonb((SELECT x FROM public.flow_runs x WHERE id = rid));
  FOR t IN SELECT * FROM (VALUES
    ('target differs from node config', 'call', 'x', '52000000-0000-4000-8000-0000000000c1'),
    ('continuation differs from node config', 'call', 'end', '52000000-0000-4000-8000-0000000000b1'),
    ('target of the other call node', 'call', 'x', '52000000-0000-4000-8000-0000000000d1')
  ) AS x(label, call_node, ret, target) LOOP
    got := NULL;
    BEGIN PERFORM public.qa_push(rid, 'w1', t.call_node, t.ret, t.target::uuid); EXCEPTION WHEN OTHERS THEN got := SQLSTATE || ' ' || SQLERRM; END;
    IF got IS DISTINCT FROM '22023 call node is not an execute_flow node matching the requested call' THEN ok := false; detail := detail || ' [' || t.label || ': ' || coalesce(got, 'accepted') || ']'; END IF;
  END LOOP;
  -- a cursor on a node that is not execute_flow (A.x is send_message) cannot be used as a call node
  PERFORM public.qa_goto(rid, 'w1', 'x');
  before_row := to_jsonb((SELECT x FROM public.flow_runs x WHERE id = rid));
  got := NULL;
  BEGIN PERFORM public.qa_push(rid, 'w1', 'x', 'end', '52000000-0000-4000-8000-0000000000b1'); EXCEPTION WHEN OTHERS THEN got := SQLSTATE || ' ' || SQLERRM; END;
  IF got IS DISTINCT FROM '22023 call node is not an execute_flow node matching the requested call' THEN ok := false; detail := detail || ' [non-call node: ' || coalesce(got, 'accepted') || ']'; END IF;
  PERFORM public.qa_result('S24', ok AND to_jsonb((SELECT x FROM public.flow_runs x WHERE id = rid)) = before_row AND NOT EXISTS (SELECT 1 FROM public.flow_run_call_frames WHERE flow_run_id = rid),
    'push refused (22023) when target or continuation differ from the published execute_flow config, or when the cursor node is not execute_flow; no frame, no event' || detail);
END $$;

-- S25: traceability that outlives the frame; ids and keys only.
DO $$
DECLARE rid uuid; va uuid; vb uuid; ev public.flow_run_events%ROWTYPE; n int; txt text; ok boolean := true; detail text := '';
BEGIN
  SELECT id INTO va FROM qa_s WHERE name = 'va'; SELECT id INTO vb FROM qa_s WHERE name = 'vb';
  rid := public.qa_flow_run('52000000-0000-4000-8000-0000000000a1', 525);
  UPDATE public.flow_runs SET vars = '{"secret":"s3cr3t-value","email":"a@b.test"}' WHERE id = rid;
  PERFORM public.qa_lease(rid);
  PERFORM public.qa_push(rid, 'w1', 'call', 'x', '52000000-0000-4000-8000-0000000000b1');
  SELECT * INTO ev FROM public.flow_run_events WHERE flow_run_id = rid AND event_type = 'subflow_called';
  IF NOT (ev.node_key = 'call' AND ev.payload->>'caller_flow_id' = '52000000-0000-4000-8000-0000000000a1' AND ev.payload->>'caller_flow_version_id' = va::text
      AND ev.payload->>'callee_flow_id' = '52000000-0000-4000-8000-0000000000b1' AND ev.payload->>'callee_flow_version_id' = vb::text
      AND ev.payload->>'call_node_key' = 'call' AND ev.payload->>'return_node_key' = 'x' AND (ev.payload->>'depth')::int = 1 AND (ev.payload->>'revision')::int = 1) THEN
    ok := false; detail := detail || ' [subflow_called ' || ev.payload::text || ']'; END IF;
  PERFORM public.qa_goto(rid, 'w1', 'bend');
  PERFORM public.qa_pop(rid, 'w1');
  SELECT * INTO ev FROM public.flow_run_events WHERE flow_run_id = rid AND event_type = 'subflow_returned';
  IF NOT (ev.node_key = 'x' AND ev.payload->>'callee_flow_version_id' = vb::text AND ev.payload->>'caller_flow_version_id' = va::text
      AND (ev.payload->>'depth')::int = 1 AND ev.payload->>'call_node_key' = 'call' AND ev.payload->>'return_node_key' = 'x') THEN
    ok := false; detail := detail || ' [subflow_returned ' || ev.payload::text || ']'; END IF;
  SELECT count(*) INTO n FROM public.flow_run_call_frames WHERE flow_run_id = rid;
  IF n <> 0 THEN ok := false; detail := detail || ' [frame still there]'; END IF;
  SELECT string_agg(payload::text, ' ') INTO txt FROM public.flow_run_events WHERE flow_run_id = rid;
  IF txt LIKE '%s3cr3t%' OR txt LIKE '%a@b.test%' OR txt LIKE '%secret%' THEN ok := false; detail := detail || ' [payload leaks variables]'; END IF;
  PERFORM public.qa_result('S25', ok, 'subflow_called and subflow_returned events carry run, caller/callee flow+version, call/return nodes, depth and revision; they remain after the frame is deleted; no variables in the payload' || detail);
END $$;
