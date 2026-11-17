-- Behaviour test for 20261128000000_conversation_routing.sql (explicit routing: commercial / logistics / shared).
-- Run against a database that already has ALL migrations applied:  psql -v ON_ERROR_STOP=1 -f supabase/ci/conversation-routing-test.sql
-- One transaction that ends in ROLLBACK, synthetic users/accounts only: nothing persists, no existing row is touched.
BEGIN;

CREATE TEMP TABLE ids (k text PRIMARY KEY, v uuid NOT NULL);

DO $$
DECLARE kk text; u uuid; acc uuid; acc_f uuid; c uuid; conv uuid;
BEGIN
  FOREACH kk IN ARRAY ARRAY['owner','sup','comm','logi','none','foreign'] LOOP
    u := gen_random_uuid();
    INSERT INTO auth.users (id, email) VALUES (u, 'rtg-' || kk || '@example.invalid');
    INSERT INTO ids VALUES (kk, u);
  END LOOP;
  SELECT account_id INTO acc   FROM profiles WHERE user_id = (SELECT v FROM ids WHERE k = 'owner');
  SELECT account_id INTO acc_f FROM profiles WHERE user_id = (SELECT v FROM ids WHERE k = 'foreign');
  INSERT INTO ids VALUES ('acc', acc), ('acc_f', acc_f);
  UPDATE profiles SET account_id = acc, account_role = 'agent' WHERE user_id IN (SELECT v FROM ids WHERE k IN ('sup','comm','logi','none'));
  UPDATE profiles SET operational_role = 'supervisor' WHERE user_id = (SELECT v FROM ids WHERE k = 'sup');
  UPDATE profiles SET operational_role = 'commercial' WHERE user_id = (SELECT v FROM ids WHERE k = 'comm');
  UPDATE profiles SET operational_role = 'logistics'  WHERE user_id = (SELECT v FROM ids WHERE k = 'logi');
  UPDATE profiles SET operational_role = 'supervisor' WHERE user_id = (SELECT v FROM ids WHERE k = 'foreign');
  INSERT INTO order_integration_settings (account_id, confirm_enabled, logistics_mvp_enabled) VALUES (acc, TRUE, TRUE), (acc_f, TRUE, TRUE)
    ON CONFLICT (account_id) DO UPDATE SET confirm_enabled = TRUE, logistics_mvp_enabled = TRUE;

  -- Conversations: c_new (will go commercial -> logistics), c_shared (logistics -> shared -> logistics), c_comm (stays commercial), c_other (other account)
  FOREACH kk IN ARRAY ARRAY['new','shared','comm','other'] LOOP
    c := gen_random_uuid(); conv := gen_random_uuid();
    INSERT INTO contacts (id, user_id, account_id, phone, name)
      VALUES (c, (SELECT v FROM ids WHERE k = CASE WHEN kk = 'other' THEN 'foreign' ELSE 'owner' END), CASE WHEN kk = 'other' THEN acc_f ELSE acc END, '5198' || floor(random()*1e8)::int, 'RTG ' || kk);
    INSERT INTO conversations (id, user_id, account_id, contact_id)
      VALUES (conv, (SELECT v FROM ids WHERE k = CASE WHEN kk = 'other' THEN 'foreign' ELSE 'owner' END), CASE WHEN kk = 'other' THEN acc_f ELSE acc END, c);
    INSERT INTO ids VALUES ('conv_' || kk, conv), ('contact_' || kk, c);
    INSERT INTO messages (conversation_id, sender_type, content_type, content_text) VALUES (conv, 'customer', 'text', 'hola ' || kk), (conv, 'agent', 'text', 'respuesta ' || kk);
  END LOOP;
END $$;

CREATE FUNCTION pg_temp.uid(p text) RETURNS uuid LANGUAGE sql AS $$ SELECT v FROM ids WHERE k = p $$;

CREATE FUNCTION pg_temp.run(p_caller text, p_sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE c uuid := pg_temp.uid(p_caller); r text; n bigint;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', c, 'role', 'authenticated')::text, TRUE);
  PERFORM set_config('request.jwt.claim.sub', c::text, TRUE);
  SET LOCAL ROLE authenticated;
  BEGIN
    IF p_sql ILIKE 'select%' THEN
      EXECUTE p_sql INTO r;
    ELSIF p_sql ILIKE 'update%' OR p_sql ILIKE 'delete%' THEN
      EXECUTE p_sql; GET DIAGNOSTICS n = ROW_COUNT; r := n::text;
    ELSE
      EXECUTE p_sql; r := 'OK';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    r := 'ERR:' || SQLSTATE || ':' || SQLERRM;
  END;
  RESET ROLE;
  RETURN r;
END $$;

CREATE FUNCTION pg_temp.expect(p_name text, p_actual text, p_expected text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_actual IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'FAIL %: got [%] expected [%]', p_name, p_actual, p_expected; END IF;
  RAISE NOTICE 'PASS %', p_name;
END $$;

-- [conversations visible, messages visible, rows updated, insert result] for one role against one conversation
CREATE FUNCTION pg_temp.probe(p_caller text, p_conv text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE conv text := pg_temp.uid(p_conv)::text;
BEGIN
  RETURN concat_ws('/',
    pg_temp.run(p_caller, 'select count(*) from public.conversations where id = ' || quote_literal(conv)),
    pg_temp.run(p_caller, 'select count(*) from public.messages where content_text is distinct from ''x'' and conversation_id = ' || quote_literal(conv)),
    pg_temp.run(p_caller, 'update public.conversations set unread_count = 0 where id = ' || quote_literal(conv)),
    CASE WHEN pg_temp.run(p_caller, 'insert into public.messages (conversation_id, sender_type, content_type, content_text) values (' || quote_literal(conv) || ', ''agent'', ''text'', ''x'')') = 'OK' THEN 'OK' ELSE 'ERR' END);
END $$;

-- Confirms an order through the REAL function (service-role path). Returns the order id.
CREATE FUNCTION pg_temp.confirm(p_conv text, p_key text, p_price text DEFAULT '10.00') RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE r uuid;
BEGIN
  SELECT x.order_id INTO r FROM public.create_order_confirmation(
    pg_temp.uid('acc'), pg_temp.uid('contact_' || p_conv), pg_temp.uid('conv_' || p_conv), pg_temp.uid('comm'), 'Comercial QA', p_key, pg_temp.uid('comm'),
    jsonb_build_object('customer_name', 'RTG cliente', 'phone', '900000000', 'product', 'Prod', 'quantity', '1', 'price', p_price, 'destination', 'Lima')) x;
  RETURN r;
END $$;

CREATE FUNCTION pg_temp.stage(p_conv text) RETURNS text LANGUAGE sql AS $$
  SELECT COALESCE((SELECT stage || '/v' || version FROM public.conversation_routing WHERE conversation_id = pg_temp.uid('conv_' || p_conv)), 'none') $$;
CREATE FUNCTION pg_temp.events(p_conv text) RETURNS text LANGUAGE sql AS $$
  SELECT COALESCE(string_agg(from_stage || '>' || to_stage || ':' || reason, ' | ' ORDER BY created_at, id), '-') FROM public.conversation_routing_events WHERE conversation_id = pg_temp.uid('conv_' || p_conv) $$;
CREATE FUNCTION pg_temp.derive(p_caller text, p_conv text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE c uuid := pg_temp.uid(p_caller); conv uuid := pg_temp.uid(p_conv); r text;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', c, 'role', 'authenticated')::text, TRUE);
  PERFORM set_config('request.jwt.claim.sub', c::text, TRUE);
  SET LOCAL ROLE authenticated;
  BEGIN
    SELECT d.stage || '/' || d.changed INTO r FROM public.derive_conversation_to_commercial(conv) d;
  EXCEPTION WHEN OTHERS THEN
    r := 'ERR:' || SQLSTATE || ':' || SQLERRM;
  END;
  RESET ROLE;
  RETURN r;
END $$;

-- Backfill fixtures: orders inserted DIRECTLY (as they existed before this migration), no routing written for them.
CREATE FUNCTION pg_temp.backfill_setup() RETURNS void LANGUAGE plpgsql AS $$
DECLARE acc uuid := pg_temp.uid('acc'); acc_f uuid := pg_temp.uid('acc_f'); cv uuid; ct uuid; ow uuid := pg_temp.uid('owner'); fw uuid := pg_temp.uid('foreign'); r bigint; k text;
BEGIN
  -- chat WITH an order (flag-ON account), chat WITHOUT an order (flag-ON account), chat WITH an order in an account whose flag is OFF
  FOREACH k IN ARRAY ARRAY['bf_order','bf_plain','bf_off'] LOOP
    ct := gen_random_uuid(); cv := gen_random_uuid();
    INSERT INTO contacts (id, user_id, account_id, phone, name) VALUES (ct, CASE WHEN k = 'bf_off' THEN fw ELSE ow END, CASE WHEN k = 'bf_off' THEN acc_f ELSE acc END, '5197' || floor(random()*1e8)::int, 'RTG ' || k);
    INSERT INTO conversations (id, user_id, account_id, contact_id) VALUES (cv, CASE WHEN k = 'bf_off' THEN fw ELSE ow END, CASE WHEN k = 'bf_off' THEN acc_f ELSE acc END, ct);
    INSERT INTO ids VALUES ('conv_' || k, cv);
    IF k <> 'bf_plain' THEN
      INSERT INTO order_confirmations (account_id, conversation_id, customer_name, phone, product, quantity, price, destination, seller_name, confirmed_by_name, request_key, delivery_status)
        VALUES (CASE WHEN k = 'bf_off' THEN acc_f ELSE acc END, cv, 'BF', '900000000', 'Prod', 1, 10, 'Lima', 'Seller', 'Seller', 'RTG-' || k, 'held');
    END IF;
  END LOOP;
  UPDATE order_integration_settings SET logistics_mvp_enabled = FALSE WHERE account_id = acc_f;   -- the foreign account is the flag-OFF account here
  r := public.backfill_conversation_routing(NULL);
  PERFORM pg_temp.expect('backfill(all): only the flag-ON chat WITH an order got a row', r::text, '1');
  PERFORM pg_temp.expect('backfill: that chat is logistics v1 with one backfill event', pg_temp.stage('bf_order') || ' ' || pg_temp.events('bf_order'), 'logistics/v1 commercial>logistics:backfill');
  PERFORM pg_temp.expect('backfill: chat WITHOUT an order has NO row (= commercial)', pg_temp.stage('bf_plain'), 'none');
  PERFORM pg_temp.expect('backfill: flag-OFF account chat with an order has NO row', pg_temp.stage('bf_off'), 'none');
  PERFORM pg_temp.expect('backfill: no event for the skipped chats', (SELECT count(*)::text FROM conversation_routing_events WHERE conversation_id IN (pg_temp.uid('conv_bf_plain'), pg_temp.uid('conv_bf_off'))), '0');
  PERFORM pg_temp.expect('backfill is service-role only', (has_function_privilege('authenticated', 'public.backfill_conversation_routing(uuid)', 'EXECUTE') OR has_function_privilege('anon', 'public.backfill_conversation_routing(uuid)', 'EXECUTE'))::text || '/' || has_function_privilege('service_role', 'public.backfill_conversation_routing(uuid)', 'EXECUTE')::text, 'false/true');
  PERFORM pg_temp.expect('backfilled chat: commercial blocked, logistics open', pg_temp.probe('comm','conv_bf_order') || ' ' || pg_temp.probe('logi','conv_bf_order'), '0/0/0/ERR 1/0/1/OK');
  UPDATE order_integration_settings SET logistics_mvp_enabled = TRUE WHERE account_id = acc_f;
END $$;

DO $$
DECLARE
  OPEN_ text := '1/2/1/OK'; BLOCK text := '0/0/0/ERR'; o1 uuid; o2 uuid; o3 uuid; n int;
BEGIN
  -- ================= MODEL: absence of a row = commercial =================
  PERFORM pg_temp.expect('no row for a conversation without an order', pg_temp.stage('comm'), 'none');
  PERFORM pg_temp.expect('backfill did not create rows for unrelated conversations', (SELECT count(*)::text FROM conversation_routing WHERE conversation_id IN (pg_temp.uid('conv_comm'), pg_temp.uid('conv_new'))), '0');

  -- ================= FLAG ON: matrix per stage =================
  -- stage commercial (no row)
  PERFORM pg_temp.expect('commercial stage: commercial YES', pg_temp.probe('comm','conv_comm'), OPEN_);
  PERFORM pg_temp.expect('commercial stage: logistics NO',   pg_temp.probe('logi','conv_comm'), BLOCK);
  PERFORM pg_temp.expect('commercial stage: supervisor YES', pg_temp.probe('sup','conv_comm'), OPEN_);
  PERFORM pg_temp.expect('commercial stage: area NULL NO',   pg_temp.probe('none','conv_comm'), BLOCK);
  PERFORM pg_temp.expect('commercial stage: owner without area NO', pg_temp.probe('owner','conv_comm'), BLOCK);
  PERFORM pg_temp.expect('commercial stage: cross-account NO', pg_temp.probe('foreign','conv_comm'), BLOCK);

  -- ================= TRANSITION 1: commercial -> logistics, atomically with the order =================
  o1 := pg_temp.confirm('new', 'RTG-1');
  PERFORM pg_temp.expect('order 1 created', (o1 IS NOT NULL)::text, 'true');
  PERFORM pg_temp.expect('routing row created as logistics v1', pg_temp.stage('new'), 'logistics/v1');
  PERFORM pg_temp.expect('event recorded with order id and actor', (SELECT (order_id = o1 AND actor_user_id = pg_temp.uid('comm') AND actor_name = 'Comercial QA' AND from_stage = 'commercial' AND reason = 'order_confirmed')::text FROM conversation_routing_events WHERE conversation_id = pg_temp.uid('conv_new')), 'true');
  PERFORM pg_temp.expect('logistics stage: commercial NO', pg_temp.probe('comm','conv_new'), BLOCK);
  PERFORM pg_temp.expect('logistics stage: logistics YES (same conversation, full history)', pg_temp.probe('logi','conv_new'), OPEN_);
  PERFORM pg_temp.expect('logistics stage: supervisor YES', pg_temp.probe('sup','conv_new'), OPEN_);
  PERFORM pg_temp.expect('logistics stage: area NULL NO', pg_temp.probe('none','conv_new'), BLOCK);
  PERFORM pg_temp.expect('logistics stage: owner without area NO', pg_temp.probe('owner','conv_new'), BLOCK);
  PERFORM pg_temp.expect('logistics stage: cross-account NO', pg_temp.probe('foreign','conv_new'), BLOCK);

  -- idempotent retry of the SAME request_key: no second order, no second transition
  PERFORM pg_temp.expect('retry same request_key returns the same order', (pg_temp.confirm('new', 'RTG-1') = o1)::text, 'true');
  PERFORM pg_temp.expect('retry did not change routing or events', pg_temp.stage('new') || ' ' || pg_temp.events('new'), 'logistics/v1 commercial>logistics:order_confirmed');
  -- another order while already logistics: no transition, no event
  o2 := pg_temp.confirm('new', 'RTG-2');
  PERFORM pg_temp.expect('2nd order on a logistics chat: stays logistics, no new event', pg_temp.stage('new') || ' ' || pg_temp.events('new'), 'logistics/v1 commercial>logistics:order_confirmed');

  -- ================= FAILED order: routing does NOT change =================
  BEGIN
    PERFORM pg_temp.confirm('comm', 'RTG-BAD', '0.00');         -- price check violation AFTER no row was inserted -> whole call aborts
    RAISE EXCEPTION 'expected the invalid order to fail';
  EXCEPTION WHEN check_violation OR raise_exception THEN
    IF SQLERRM LIKE 'expected%' THEN RAISE; END IF;
  END;
  PERFORM pg_temp.expect('failed order: no routing row', pg_temp.stage('comm'), 'none');
  PERFORM pg_temp.expect('failed order: commercial keeps the chat', pg_temp.probe('comm','conv_comm'), OPEN_);
  PERFORM pg_temp.expect('failed order: logistics does not get it', pg_temp.probe('logi','conv_comm'), BLOCK);

  -- ================= DERIVE: logistics -> shared (Pedido 1 stays with Logistica) =================
  o3 := pg_temp.confirm('shared', 'RTG-S1');
  PERFORM pg_temp.expect('derive: supervisor/logistics start from logistics', pg_temp.stage('shared'), 'logistics/v1');
  PERFORM pg_temp.expect('commercial cannot derive', left(pg_temp.derive('comm','conv_shared'), 18), 'ERR:42501:Only log');
  PERFORM pg_temp.expect('area NULL cannot derive', left(pg_temp.derive('none','conv_shared'), 9), 'ERR:42501');
  PERFORM pg_temp.expect('owner without area cannot derive', left(pg_temp.derive('owner','conv_shared'), 9), 'ERR:42501');
  PERFORM pg_temp.expect('cross-account cannot derive', pg_temp.derive('foreign','conv_shared'), 'ERR:42501:conversation_not_accessible');
  PERFORM pg_temp.expect('derive of a commercial conversation is rejected', pg_temp.derive('logi','conv_comm'), 'ERR:22023:invalid_transition');
  PERFORM pg_temp.expect('  (supervisor too)', pg_temp.derive('sup','conv_comm'), 'ERR:22023:invalid_transition');
  PERFORM pg_temp.expect('logistics derives: shared (changed)', pg_temp.derive('logi','conv_shared'), 'shared/true');
  PERFORM pg_temp.expect('stage shared v2 + event with actor', pg_temp.stage('shared'), 'shared/v2');
  PERFORM pg_temp.expect('derive event shape', (SELECT (actor_user_id = pg_temp.uid('logi') AND from_stage = 'logistics' AND to_stage = 'shared' AND order_id IS NULL AND actor_name <> '')::text FROM conversation_routing_events WHERE conversation_id = pg_temp.uid('conv_shared') AND reason = 'derived_to_commercial'), 'true');
  PERFORM pg_temp.expect('derive again: idempotent (shared / not changed)', pg_temp.derive('logi','conv_shared'), 'shared/false');
  PERFORM pg_temp.expect('supervisor derive on shared: idempotent too', pg_temp.derive('sup','conv_shared'), 'shared/false');
  PERFORM pg_temp.expect('no duplicate event, version unchanged', pg_temp.stage('shared') || ' ' || pg_temp.events('shared'), 'shared/v2 commercial>logistics:order_confirmed | logistics>shared:derived_to_commercial');
  PERFORM pg_temp.expect('derive did not touch the order', (SELECT count(*)::text FROM order_confirmations WHERE id = o3 AND delivery_status = 'held'), '1');
  PERFORM pg_temp.expect('derive did not touch messages', (SELECT count(*)::text FROM messages WHERE conversation_id = pg_temp.uid('conv_shared')), '2');

  -- shared stage matrix
  PERFORM pg_temp.expect('shared stage: commercial YES', pg_temp.probe('comm','conv_shared'), OPEN_);
  PERFORM pg_temp.expect('shared stage: logistics YES (keeps managing the first order)', pg_temp.probe('logi','conv_shared'), OPEN_);
  PERFORM pg_temp.expect('shared stage: supervisor YES', pg_temp.probe('sup','conv_shared'), OPEN_);
  PERFORM pg_temp.expect('shared stage: area NULL NO', pg_temp.probe('none','conv_shared'), BLOCK);
  PERFORM pg_temp.expect('shared stage: owner without area NO', pg_temp.probe('owner','conv_shared'), BLOCK);
  PERFORM pg_temp.expect('shared stage: cross-account NO', pg_temp.probe('foreign','conv_shared'), BLOCK);

  -- ================= TRANSITION 2: shared -> logistics at the second order =================
  o2 := pg_temp.confirm('shared', 'RTG-S2');
  PERFORM pg_temp.expect('2nd order on a shared chat: back to logistics v3', pg_temp.stage('shared'), 'logistics/v3');
  PERFORM pg_temp.expect('events: order, derive, order (2nd carries the 2nd order id)', pg_temp.events('shared'), 'commercial>logistics:order_confirmed | logistics>shared:derived_to_commercial | shared>logistics:order_confirmed');
  PERFORM pg_temp.expect('last event points to order 2', (SELECT (order_id = o2)::text FROM conversation_routing_events WHERE conversation_id = pg_temp.uid('conv_shared') AND from_stage = 'shared'), 'true');
  PERFORM pg_temp.expect('both orders still exist on the same conversation', (SELECT count(*)::text FROM order_confirmations WHERE conversation_id = pg_temp.uid('conv_shared')), '2');
  PERFORM pg_temp.expect('commercial lost access again', pg_temp.probe('comm','conv_shared'), BLOCK);
  PERFORM pg_temp.expect('logistics continues', pg_temp.probe('logi','conv_shared'), OPEN_);
  PERFORM pg_temp.expect('supervisor continues', pg_temp.probe('sup','conv_shared'), OPEN_);

  -- ================= browsers cannot write routing or events; events are immutable =================
  PERFORM pg_temp.expect('authenticated cannot UPDATE routing', left(pg_temp.run('sup', 'update public.conversation_routing set stage = ''commercial'''), 7), 'ERR:425');
  PERFORM pg_temp.expect('authenticated cannot INSERT routing', left(pg_temp.run('sup', 'insert into public.conversation_routing (conversation_id, account_id, stage) select id, account_id, ''shared'' from public.conversations limit 1'), 7), 'ERR:425');
  PERFORM pg_temp.expect('authenticated cannot DELETE routing', left(pg_temp.run('sup', 'delete from public.conversation_routing'), 7), 'ERR:425');
  PERFORM pg_temp.expect('authenticated cannot INSERT events', left(pg_temp.run('sup', 'insert into public.conversation_routing_events (account_id, conversation_id, from_stage, to_stage, reason, actor_name) values (gen_random_uuid(), gen_random_uuid(), ''logistics'', ''shared'', ''derived_to_commercial'', ''x'')'), 7), 'ERR:425');
  PERFORM pg_temp.expect('authenticated cannot UPDATE events', left(pg_temp.run('sup', 'update public.conversation_routing_events set reason = ''backfill'''), 7), 'ERR:425');
  PERFORM pg_temp.expect('authenticated cannot DELETE events', left(pg_temp.run('sup', 'delete from public.conversation_routing_events'), 7), 'ERR:425');
  BEGIN UPDATE conversation_routing_events SET actor_name = 'tamper'; RAISE EXCEPTION 'expected failure';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS even the owner cannot UPDATE events (trigger)'; END;
  BEGIN DELETE FROM conversation_routing_events WHERE conversation_id = pg_temp.uid('conv_shared'); RAISE EXCEPTION 'expected failure';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS even the owner cannot DELETE events while the conversation exists (trigger)'; END;

  -- reads: routing/events follow the conversation policy
  PERFORM pg_temp.expect('logistics reads routing of its chat', pg_temp.run('logi', 'select stage from public.conversation_routing where conversation_id = ' || quote_literal(pg_temp.uid('conv_shared'))), 'logistics');
  PERFORM pg_temp.expect('commercial reads NO routing of a logistics chat', pg_temp.run('comm', 'select count(*) from public.conversation_routing where conversation_id = ' || quote_literal(pg_temp.uid('conv_shared'))), '0');
  PERFORM pg_temp.expect('cross-account reads no routing', pg_temp.run('foreign', 'select count(*) from public.conversation_routing'), '0');
  PERFORM pg_temp.expect('supervisor reads the 3 events of the chat', pg_temp.run('sup', 'select count(*) from public.conversation_routing_events where conversation_id = ' || quote_literal(pg_temp.uid('conv_shared'))), '3');

  -- ================= owner + supervisor, viewer =================
  UPDATE profiles SET operational_role = 'supervisor' WHERE user_id = pg_temp.uid('owner');
  PERFORM pg_temp.expect('owner who is also supervisor: full access (commercial chat)', pg_temp.probe('owner','conv_comm'), OPEN_);
  PERFORM pg_temp.expect('owner who is also supervisor: full access (logistics chat)', pg_temp.probe('owner','conv_new'), OPEN_);
  UPDATE profiles SET operational_role = NULL WHERE user_id = pg_temp.uid('owner');
  PERFORM pg_temp.expect('owner back to no area: blocked again (no bypass)', pg_temp.probe('owner','conv_new'), BLOCK);
  UPDATE profiles SET account_role = 'viewer' WHERE user_id = pg_temp.uid('logi');
  PERFORM pg_temp.expect('a viewer with area logistics cannot derive', left(pg_temp.derive('logi','conv_new'), 9), 'ERR:42501');
  UPDATE profiles SET account_role = 'agent' WHERE user_id = pg_temp.uid('logi');

  -- ================= BACKFILL: only flag-ON accounts, only chats WITH an order =================
  PERFORM pg_temp.backfill_setup();

  -- ================= FLAG OFF: exactly the legacy behaviour =================
  UPDATE order_integration_settings SET logistics_mvp_enabled = FALSE WHERE account_id = pg_temp.uid('acc');
  PERFORM pg_temp.expect('OFF commercial + logistics chat (legacy: open)', pg_temp.probe('comm','conv_shared'), OPEN_);
  PERFORM pg_temp.expect('OFF logistics + commercial chat (legacy: open)', pg_temp.probe('logi','conv_comm'), OPEN_);
  PERFORM pg_temp.expect('OFF area NULL (legacy: open)', pg_temp.probe('none','conv_shared'), OPEN_);
  PERFORM pg_temp.expect('OFF owner (legacy: open)', pg_temp.probe('owner','conv_new'), OPEN_);
  PERFORM pg_temp.expect('OFF cross-account stays blocked', pg_temp.probe('foreign','conv_shared'), BLOCK);
  PERFORM pg_temp.expect('OFF derive is refused', pg_temp.derive('logi','conv_shared'), 'ERR:42501:operational_roles_disabled');
  o1 := pg_temp.confirm('comm', 'RTG-OFF');
  PERFORM pg_temp.expect('OFF: an order writes NO routing and NO event (exact legacy)', pg_temp.stage('comm') || ' ' || pg_temp.events('comm'), 'none -');
  PERFORM pg_temp.expect('OFF: the order itself was created', (SELECT count(*)::text FROM order_confirmations WHERE id = o1), '1');
  UPDATE order_integration_settings SET logistics_mvp_enabled = TRUE WHERE account_id = pg_temp.uid('acc');
  -- Enabling the flag later: the per-account backfill brings the OFF-time order into logistics (once), nothing else changes.
  PERFORM pg_temp.expect('before the backfill the OFF-time order chat is still commercial (no row)', pg_temp.stage('comm'), 'none');
  PERFORM pg_temp.expect('backfill(account) creates exactly that row', public.backfill_conversation_routing(pg_temp.uid('acc'))::text, '1');
  PERFORM pg_temp.expect('backfilled: logistics v1 + one backfill event with the order id', pg_temp.stage('comm') || ' ' || pg_temp.events('comm') || ' ' || (SELECT (order_id = o1)::text FROM conversation_routing_events WHERE conversation_id = pg_temp.uid('conv_comm')), 'logistics/v1 commercial>logistics:backfill true');
  PERFORM pg_temp.expect('backfill again: idempotent (0 rows, still 1 event)', public.backfill_conversation_routing(pg_temp.uid('acc'))::text || '/' || (SELECT count(*)::text FROM conversation_routing_events WHERE conversation_id = pg_temp.uid('conv_comm')), '0/1');
  PERFORM pg_temp.expect('backfill NULL (all accounts): the account whose flag was turned ON meanwhile is now picked up (1), then idempotent (0)', public.backfill_conversation_routing(NULL)::text || '/' || public.backfill_conversation_routing(NULL)::text, '1/0');

  -- ================= cascade: deleting a conversation removes its routing and events =================
  DELETE FROM conversations WHERE id = pg_temp.uid('conv_comm');
  PERFORM pg_temp.expect('deleting a conversation cascades routing + events (immutability guard allows it)', (SELECT count(*)::text FROM conversation_routing WHERE conversation_id = pg_temp.uid('conv_comm')) || '/' || (SELECT count(*)::text FROM conversation_routing_events WHERE conversation_id = pg_temp.uid('conv_comm')), '0/0');

  -- ================= catalog =================
  PERFORM pg_temp.expect('derive RPC: SECURITY DEFINER, postgres, pinned search_path, no PUBLIC/anon', (SELECT prosecdef::text || '/' || pg_get_userbyid(proowner) || '/' || array_to_string(proconfig, ',') || '/' || (NOT EXISTS (SELECT 1 FROM aclexplode(proacl) a WHERE a.grantee = 0))::text || '/' || has_function_privilege('anon', oid, 'EXECUTE')::text FROM pg_proc WHERE oid = 'public.derive_conversation_to_commercial(uuid)'::regprocedure), 'true/postgres/search_path=public/true/false');
  PERFORM pg_temp.expect('apply_order_confirmed_routing: only service_role', (has_function_privilege('authenticated', 'public.apply_order_confirmed_routing(uuid,uuid,uuid,text,uuid)', 'EXECUTE') OR has_function_privilege('anon', 'public.apply_order_confirmed_routing(uuid,uuid,uuid,text,uuid)', 'EXECUTE'))::text || '/' || has_function_privilege('service_role', 'public.apply_order_confirmed_routing(uuid,uuid,uuid,text,uuid)', 'EXECUTE')::text, 'false/true');
  PERFORM pg_temp.expect('create_order_confirmation ACL unchanged (not callable by browsers)', (has_function_privilege('authenticated', 'public.create_order_confirmation(uuid,uuid,uuid,uuid,text,text,uuid,jsonb)', 'EXECUTE') OR has_function_privilege('anon', 'public.create_order_confirmation(uuid,uuid,uuid,uuid,text,text,uuid,jsonb)', 'EXECUTE'))::text, 'false');
  RAISE NOTICE 'ALL CONVERSATION ROUTING CHECKS PASSED';
END $$;

ROLLBACK;
