-- Behavioural assertions for 20261101000000_order_confirmations.sql and 20261102000000_order_sellers_from_members.sql, with synthetic data, run inside a transaction that is rolled back.
-- Run after `supabase db reset`:  supabase db query --local --file supabase/ci/verify-order-confirmations.sql
-- Any failed assertion raises and aborts the run.
BEGIN;

CREATE TEMP TABLE t (k TEXT PRIMARY KEY, v TEXT);
GRANT ALL ON t TO PUBLIC;

DO $$
DECLARE
  ua UUID := gen_random_uuid(); ub UUID := gen_random_uuid();
  aa UUID; ab UUID; ca UUID; cb UUID; va UUID; sa UUID := gen_random_uuid(); sb UUID := gen_random_uuid(); uc UUID := gen_random_uuid(); ac UUID;
BEGIN
  INSERT INTO auth.users (id, email) VALUES (ua, 'synthetic-a@example.invalid'), (ub, 'synthetic-b@example.invalid');
  SELECT account_id INTO aa FROM profiles WHERE user_id = ua;
  SELECT account_id INTO ab FROM profiles WHERE user_id = ub;
  IF aa IS NULL OR ab IS NULL OR aa = ab THEN RAISE EXCEPTION 'setup: expected one account per synthetic user'; END IF;
  INSERT INTO contacts (user_id, account_id, phone, name) VALUES (ua, aa, '51900000001', 'Synthetic A') RETURNING id INTO ca;
  INSERT INTO contacts (user_id, account_id, phone, name) VALUES (ub, ab, '51900000002', 'Synthetic B') RETURNING id INTO cb;
  INSERT INTO conversations (user_id, account_id, contact_id) VALUES (ua, aa, ca) RETURNING id INTO va;
  -- Sellers are MEMBERS: a user joins the account (what redeem_invitation does) and gets a profile there.
  INSERT INTO auth.users (id, email) VALUES (sa, 'synthetic-seller-a@example.invalid'), (sb, 'synthetic-seller-b@example.invalid'), (uc, 'synthetic-c@example.invalid');
  UPDATE profiles SET account_id = aa, account_role = 'agent', full_name = 'Vendedor Uno' WHERE user_id = sa;
  UPDATE profiles SET account_id = ab, account_role = 'agent', full_name = 'Vendedor B' WHERE user_id = sb;
  UPDATE profiles SET full_name = 'Asesor A' WHERE user_id = ua;
  UPDATE profiles SET full_name = 'Asesor B' WHERE user_id = ub;
  SELECT account_id INTO ac FROM profiles WHERE user_id = uc;
  -- A: feature on, delivery on. B: feature on, delivery OFF (pilot scenario). C: feature never enabled (no settings row).
  INSERT INTO order_integration_settings (account_id, enabled, confirm_enabled) VALUES (aa, TRUE, TRUE), (ab, FALSE, TRUE);
  INSERT INTO t VALUES ('ua', ua::text), ('ub', ub::text), ('uc', uc::text), ('aa', aa::text), ('ab', ab::text), ('ac', ac::text), ('ca', ca::text), ('cb', cb::text),
                       ('va', va::text), ('sa', sa::text), ('sb', sb::text);
END $$;

-- Helper values.
CREATE FUNCTION pg_temp.f(p_price TEXT DEFAULT '150.50', p_qty TEXT DEFAULT '2') RETURNS JSONB LANGUAGE sql AS $$
  SELECT jsonb_build_object('customer_name', 'Cliente Sintetico', 'dni', '', 'phone', '51900000001', 'product', 'Nivel laser', 'quantity', p_qty,
                            'price', p_price, 'order_description', 'texto libre https://example.invalid/x', 'destination', 'Arequipa', 'department', NULL)
$$;
CREATE FUNCTION pg_temp.v(p_k TEXT) RETURNS TEXT LANGUAGE sql AS $$ SELECT v FROM t WHERE k = p_k $$;

DO $$
DECLARE
  r RECORD; r2 RECORD; n INTEGER; s TEXT; o UUID;
BEGIN
  -- Idempotent create: same key twice = one order.
  SELECT * INTO r FROM create_order_confirmation(pg_temp.v('aa')::uuid, pg_temp.v('ca')::uuid, pg_temp.v('va')::uuid, pg_temp.v('ua')::uuid, 'Asesor A', 'key-1', pg_temp.v('sa')::uuid, pg_temp.f());
  SELECT * INTO r2 FROM create_order_confirmation(pg_temp.v('aa')::uuid, pg_temp.v('ca')::uuid, pg_temp.v('va')::uuid, pg_temp.v('ua')::uuid, 'Asesor A', 'key-1', pg_temp.v('sa')::uuid, pg_temp.f());
  IF NOT r.created OR r2.created OR r.order_id <> r2.order_id THEN RAISE EXCEPTION 'idempotent create failed'; END IF;
  o := r.order_id;
  SELECT delivery_status INTO s FROM order_confirmations WHERE id = o;
  IF s <> 'pending' THEN RAISE EXCEPTION 'enabled account should start pending, got %', s; END IF;
  -- Fields are stored typed: price keeps cents, empty DNI becomes NULL, agency defaults to Shalom, status is the constant.
  IF NOT EXISTS (SELECT 1 FROM order_confirmations WHERE id = o AND price = 150.50 AND dni IS NULL AND agency = 'Shalom'
                 AND order_status = 'Pedido confirmado' AND seller_name = 'Vendedor Uno' AND confirmed_by_name = 'Asesor A') THEN
    RAISE EXCEPTION 'stored fields are wrong';
  END IF;

  -- Two different orders of the same contact are independent.
  PERFORM create_order_confirmation(pg_temp.v('aa')::uuid, pg_temp.v('ca')::uuid, pg_temp.v('va')::uuid, pg_temp.v('ua')::uuid, 'Asesor A', 'key-2', pg_temp.v('sa')::uuid, pg_temp.f());
  SELECT count(*) INTO n FROM order_confirmations WHERE contact_id = pg_temp.v('ca')::uuid;
  IF n <> 2 THEN RAISE EXCEPTION 'two orders of one contact expected, got %', n; END IF;

  -- Account isolation: foreign contact, foreign conversation, foreign seller are rejected.
  BEGIN PERFORM create_order_confirmation(pg_temp.v('aa')::uuid, pg_temp.v('cb')::uuid, NULL, pg_temp.v('ua')::uuid, 'x', 'key-x1', pg_temp.v('sa')::uuid, pg_temp.f());
        RAISE EXCEPTION 'foreign contact accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM LIKE 'foreign contact%' THEN RAISE; END IF; END;
  BEGIN PERFORM create_order_confirmation(pg_temp.v('aa')::uuid, pg_temp.v('ca')::uuid, NULL, pg_temp.v('ua')::uuid, 'x', 'key-x2', pg_temp.v('sb')::uuid, pg_temp.f());
        RAISE EXCEPTION 'foreign seller accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM LIKE 'foreign seller%' THEN RAISE; END IF; END;

  -- Integration off (account B has no settings row): the order is kept but HELD, and the worker never sees it.
  PERFORM create_order_confirmation(pg_temp.v('ab')::uuid, pg_temp.v('cb')::uuid, NULL, pg_temp.v('ub')::uuid, 'Asesor B', 'key-b', pg_temp.v('sb')::uuid, pg_temp.f());
  IF (SELECT delivery_status FROM order_confirmations WHERE account_id = pg_temp.v('ab')::uuid) <> 'held' THEN RAISE EXCEPTION 'disabled account should be held'; END IF;

  -- Check constraints: price must be > 0 (0 would mark the order as paid in InkaClick), quantity >= 1.
  BEGIN PERFORM create_order_confirmation(pg_temp.v('aa')::uuid, pg_temp.v('ca')::uuid, NULL, pg_temp.v('ua')::uuid, 'x', 'key-p0', pg_temp.v('sa')::uuid, pg_temp.f('0'));
        RAISE EXCEPTION 'price 0 accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN PERFORM create_order_confirmation(pg_temp.v('aa')::uuid, pg_temp.v('ca')::uuid, NULL, pg_temp.v('ua')::uuid, 'x', 'key-q0', pg_temp.v('sa')::uuid, pg_temp.f('10', '0'));
        RAISE EXCEPTION 'quantity 0 accepted'; EXCEPTION WHEN check_violation THEN NULL; END;

  -- Frozen fields cannot change; delivery bookkeeping can.
  BEGIN UPDATE order_confirmations SET price = 1 WHERE id = o; RAISE EXCEPTION 'price update accepted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM LIKE 'price update%' THEN RAISE; END IF; END;
  BEGIN UPDATE order_confirmations SET seller_name = 'otro' WHERE id = o; RAISE EXCEPTION 'seller update accepted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM LIKE 'seller update%' THEN RAISE; END IF; END;
  UPDATE order_confirmations SET last_error_code = 'noop' WHERE id = o;
  UPDATE order_confirmations SET last_error_code = NULL WHERE id = o;

  -- Claim: leases only due orders of enabled accounts; a second claim finds nothing.
  SELECT count(*) INTO n FROM claim_order_deliveries(10, 120, 3);
  IF n <> 2 THEN RAISE EXCEPTION 'first claim should lease the 2 pending orders of account A, got %', n; END IF;
  SELECT count(*) INTO n FROM claim_order_deliveries(10, 120, 3);
  IF n <> 0 THEN RAISE EXCEPTION 'second claim must be empty (leased), got %', n; END IF;
  IF (SELECT attempts FROM order_confirmations WHERE id = o) <> 1 THEN RAISE EXCEPTION 'attempt counter'; END IF;

  -- Retry, stale report, then success and reconciliation.
  s := finish_order_delivery(o, 1, 'retry', 503, 'http_503', 'upstream', NULL, NOW() - INTERVAL '1 second', 3);
  IF s <> 'pending' THEN RAISE EXCEPTION 'retry should return to pending, got %', s; END IF;
  IF finish_order_delivery(o, 1, 'sent', 200, NULL, NULL, NULL, NULL, 3) <> 'ignored' THEN RAISE EXCEPTION 'report on a non-leased order must be ignored'; END IF;
  SELECT count(*) INTO n FROM claim_order_deliveries(10, 120, 3);
  IF n <> 1 THEN RAISE EXCEPTION 'retry should be claimable again, got %', n; END IF;
  IF (SELECT attempts FROM order_confirmations WHERE id = o) <> 2 THEN RAISE EXCEPTION 'second attempt counter'; END IF;
  IF finish_order_delivery(o, 1, 'sent', 200, NULL, NULL, NULL, NULL, 3) <> 'ignored' THEN RAISE EXCEPTION 'stale attempt report must be ignored'; END IF;
  s := finish_order_delivery(o, 2, 'sent', 200, NULL, NULL, gen_random_uuid(), NULL, 3);
  IF s <> 'sent' THEN RAISE EXCEPTION 'expected sent, got %', s; END IF;
  IF NOT acknowledge_order_delivery(o, (SELECT inkaclick_order_id FROM order_confirmations WHERE id = o)) THEN RAISE EXCEPTION 'acknowledge failed'; END IF;
  IF (SELECT delivery_status FROM order_confirmations WHERE id = o) <> 'acknowledged' THEN RAISE EXCEPTION 'expected acknowledged'; END IF;
  SELECT count(*) INTO n FROM order_confirmation_deliveries WHERE order_id = o;
  IF n <> 2 THEN RAISE EXCEPTION 'two attempts expected in history, got %', n; END IF;
END $$;

DO $$
DECLARE o UUID; s TEXT; n INTEGER;
BEGIN
  -- 4xx is a person's problem (failed), and attempts exhausted becomes dead; a dead worker's lease expires and is retried or killed.
  SELECT id INTO o FROM order_confirmations WHERE request_key = 'key-2';
  IF (SELECT delivery_status FROM order_confirmations WHERE id = o) <> 'sending' THEN RAISE EXCEPTION 'key-2 should still be leased'; END IF;
  s := finish_order_delivery(o, 1, 'rejected', 422, 'http_422', 'invalid payload', NULL, NULL, 3);
  IF s <> 'failed' THEN RAISE EXCEPTION 'rejected should be failed, got %', s; END IF;

  PERFORM create_order_confirmation(pg_temp.v('aa')::uuid, pg_temp.v('ca')::uuid, NULL, pg_temp.v('ua')::uuid, 'Asesor A', 'key-3', pg_temp.v('sa')::uuid, pg_temp.f());
  SELECT id INTO o FROM order_confirmations WHERE request_key = 'key-3';
  PERFORM claim_order_deliveries(10, 120, 2);
  s := finish_order_delivery(o, 1, 'retry', NULL, 'timeout', 'timeout', NULL, NOW() - INTERVAL '1 second', 2);
  PERFORM claim_order_deliveries(10, 120, 2);
  s := finish_order_delivery(o, 2, 'retry', NULL, 'timeout', 'timeout', NULL, NOW() - INTERVAL '1 second', 2);
  IF s <> 'dead' THEN RAISE EXCEPTION 'attempts exhausted should be dead, got %', s; END IF;

  -- Lease takeover: an expired lease is claimed again (the receiver is idempotent).
  PERFORM create_order_confirmation(pg_temp.v('aa')::uuid, pg_temp.v('ca')::uuid, NULL, pg_temp.v('ua')::uuid, 'Asesor A', 'key-4', pg_temp.v('sa')::uuid, pg_temp.f());
  SELECT id INTO o FROM order_confirmations WHERE request_key = 'key-4';
  PERFORM claim_order_deliveries(10, 120, 3);
  UPDATE order_confirmations SET locked_until = NOW() - INTERVAL '1 second' WHERE id = o;
  SELECT count(*) INTO n FROM claim_order_deliveries(10, 120, 3);
  IF n <> 1 OR (SELECT attempts FROM order_confirmations WHERE id = o) <> 2 THEN RAISE EXCEPTION 'expired lease should be re-claimed as attempt 2'; END IF;
  IF (SELECT outcome FROM order_confirmation_deliveries WHERE order_id = o AND attempt = 1) <> 'abandoned' THEN RAISE EXCEPTION 'abandoned attempt not recorded'; END IF;
  UPDATE order_confirmations SET locked_until = NOW() - INTERVAL '1 second', attempts = 3 WHERE id = o;
  PERFORM claim_order_deliveries(10, 120, 3);
  IF (SELECT delivery_status FROM order_confirmations WHERE id = o) <> 'dead' THEN RAISE EXCEPTION 'expired lease at max attempts should be dead'; END IF;
END $$;

-- References: the order keeps pointing at what it was confirmed for. The only change allowed is non-NULL -> NULL (what ON DELETE SET NULL does),
-- the business snapshots (customer_name, seller_name, ...) survive it, and a reference can neither be re-pointed nor restored afterwards.
DO $$
DECLARE
  ua UUID := pg_temp.v('ua')::uuid; aa UUID := pg_temp.v('aa')::uuid; ab UUID := pg_temp.v('ab')::uuid;
  ca2 UUID; va2 UUID; vb UUID; sa2 UUID; usa2 UUID := gen_random_uuid(); dA UUID; dB UUID; pA UUID; pB UUID; stA UUID; stB UUID; o UUID; o2 UUID; r order_confirmations;
BEGIN
  INSERT INTO contacts (user_id, account_id, phone, name) VALUES (ua, aa, '51900000003', 'Synthetic A2') RETURNING id INTO ca2;
  INSERT INTO conversations (user_id, account_id, contact_id) VALUES (ua, aa, ca2) RETURNING id INTO va2;
  INSERT INTO conversations (user_id, account_id, contact_id) VALUES (pg_temp.v('ub')::uuid, ab, pg_temp.v('cb')::uuid) RETURNING id INTO vb;
  INSERT INTO order_sellers (account_id, name, name_key) VALUES (ab, 'Vendedor B legacy', 'vendedor b legacy');
  INSERT INTO order_sellers (account_id, name, name_key) VALUES (aa, 'Vendedor Dos', 'vendedor dos') RETURNING id INTO sa2;   -- LEGACY catalogue row (direct inserts only)
  INSERT INTO auth.users (id, email) VALUES (usa2, 'synthetic-seller-a2@example.invalid');
  UPDATE profiles SET account_id = aa, account_role = 'agent', full_name = 'Vendedor Dos' WHERE user_id = usa2;
  INSERT INTO pipelines (user_id, account_id, name) VALUES (ua, aa, 'pA') RETURNING id INTO pA;
  INSERT INTO pipelines (user_id, account_id, name) VALUES (pg_temp.v('ub')::uuid, ab, 'pB') RETURNING id INTO pB;
  INSERT INTO pipeline_stages (pipeline_id, name) VALUES (pA, 's') RETURNING id INTO stA;
  INSERT INTO pipeline_stages (pipeline_id, name) VALUES (pB, 's') RETURNING id INTO stB;
  INSERT INTO deals (user_id, account_id, pipeline_id, stage_id, title) VALUES (ua, aa, pA, stA, 'dA') RETURNING id INTO dA;
  INSERT INTO deals (user_id, account_id, pipeline_id, stage_id, title) VALUES (pg_temp.v('ub')::uuid, ab, pB, stB, 'dB') RETURNING id INTO dB;

  SELECT order_id INTO o FROM create_order_confirmation(aa, ca2, va2, ua, 'Asesor A', 'key-ref-1', usa2, pg_temp.f());

  -- Re-pointing any reference is refused, in the same account or across accounts, and a NULL reference cannot be filled in.
  BEGIN UPDATE order_confirmations SET contact_id = pg_temp.v('ca')::uuid WHERE id = o; RAISE EXCEPTION 'contact re-pointed (same account)';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM LIKE 'contact re-pointed%' THEN RAISE; END IF; END;
  BEGIN UPDATE order_confirmations SET contact_id = pg_temp.v('cb')::uuid WHERE id = o; RAISE EXCEPTION 'contact re-pointed (other account)';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM LIKE 'contact re-pointed%' THEN RAISE; END IF; END;
  BEGIN UPDATE order_confirmations SET conversation_id = pg_temp.v('va')::uuid WHERE id = o; RAISE EXCEPTION 'conversation re-pointed';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM LIKE 'conversation re-pointed%' THEN RAISE; END IF; END;
  BEGIN UPDATE order_confirmations SET seller_user_id = pg_temp.v('sa')::uuid WHERE id = o; RAISE EXCEPTION 'seller re-pointed (same account)';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM LIKE 'seller re-pointed%' THEN RAISE; END IF; END;
  BEGIN UPDATE order_confirmations SET seller_user_id = pg_temp.v('sb')::uuid WHERE id = o; RAISE EXCEPTION 'seller re-pointed (other account)';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM LIKE 'seller re-pointed%' THEN RAISE; END IF; END;
  BEGIN UPDATE order_confirmations SET deal_id = dA WHERE id = o; RAISE EXCEPTION 'deal linked after the fact';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM LIKE 'deal linked%' THEN RAISE; END IF; END;
  BEGIN UPDATE order_confirmations SET id = gen_random_uuid() WHERE id = o; RAISE EXCEPTION 'id changed';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM LIKE 'id changed%' THEN RAISE; END IF; END;
  BEGIN UPDATE order_confirmations SET created_at = created_at - INTERVAL '1 day' WHERE id = o; RAISE EXCEPTION 'created_at changed';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM LIKE 'created_at changed%' THEN RAISE; END IF; END;

  -- A direct insert (bypassing create_order_confirmation) cannot reference another account's contact, conversation, seller or deal,
  -- nor carry a seller name that is not the seller's name.
  BEGIN INSERT INTO order_confirmations (account_id, contact_id, confirmed_by_name, request_key, seller_id, seller_name, customer_name, phone, product, quantity, price, destination)
        VALUES (aa, pg_temp.v('cb')::uuid, 'x', 'direct-1', sa2, 'Vendedor Dos', 'n', 'p', 'p', 1, 1, 'd'); RAISE EXCEPTION 'cross-account contact inserted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM LIKE 'cross-account%' THEN RAISE; END IF; END;
  BEGIN INSERT INTO order_confirmations (account_id, conversation_id, confirmed_by_name, request_key, seller_id, seller_name, customer_name, phone, product, quantity, price, destination)
        VALUES (aa, vb, 'x', 'direct-2', sa2, 'Vendedor Dos', 'n', 'p', 'p', 1, 1, 'd'); RAISE EXCEPTION 'cross-account conversation inserted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM LIKE 'cross-account%' THEN RAISE; END IF; END;
  BEGIN INSERT INTO order_confirmations (account_id, confirmed_by_name, request_key, seller_id, seller_name, customer_name, phone, product, quantity, price, destination)
        VALUES (aa, 'x', 'direct-3', (SELECT id FROM order_sellers WHERE account_id = ab LIMIT 1), 'Vendedor B legacy', 'n', 'p', 'p', 1, 1, 'd'); RAISE EXCEPTION 'cross-account seller inserted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM LIKE 'cross-account%' THEN RAISE; END IF; END;
  BEGIN INSERT INTO order_confirmations (account_id, deal_id, confirmed_by_name, request_key, seller_id, seller_name, customer_name, phone, product, quantity, price, destination)
        VALUES (aa, dB, 'x', 'direct-4', sa2, 'Vendedor Dos', 'n', 'p', 'p', 1, 1, 'd'); RAISE EXCEPTION 'cross-account deal inserted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM LIKE 'cross-account%' THEN RAISE; END IF; END;
  BEGIN INSERT INTO order_confirmations (account_id, confirmed_by_name, request_key, seller_id, seller_name, customer_name, phone, product, quantity, price, destination)
        VALUES (aa, 'x', 'direct-5', sa2, 'Otro nombre', 'n', 'p', 'p', 1, 1, 'd'); RAISE EXCEPTION 'seller name mismatch inserted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM LIKE 'seller name mismatch%' THEN RAISE; END IF; END;
  -- A same-account deal is a legitimate reference at insert time.
  INSERT INTO order_confirmations (account_id, deal_id, confirmed_by_name, request_key, seller_id, seller_name, customer_name, phone, product, quantity, price, destination)
    VALUES (aa, dA, 'x', 'direct-ok', sa2, 'Vendedor Dos', 'n', 'p', 'p', 1, 1, 'd') RETURNING id INTO o2;

  -- What the foreign keys do: deleting the referenced rows sets the references to NULL; every snapshot stays; a NULL cannot be refilled.
  DELETE FROM deals WHERE id = dA;
  DELETE FROM order_sellers WHERE id = sa2;
  DELETE FROM accounts WHERE owner_user_id = usa2;   -- the personal account the signup trigger created (what redeem_invitation cleans up)
  DELETE FROM auth.users WHERE id = usa2;   -- the member (and its profile) disappears: seller_user_id must become NULL, the name stays
  DELETE FROM contacts WHERE id = ca2;      -- also removes the conversation
  SELECT * INTO r FROM order_confirmations WHERE id = o;
  IF r.contact_id IS NOT NULL OR r.conversation_id IS NOT NULL OR r.seller_user_id IS NOT NULL THEN RAISE EXCEPTION 'references should have become NULL'; END IF;
  IF r.customer_name <> 'Cliente Sintetico' OR r.seller_name <> 'Vendedor Dos' OR r.phone <> '51900000001' OR r.price <> 150.50
     OR r.confirmed_by_name <> 'Asesor A' OR r.product <> 'Nivel laser' THEN RAISE EXCEPTION 'snapshots must survive the NULLing'; END IF;
  IF (SELECT deal_id FROM order_confirmations WHERE id = o2) IS NOT NULL THEN RAISE EXCEPTION 'deal reference should have become NULL'; END IF;
  BEGIN UPDATE order_confirmations SET contact_id = pg_temp.v('ca')::uuid WHERE id = o; RAISE EXCEPTION 'NULL contact refilled';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM LIKE 'NULL contact refilled%' THEN RAISE; END IF; END;
  -- Delivery bookkeeping keeps working on an order whose references are gone.
  UPDATE order_confirmations SET last_error_code = 'noop' WHERE id = o;
END $$;

-- Sellers are the account's real members (20261102000000): owner, accepted invitations, no pending ones, no removed ones, renames visible, history kept.
DO $$
DECLARE
  ua UUID := pg_temp.v('ua')::uuid; aa UUID := pg_temp.v('aa')::uuid; ab UUID := pg_temp.v('ab')::uuid; ac UUID := pg_temp.v('ac')::uuid;
  uc UUID := pg_temp.v('uc')::uuid; ca UUID := pg_temp.v('ca')::uuid;
  newu UUID := gen_random_uuid(); vu UUID := gen_random_uuid();
  o1 UUID; o2 UUID; o3 UUID; names TEXT; n INTEGER; r order_confirmations;
BEGIN
  -- 1. The owner is eligible without any setup.
  IF NOT EXISTS (SELECT 1 FROM order_seller_candidates(aa) c WHERE c.user_id = ua AND c.name = 'Asesor A' AND c.account_role = 'owner') THEN RAISE EXCEPTION 'owner must be a candidate'; END IF;

  -- 2. A pending invitation creates no seller; the invited user (still alone in a personal account) is not a candidate either.
  INSERT INTO auth.users (id, email) VALUES (newu, 'synthetic-new@example.invalid');
  UPDATE profiles SET full_name = 'Miembro Nuevo' WHERE user_id = newu;
  SELECT count(*) INTO n FROM order_seller_candidates(aa);
  INSERT INTO account_invitations (account_id, token_hash, role, created_by_user_id, expires_at) VALUES (aa, 'qa-token-hash', 'agent', ua, NOW() + INTERVAL '1 day');
  IF (SELECT count(*) FROM order_seller_candidates(aa)) <> n OR EXISTS (SELECT 1 FROM order_seller_candidates(aa) c WHERE c.user_id = newu) THEN RAISE EXCEPTION 'a pending invitation must not create a seller'; END IF;
  BEGIN PERFORM create_order_confirmation(aa, ca, NULL, ua, 'Asesor A', 'mem-pending', newu, pg_temp.f()); RAISE EXCEPTION 'pending invitee accepted as seller';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM LIKE 'pending invitee%' THEN RAISE; END IF; END;

  -- 3. Accepting the invitation (the real redeem_invitation, as the invited user) enables the new member automatically.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', newu, 'role', 'authenticated')::text, TRUE);
  PERFORM set_config('request.jwt.claim.sub', newu::text, TRUE);
  SET LOCAL ROLE authenticated;
  PERFORM redeem_invitation('qa-token-hash');
  RESET ROLE;
  IF NOT EXISTS (SELECT 1 FROM order_seller_candidates(aa) c WHERE c.user_id = newu AND c.name = 'Miembro Nuevo') THEN RAISE EXCEPTION 'accepted member must become a candidate'; END IF;

  -- 4. The confirmer and the seller are different people and both identities are stored.
  SELECT order_id INTO o1 FROM create_order_confirmation(aa, ca, NULL, ua, 'Asesor A', 'mem-1', newu, pg_temp.f());
  SELECT * INTO r FROM order_confirmations WHERE id = o1;
  IF r.confirmed_by <> ua OR r.seller_user_id <> newu OR r.confirmed_by_name <> 'Asesor A' OR r.seller_name <> 'Miembro Nuevo' OR r.seller_id IS NOT NULL THEN
    RAISE EXCEPTION 'confirmer/seller must be stored separately';
  END IF;

  -- 5. A rename updates the selector and later orders, never past ones.
  UPDATE profiles SET full_name = 'Miembro Renombrado' WHERE user_id = newu;
  IF NOT EXISTS (SELECT 1 FROM order_seller_candidates(aa) c WHERE c.user_id = newu AND c.name = 'Miembro Renombrado') THEN RAISE EXCEPTION 'rename must reach the selector'; END IF;
  SELECT order_id INTO o2 FROM create_order_confirmation(aa, ca, NULL, ua, 'Asesor A', 'mem-2', newu, pg_temp.f());
  IF (SELECT seller_name FROM order_confirmations WHERE id = o1) <> 'Miembro Nuevo' OR (SELECT seller_name FROM order_confirmations WHERE id = o2) <> 'Miembro Renombrado' THEN
    RAISE EXCEPTION 'a rename must not rewrite earlier orders';
  END IF;

  -- 6. Removing the member (the real remove_account_member, as the owner) takes them out of the selector and out of new orders; history stays.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, TRUE);
  PERFORM set_config('request.jwt.claim.sub', ua::text, TRUE);
  SET LOCAL ROLE authenticated;
  PERFORM remove_account_member(newu);
  RESET ROLE;
  IF EXISTS (SELECT 1 FROM order_seller_candidates(aa) c WHERE c.user_id = newu) THEN RAISE EXCEPTION 'removed member must leave the selector'; END IF;
  BEGIN PERFORM create_order_confirmation(aa, ca, NULL, ua, 'Asesor A', 'mem-3', newu, pg_temp.f()); RAISE EXCEPTION 'removed member accepted as seller';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM LIKE 'removed member%' THEN RAISE; END IF; END;
  SELECT * INTO r FROM order_confirmations WHERE id = o1;
  IF r.seller_name <> 'Miembro Nuevo' OR r.seller_user_id <> newu THEN RAISE EXCEPTION 'removal must not rewrite history'; END IF;
  -- The removed user now belongs to their own personal account, whose roster is theirs alone: no cross-account leakage.
  IF EXISTS (SELECT 1 FROM order_seller_candidates(aa) c WHERE c.user_id = newu) OR NOT EXISTS (SELECT 1 FROM profiles p WHERE p.user_id = newu AND p.account_id <> aa) THEN RAISE EXCEPTION 'removed member should be elsewhere'; END IF;

  -- 7. A viewer can be chosen as seller (temporary rule) but can NOT confirm.
  INSERT INTO auth.users (id, email) VALUES (vu, 'synthetic-viewer@example.invalid');
  UPDATE profiles SET account_id = aa, account_role = 'viewer', full_name = 'Visor Sintetico' WHERE user_id = vu;
  IF NOT EXISTS (SELECT 1 FROM order_seller_candidates(aa) c WHERE c.user_id = vu AND c.account_role = 'viewer') THEN RAISE EXCEPTION 'viewer should be eligible as seller'; END IF;
  SELECT order_id INTO o3 FROM create_order_confirmation(aa, ca, NULL, ua, 'Asesor A', 'mem-viewer-seller', vu, pg_temp.f());
  IF (SELECT seller_name FROM order_confirmations WHERE id = o3) <> 'Visor Sintetico' THEN RAISE EXCEPTION 'viewer seller not stored'; END IF;
  BEGIN PERFORM create_order_confirmation(aa, ca, NULL, vu, 'Visor Sintetico', 'mem-viewer-actor', ua, pg_temp.f()); RAISE EXCEPTION 'viewer confirmed an order';
  EXCEPTION WHEN insufficient_privilege THEN IF SQLERRM <> 'actor_not_allowed' THEN RAISE; END IF; END;
  -- An actor from another account cannot confirm here either.
  BEGIN PERFORM create_order_confirmation(aa, ca, NULL, pg_temp.v('ub')::uuid, 'x', 'mem-foreign-actor', ua, pg_temp.f()); RAISE EXCEPTION 'foreign actor confirmed an order';
  EXCEPTION WHEN insufficient_privilege THEN IF SQLERRM <> 'actor_not_allowed' THEN RAISE; END IF; END;

  -- 8. Account isolation of the roster.
  IF EXISTS (SELECT 1 FROM order_seller_candidates(ab) c WHERE c.user_id IN (ua, vu, pg_temp.v('sa')::uuid)) OR EXISTS (SELECT 1 FROM order_seller_candidates(aa) c WHERE c.user_id = pg_temp.v('sb')::uuid) THEN
    RAISE EXCEPTION 'rosters must not cross accounts';
  END IF;

  -- 9. The feature switch is per account and OFF by default: an account with no settings, or with confirm_enabled = false, cannot confirm,
  --    however good its roster is. The delivery switch is a different thing (account B: feature on, delivery off => held).
  BEGIN PERFORM create_order_confirmation(ac, NULL, NULL, uc, 'x', 'feat-off-1', uc, pg_temp.f()); RAISE EXCEPTION 'feature-off account confirmed an order';
  EXCEPTION WHEN insufficient_privilege THEN IF SQLERRM <> 'feature_disabled' THEN RAISE; END IF; END;
  INSERT INTO order_integration_settings (account_id, enabled, confirm_enabled) VALUES (ac, TRUE, FALSE);
  BEGIN PERFORM create_order_confirmation(ac, NULL, NULL, uc, 'x', 'feat-off-2', uc, pg_temp.f()); RAISE EXCEPTION 'delivery switch must not enable the feature';
  EXCEPTION WHEN insufficient_privilege THEN IF SQLERRM <> 'feature_disabled' THEN RAISE; END IF; END;
  IF (SELECT count(*) FROM order_confirmations WHERE account_id = ac) <> 0 THEN RAISE EXCEPTION 'nothing may be written for a disabled account'; END IF;
  IF (SELECT delivery_status FROM order_confirmations WHERE account_id = ab LIMIT 1) <> 'held' THEN RAISE EXCEPTION 'feature on + delivery off must hold orders'; END IF;

  -- 10. Seller identity is immutable like the other references (only value -> NULL).
  BEGIN UPDATE order_confirmations SET seller_user_id = ua WHERE id = o2; RAISE EXCEPTION 'seller member re-pointed';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM LIKE 'seller member re-pointed%' THEN RAISE; END IF; END;
  BEGIN INSERT INTO order_confirmations (account_id, seller_user_id, seller_name, confirmed_by_name, request_key, customer_name, phone, product, quantity, price, destination)
        VALUES (aa, pg_temp.v('sb')::uuid, 'Vendedor B', 'x', 'direct-member-1', 'n', 'p', 'p', 1, 1, 'd'); RAISE EXCEPTION 'cross-account seller member inserted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM LIKE 'cross-account seller member%' THEN RAISE; END IF; END;
  BEGIN INSERT INTO order_confirmations (account_id, seller_user_id, seller_name, confirmed_by_name, request_key, customer_name, phone, product, quantity, price, destination)
        VALUES (aa, ua, 'Otro nombre', 'x', 'direct-member-2', 'n', 'p', 'p', 1, 1, 'd'); RAISE EXCEPTION 'wrong member name inserted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM LIKE 'wrong member name%' THEN RAISE; END IF; END;
END $$;

-- RLS: a member sees only their account; writes and the worker functions are closed to signed-in users.
DO $$
DECLARE n INTEGER;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', pg_temp.v('ua'), 'role', 'authenticated')::text, TRUE);
  PERFORM set_config('request.jwt.claim.sub', pg_temp.v('ua'), TRUE); -- older auth.uid() implementations read this setting
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO n FROM order_confirmations;
  IF n = 0 OR EXISTS (SELECT 1 FROM order_confirmations WHERE account_id <> pg_temp.v('aa')::uuid) THEN RESET ROLE; RAISE EXCEPTION 'member must see only own account orders'; END IF;
  BEGIN INSERT INTO order_confirmations (account_id) VALUES (pg_temp.v('aa')::uuid); RESET ROLE; RAISE EXCEPTION 'insert allowed to authenticated';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM claim_order_deliveries(1, 1, 1); RESET ROLE; RAISE EXCEPTION 'claim allowed to authenticated';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  RESET ROLE;
END $$;

ROLLBACK;
SELECT 'order_confirmations: all assertions passed' AS result;
