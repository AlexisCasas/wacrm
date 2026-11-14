-- Executed only by GitHub's disposable local Supabase Postgres after all migrations (single DO statement: `supabase db query` uses a prepared statement).
-- Regression for 20261124000000: saving / deleting / creating nodes of a flow whose id STARTS WITH A DIGIT must work, for every possible first hex character.
DO $qa$
DECLARE
  u uuid := gen_random_uuid(); acct uuid := gen_random_uuid(); fid uuid; ch text; n int; bad text := '';
BEGIN
  INSERT INTO auth.users(id, email) VALUES (u, 'autoauth-guc-qa@example.test');
  INSERT INTO public.accounts(id, name, owner_user_id) VALUES (acct, 'autoauth-guc-qa', u);
  INSERT INTO public.bsuid_flow_autoauth(account_id, enabled, audio_enabled) VALUES (acct, true, false);
  -- Fire the deferred node trigger right after each statement so a failure is caught per flow below; the same function also runs at COMMIT in the app.
  SET CONSTRAINTS public.bsuid_flow_autoauth_node IMMEDIATE;
  FOREACH ch IN ARRAY ARRAY['0','1','2','3','4','5','6','7','8','9','a','b','c','d','e','f'] LOOP
    fid := (ch || substr(gen_random_uuid()::text, 2))::uuid;
    INSERT INTO public.flows(id, account_id, user_id, name, status, trigger_type) VALUES (fid, acct, u, 'qa-' || ch, 'draft', 'keyword');
    BEGIN
      -- the editor's save: header + replace-all nodes
      PERFORM public.replace_flow_draft_atomic(acct, fid,
        '{"name":"qa-saved"}'::jsonb,
        '[{"node_key":"start","node_type":"start","config":{}},{"node_key":"m","node_type":"send_message","config":{}},{"node_key":"i","node_type":"send_media","config":{}},{"node_key":"end","node_type":"end","config":{}}]'::jsonb);
      -- a second save of the same flow (replace again) and publish
      PERFORM public.replace_flow_draft_atomic(acct, fid, '{}'::jsonb,
        '[{"node_key":"start","node_type":"start","config":{}},{"node_key":"m","node_type":"send_message","config":{}},{"node_key":"end","node_type":"end","config":{}}]'::jsonb);
      SELECT count(*) INTO n FROM public.flow_nodes WHERE flow_id = fid;
      IF n <> 3 THEN bad := bad || ch || ':nodes=' || n || ' '; END IF;
    EXCEPTION WHEN OTHERS THEN bad := bad || ch || ':' || SQLSTATE || ' ';
    END;
  END LOOP;
  IF bad <> '' THEN RAISE EXCEPTION 'flow node save failed for first characters: %', bad; END IF;
  -- The real COMMIT-time behaviour (deferred) is covered by qa/bsuid/migration-autoauth-guc.test.sql with explicit transactions.
  IF position('''wacrm.bsuid_autoauth.f_''' IN pg_get_functiondef('public.bsuid_flow_autoauth_on_node'::regproc)) = 0 THEN
    RAISE EXCEPTION 'on_node trigger function does not use the letter-prefixed setting name';
  END IF;
  DELETE FROM public.flows WHERE account_id = acct;           -- cascade delete of nodes must work too
  DELETE FROM public.bsuid_flow_autoauth WHERE account_id = acct;
  DELETE FROM public.accounts WHERE id = acct;
  DELETE FROM auth.users WHERE id = u;
END $qa$;
