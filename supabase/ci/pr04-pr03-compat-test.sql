-- PR-04 <-> PR-03 COMPATIBILITY (behaviour, against a database that has ALL migrations applied, PR-04 included):
--   psql -v ON_ERROR_STOP=1 -f supabase/ci/pr04-pr03-compat-test.sql
-- Proves that conversation_routing (commercial / logistics / shared), its RPCs and its transitions keep working with the PR-04 objects present, and that PR-04
-- operations never move a conversation between stages. It belongs to PR-04: the frozen PR-03 suites are not edited (they also pass: see docs/operations/ORDER-VOUCHER-PACKAGING-PR04.md).
-- One transaction that ends in ROLLBACK, synthetic data only.
BEGIN;

CREATE TEMP TABLE ids (k text PRIMARY KEY, v uuid NOT NULL);

DO $$
DECLARE kk text; u uuid; acc uuid; c uuid; conv uuid;
BEGIN
  FOREACH kk IN ARRAY ARRAY['owner','sup','comm','logi','none'] LOOP
    u := gen_random_uuid();
    INSERT INTO auth.users (id, email) VALUES (u, 'cmp-' || kk || '@example.invalid');
    INSERT INTO ids VALUES (kk, u);
  END LOOP;
  SELECT account_id INTO acc FROM profiles WHERE user_id = (SELECT v FROM ids WHERE k = 'owner');
  INSERT INTO ids VALUES ('acc', acc);
  UPDATE profiles SET account_id = acc, account_role = 'agent' WHERE user_id IN (SELECT v FROM ids WHERE k IN ('sup','comm','logi','none'));
  UPDATE profiles SET operational_role = 'supervisor' WHERE user_id = (SELECT v FROM ids WHERE k = 'sup');
  UPDATE profiles SET operational_role = 'commercial' WHERE user_id = (SELECT v FROM ids WHERE k = 'comm');
  UPDATE profiles SET operational_role = 'logistics'  WHERE user_id = (SELECT v FROM ids WHERE k = 'logi');
  INSERT INTO order_integration_settings (account_id, confirm_enabled, logistics_mvp_enabled) VALUES (acc, TRUE, TRUE)
    ON CONFLICT (account_id) DO UPDATE SET confirm_enabled = TRUE, logistics_mvp_enabled = TRUE;
  c := gen_random_uuid(); conv := gen_random_uuid();
  INSERT INTO contacts (id, user_id, account_id, phone, name) VALUES (c, (SELECT v FROM ids WHERE k = 'owner'), acc, '5194' || floor(random()*1e8)::int, 'CMP chat');
  INSERT INTO conversations (id, user_id, account_id, contact_id) VALUES (conv, (SELECT v FROM ids WHERE k = 'owner'), acc, c);
  INSERT INTO ids VALUES ('conv', conv), ('contact', c);
  INSERT INTO messages (conversation_id, sender_type, content_type, content_text) VALUES (conv, 'customer', 'text', 'hola'), (conv, 'agent', 'text', 'respuesta');
END $$;

CREATE FUNCTION pg_temp.uid(p text) RETURNS uuid LANGUAGE sql AS $$ SELECT v FROM ids WHERE k = p $$;
CREATE FUNCTION pg_temp.expect(p_name text, p_actual text, p_expected text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_actual IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'FAIL %: got [%] expected [%]', p_name, p_actual, p_expected; END IF;
  RAISE NOTICE 'PASS %', p_name;
END $$;
CREATE FUNCTION pg_temp.run(p_caller text, p_sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE c uuid := pg_temp.uid(p_caller); r text;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', c, 'role', 'authenticated')::text, TRUE);
  PERFORM set_config('request.jwt.claim.sub', c::text, TRUE);
  SET LOCAL ROLE authenticated;
  BEGIN EXECUTE p_sql INTO r; EXCEPTION WHEN OTHERS THEN r := 'ERR:' || SQLSTATE || ':' || SQLERRM; END;
  RESET ROLE;
  RETURN r;
END $$;
CREATE FUNCTION pg_temp.rpc(p_sql text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  BEGIN EXECUTE p_sql INTO r; EXCEPTION WHEN OTHERS THEN r := jsonb_build_object('err', SQLSTATE || ':' || SQLERRM); END;
  RETURN r;
END $$;
-- who may open the conversation: the routing-driven helper that every PR-03 policy uses
CREATE FUNCTION pg_temp.access(p_caller text) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.run(p_caller, 'select public.conversation_operational_access(' || quote_literal(pg_temp.uid('acc')) || '::uuid, ' || quote_literal(pg_temp.uid('conv')) || '::uuid)::text') $$;
CREATE FUNCTION pg_temp.matrix() RETURNS text LANGUAGE sql AS $$
  SELECT concat_ws('/', pg_temp.access('comm'), pg_temp.access('logi'), pg_temp.access('sup'), pg_temp.access('none')) $$;
CREATE FUNCTION pg_temp.stage() RETURNS text LANGUAGE sql AS $$
  SELECT COALESCE((SELECT stage || '/v' || version FROM public.conversation_routing WHERE conversation_id = pg_temp.uid('conv')), 'none') $$;
CREATE FUNCTION pg_temp.events() RETURNS text LANGUAGE sql AS $$
  SELECT COALESCE(string_agg(from_stage || '>' || to_stage || ':' || reason, ' | ' ORDER BY created_at, id), '-') FROM public.conversation_routing_events WHERE conversation_id = pg_temp.uid('conv') $$;
CREATE FUNCTION pg_temp.confirm(p_key text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE r uuid;
BEGIN
  SELECT x.order_id INTO r FROM public.create_order_confirmation(pg_temp.uid('acc'), pg_temp.uid('contact'), pg_temp.uid('conv'), pg_temp.uid('comm'), 'Comercial QA', p_key, pg_temp.uid('comm'),
    jsonb_build_object('customer_name', 'CMP cliente', 'phone', '900000000', 'product', 'Prod', 'quantity', '1', 'price', '10.00', 'destination', 'Lima')) x;
  RETURN r;
END $$;
CREATE FUNCTION pg_temp.derive(p_caller text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE c uuid := pg_temp.uid(p_caller); v_conv uuid := pg_temp.uid('conv'); r text;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', c, 'role', 'authenticated')::text, TRUE);
  PERFORM set_config('request.jwt.claim.sub', c::text, TRUE);
  SET LOCAL ROLE authenticated;
  BEGIN SELECT d.stage || '/' || d.changed INTO r FROM public.derive_conversation_to_commercial(v_conv) d; EXCEPTION WHEN OTHERS THEN r := 'ERR:' || SQLSTATE; END;
  RESET ROLE;
  RETURN r;
END $$;

DO $$
DECLARE o1 uuid; o2 uuid; d uuid := gen_random_uuid(); doc uuid; v jsonb;
BEGIN
  -- ================= the PR-03 catalog is intact =================
  PERFORM pg_temp.expect('conversation_routing keeps its columns', (SELECT string_agg(column_name, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'conversation_routing'),
    'conversation_id,account_id,stage,updated_at,updated_by,version');
  PERFORM pg_temp.expect('conversation_routing_events keeps its columns', (SELECT string_agg(column_name, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'conversation_routing_events'),
    'id,account_id,conversation_id,from_stage,to_stage,reason,actor_user_id,actor_name,order_id,created_at');
  PERFORM pg_temp.expect('PR-03 functions exist with their ACLs (derive: authenticated; apply / backfill: service_role only)',
    has_function_privilege('authenticated', 'public.derive_conversation_to_commercial(uuid)', 'EXECUTE')::text || '/'
    || has_function_privilege('authenticated', 'public.apply_order_confirmed_routing(uuid,uuid,uuid,text,uuid)', 'EXECUTE')::text || '/'
    || has_function_privilege('authenticated', 'public.backfill_conversation_routing(uuid)', 'EXECUTE')::text || '/'
    || has_function_privilege('service_role', 'public.apply_order_confirmed_routing(uuid,uuid,uuid,text,uuid)', 'EXECUTE')::text, 'true/false/false/true');
  PERFORM pg_temp.expect('create_order_confirmation still calls the PR-03 routing step and knows nothing of PR-04',
    (position('apply_order_confirmed_routing' in pg_get_functiondef('public.create_order_confirmation(uuid,uuid,uuid,uuid,text,text,uuid,jsonb)'::regprocedure)) > 0)::text || '/'
    || (position('order_logistics' in pg_get_functiondef('public.create_order_confirmation(uuid,uuid,uuid,uuid,text,text,uuid,jsonb)'::regprocedure)) = 0)::text, 'true/true');
  PERFORM pg_temp.expect('the routing helper still decides by stage and does not mention PR-04',
    (position('conversation_routing' in pg_get_functiondef('public.conversation_operational_access(uuid,uuid)'::regprocedure)) > 0)::text || '/'
    || (position('order_logistics' in pg_get_functiondef('public.conversation_operational_access(uuid,uuid)'::regprocedure)) = 0)::text, 'true/true');
  PERFORM pg_temp.expect('PR-04 added no trigger to any PR-03 table or to order_confirmations',
    (SELECT count(*)::text FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid WHERE NOT t.tgisinternal AND t.tgrelid IN ('public.conversation_routing'::regclass, 'public.conversation_routing_events'::regclass, 'public.order_confirmations'::regclass) AND p.proname LIKE 'order\_logistics%'), '0');

  -- ================= commercial stage (no row) =================
  PERFORM pg_temp.expect('no row = commercial: comm yes, logistics no, supervisor yes, no-area no', pg_temp.stage() || ' ' || pg_temp.matrix(), 'none true/false/true/false');

  -- ================= commercial -> logistics (create_order_confirmation) =================
  o1 := pg_temp.confirm('cmp-o1');
  PERFORM pg_temp.expect('confirming an order moves the chat to logistics (v1) with ONE audited transition', pg_temp.stage() || ' ' || pg_temp.events(), 'logistics/v1 commercial>logistics:order_confirmed');
  PERFORM pg_temp.expect('logistics stage: comm no, logistics yes, supervisor yes, no-area no', pg_temp.matrix(), 'false/true/true/false');

  -- ================= PR-04 works on that order and NEVER touches the routing =================
  v := pg_temp.rpc(format('select public.register_order_document(%L,%L,%L,%L,NULL,%L,%L,%L,%L,100,%L,false)', pg_temp.uid('acc'), pg_temp.uid('logi'), d, o1, 'cmp-v1',
        'account-' || pg_temp.uid('acc') || '/orders/' || o1 || '/vouchers/' || d || '/v.pdf', 'v.pdf', 'application/pdf', encode(sha256('cmp'::bytea), 'hex')));
  PERFORM pg_temp.expect('PR-04: voucher registered on the order', v->>'ok', 'true');
  v := pg_temp.rpc(format('select public.review_order_document(%L,%L,%L,''validate'',NULL,%L)', pg_temp.uid('acc'), pg_temp.uid('logi'), d, '{"dni":"1"}'));
  PERFORM pg_temp.expect('PR-04: voucher validated', v->>'ok', 'true');
  v := pg_temp.rpc(format('select public.start_order_packaging(%L,%L,%L)', pg_temp.uid('acc'), pg_temp.uid('logi'), o1));
  PERFORM pg_temp.expect('PR-04: packaging started', v->>'status', 'packing');
  PERFORM pg_temp.expect('PR-04 operations left the routing exactly as PR-03 left it (stage, version, events)', pg_temp.stage() || ' ' || pg_temp.events(), 'logistics/v1 commercial>logistics:order_confirmed');
  PERFORM pg_temp.expect('PR-04 grants nothing through routing: commercial still sees no logistics rows', pg_temp.run('comm', 'select count(*) from public.order_documents') || '/' || pg_temp.run('comm', 'select count(*) from public.order_logistics_events'), '0/0');

  -- ================= logistics -> shared (derive) =================
  PERFORM pg_temp.expect('commercial cannot derive; logistics derives -> shared (changed)', left(pg_temp.derive('comm'), 9) || ' ' || pg_temp.derive('logi'), 'ERR:42501 shared/true');
  PERFORM pg_temp.expect('derive twice is idempotent (no second event)', pg_temp.derive('sup') || ' ' || pg_temp.events(), 'shared/false commercial>logistics:order_confirmed | logistics>shared:derived_to_commercial');
  PERFORM pg_temp.expect('shared stage: comm yes, logistics yes, supervisor yes, no-area no', pg_temp.matrix(), 'true/true/true/false');
  PERFORM pg_temp.expect('shared grants Commercial NO logistic permission (PR-04 rows stay invisible)',
    pg_temp.run('comm', 'select count(*) from public.order_documents') || '/' || pg_temp.run('comm', 'select count(*) from public.order_logistics') || '/' || pg_temp.run('logi', 'select count(*) from public.order_logistics'), '0/0/1');
  PERFORM pg_temp.expect('shared: Commercial cannot operate PR-04 either (RPC refuses it)', pg_temp.rpc(format('select public.start_order_packaging(%L,%L,%L)', pg_temp.uid('acc'), pg_temp.uid('comm'), o1))->>'err', '42501:forbidden');

  -- ================= shared -> logistics (second order) =================
  o2 := pg_temp.confirm('cmp-o2');
  PERFORM pg_temp.expect('a new order brings the chat back to logistics (PR-03 rule), with the PR-04 order of the first one untouched', pg_temp.stage() || ' ' || pg_temp.matrix() || ' ' || pg_temp.events(),
    'logistics/v3 false/true/true/false commercial>logistics:order_confirmed | logistics>shared:derived_to_commercial | shared>logistics:order_confirmed');
  PERFORM pg_temp.expect('both orders keep their own, independent logistic state', (SELECT string_agg(status, ',' ORDER BY updated_at) FROM public.order_logistics WHERE order_id IN (o1, o2)) || '/' || (SELECT count(*)::text FROM public.order_logistics WHERE order_id = o2), 'packing/0');

  -- ================= same conversation, same history =================
  PERFORM pg_temp.expect('one conversation, its messages intact (no chat duplicated by PR-04)',
    (SELECT count(*)::text FROM conversations WHERE contact_id = pg_temp.uid('contact')) || '/' || (SELECT count(*)::text FROM messages WHERE conversation_id = pg_temp.uid('conv')), '1/2');
END $$;

ROLLBACK;
