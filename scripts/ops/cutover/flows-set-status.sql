-- Set the status of an EXACT list of flows of ONE account, in one guarded transaction. Used to activate a wave (draft -> active) and, with the same
-- list, to roll it back (active -> draft). It touches nothing else: not Meta, not ManyChat, not other flows, not automations.
--
--   psql -v ON_ERROR_STOP=1 -v account_id=<uuid> -v from_status=draft -v to_status=active \
--        -v flow_ids='<uuid>,<uuid>,...' -v expected=<n> -f flows-set-status.sql
--
-- Guards (any failure aborts, nothing is kept): the ids are distinct and exactly `expected`; every id belongs to the account and is currently
-- in from_status; when ACTIVATING, every sub-flow called by an activated flow (execute_flow) is ACTIVE afterwards (a draft callee fails at run time
-- with callee_unavailable); no other flow of any account changes (fingerprint before/after); lock_timeout 5 s, statement_timeout 30 s.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SELECT set_config('cut.account', :'account_id', true), set_config('cut.from', :'from_status', true), set_config('cut.to', :'to_status', true),
       set_config('cut.ids', :'flow_ids', true), set_config('cut.expected', :'expected', true) \gset
CREATE TEMP TABLE _cut_before ON COMMIT DROP AS SELECT id, md5(to_jsonb(f)::text) h FROM public.flows f;
DO $$
DECLARE
  v_ids uuid[]; n int; v_from text := current_setting('cut.from'); v_to text := current_setting('cut.to');
  v_account uuid := current_setting('cut.account')::uuid; v_expected int := current_setting('cut.expected')::int;
BEGIN
  IF v_from NOT IN ('draft','active') OR v_to NOT IN ('draft','active') OR v_from = v_to THEN RAISE EXCEPTION 'guard: from/to must be draft<->active'; END IF;
  SELECT array_agg(x::uuid) INTO v_ids FROM unnest(string_to_array(current_setting('cut.ids'), ',')) x WHERE btrim(x) <> '';
  IF v_ids IS NULL OR cardinality(v_ids) <> v_expected THEN RAISE EXCEPTION 'guard: expected % ids, got %', v_expected, coalesce(cardinality(v_ids), 0); END IF;
  IF (SELECT count(DISTINCT i) FROM unnest(v_ids) i) <> cardinality(v_ids) THEN RAISE EXCEPTION 'guard: duplicate ids in the list'; END IF;
  PERFORM 1 FROM public.accounts WHERE id = v_account;
  IF NOT FOUND THEN RAISE EXCEPTION 'guard: account does not exist'; END IF;
  SELECT count(*) INTO n FROM public.flows WHERE id = ANY (v_ids) AND account_id = v_account AND status = v_from;
  IF n <> v_expected THEN RAISE EXCEPTION 'guard: % of % flows are in this account with status %', n, v_expected, v_from; END IF;

  UPDATE public.flows SET status = v_to WHERE id = ANY (v_ids) AND account_id = v_account AND status = v_from;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> v_expected THEN RAISE EXCEPTION 'expected % rows updated, got %', v_expected, n; END IF;

  IF v_to = 'active' THEN
    SELECT count(DISTINCT nd.config->>'target_flow_id') INTO n
      FROM public.flow_nodes nd
     WHERE nd.flow_id = ANY (v_ids) AND nd.node_type = 'execute_flow'
       AND NOT EXISTS (SELECT 1 FROM public.flows c WHERE c.id::text = nd.config->>'target_flow_id' AND c.account_id = v_account AND c.status = 'active');
    IF n <> 0 THEN RAISE EXCEPTION 'guard: % sub-flow(s) called by the activated flows are not active (callee_unavailable at run time)', n; END IF;
  END IF;

  SELECT count(*) INTO n FROM public.flows f JOIN _cut_before b USING (id) WHERE NOT (f.id = ANY (v_ids)) AND md5(to_jsonb(f)::text) <> b.h;
  IF n <> 0 THEN RAISE EXCEPTION 'guard: another flow changed'; END IF;
  SELECT count(*) INTO n FROM public.flows WHERE id NOT IN (SELECT id FROM _cut_before);
  IF n <> 0 THEN RAISE EXCEPTION 'guard: flows were created'; END IF;
  RAISE NOTICE 'FLOWS_SET_% rows=%', upper(v_to), v_expected;
END $$;
COMMIT;
