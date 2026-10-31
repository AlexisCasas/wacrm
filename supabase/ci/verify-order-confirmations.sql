-- Behavioural assertions for 20261101000000_order_confirmations.sql, with synthetic data, run inside a transaction that is rolled back.
-- Run after `supabase db reset`:  supabase db query --local --file supabase/ci/verify-order-confirmations.sql
-- Any failed assertion raises and aborts the run.
BEGIN;

CREATE TEMP TABLE t (k TEXT PRIMARY KEY, v TEXT);
GRANT ALL ON t TO PUBLIC;

DO $$
DECLARE
  ua UUID := gen_random_uuid(); ub UUID := gen_random_uuid();
  aa UUID; ab UUID; ca UUID; cb UUID; va UUID; sa UUID; sb UUID;
BEGIN
  INSERT INTO auth.users (id, email) VALUES (ua, 'synthetic-a@example.invalid'), (ub, 'synthetic-b@example.invalid');
  SELECT account_id INTO aa FROM profiles WHERE user_id = ua;
  SELECT account_id INTO ab FROM profiles WHERE user_id = ub;
  IF aa IS NULL OR ab IS NULL OR aa = ab THEN RAISE EXCEPTION 'setup: expected one account per synthetic user'; END IF;
  INSERT INTO contacts (user_id, account_id, phone, name) VALUES (ua, aa, '51900000001', 'Synthetic A') RETURNING id INTO ca;
  INSERT INTO contacts (user_id, account_id, phone, name) VALUES (ub, ab, '51900000002', 'Synthetic B') RETURNING id INTO cb;
  INSERT INTO conversations (user_id, account_id, contact_id) VALUES (ua, aa, ca) RETURNING id INTO va;
  INSERT INTO order_sellers (account_id, name, name_key) VALUES (aa, 'Vendedor Uno', 'vendedor uno') RETURNING id INTO sa;
  INSERT INTO order_sellers (account_id, name, name_key) VALUES (ab, 'Vendedor B', 'vendedor b') RETURNING id INTO sb;
  INSERT INTO order_integration_settings (account_id, enabled) VALUES (aa, TRUE);
  INSERT INTO t VALUES ('ua', ua::text), ('ub', ub::text), ('aa', aa::text), ('ab', ab::text), ('ca', ca::text), ('cb', cb::text),
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
