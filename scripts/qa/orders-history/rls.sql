\set QUIET on
\set ON_ERROR_STOP on
SET client_min_messages = notice;

-- Synthetic world: accounts A and B; A has an owner, two agents (a1 confirms, a2 is the seller), a viewer; B has one agent. Plus an outsider.
INSERT INTO auth.users (id, aud, role, email) VALUES
  ('a0000000-0000-4000-8000-000000000001','authenticated','authenticated','owner-a@qa.test'),
  ('a0000000-0000-4000-8000-000000000002','authenticated','authenticated','agent-a1@qa.test'),
  ('a0000000-0000-4000-8000-000000000003','authenticated','authenticated','agent-a2@qa.test'),
  ('a0000000-0000-4000-8000-000000000004','authenticated','authenticated','viewer-a@qa.test'),
  ('b0000000-0000-4000-8000-000000000001','authenticated','authenticated','agent-b@qa.test'),
  ('c0000000-0000-4000-8000-000000000001','authenticated','authenticated','outsider@qa.test');
ALTER TABLE public.profiles DISABLE TRIGGER USER;  -- fixtures only; the policies under test are untouched
ALTER TABLE public.accounts DISABLE TRIGGER USER;
INSERT INTO public.accounts (id, name, owner_user_id) VALUES
  ('aaaaaaaa-0000-4000-8000-00000000000a','Cuenta A','a0000000-0000-4000-8000-000000000001'),
  ('bbbbbbbb-0000-4000-8000-00000000000b','Cuenta B','b0000000-0000-4000-8000-000000000001'),
  ('cccccccc-0000-4000-8000-00000000000c','Cuenta C','c0000000-0000-4000-8000-000000000001');
INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role) VALUES
  ('a0000000-0000-4000-8000-000000000001','Owner A','owner-a@qa.test','aaaaaaaa-0000-4000-8000-00000000000a','owner'),
  ('a0000000-0000-4000-8000-000000000002','Agente A1','agent-a1@qa.test','aaaaaaaa-0000-4000-8000-00000000000a','agent'),
  ('a0000000-0000-4000-8000-000000000003','Agente A2','agent-a2@qa.test','aaaaaaaa-0000-4000-8000-00000000000a','agent'),
  ('a0000000-0000-4000-8000-000000000004','Viewer A','viewer-a@qa.test','aaaaaaaa-0000-4000-8000-00000000000a','viewer'),
  ('b0000000-0000-4000-8000-000000000001','Agente B','agent-b@qa.test','bbbbbbbb-0000-4000-8000-00000000000b','agent'),
  ('c0000000-0000-4000-8000-000000000001','Fuera','outsider@qa.test','cccccccc-0000-4000-8000-00000000000c','agent');
ALTER TABLE public.profiles ENABLE TRIGGER USER;
ALTER TABLE public.accounts ENABLE TRIGGER USER;

INSERT INTO public.contacts (id, user_id, account_id, phone, name) VALUES
  ('a1111111-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-00000000000a','900000001','Cliente A'),
  ('b1111111-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','bbbbbbbb-0000-4000-8000-00000000000b','900000002','Cliente B');
INSERT INTO public.conversations (id, user_id, account_id, contact_id) VALUES
  ('a2222222-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-00000000000a','a1111111-0000-4000-8000-000000000001'),
  ('b2222222-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','bbbbbbbb-0000-4000-8000-00000000000b','b1111111-0000-4000-8000-000000000001');
INSERT INTO public.order_integration_settings (account_id, confirm_enabled, enabled) VALUES
  ('aaaaaaaa-0000-4000-8000-00000000000a', TRUE, FALSE), ('bbbbbbbb-0000-4000-8000-00000000000b', TRUE, FALSE);

-- Orders created through the REAL function (author a1, seller a2): three in A's conversation, one in B's.
SELECT create_order_confirmation('aaaaaaaa-0000-4000-8000-00000000000a','a1111111-0000-4000-8000-000000000001','a2222222-0000-4000-8000-000000000001',
  'a0000000-0000-4000-8000-000000000002','Agente A1', 'k'||g, 'a0000000-0000-4000-8000-000000000003',
  jsonb_build_object('customer_name','Cliente A','phone','900000001','product','Producto A'||g,'quantity',1,'price',100+g,'destination','Lima'))
FROM generate_series(1,3) g;
SELECT create_order_confirmation('bbbbbbbb-0000-4000-8000-00000000000b','b1111111-0000-4000-8000-000000000001','b2222222-0000-4000-8000-000000000001',
  'b0000000-0000-4000-8000-000000000001','Agente B','kb1','b0000000-0000-4000-8000-000000000001',
  jsonb_build_object('customer_name','Cliente B','phone','900000002','product','Producto B','quantity',1,'price',50,'destination','Cusco'));

CREATE TEMP TABLE fp AS SELECT md5(string_agg(to_jsonb(o)::text, '|' ORDER BY id)) AS orders, (SELECT md5(string_agg(to_jsonb(d)::text,'|' ORDER BY id)) FROM order_confirmation_deliveries d) AS deliveries,
  (SELECT count(*) FROM messages) AS msgs, (SELECT count(*) FROM notifications) AS notifs FROM order_confirmations o;
GRANT SELECT ON fp TO authenticated;

-- Helper: run the panel's query as <user> for <account>/<conversation>; same shape as the route (account filter + conversation OR contact).
CREATE FUNCTION pg_temp.as_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
END $$;

CREATE FUNCTION pg_temp.panel(p_account uuid, p_conv uuid, p_contact uuid) RETURNS text[] LANGUAGE sql AS $$
  SELECT COALESCE(array_agg(product ORDER BY confirmed_at DESC, product), '{}') FROM order_confirmations
   WHERE account_id = p_account AND (conversation_id = p_conv OR contact_id = p_contact)
$$;

CREATE PROCEDURE pg_temp.ok(p_name text, p_cond boolean) LANGUAGE plpgsql AS $$
BEGIN
  IF p_cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', p_name; END IF;
  RAISE NOTICE 'PASS: %', p_name;
END $$;

DO $t$
DECLARE r text[]; n int; A uuid := 'aaaaaaaa-0000-4000-8000-00000000000a'; B uuid := 'bbbbbbbb-0000-4000-8000-00000000000b';
  cA uuid := 'a2222222-0000-4000-8000-000000000001'; kA uuid := 'a1111111-0000-4000-8000-000000000001';
  cB uuid := 'b2222222-0000-4000-8000-000000000001'; kB uuid := 'b1111111-0000-4000-8000-000000000001';
BEGIN
  -- 1. Each agent sees exactly its own account's orders.
  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.as_user('a0000000-0000-4000-8000-000000000002');
  r := pg_temp.panel(A, cA, kA); CALL pg_temp.ok('agent A1 sees the 3 orders of the conversation, newest first', cardinality(r) = 3);
  r := pg_temp.panel(B, cB, kB); CALL pg_temp.ok('agent A1 asking for account B / conversation B gets nothing', cardinality(r) = 0);
  r := pg_temp.panel(A, cB, kB); CALL pg_temp.ok('agent A1 mixing account A with B''s conversation and contact gets nothing', cardinality(r) = 0);
  SELECT count(*) INTO n FROM order_confirmations WHERE id IN (SELECT id FROM order_confirmations WHERE account_id = B);
  CALL pg_temp.ok('agent A1 cannot read any row of account B even without the account filter', n = 0);
  SELECT count(*) INTO n FROM order_confirmation_deliveries WHERE account_id = B;
  CALL pg_temp.ok('same for the delivery attempts of B', n = 0);

  PERFORM pg_temp.as_user('b0000000-0000-4000-8000-000000000001');
  r := pg_temp.panel(B, cB, kB); CALL pg_temp.ok('agent B sees its 1 order', cardinality(r) = 1);
  r := pg_temp.panel(A, cA, kA); CALL pg_temp.ok('agent B cannot see account A''s orders', cardinality(r) = 0);

  -- 2. Roles.
  PERFORM pg_temp.as_user('a0000000-0000-4000-8000-000000000004');
  r := pg_temp.panel(A, cA, kA); CALL pg_temp.ok('a viewer of A sees nothing (agent role required)', cardinality(r) = 0);
  PERFORM pg_temp.as_user('a0000000-0000-4000-8000-000000000001');
  r := pg_temp.panel(A, cA, kA); CALL pg_temp.ok('the owner of A sees the orders', cardinality(r) = 3);
  PERFORM pg_temp.as_user('c0000000-0000-4000-8000-000000000001');
  r := pg_temp.panel(A, cA, kA); CALL pg_temp.ok('a user of another account sees nothing of A', cardinality(r) = 0);
  PERFORM set_config('request.jwt.claims', '', true); PERFORM set_config('request.jwt.claim.sub', '', true);
  r := pg_temp.panel(A, cA, kA); CALL pg_temp.ok('no session at all sees nothing', cardinality(r) = 0);

  -- 3. The panel (any signed-in role) can never write.
  PERFORM pg_temp.as_user('a0000000-0000-4000-8000-000000000002');
  -- Without a privilege the statement errors; with a privilege but no policy, row-level security makes it touch 0 rows. Either way nothing changes.
  BEGIN UPDATE order_confirmations SET delivery_status = 'acknowledged' WHERE account_id = A; GET DIAGNOSTICS n = ROW_COUNT;
        CALL pg_temp.ok('an agent updates 0 order rows (RLS)', n = 0);
  EXCEPTION WHEN insufficient_privilege THEN CALL pg_temp.ok('an agent cannot update an order (permission denied)', TRUE); END;
  BEGIN DELETE FROM order_confirmations WHERE account_id = A; GET DIAGNOSTICS n = ROW_COUNT;
        CALL pg_temp.ok('an agent deletes 0 order rows (RLS)', n = 0);
  EXCEPTION WHEN insufficient_privilege THEN CALL pg_temp.ok('an agent cannot delete an order (permission denied)', TRUE); END;
  BEGIN INSERT INTO order_confirmations (account_id, customer_name, phone, product, quantity, price, destination, seller_name, request_key, confirmed_by_name)
          VALUES (A, 'x', '1', 'x', 1, 1, 'x', 'x', 'direct', 'x');
        CALL pg_temp.ok('an agent cannot insert an order directly', FALSE);
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN CALL pg_temp.ok('an agent cannot insert an order directly', TRUE); END;
  BEGIN PERFORM create_order_confirmation(A, kA, cA, 'a0000000-0000-4000-8000-000000000002', 'x', 'zz', 'a0000000-0000-4000-8000-000000000003', '{}'::jsonb);
        CALL pg_temp.ok('an agent cannot call the create function directly', FALSE);
  EXCEPTION WHEN insufficient_privilege THEN CALL pg_temp.ok('an agent cannot call the create function directly (service role only)', TRUE); END;
  RESET ROLE;
END $t$;

-- 4. Author and seller are separate fields, and snapshots survive the removal of the people.
DO $t$ DECLARE n int; a text; s text; cb uuid; BEGIN
  SELECT confirmed_by_name, seller_name INTO a, s FROM order_confirmations WHERE request_key = 'k1';
  CALL pg_temp.ok('author and seller are different people and kept as separate fields', a = 'Agente A1' AND s = 'Agente A2');
  DELETE FROM public.conversations WHERE id = 'a2222222-0000-4000-8000-000000000001';
  SELECT count(*) INTO n FROM order_confirmations WHERE account_id = 'aaaaaaaa-0000-4000-8000-00000000000a' AND conversation_id IS NULL;
  CALL pg_temp.ok('deleting the conversation keeps the orders (conversation_id becomes NULL)', n = 3);
  SET LOCAL ROLE authenticated; PERFORM pg_temp.as_user('a0000000-0000-4000-8000-000000000002');
  CALL pg_temp.ok('orders of a deleted conversation are still found through the contact',
    cardinality(pg_temp.panel('aaaaaaaa-0000-4000-8000-00000000000a', 'a2222222-0000-4000-8000-000000000001', 'a1111111-0000-4000-8000-000000000001')) = 3);
  RESET ROLE;
  ALTER TABLE public.profiles DISABLE TRIGGER USER;
  DELETE FROM auth.users WHERE id = 'a0000000-0000-4000-8000-000000000002';
  SELECT confirmed_by, confirmed_by_name INTO cb, a FROM order_confirmations WHERE request_key = 'k1';
  CALL pg_temp.ok('deleting the author keeps the frozen name and nulls the reference', cb IS NULL AND a = 'Agente A1');
  SELECT seller_name INTO s FROM order_confirmations WHERE request_key = 'k1';
  CALL pg_temp.ok('the seller name snapshot is unchanged', s = 'Agente A2');
END $t$;

-- 5. Reading the panel changed nothing: orders and deliveries identical (apart from the deliberate fixture changes above), no messages, no notifications.
DO $t$ DECLARE f record; m bigint; nn bigint; d bigint; h bigint; BEGIN
  SELECT * INTO f FROM fp;
  SELECT count(*) INTO m FROM messages; SELECT count(*) INTO nn FROM notifications;
  SELECT count(*) INTO d FROM order_confirmation_deliveries; SELECT count(*) INTO h FROM order_confirmations WHERE delivery_status <> 'held';
  CALL pg_temp.ok('no message and no notification was created by any of this', m = f.msgs AND nn = f.notifs);
  CALL pg_temp.ok('no delivery attempt exists (nothing was sent or resent)', d = 0);
  CALL pg_temp.ok('every order is still in its original delivery state (held)', h = 0);
END $t$;
