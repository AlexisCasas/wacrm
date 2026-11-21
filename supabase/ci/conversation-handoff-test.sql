-- Behaviour test for the Inbox RLS of 20261204000001_conversation_handoff_rls.sql AS EVOLVED by 20261204000002_conversation_routing.sql:
-- the stage is now conversation_routing (not the mere existence of an order), so every order below also applies the order-confirmed routing
-- (exactly what create_order_confirmation does). The full routing matrix (shared, derive, audit) is in conversation-routing-test.sql.
-- Original description: 20261204000001_conversation_handoff_rls.sql (Comercial -> Logistica handoff enforced by RLS).
-- Run against a database that already has ALL migrations applied:  psql -v ON_ERROR_STOP=1 -f supabase/ci/conversation-handoff-test.sql
-- One transaction that ends in ROLLBACK, synthetic users/accounts only: nothing persists, no existing row is touched.
BEGIN;

CREATE TEMP TABLE ids (k text PRIMARY KEY, v uuid NOT NULL);

DO $$
DECLARE kk text; u uuid; acc uuid; acc_f uuid; c uuid; conv uuid; m uuid;
BEGIN
  FOREACH kk IN ARRAY ARRAY['owner','sup','comm','logi','none','foreign'] LOOP
    u := gen_random_uuid();
    INSERT INTO auth.users (id, email) VALUES (u, 'hnd-' || kk || '@example.invalid');
    INSERT INTO ids VALUES (kk, u);
  END LOOP;
  SELECT account_id INTO acc   FROM profiles WHERE user_id = (SELECT v FROM ids WHERE k = 'owner');
  SELECT account_id INTO acc_f FROM profiles WHERE user_id = (SELECT v FROM ids WHERE k = 'foreign');
  INSERT INTO ids VALUES ('acc', acc), ('acc_f', acc_f);
  UPDATE profiles SET account_id = acc, account_role = 'agent' WHERE user_id IN (SELECT v FROM ids WHERE k IN ('sup','comm','logi','none'));
  -- areas (owner has NO area on purpose: account_role alone must grant nothing). 'foreign' is supervisor of its OWN account.
  UPDATE profiles SET operational_role = 'supervisor' WHERE user_id = (SELECT v FROM ids WHERE k = 'sup');
  UPDATE profiles SET operational_role = 'commercial' WHERE user_id = (SELECT v FROM ids WHERE k = 'comm');
  UPDATE profiles SET operational_role = 'logistics'  WHERE user_id = (SELECT v FROM ids WHERE k = 'logi');
  UPDATE profiles SET operational_role = 'supervisor' WHERE user_id = (SELECT v FROM ids WHERE k = 'foreign');
  INSERT INTO order_integration_settings (account_id, logistics_mvp_enabled) VALUES (acc, TRUE), (acc_f, TRUE)
    ON CONFLICT (account_id) DO UPDATE SET logistics_mvp_enabled = TRUE;

  -- PRE (no order) and POST (with a confirmed order) conversations, 2 messages each, 1 reaction each; plus a conversation of the other account.
  FOREACH kk IN ARRAY ARRAY['pre','post','other'] LOOP
    c := gen_random_uuid(); conv := gen_random_uuid();
    INSERT INTO contacts (id, user_id, account_id, phone, name)
      VALUES (c, (SELECT v FROM ids WHERE k = CASE WHEN kk = 'other' THEN 'foreign' ELSE 'owner' END), CASE WHEN kk = 'other' THEN acc_f ELSE acc END, '5199' || floor(random()*1e8)::int, 'HND ' || kk);
    INSERT INTO conversations (id, user_id, account_id, contact_id)
      VALUES (conv, (SELECT v FROM ids WHERE k = CASE WHEN kk = 'other' THEN 'foreign' ELSE 'owner' END), CASE WHEN kk = 'other' THEN acc_f ELSE acc END, c);
    INSERT INTO ids VALUES ('conv_' || kk, conv);
    INSERT INTO messages (conversation_id, sender_type, content_type, content_text) VALUES (conv, 'customer', 'text', 'hola ' || kk), (conv, 'agent', 'text', 'respuesta comercial ' || kk);
    SELECT id INTO m FROM messages WHERE conversation_id = conv ORDER BY created_at LIMIT 1;
    INSERT INTO message_reactions (message_id, conversation_id, actor_type, emoji) VALUES (m, conv, 'customer', 'x');
  END LOOP;
  INSERT INTO order_confirmations (account_id, conversation_id, customer_name, phone, product, quantity, price, destination, seller_name, confirmed_by_name, request_key, delivery_status)
    VALUES (acc, (SELECT v FROM ids WHERE k = 'conv_post'), 'HND cliente', '900000000', 'Prod', 1, 10, 'Lima', 'Seller', 'Seller', 'HND-ORDER-1', 'held');
  PERFORM public.apply_order_confirmed_routing(acc, (SELECT v FROM ids WHERE k = 'conv_post'), NULL, 'HND', (SELECT id FROM order_confirmations WHERE request_key = 'HND-ORDER-1'));
END $$;

CREATE FUNCTION pg_temp.uid(p text) RETURNS uuid LANGUAGE sql AS $$ SELECT v FROM ids WHERE k = p $$;

-- Runs one statement as `p_caller` (role authenticated) and returns: the count of rows (SELECT count), the affected rows (UPDATE) or OK/SQLSTATE (INSERT).
CREATE FUNCTION pg_temp.run(p_caller text, p_sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE c uuid := pg_temp.uid(p_caller); r text; n bigint;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', c, 'role', 'authenticated')::text, TRUE);
  PERFORM set_config('request.jwt.claim.sub', c::text, TRUE);
  SET LOCAL ROLE authenticated;
  BEGIN
    IF p_sql ILIKE 'select%' THEN
      EXECUTE p_sql INTO n; r := n::text;
    ELSIF p_sql ILIKE 'update%' OR p_sql ILIKE 'delete%' THEN
      EXECUTE p_sql; GET DIAGNOSTICS n = ROW_COUNT; r := n::text;
    ELSE
      EXECUTE p_sql; r := 'OK';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    r := 'ERR:' || SQLSTATE;
  END;
  RESET ROLE;
  RETURN r;
END $$;

CREATE FUNCTION pg_temp.expect(p_name text, p_actual text, p_expected text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_actual IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'FAIL %: got [%] expected [%]', p_name, p_actual, p_expected; END IF;
  RAISE NOTICE 'PASS %', p_name;
END $$;

-- One role against one conversation: [conversations visible, messages visible, reactions visible, rows updated, insert result]
CREATE FUNCTION pg_temp.probe(p_caller text, p_conv text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE conv text := pg_temp.uid(p_conv)::text;
BEGIN
  RETURN concat_ws('/',
    pg_temp.run(p_caller, 'select count(*) from public.conversations where id = ' || quote_literal(conv)),
    pg_temp.run(p_caller, 'select count(*) from public.messages where content_text is distinct from ''x'' and conversation_id = ' || quote_literal(conv)),
    pg_temp.run(p_caller, 'select count(*) from public.message_reactions where conversation_id = ' || quote_literal(conv)),
    pg_temp.run(p_caller, 'update public.conversations set unread_count = 0 where id = ' || quote_literal(conv)),
    pg_temp.run(p_caller, 'insert into public.messages (conversation_id, sender_type, content_type, content_text) values (' || quote_literal(conv) || ', ''agent'', ''text'', ''x'')'));
END $$;

DO $$
DECLARE OPEN_ text := '1/2/1/1/OK'; BLOCK text := '0/0/0/0/ERR:42501';
BEGIN
  -- ================= FLAG ON =================
  PERFORM pg_temp.expect('ON  commercial + PRE  -> list/open/read/react/update/send', pg_temp.probe('comm','conv_pre'), OPEN_);
  PERFORM pg_temp.expect('ON  commercial + POST -> blocked everywhere', pg_temp.probe('comm','conv_post'), BLOCK);
  PERFORM pg_temp.expect('ON  logistics  + PRE  -> blocked everywhere', pg_temp.probe('logi','conv_pre'), BLOCK);
  PERFORM pg_temp.expect('ON  logistics  + POST -> full history (2 msgs), react, update, send', pg_temp.probe('logi','conv_post'), OPEN_);
  PERFORM pg_temp.expect('ON  supervisor + PRE', pg_temp.probe('sup','conv_pre'), OPEN_);
  PERFORM pg_temp.expect('ON  supervisor + POST', pg_temp.probe('sup','conv_post'), OPEN_);
  PERFORM pg_temp.expect('ON  area NULL (agent) + PRE  -> blocked', pg_temp.probe('none','conv_pre'), BLOCK);
  PERFORM pg_temp.expect('ON  area NULL (agent) + POST -> blocked', pg_temp.probe('none','conv_post'), BLOCK);
  PERFORM pg_temp.expect('ON  owner WITHOUT area + PRE  -> blocked (account_role grants nothing)', pg_temp.probe('owner','conv_pre'), BLOCK);
  PERFORM pg_temp.expect('ON  owner WITHOUT area + POST -> blocked', pg_temp.probe('owner','conv_post'), BLOCK);
  PERFORM pg_temp.expect('ON  cross-account (supervisor of ANOTHER account) PRE', pg_temp.probe('foreign','conv_pre'), BLOCK);
  PERFORM pg_temp.expect('ON  cross-account POST', pg_temp.probe('foreign','conv_post'), BLOCK);
  PERFORM pg_temp.expect('ON  own account still works for the foreign supervisor', pg_temp.probe('foreign','conv_other'), OPEN_);
  PERFORM pg_temp.expect('ON  commercial cannot reach the other account', pg_temp.probe('comm','conv_other'), BLOCK);

  -- logistics reads the messages that commercial wrote (history is not copied or modified)
  PERFORM pg_temp.expect('ON  logistics reads the commercial reply', pg_temp.run('logi', 'select count(*) from public.messages where conversation_id = ' || quote_literal(pg_temp.uid('conv_post')) || ' and content_text like ''respuesta comercial%'''), '1');

  -- ================= HANDOFF happens when the order is persisted, and only then =================
  PERFORM pg_temp.expect('handoff: before the order, commercial works the PRE conversation', pg_temp.probe('comm','conv_pre'), OPEN_);
  INSERT INTO order_confirmations (account_id, conversation_id, customer_name, phone, product, quantity, price, destination, seller_name, confirmed_by_name, request_key, delivery_status)
    VALUES (pg_temp.uid('acc'), pg_temp.uid('conv_pre'), 'HND cliente 2', '900000000', 'Prod', 1, 10, 'Lima', 'Seller', 'Seller', 'HND-ORDER-2', 'held');
  PERFORM public.apply_order_confirmed_routing(pg_temp.uid('acc'), pg_temp.uid('conv_pre'), NULL, 'HND', (SELECT id FROM order_confirmations WHERE request_key = 'HND-ORDER-2'));
  PERFORM pg_temp.expect('handoff: after the order, commercial loses it (same conversation_id)', pg_temp.probe('comm','conv_pre'), BLOCK);
  PERFORM pg_temp.expect('handoff: after the order, logistics gets it with the whole history', pg_temp.probe('logi','conv_pre'), OPEN_);
  INSERT INTO messages (conversation_id, sender_type, content_type, content_text) VALUES (pg_temp.uid('conv_pre'), 'customer', 'text', 'el cliente vuelve a escribir');
  PERFORM pg_temp.expect('the customer writes again: still logistics (3 msgs), never back to commercial', pg_temp.run('logi', 'select count(*) from public.messages where content_text is distinct from ''x'' and conversation_id = ' || quote_literal(pg_temp.uid('conv_pre'))), '3');
  PERFORM pg_temp.expect('the customer writes again: commercial still sees nothing', pg_temp.run('comm', 'select count(*) from public.messages where content_text is distinct from ''x'' and conversation_id = ' || quote_literal(pg_temp.uid('conv_pre'))), '0');
  -- (a failed confirmation leaves no order and no routing change: covered in conversation-routing-test.sql with the real create_order_confirmation)

  -- ================= FLAG OFF: exactly the legacy behaviour =================
  UPDATE order_integration_settings SET logistics_mvp_enabled = FALSE WHERE account_id = pg_temp.uid('acc');
  PERFORM pg_temp.expect('OFF commercial + PRE  (legacy)', pg_temp.probe('comm','conv_pre'), '1/3/1/1/OK');
  PERFORM pg_temp.expect('OFF commercial + POST (legacy)', pg_temp.probe('comm','conv_post'), OPEN_);
  PERFORM pg_temp.expect('OFF logistics  + PRE  (legacy)', pg_temp.probe('logi','conv_pre'), '1/3/1/1/OK');
  PERFORM pg_temp.expect('OFF area NULL  + POST (legacy)', pg_temp.probe('none','conv_post'), OPEN_);
  PERFORM pg_temp.expect('OFF owner      + POST (legacy)', pg_temp.probe('owner','conv_post'), OPEN_);
  PERFORM pg_temp.expect('OFF cross-account stays blocked', pg_temp.probe('foreign','conv_post'), BLOCK);
  UPDATE order_integration_settings SET logistics_mvp_enabled = TRUE WHERE account_id = pg_temp.uid('acc');

  -- ================= signed-out / catalog =================
  PERFORM set_config('request.jwt.claims', '', TRUE);
  PERFORM set_config('request.jwt.claim.sub', '', TRUE);
  PERFORM set_config('hnd.acc', pg_temp.uid('acc')::text, TRUE);
  PERFORM set_config('hnd.pre', pg_temp.uid('conv_pre')::text, TRUE);
  SET LOCAL ROLE anon;
  PERFORM pg_temp.expect('anon: no conversation rows and no permission error', (SELECT count(*)::text FROM public.conversations), '0');
  PERFORM pg_temp.expect('anon: helper answers FALSE', public.conversation_operational_access(current_setting('hnd.acc')::uuid, current_setting('hnd.pre')::uuid)::text, 'false');
  RESET ROLE;
  PERFORM pg_temp.expect('helper: SECURITY DEFINER, owner postgres, pinned search_path', (SELECT prosecdef::text || '/' || pg_get_userbyid(proowner) || '/' || array_to_string(proconfig, ',') FROM pg_proc WHERE oid = 'public.conversation_operational_access(uuid, uuid)'::regprocedure), 'true/postgres/search_path=public');
  PERFORM pg_temp.expect('helper: PUBLIC has no EXECUTE', (NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = 'public.conversation_operational_access(uuid, uuid)'::regprocedure AND a.grantee = 0))::text, 'true');
  RAISE NOTICE 'ALL CONVERSATION HANDOFF CHECKS PASSED';
END $$;

ROLLBACK;
