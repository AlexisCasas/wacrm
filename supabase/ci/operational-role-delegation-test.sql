-- Behaviour test for 20261204000000_operational_role_supervisor_delegation.sql (set_member_operational_role authority matrix).
-- Run against a database that already has ALL migrations applied:  psql -v ON_ERROR_STOP=1 -f supabase/ci/operational-role-delegation-test.sql
-- Everything runs inside ONE transaction that ends in ROLLBACK, with synthetic users/accounts: nothing persists and no existing row is changed.
BEGIN;

CREATE TEMP TABLE ids (k text PRIMARY KEY, v uuid NOT NULL);

-- Synthetic users. The signup trigger gives each one its own account; they are then moved into account A as members.
DO $$
DECLARE kk text; u uuid; acc_a uuid;
BEGIN
  FOREACH kk IN ARRAY ARRAY['owner','admin','sup','sup2','agent','viewer','commercial','target','foreign'] LOOP
    u := gen_random_uuid();
    INSERT INTO auth.users (id, email) VALUES (u, 'opr-' || kk || '@example.invalid');
    INSERT INTO ids VALUES (kk, u);
  END LOOP;
  INSERT INTO ids VALUES ('ghost', gen_random_uuid());
  SELECT account_id INTO acc_a FROM profiles WHERE user_id = (SELECT v FROM ids WHERE k = 'owner');
  INSERT INTO ids VALUES ('acc_a', acc_a);
  UPDATE profiles SET account_id = acc_a, account_role = 'admin'  WHERE user_id = (SELECT v FROM ids WHERE k = 'admin');
  UPDATE profiles SET account_id = acc_a, account_role = 'agent'  WHERE user_id IN (SELECT v FROM ids WHERE k IN ('sup','sup2','agent','commercial','target'));
  UPDATE profiles SET account_id = acc_a, account_role = 'viewer' WHERE user_id = (SELECT v FROM ids WHERE k = 'viewer');
  -- 'foreign' keeps its own account (cross-account target).
  INSERT INTO order_integration_settings (account_id, logistics_mvp_enabled) VALUES (acc_a, TRUE)
    ON CONFLICT (account_id) DO UPDATE SET logistics_mvp_enabled = TRUE;
  UPDATE profiles SET operational_role = 'supervisor' WHERE user_id IN (SELECT v FROM ids WHERE k IN ('sup','sup2'));
  UPDATE profiles SET operational_role = 'commercial' WHERE user_id IN (SELECT v FROM ids WHERE k IN ('commercial','agent'));
END $$;

CREATE FUNCTION pg_temp.uid(p text) RETURNS uuid LANGUAGE sql AS $$ SELECT v FROM ids WHERE k = p $$;
CREATE FUNCTION pg_temp.op(p text) RETURNS text LANGUAGE sql AS $$ SELECT operational_role::text FROM public.profiles WHERE user_id = pg_temp.uid(p) $$;

-- Calls the RPC as `p_caller` (role authenticated). Returns 'OK' or 'SQLSTATE:message'.
CREATE FUNCTION pg_temp.attempt(p_caller text, p_target text, p_role text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE r text; c uuid := pg_temp.uid(p_caller); t uuid := pg_temp.uid(p_target);
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', c, 'role', 'authenticated')::text, TRUE);
  PERFORM set_config('request.jwt.claim.sub', c::text, TRUE);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.set_member_operational_role(t, p_role::public.operational_role_enum);
    r := 'OK';
  EXCEPTION WHEN OTHERS THEN
    r := SQLSTATE || ':' || SQLERRM;
  END;
  RESET ROLE;
  RETURN r;
END $$;

-- Direct browser-style UPDATE of the caller's own profile row (role authenticated). Returns 'OK' or SQLSTATE.
CREATE FUNCTION pg_temp.direct(p_caller text, p_set text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE r text; c uuid := pg_temp.uid(p_caller);
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', c, 'role', 'authenticated')::text, TRUE);
  PERFORM set_config('request.jwt.claim.sub', c::text, TRUE);
  SET LOCAL ROLE authenticated;
  BEGIN
    EXECUTE 'UPDATE public.profiles SET ' || p_set || ' WHERE user_id = ' || quote_literal(c);
    r := 'OK';
  EXCEPTION WHEN OTHERS THEN
    r := SQLSTATE;
  END;
  RESET ROLE;
  RETURN r;
END $$;

CREATE FUNCTION pg_temp.expect(p_name text, p_actual text, p_expected text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_actual IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION 'FAIL %: got [%] expected [%]', p_name, p_actual, p_expected;
  END IF;
  RAISE NOTICE 'PASS %', p_name;
END $$;

DO $$
DECLARE before_role text; before_acc uuid;
BEGIN
  -- ---------------- owner / admin ----------------
  PERFORM pg_temp.expect('owner -> commercial', pg_temp.attempt('owner','target','commercial'), 'OK');
  PERFORM pg_temp.expect('  value written', pg_temp.op('target'), 'commercial');
  PERFORM pg_temp.expect('owner -> logistics', pg_temp.attempt('owner','target','logistics'), 'OK');
  PERFORM pg_temp.expect('owner -> supervisor', pg_temp.attempt('owner','target','supervisor'), 'OK');
  PERFORM pg_temp.expect('  value written', pg_temp.op('target'), 'supervisor');
  PERFORM pg_temp.expect('owner -> NULL (on a supervisor)', pg_temp.attempt('owner','target', NULL), 'OK');
  PERFORM pg_temp.expect('  value cleared', pg_temp.op('target'), NULL);
  PERFORM pg_temp.expect('admin -> supervisor', pg_temp.attempt('admin','target','supervisor'), 'OK');
  PERFORM pg_temp.expect('admin demotes a supervisor', pg_temp.attempt('admin','target','logistics'), 'OK');

  -- owner who is ALSO supervisor keeps the full owner power
  UPDATE profiles SET operational_role = 'supervisor' WHERE user_id = pg_temp.uid('owner');
  PERFORM pg_temp.expect('owner+supervisor -> supervisor on another', pg_temp.attempt('owner','target','supervisor'), 'OK');
  PERFORM pg_temp.expect('owner+supervisor edits another supervisor', pg_temp.attempt('owner','sup2','logistics'), 'OK');
  UPDATE profiles SET operational_role = 'supervisor' WHERE user_id = pg_temp.uid('sup2');
  UPDATE profiles SET operational_role = NULL WHERE user_id = pg_temp.uid('owner');
  UPDATE profiles SET operational_role = 'logistics' WHERE user_id = pg_temp.uid('target');

  -- ---------------- operational supervisor (account_role = agent) ----------------
  PERFORM pg_temp.expect('supervisor -> commercial', pg_temp.attempt('sup','target','commercial'), 'OK');
  PERFORM pg_temp.expect('  value written', pg_temp.op('target'), 'commercial');
  PERFORM pg_temp.expect('supervisor -> logistics', pg_temp.attempt('sup','target','logistics'), 'OK');
  PERFORM pg_temp.expect('supervisor -> NULL', pg_temp.attempt('sup','target', NULL), 'OK');
  PERFORM pg_temp.expect('  value cleared', pg_temp.op('target'), NULL);
  PERFORM pg_temp.expect('supervisor -> supervisor REJECTED', left(pg_temp.attempt('sup','target','supervisor'), 5), '42501');
  PERFORM pg_temp.expect('  target untouched', pg_temp.op('target'), NULL);
  PERFORM pg_temp.expect('supervisor modifies ANOTHER supervisor REJECTED', left(pg_temp.attempt('sup','sup2','commercial'), 5), '42501');
  PERFORM pg_temp.expect('supervisor removes ANOTHER supervisor (NULL) REJECTED', left(pg_temp.attempt('sup','sup2', NULL), 5), '42501');
  PERFORM pg_temp.expect('  other supervisor intact', pg_temp.op('sup2'), 'supervisor');
  PERFORM pg_temp.expect('supervisor self-assign supervisor REJECTED', left(pg_temp.attempt('sup','sup','supervisor'), 5), '42501');
  PERFORM pg_temp.expect('supervisor self-edit REJECTED (cannot touch any supervisor, itself included)', left(pg_temp.attempt('sup','sup','commercial'), 5), '42501');
  PERFORM pg_temp.expect('  self intact', pg_temp.op('sup'), 'supervisor');

  -- supervisor (agent) vs owner / admin targets: protected, with and without an operational area
  PERFORM pg_temp.expect('supervisor -> owner (no area) REJECTED', left(pg_temp.attempt('sup','owner','commercial'), 5), '42501');
  PERFORM pg_temp.expect('supervisor -> admin (no area) REJECTED', left(pg_temp.attempt('sup','admin','logistics'), 5), '42501');
  PERFORM pg_temp.expect('supervisor -> admin NULL REJECTED', left(pg_temp.attempt('sup','admin', NULL), 5), '42501');
  UPDATE profiles SET operational_role = 'commercial' WHERE user_id = pg_temp.uid('admin');
  PERFORM pg_temp.expect('supervisor -> admin with area REJECTED', left(pg_temp.attempt('sup','admin', NULL), 5), '42501');
  PERFORM pg_temp.expect('  admin area intact', pg_temp.op('admin'), 'commercial');
  UPDATE profiles SET operational_role = 'supervisor' WHERE user_id = pg_temp.uid('owner');
  PERFORM pg_temp.expect('supervisor -> owner+supervisor REJECTED', left(pg_temp.attempt('sup','owner','commercial'), 5), '42501');
  PERFORM pg_temp.expect('  owner area intact', pg_temp.op('owner'), 'supervisor');
  UPDATE profiles SET operational_role = NULL WHERE user_id IN (pg_temp.uid('owner'), pg_temp.uid('admin'));
  PERFORM pg_temp.expect('owner still manages admin', pg_temp.attempt('owner','admin','logistics'), 'OK');
  PERFORM pg_temp.expect('admin still manages owner', pg_temp.attempt('admin','owner','commercial'), 'OK');
  UPDATE profiles SET operational_role = NULL WHERE user_id IN (pg_temp.uid('owner'), pg_temp.uid('admin'));

  -- ---------------- everyone else ----------------
  PERFORM pg_temp.expect('commercial agent self-elevation REJECTED', left(pg_temp.attempt('commercial','commercial','supervisor'), 5), '42501');
  PERFORM pg_temp.expect('  intact', pg_temp.op('commercial'), 'commercial');
  PERFORM pg_temp.expect('agent (commercial area) -> change REJECTED', left(pg_temp.attempt('agent','target','logistics'), 5), '42501');
  PERFORM pg_temp.expect('viewer -> change REJECTED', left(pg_temp.attempt('viewer','target','logistics'), 5), '42501');
  PERFORM pg_temp.expect('  target intact', pg_temp.op('target'), NULL);

  -- ---------------- cross-account / unknown target ----------------
  PERFORM pg_temp.expect('owner -> member of ANOTHER account REJECTED', left(pg_temp.attempt('owner','foreign','commercial'), 5), '42501');
  PERFORM pg_temp.expect('supervisor -> member of ANOTHER account REJECTED', left(pg_temp.attempt('sup','foreign','commercial'), 5), '42501');
  PERFORM pg_temp.expect('  foreign intact', pg_temp.op('foreign'), NULL);
  PERFORM pg_temp.expect('unknown target -> 22023', left(pg_temp.attempt('owner','ghost','commercial'), 5), '22023');

  -- ---------------- feature flag OFF (20261205000000: areas can be assigned BEFORE activation) ----------------
  UPDATE order_integration_settings SET logistics_mvp_enabled = FALSE WHERE account_id = pg_temp.uid('acc_a');
  PERFORM pg_temp.expect('flag OFF: owner assigns commercial OK', pg_temp.attempt('owner','target','commercial'), 'OK');
  PERFORM pg_temp.expect('  target is commercial', pg_temp.op('target'), 'commercial');
  PERFORM pg_temp.expect('flag OFF: owner assigns logistics OK', pg_temp.attempt('owner','target','logistics'), 'OK');
  PERFORM pg_temp.expect('flag OFF: owner assigns supervisor OK', pg_temp.attempt('owner','target','supervisor'), 'OK');
  PERFORM pg_temp.expect('flag OFF: admin clears to NULL OK', pg_temp.attempt('admin','target',NULL), 'OK');
  PERFORM pg_temp.expect('  target cleared', pg_temp.op('target'), NULL);
  PERFORM pg_temp.expect('flag OFF: agent (commercial) REJECTED', left(pg_temp.attempt('agent','target','commercial'), 5), '42501');
  PERFORM pg_temp.expect('flag OFF: viewer REJECTED', left(pg_temp.attempt('viewer','target','commercial'), 5), '42501');
  PERFORM pg_temp.expect('flag OFF: cross-account REJECTED', left(pg_temp.attempt('owner','foreign','commercial'), 5), '42501');
  PERFORM pg_temp.expect('  target intact after rejections', pg_temp.op('target'), NULL);
  PERFORM pg_temp.expect('  logistics_mvp_enabled is STILL false', (SELECT logistics_mvp_enabled::text FROM order_integration_settings WHERE account_id = pg_temp.uid('acc_a')), 'false');
  PERFORM pg_temp.expect('  owner account_role unchanged', (SELECT account_role::text FROM profiles WHERE user_id = pg_temp.uid('owner')), 'owner');
  UPDATE order_integration_settings SET logistics_mvp_enabled = TRUE WHERE account_id = pg_temp.uid('acc_a');

  -- ---------------- only operational_role changes; direct browser writes still blocked ----------------
  SELECT account_role::text, account_id INTO before_role, before_acc FROM profiles WHERE user_id = pg_temp.uid('target');
  PERFORM pg_temp.attempt('sup','target','logistics');
  PERFORM pg_temp.attempt('owner','target','supervisor');
  PERFORM pg_temp.expect('account_role unchanged by the RPC', (SELECT account_role::text FROM profiles WHERE user_id = pg_temp.uid('target')), before_role);
  PERFORM pg_temp.expect('account_id unchanged by the RPC', (SELECT account_id::text FROM profiles WHERE user_id = pg_temp.uid('target')), before_acc::text);
  PERFORM pg_temp.expect('direct UPDATE operational_role by a supervisor blocked', pg_temp.direct('sup', 'operational_role = ''commercial'''), '42501');
  PERFORM pg_temp.expect('direct UPDATE operational_role by the owner blocked', pg_temp.direct('owner', 'operational_role = ''supervisor'''), '42501');
  PERFORM pg_temp.expect('direct UPDATE operational_role by an agent (self-elevation) blocked', pg_temp.direct('agent', 'operational_role = ''supervisor'''), '42501');
  PERFORM pg_temp.expect('direct UPDATE account_role blocked', pg_temp.direct('sup', 'account_role = ''admin'''), '42501');
  PERFORM pg_temp.expect('direct UPDATE account_id blocked', pg_temp.direct('sup', 'account_id = ' || quote_literal((SELECT account_id FROM public.profiles WHERE user_id = pg_temp.uid('foreign')))), '42501');

  -- ---------------- catalog properties ----------------
  PERFORM pg_temp.expect('EXECUTE: authenticated yes', has_function_privilege('authenticated', 'public.set_member_operational_role(uuid, public.operational_role_enum)', 'EXECUTE')::text, 'true');
  PERFORM pg_temp.expect('EXECUTE: anon no', has_function_privilege('anon', 'public.set_member_operational_role(uuid, public.operational_role_enum)', 'EXECUTE')::text, 'false');
  PERFORM pg_temp.expect('SECURITY DEFINER + owner postgres', (SELECT prosecdef::text || '/' || pg_get_userbyid(proowner) FROM pg_proc WHERE oid = 'public.set_member_operational_role(uuid, public.operational_role_enum)'::regprocedure), 'true/postgres');
  PERFORM pg_temp.expect('search_path pinned', (SELECT array_to_string(proconfig, ',') FROM pg_proc WHERE oid = 'public.set_member_operational_role(uuid, public.operational_role_enum)'::regprocedure), 'search_path=public');
  RAISE NOTICE 'ALL OPERATIONAL-ROLE DELEGATION CHECKS PASSED';
END $$;

ROLLBACK;
