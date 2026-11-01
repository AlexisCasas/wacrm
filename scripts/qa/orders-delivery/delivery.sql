\set QUIET on
\set ON_ERROR_STOP on
SET client_min_messages = notice;

CREATE FUNCTION pg_temp.ok(p_name text, p_cond boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', p_name; END IF; RAISE NOTICE 'PASS: %', p_name; END $$;

ALTER TABLE public.profiles DISABLE TRIGGER USER; ALTER TABLE public.accounts DISABLE TRIGGER USER;
INSERT INTO auth.users (id, aud, role, email) VALUES
  ('a0000000-0000-4000-8000-000000000001','authenticated','authenticated','p-owner@qa.test'),
  ('a0000000-0000-4000-8000-000000000002','authenticated','authenticated','p-agent@qa.test'),
  ('b0000000-0000-4000-8000-000000000001','authenticated','authenticated','q-owner@qa.test');
INSERT INTO public.accounts (id, name, owner_user_id) VALUES
  ('aaaaaaaa-0000-4000-8000-00000000000a','Piloto','a0000000-0000-4000-8000-000000000001'),
  ('bbbbbbbb-0000-4000-8000-00000000000b','Otra cuenta','b0000000-0000-4000-8000-000000000001');
INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role) VALUES
  ('a0000000-0000-4000-8000-000000000001','Owner P','p-owner@qa.test','aaaaaaaa-0000-4000-8000-00000000000a','owner'),
  ('a0000000-0000-4000-8000-000000000002','Agente P','p-agent@qa.test','aaaaaaaa-0000-4000-8000-00000000000a','agent'),
  ('b0000000-0000-4000-8000-000000000001','Owner Q','q-owner@qa.test','bbbbbbbb-0000-4000-8000-00000000000b','owner');
ALTER TABLE public.profiles ENABLE TRIGGER USER; ALTER TABLE public.accounts ENABLE TRIGGER USER;
INSERT INTO public.contacts (id, user_id, account_id, phone, name) VALUES
  ('a1111111-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-00000000000a','900000001','Cliente P'),
  ('b1111111-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','bbbbbbbb-0000-4000-8000-00000000000b','900000002','Cliente Q');
INSERT INTO public.order_integration_settings (account_id, confirm_enabled, enabled) VALUES
  ('aaaaaaaa-0000-4000-8000-00000000000a', TRUE, FALSE), ('bbbbbbbb-0000-4000-8000-00000000000b', TRUE, FALSE);

CREATE FUNCTION pg_temp.mk(p_acct uuid, p_contact uuid, p_actor uuid, p_seller uuid, p_key text) RETURNS uuid LANGUAGE sql AS $$
  SELECT order_id FROM create_order_confirmation(p_acct, p_contact, NULL, p_actor, 'Agente', p_key, p_seller,
    jsonb_build_object('customer_name','Cliente','phone','900000001','product','Prod '||p_key,'quantity',1,'price',100,'destination','Lima'))
$$;
CREATE FUNCTION pg_temp.st(p_key text) RETURNS text LANGUAGE sql AS $$ SELECT delivery_status FROM order_confirmations WHERE request_key = p_key $$;

-- 1. Two orders are created while the switch is OFF: they are `held`.
SELECT pg_temp.mk('aaaaaaaa-0000-4000-8000-00000000000a','a1111111-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','held1');
SELECT pg_temp.mk('aaaaaaaa-0000-4000-8000-00000000000a','a1111111-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000002','held2');
SELECT pg_temp.mk('bbbbbbbb-0000-4000-8000-00000000000b','b1111111-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','q-held');
-- A pending row in an account WITHOUT the switch (forced: e.g. the switch was turned off after creation).
INSERT INTO order_confirmations (account_id, contact_id, confirmed_by_name, seller_name, request_key, customer_name, phone, product, quantity, price, destination, delivery_status)
  VALUES ('bbbbbbbb-0000-4000-8000-00000000000b','b1111111-0000-4000-8000-000000000001','x','x','q-pending-off','c','9','p',1,1,'d','pending');
DO $t$ DECLARE n int; BEGIN
  PERFORM pg_temp.ok('orders made with the switch off are held', pg_temp.st('held1') = 'held' AND pg_temp.st('held2') = 'held');
  SELECT count(*) INTO n FROM claim_order_deliveries(10, 120, 8); PERFORM pg_temp.ok('nothing is claimed while no account has delivery on', n = 0);
END $t$;

-- 2. Turn delivery ON for the pilot account only.
UPDATE order_integration_settings SET enabled = TRUE WHERE account_id = 'aaaaaaaa-0000-4000-8000-00000000000a';
DO $t$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM claim_order_deliveries(10, 120, 8);
  PERFORM pg_temp.ok('switching the account on does NOT claim the held orders', n = 0);
  PERFORM pg_temp.ok('the held orders stay held with 0 attempts and no delivery rows',
    (SELECT count(*) FROM order_confirmations WHERE request_key IN ('held1','held2') AND delivery_status = 'held' AND attempts = 0 AND sent_at IS NULL) = 2
    AND (SELECT count(*) FROM order_confirmation_deliveries) = 0);
  PERFORM pg_temp.ok('a pending row of an account without the switch is not claimed either', pg_temp.st('q-pending-off') = 'pending');
END $t$;

-- 3. A NEW order of the pilot account is pending and is the only thing claimed.
SELECT pg_temp.mk('aaaaaaaa-0000-4000-8000-00000000000a','a1111111-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','new1');
DO $t$ DECLARE n int; r record; oid uuid; BEGIN
  PERFORM pg_temp.ok('a new order of the pilot account is pending', pg_temp.st('new1') = 'pending');
  SELECT count(*) INTO n FROM claim_order_deliveries(10, 120, 8);
  PERFORM pg_temp.ok('exactly the new order is claimed (1 row), attempt 1, now sending', n = 1 AND pg_temp.st('new1') = 'sending');
  SELECT count(*) INTO n FROM claim_order_deliveries(10, 120, 8);
  PERFORM pg_temp.ok('a second tick claims nothing while the lease holds (no double send)', n = 0);
  PERFORM pg_temp.ok('held and other-account rows still untouched after the claim',
    (SELECT count(*) FROM order_confirmations WHERE request_key IN ('held1','held2','q-held') AND delivery_status = 'held' AND attempts = 0) = 3
    AND pg_temp.st('q-pending-off') = 'pending');
  SELECT o.id INTO oid FROM order_confirmations o WHERE request_key = 'new1';
  PERFORM pg_temp.ok('finish: sent', finish_order_delivery(oid, 1, 'sent', 201, NULL, NULL, gen_random_uuid(), NULL, 8) = 'sent');
  PERFORM pg_temp.ok('a stale finish for the same attempt is ignored', finish_order_delivery(oid, 1, 'sent', 201, NULL, NULL, gen_random_uuid(), NULL, 8) = 'ignored');
  PERFORM pg_temp.ok('reconciliation: sent -> acknowledged', acknowledge_order_delivery(oid, gen_random_uuid()) AND pg_temp.st('new1') = 'acknowledged');
  PERFORM pg_temp.ok('a held order can never be acknowledged', NOT acknowledge_order_delivery((SELECT x.id FROM order_confirmations x WHERE x.request_key='held1'), gen_random_uuid()) AND pg_temp.st('held1') = 'held');
  PERFORM pg_temp.ok('finish on a held order is ignored', finish_order_delivery((SELECT x.id FROM order_confirmations x WHERE x.request_key='held2'), 1, 'sent', 201, NULL, NULL, gen_random_uuid(), NULL, 8) = 'ignored' AND pg_temp.st('held2') = 'held');
END $t$;

-- 4. Rejected -> failed (no automatic retry); retries -> pending with backoff -> dead after the maximum.
SELECT pg_temp.mk('aaaaaaaa-0000-4000-8000-00000000000a','a1111111-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','rej1');
SELECT count(*) AS claimed_rej1 FROM claim_order_deliveries(10, 120, 8);
DO $t$ DECLARE oid uuid; BEGIN
  SELECT o.id INTO oid FROM order_confirmations o WHERE request_key = 'rej1';
  PERFORM pg_temp.ok('4xx: failed', finish_order_delivery(oid, 1, 'rejected', 422, 'invalid_order', 'receiver rejected the order (422)', NULL, NULL, 8) = 'failed');
  PERFORM pg_temp.ok('a failed order is never claimed again', (SELECT count(*) FROM claim_order_deliveries(10, 120, 8)) = 0 AND pg_temp.st('rej1') = 'failed');
END $t$;

