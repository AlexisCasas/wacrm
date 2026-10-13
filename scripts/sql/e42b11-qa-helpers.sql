-- Assertion helpers shared by the E4.2B1.1 suites. Every verdict is emitted
-- as "QA-RESULT <test> PASS|FAIL <detail>"; the runner parses these lines.
CREATE OR REPLACE FUNCTION public.qa_result(t text, ok boolean, detail text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok THEN RAISE NOTICE 'QA-RESULT % PASS %', t, detail;
  ELSE RAISE EXCEPTION 'QA-RESULT % FAIL %', t, detail; END IF;
END $$;

-- Runs call_sql and passes only when it raises exactly SQLSTATE + message.
CREATE OR REPLACE FUNCTION public.qa_expect_error(t text, call_sql text, want_state text, want_msg text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE got boolean := false; s text; m text;
BEGIN
  BEGIN
    EXECUTE call_sql;
  EXCEPTION WHEN OTHERS THEN
    got := true; s := SQLSTATE; m := SQLERRM;
  END;
  IF NOT got THEN PERFORM public.qa_result(t, false, 'no error raised, expected ' || want_state || ' ' || want_msg); END IF;
  PERFORM public.qa_result(t, s = want_state AND m = want_msg,
    CASE WHEN s = want_state AND m = want_msg THEN 'rejected ' || s || ' "' || m || '"'
         ELSE 'got ' || s || ' "' || m || '", expected ' || want_state || ' "' || want_msg || '"' END);
END $$;

-- Convenience: SQL text of a create_versioned_flow_run call.
CREATE OR REPLACE FUNCTION public.qa_call(p_account uuid, p_flow uuid, p_contact uuid, p_conv uuid, p_vars text DEFAULT '{}')
RETURNS text LANGUAGE sql AS $$
  SELECT format('SELECT * FROM public.create_versioned_flow_run(%L,%L,%L,%L,%L::jsonb)', p_account, p_flow, p_contact, p_conv, p_vars)
$$;

-- Publishes a flow through the real RPC (the only supported path to active).
CREATE OR REPLACE FUNCTION public.qa_publish(p_flow uuid, p_user uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE f public.flows%ROWTYPE; d jsonb;
BEGIN
  SELECT * INTO f FROM public.flows WHERE id = p_flow;
  SELECT jsonb_build_object(
    'flow', jsonb_build_object('id',f.id,'name',f.name,'description',f.description,'trigger_type',f.trigger_type,
            'trigger_config',f.trigger_config,'entry_node_id',f.entry_node_id,'fallback_policy',f.fallback_policy),
    'nodes', COALESCE((SELECT jsonb_agg(jsonb_build_object('node_key',n.node_key,'node_type',n.node_type,'config',n.config,
            'position_x',n.position_x,'position_y',n.position_y) ORDER BY n.node_key)
            FROM public.flow_nodes n WHERE n.flow_id = f.id), '[]'::jsonb)) INTO d;
  PERFORM public.publish_flow_version(f.id, f.updated_at, p_user, d);
END $$;

-- B1.2 helpers. qa_new_contact/qa_new_run make a fresh contact (and a versioned
-- run on flow 5000..01) per call so every test owns its row; ids derive from n.
CREATE OR REPLACE FUNCTION public.qa_new_contact(n int) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE cid uuid := ('31000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid; f public.flows%ROWTYPE;
BEGIN
  SELECT * INTO f FROM public.flows WHERE id = '50000000-0000-4000-8000-000000000001';
  INSERT INTO public.contacts (id, user_id, account_id, phone, name)
  VALUES (cid, f.user_id, f.account_id, '+1556' || lpad(n::text, 7, '0'), 'QA contact ' || n) ON CONFLICT DO NOTHING;
  RETURN cid;
END $$;
CREATE OR REPLACE FUNCTION public.qa_new_run(n int) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE r record; f public.flows%ROWTYPE;
BEGIN
  SELECT * INTO f FROM public.flows WHERE id = '50000000-0000-4000-8000-000000000001';
  SELECT * INTO r FROM public.create_versioned_flow_run(f.account_id, f.id, public.qa_new_contact(n), NULL);
  IF NOT r.created THEN RAISE EXCEPTION 'qa_new_run % failed: %', n, r.reason; END IF;
  RETURN r.flow_run_id;
END $$;

-- B2.1 helpers. Synthetic published flows: a flow_versions row is inserted with a valid E4.1-shaped
-- definition (including node types the live editor cannot produce yet, e.g. execute_flow) and the
-- flow is activated through the same app.flow_publication switch publish_flow_version uses. No trigger,
-- constraint or validator is weakened. Calling it again for the same flow = a republication.
CREATE OR REPLACE FUNCTION public.qa_synth_flow(p_flow uuid, p_nodes jsonb, p_entry text, p_user uuid DEFAULT '10000000-0000-4000-8000-000000000001')
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_acct uuid; v_def jsonb; v_ver uuid; v_no int; v_name text := 'synthetic ' || left(p_flow::text, 8);
BEGIN
  SELECT account_id INTO v_acct FROM public.profiles WHERE user_id = p_user;
  INSERT INTO public.flows (id, user_id, account_id, name, trigger_type, entry_node_id) VALUES (p_flow, p_user, v_acct, v_name, 'manual', p_entry)
    ON CONFLICT (id) DO UPDATE SET entry_node_id = EXCLUDED.entry_node_id;
  SELECT jsonb_build_object(
    'flow', jsonb_build_object('id', f.id, 'name', f.name, 'description', f.description, 'trigger_type', f.trigger_type,
            'trigger_config', f.trigger_config, 'entry_node_id', p_entry, 'fallback_policy', f.fallback_policy),
    'nodes', (SELECT jsonb_agg(jsonb_build_object('node_key', n->>'node_key', 'node_type', n->>'node_type',
              'config', COALESCE(n->'config', '{}'::jsonb), 'position_x', 0, 'position_y', 0) ORDER BY n->>'node_key')
              FROM jsonb_array_elements(p_nodes) n)) INTO v_def FROM public.flows f WHERE f.id = p_flow;
  SELECT COALESCE(max(version_number), 0) + 1 INTO v_no FROM public.flow_versions WHERE flow_id = p_flow;
  INSERT INTO public.flow_versions (flow_id, account_id, version_number, definition, definition_hash, published_by)
  VALUES (p_flow, v_acct, v_no, v_def, encode(extensions.digest(v_def::text, 'sha256'), 'hex'), p_user) RETURNING id INTO v_ver;
  PERFORM set_config('app.flow_publication', 'on', true);
  UPDATE public.flows SET status = 'active', active_version_id = v_ver, entry_node_id = p_entry, updated_at = clock_timestamp() WHERE id = p_flow;
  PERFORM set_config('app.flow_publication', 'off', true);
  RETURN v_ver;
END $$;

-- Run on a synthetic (or fixture) flow for a fresh contact; returns the run id.
CREATE OR REPLACE FUNCTION public.qa_flow_run(p_flow uuid, n int) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE r record; f public.flows%ROWTYPE;
BEGIN
  SELECT * INTO f FROM public.flows WHERE id = p_flow;
  SELECT * INTO r FROM public.create_versioned_flow_run(f.account_id, f.id, public.qa_new_contact(n), NULL);
  IF NOT r.created THEN RAISE EXCEPTION 'qa_flow_run % failed: %', n, r.reason; END IF;
  RETURN r.flow_run_id;
END $$;

-- Lease helper: acquires (or fails loudly) and returns the fencing token.
CREATE OR REPLACE FUNCTION public.qa_lease(p_run uuid, p_owner text DEFAULT 'w1') RETURNS int LANGUAGE plpgsql AS $$
DECLARE r record; a uuid;
BEGIN
  SELECT account_id INTO a FROM public.flow_runs WHERE id = p_run;
  SELECT * INTO r FROM public.acquire_versioned_run_lease(a, p_run, p_owner, 600);
  IF NOT r.acquired THEN RAISE EXCEPTION 'qa_lease failed: %', r.reason; END IF;
  RETURN r.fencing_token;
END $$;

-- Moves the cursor to another node of the CURRENT version through the generic CAS commit.
CREATE OR REPLACE FUNCTION public.qa_goto(p_run uuid, p_owner text, p_node text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE run public.flow_runs%ROWTYPE; c record;
BEGIN
  SELECT * INTO run FROM public.flow_runs WHERE id = p_run;
  SELECT * INTO c FROM public.commit_versioned_run_transition(run.account_id, p_run, p_owner, run.versioned_lease, run.versioned_revision,
    jsonb_build_object('cursor', jsonb_build_object('flow_version_id', run.current_flow_version_id, 'node_key', p_node),
                       'step', (run.versioned_checkpoint->>'step')::int + 1));
  IF NOT c.committed THEN RAISE EXCEPTION 'qa_goto refused: %', c.reason; END IF;
END $$;

-- push/pop with the run's current token and revision; returns the whole result row as jsonb.
CREATE OR REPLACE FUNCTION public.qa_push(p_run uuid, p_owner text, p_call text, p_return text, p_target uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE run public.flow_runs%ROWTYPE; r record;
BEGIN
  SELECT * INTO run FROM public.flow_runs WHERE id = p_run;
  SELECT * INTO r FROM public.push_versioned_run_subflow(run.account_id, p_run, p_owner, run.versioned_lease, run.versioned_revision, p_call, p_return, p_target);
  RETURN to_jsonb(r);
END $$;
CREATE OR REPLACE FUNCTION public.qa_pop(p_run uuid, p_owner text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE run public.flow_runs%ROWTYPE; r record;
BEGIN
  SELECT * INTO run FROM public.flow_runs WHERE id = p_run;
  SELECT * INTO r FROM public.pop_versioned_run_subflow(run.account_id, p_run, p_owner, run.versioned_lease, run.versioned_revision);
  RETURN to_jsonb(r);
END $$;

-- Cursor/frames invariant: depth = number of frames = top frame depth, and the cursor sits in the
-- callee version of the top frame (or, at depth 0, in a version of the run's root flow).
CREATE OR REPLACE FUNCTION public.qa_stack_ok(p_run uuid) RETURNS boolean LANGUAGE sql AS $$
  SELECT r.versioned_depth = (SELECT count(*) FROM public.flow_run_call_frames f WHERE f.flow_run_id = r.id)
     AND r.versioned_depth = COALESCE((SELECT max(f.depth) FROM public.flow_run_call_frames f WHERE f.flow_run_id = r.id), 0)
     AND (r.versioned_depth = 0 OR r.current_flow_version_id = (SELECT f.callee_flow_version_id FROM public.flow_run_call_frames f WHERE f.flow_run_id = r.id AND f.depth = r.versioned_depth))
     AND (r.versioned_depth > 0 OR r.current_flow_version_id = r.root_flow_version_id)
     AND (r.versioned_checkpoint #>> '{cursor,flow_version_id}') = r.current_flow_version_id::text
     AND (r.versioned_checkpoint #>> '{cursor,node_key}') = r.versioned_node_key
  FROM public.flow_runs r WHERE r.id = p_run
$$;

-- C1 helpers (effect ledger). They read the run's current lease token / revision, like qa_push/qa_pop.
CREATE OR REPLACE FUNCTION public.qa_eff_register(p_run uuid, p_owner text, p_type text DEFAULT 'send_message', p_request jsonb DEFAULT '{"text":"hello"}') RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE run public.flow_runs%ROWTYPE; r record;
BEGIN
  SELECT * INTO run FROM public.flow_runs WHERE id = p_run;
  SELECT * INTO r FROM public.register_versioned_effect(run.account_id, p_run, p_owner, run.versioned_lease, run.versioned_revision, p_type, p_request);
  RETURN to_jsonb(r);
END $$;
CREATE OR REPLACE FUNCTION public.qa_eff_claim(p_run uuid, p_owner text, p_effect uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE run public.flow_runs%ROWTYPE; r record;
BEGIN
  SELECT * INTO run FROM public.flow_runs WHERE id = p_run;
  SELECT * INTO r FROM public.claim_versioned_effect(run.account_id, p_run, p_owner, run.versioned_lease, p_effect);
  RETURN to_jsonb(r);
END $$;
CREATE OR REPLACE FUNCTION public.qa_eff_settle(p_run uuid, p_owner text, p_effect uuid, p_attempt uuid, p_outcome text, p_provider text DEFAULT NULL, p_error text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE run public.flow_runs%ROWTYPE; r record;
BEGIN
  SELECT * INTO run FROM public.flow_runs WHERE id = p_run;
  SELECT * INTO r FROM public.settle_versioned_effect(run.account_id, p_run, p_owner, run.versioned_lease, p_effect, p_attempt, p_outcome, p_provider, p_error);
  RETURN to_jsonb(r);
END $$;
CREATE OR REPLACE FUNCTION public.qa_eff_step(p_run uuid, p_owner text, p_effect uuid, p_node text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE run public.flow_runs%ROWTYPE; r record;
BEGIN
  SELECT * INTO run FROM public.flow_runs WHERE id = p_run;
  SELECT * INTO r FROM public.commit_versioned_effect_step(run.account_id, p_run, p_owner, run.versioned_lease, run.versioned_revision, p_effect,
    jsonb_build_object('cursor', jsonb_build_object('flow_version_id', run.current_flow_version_id, 'node_key', p_node), 'step', (run.versioned_checkpoint->>'step')::int + 1));
  RETURN to_jsonb(r);
END $$;
CREATE OR REPLACE FUNCTION public.qa_eff_recover(p_run uuid, p_owner text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE run public.flow_runs%ROWTYPE;
BEGIN
  SELECT * INTO run FROM public.flow_runs WHERE id = p_run;
  RETURN COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM public.recover_versioned_run_effects(run.account_id, p_run, p_owner, run.versioned_lease) r), '[]'::jsonb);
END $$;
CREATE OR REPLACE FUNCTION public.qa_eff_resolve(p_run uuid, p_owner text, p_effect uuid, p_resolution text, p_evidence text, p_provider text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE run public.flow_runs%ROWTYPE; r record;
BEGIN
  SELECT * INTO run FROM public.flow_runs WHERE id = p_run;
  SELECT * INTO r FROM public.resolve_versioned_effect(run.account_id, p_run, p_owner, run.versioned_lease, p_effect, p_resolution, p_evidence, p_provider);
  RETURN to_jsonb(r);
END $$;
-- Whole happy path for the pending message node: register, claim, confirm, advance. Returns the effect id.
CREATE OR REPLACE FUNCTION public.qa_eff_full(p_run uuid, p_owner text, p_next text, p_request jsonb DEFAULT '{"text":"hello"}') RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE reg jsonb; clm jsonb; st jsonb; eid uuid;
BEGIN
  reg := public.qa_eff_register(p_run, p_owner, 'send_message', p_request);
  eid := (reg->>'effect_id')::uuid;
  clm := public.qa_eff_claim(p_run, p_owner, eid);
  st := public.qa_eff_settle(p_run, p_owner, eid, (clm->>'claimed_attempt_id')::uuid, 'confirmed', 'wamid.' || gen_random_uuid()::text);
  IF NOT (public.qa_eff_step(p_run, p_owner, eid, p_next)->>'committed')::bool THEN RAISE EXCEPTION 'qa_eff_full: step refused'; END IF;
  RETURN eid;
END $$;

-- C3.1 helper: a versioned run WITH a real conversation (needed for Inbox persistence). Returns the run id.
CREATE OR REPLACE FUNCTION public.qa_flow_run_conv(p_flow uuid, n int) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE r record; f public.flows%ROWTYPE; c uuid := public.qa_new_contact(n); v uuid;
BEGIN
  SELECT * INTO f FROM public.flows WHERE id = p_flow;
  INSERT INTO public.conversations (user_id, account_id, contact_id) VALUES (f.user_id, f.account_id, c) RETURNING id INTO v;
  SELECT * INTO r FROM public.create_versioned_flow_run(f.account_id, f.id, c, v);
  IF NOT r.created THEN RAISE EXCEPTION 'qa_flow_run_conv % failed: %', n, r.reason; END IF;
  RETURN r.flow_run_id;
END $$;
-- Claim + settle(confirmed) with a given wamid; returns the settle result row as jsonb.
CREATE OR REPLACE FUNCTION public.qa_eff_accept(p_run uuid, p_owner text, p_effect uuid, p_wamid text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE clm jsonb;
BEGIN
  clm := public.qa_eff_claim(p_run, p_owner, p_effect);
  RETURN public.qa_eff_settle(p_run, p_owner, p_effect, (clm->>'claimed_attempt_id')::uuid, 'confirmed', p_wamid);
END $$;

-- PR30 helper: confirms an effect (claim + settle) and returns its id; leaves the cursor where it is.
CREATE OR REPLACE FUNCTION public.qa_eff_registered_accept(p_run uuid, p_owner text, p_request jsonb, p_wamid text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE eid uuid;
BEGIN
  eid := (public.qa_eff_register(p_run, p_owner, 'send_message', p_request)->>'effect_id')::uuid;
  PERFORM public.qa_eff_accept(p_run, p_owner, eid, p_wamid);
  RETURN eid;
END $$;
-- PR30 helper: advance past a confirmed effect to the END node and finish the run ('completed' or 'failed').
CREATE OR REPLACE FUNCTION public.qa_finish_run(p_run uuid, p_owner text, p_effect uuid, p_status text DEFAULT 'completed') RETURNS void LANGUAGE plpgsql AS $$
DECLARE run public.flow_runs%ROWTYPE; c record;
BEGIN
  IF NOT (public.qa_eff_step(p_run, p_owner, p_effect, 'x')->>'committed')::bool THEN RAISE EXCEPTION 'qa_finish_run: step refused'; END IF;
  SELECT * INTO run FROM public.flow_runs WHERE id = p_run;
  SELECT * INTO c FROM public.commit_versioned_run_transition(run.account_id, p_run, p_owner, run.versioned_lease, run.versioned_revision,
    jsonb_build_object('cursor', jsonb_build_object('flow_version_id', run.current_flow_version_id, 'node_key', 'x'), 'step', (run.versioned_checkpoint->>'step')::int + 1, 'state', 'terminal'),
    p_status, 'qa', 1);
  IF NOT c.committed THEN RAISE EXCEPTION 'qa_finish_run: finish refused (%)', c.reason; END IF;
END $$;
