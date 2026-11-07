-- Synthetic data only. Runs inside a disposable PostgreSQL (no network). Each check prints PASS/FAIL; ON_ERROR_STOP is off so every check runs.
\set ON_ERROR_STOP off
CREATE TEMP TABLE r(name text, ok boolean);
CREATE FUNCTION pg_temp.chk(n text, ok boolean) RETURNS void LANGUAGE plpgsql AS $$ BEGIN INSERT INTO r VALUES (n, COALESCE(ok,false)); RAISE NOTICE '% %', CASE WHEN COALESCE(ok,false) THEN 'PASS' ELSE 'FAIL' END, n; END $$;

INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) VALUES
 ('a1000000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','qa-a@example.test','{"full_name":"QA A"}'::jsonb, now(), now()),
 ('b2000000-0000-4000-8000-000000000002','00000000-0000-0000-0000-000000000000','authenticated','authenticated','qa-b@example.test','{"full_name":"QA B"}'::jsonb, now(), now());
SELECT account_id AS acct_a FROM public.profiles WHERE user_id='a1000000-0000-4000-8000-000000000001' \gset
SELECT account_id AS acct_b FROM public.profiles WHERE user_id='b2000000-0000-4000-8000-000000000002' \gset

INSERT INTO public.contacts (id, account_id, user_id, phone, name) VALUES
 ('c0000000-0000-4000-8000-0000000000a1', :'acct_a','a1000000-0000-4000-8000-000000000001','51900000001','Con anuncio'),
 ('c0000000-0000-4000-8000-0000000000a2', :'acct_a','a1000000-0000-4000-8000-000000000001','51900000002','Sin anuncio'),
 ('c0000000-0000-4000-8000-0000000000a3', :'acct_a','a1000000-0000-4000-8000-000000000001','51900000003','Solo primera atribucion'),
 ('c0000000-0000-4000-8000-0000000000b1', :'acct_b','b2000000-0000-4000-8000-000000000002','51900000009','Otra cuenta');
-- BSUID-only contact (no phone), same shape the webhook creates; contact + identity must commit together
BEGIN;
INSERT INTO public.contacts (id, account_id, user_id, phone, name, phone_optional) VALUES
 ('c0000000-0000-4000-8000-0000000000a4', :'acct_a','a1000000-0000-4000-8000-000000000001','','Usuario BSUID', true);
INSERT INTO public.contact_identities (account_id, contact_id, kind, value) VALUES (:'acct_a','c0000000-0000-4000-8000-0000000000a4','bsuid','PE.QA0000000000001');
COMMIT;

-- attributions: a1 first AD1 (day -10), later click AD2 (day -3); a3 only legacy first attribution AD3; a4 (BSUID) AD1
INSERT INTO public.contact_ad_attributions (contact_id, account_id, source_id, ctwa_clid, headline, captured_at) VALUES
 ('c0000000-0000-4000-8000-0000000000a1', :'acct_a','AD1','CLID-A1-OLD','Oferta Laser', now()-interval '10 days'),
 ('c0000000-0000-4000-8000-0000000000a3', :'acct_a','AD3','CLID-A3','Oferta Tres', now()-interval '2 days'),
 ('c0000000-0000-4000-8000-0000000000a4', :'acct_a','AD1','CLID-A4','Oferta Laser', now()-interval '2 days'),
 ('c0000000-0000-4000-8000-0000000000b1', :'acct_b','ADB','CLID-B1','Otra', now()-interval '2 days');
INSERT INTO public.contact_ad_clicks (account_id, contact_id, ctwa_clid, source_id, captured_at) VALUES
 (:'acct_a','c0000000-0000-4000-8000-0000000000a1','CLID-A1-OLD','AD1', now()-interval '10 days'),
 (:'acct_a','c0000000-0000-4000-8000-0000000000a1','CLID-A1-NEW','AD2', now()-interval '3 days'),
 (:'acct_a','c0000000-0000-4000-8000-0000000000a1','CLID-A1-LATE','AD9', now()+interval '1 day');

-- orders (direct inserts as the table owner; the app creates them through create_order_confirmation)
INSERT INTO public.order_confirmations (id, account_id, contact_id, confirmed_at, customer_name, phone, product, quantity, price, destination, seller_name, confirmed_by_name, request_key) VALUES
 ('d0000000-0000-4000-8000-000000000001', :'acct_a','c0000000-0000-4000-8000-0000000000a1', now()-interval '1 day','C','51900000001','Laser x2 + Gel x1',3,300.00,'Lima','V','QA','k1'),
 ('d0000000-0000-4000-8000-000000000002', :'acct_a','c0000000-0000-4000-8000-0000000000a2', now()-interval '1 day','C','51900000002','Laser',1,100.00,'Lima','V','QA','k2'),
 ('d0000000-0000-4000-8000-000000000003', :'acct_a','c0000000-0000-4000-8000-0000000000a3', now()-interval '1 day','C','51900000003','Gel',2,60.00,'Lima','V','QA','k3'),
 ('d0000000-0000-4000-8000-000000000004', :'acct_a','c0000000-0000-4000-8000-0000000000a4', now()-interval '1 day','C','51900000004','Laser',1,90.00,'Lima','V','QA','k4'),
 ('d0000000-0000-4000-8000-000000000005', :'acct_a','c0000000-0000-4000-8000-0000000000a1', now()-interval '5 days','C','51900000001','Laser',1,80.00,'Lima','V','QA','k5'),
 ('d0000000-0000-4000-8000-000000000006', :'acct_b','c0000000-0000-4000-8000-0000000000b1', now()-interval '1 day','C','51900000009','Otro',1,50.00,'Lima','V','QA','k6');
INSERT INTO public.order_confirmation_items (order_id, account_id, line_number, product_name, quantity, unit_price) VALUES
 ('d0000000-0000-4000-8000-000000000001', :'acct_a',1,'Laser',2,100.00), ('d0000000-0000-4000-8000-000000000001', :'acct_a',2,'Gel',1,100.00);

-- 1. attribution resolution
SELECT pg_temp.chk('multi-click contact: latest click BEFORE the order wins (AD2), later click ignored', (SELECT source_id='AD2' AND ctwa_clid='CLID-A1-NEW' AND basis='click_history' FROM order_ad_attribution(:'acct_a') WHERE order_id='d0000000-0000-4000-8000-000000000001'));
SELECT pg_temp.chk('order before the second click resolves to the first ad (AD1)', (SELECT source_id='AD1' FROM order_ad_attribution(:'acct_a') WHERE order_id='d0000000-0000-4000-8000-000000000005'));
SELECT pg_temp.chk('contact without ad: no attribution (not invented)', NOT EXISTS (SELECT 1 FROM order_ad_attribution(:'acct_a') WHERE order_id='d0000000-0000-4000-8000-000000000002'));
SELECT pg_temp.chk('legacy first-attribution-only contact falls back to it', (SELECT source_id='AD3' AND basis='first_attribution' FROM order_ad_attribution(:'acct_a') WHERE order_id='d0000000-0000-4000-8000-000000000003'));
SELECT pg_temp.chk('BSUID-only contact is attributed like any contact', (SELECT source_id='AD1' FROM order_ad_attribution(:'acct_a') WHERE order_id='d0000000-0000-4000-8000-000000000004'));
SELECT pg_temp.chk('other account order never appears in account A resolution', NOT EXISTS (SELECT 1 FROM order_ad_attribution(:'acct_a') WHERE order_id='d0000000-0000-4000-8000-000000000006'));
SELECT pg_temp.chk('max click age: a 10-day-old click is excluded with a 7-day window', NOT EXISTS (SELECT 1 FROM order_ad_attribution(:'acct_a', 2) WHERE order_id='d0000000-0000-4000-8000-000000000005'));
DO $$ BEGIN
  BEGIN INSERT INTO public.contact_ad_clicks (account_id, contact_id, ctwa_clid) VALUES ((SELECT account_id FROM profiles WHERE user_id='a1000000-0000-4000-8000-000000000001'),'c0000000-0000-4000-8000-0000000000b1','X'); PERFORM pg_temp.chk('cross-account click insert blocked', false);
  EXCEPTION WHEN foreign_key_violation THEN PERFORM pg_temp.chk('cross-account click insert blocked', true); END;
  BEGIN INSERT INTO public.contact_ad_clicks (account_id, contact_id, ctwa_clid) VALUES ((SELECT account_id FROM profiles WHERE user_id='a1000000-0000-4000-8000-000000000001'),'c0000000-0000-4000-8000-0000000000a1','CLID-A1-NEW'); PERFORM pg_temp.chk('duplicate click (same clid) blocked', false);
  EXCEPTION WHEN unique_violation THEN PERFORM pg_temp.chk('duplicate click (same clid) blocked', true); END;
END $$;

-- 2. settings are OFF by default and constrained
SELECT pg_temp.chk('no settings row exists for any account after migration', NOT EXISTS (SELECT 1 FROM meta_capi_settings));
SELECT pg_temp.chk('enqueue with no settings queues nothing', meta_capi_enqueue() = 0);
DO $$ DECLARE a uuid := (SELECT account_id FROM profiles WHERE user_id='a1000000-0000-4000-8000-000000000001'); BEGIN
  BEGIN INSERT INTO meta_capi_settings (account_id, enabled) VALUES (a, true); PERFORM pg_temp.chk('cannot enable without dataset/WABA/token/activation', false);
  EXCEPTION WHEN check_violation THEN PERFORM pg_temp.chk('cannot enable without dataset/WABA/token/activation', true); END;
  BEGIN INSERT INTO meta_capi_settings (account_id, send_purchase) VALUES (a, true); PERFORM pg_temp.chk('Purchase is locked off', false);
  EXCEPTION WHEN check_violation THEN PERFORM pg_temp.chk('Purchase is locked off', true); END;
  BEGIN INSERT INTO meta_capi_settings (account_id, send_order_canceled) VALUES (a, true); PERFORM pg_temp.chk('OrderCanceled is locked off', false);
  EXCEPTION WHEN check_violation THEN PERFORM pg_temp.chk('OrderCanceled is locked off', true); END;
END $$;
-- configured but switch off: still nothing
INSERT INTO meta_capi_settings (account_id, enabled, dataset_id, waba_id, access_token_enc, send_order_created, activated_at)
 VALUES (:'acct_a', false, '111111111', '222222222', 'enc-a', true, now()-interval '2 days');
SELECT pg_temp.chk('configured but enabled=false: nothing queued', meta_capi_enqueue() = 0);

-- 3. enable account A (activated 2 days ago => only the 1-day-old orders qualify, not the 5-day-old one)
UPDATE meta_capi_settings SET enabled = true WHERE account_id = :'acct_a';
SELECT meta_capi_enqueue() AS n1 \gset
SELECT pg_temp.chk('enqueue creates 3 events (a1, a3, a4 orders; none for no-ad contact, pre-activation order or account B)', :n1 = 3);
SELECT pg_temp.chk('second enqueue creates no duplicates', meta_capi_enqueue() = 0);
SELECT pg_temp.chk('event uses the resolved click and the order total', (SELECT ctwa_clid='CLID-A1-NEW' AND value=300.00 AND currency='PEN' AND event_id = 'wacrm:'||account_id||':'||order_id||':OrderCreated' FROM meta_capi_events WHERE order_id='d0000000-0000-4000-8000-000000000001'));
SELECT pg_temp.chk('multi-product order is ONE event (total, not per line)', (SELECT count(*)=1 FROM meta_capi_events WHERE order_id='d0000000-0000-4000-8000-000000000001'));
SELECT pg_temp.chk('no events for account B (no settings)', NOT EXISTS (SELECT 1 FROM meta_capi_events WHERE account_id=:'acct_b'));

-- 4. claim / finish
SELECT count(*) AS c1 FROM meta_capi_claim(2, 120, 6) \gset
SELECT pg_temp.chk('claim honours the limit and leases rows', :c1 = 2 AND (SELECT count(*) FROM meta_capi_events WHERE status='sending') = 2);
SELECT pg_temp.chk('a second claim does not re-lease rows already leased', (SELECT count(*) FROM meta_capi_claim(10,120,6)) = 1);
SELECT id AS e1 FROM meta_capi_events WHERE status='sending' ORDER BY created_at, id LIMIT 1 \gset
SELECT pg_temp.chk('stale attempt number is ignored', meta_capi_finish(:'e1', 99, 'sent', 200, NULL, NULL, NULL) = 'stale');
SELECT pg_temp.chk('retry reschedules as pending', meta_capi_finish(:'e1', 1, 'retry', 503, 'http_503', 'http 503', now()+interval '1 hour') = 'pending');
SELECT pg_temp.chk('rescheduled event is not claimable yet', NOT EXISTS (SELECT 1 FROM meta_capi_claim(10,120,6) WHERE id = :'e1'));
UPDATE meta_capi_events SET next_attempt_at = now() WHERE id = :'e1';
SELECT pg_temp.chk('after the delay it is claimed again (attempt 2)', (SELECT attempts = 2 FROM meta_capi_claim(10,120,6) WHERE id = :'e1'));
SELECT pg_temp.chk('success marks sent', meta_capi_finish(:'e1', 2, 'sent', 200, NULL, NULL, NULL) = 'sent');
SELECT pg_temp.chk('a sent event is never claimed again', NOT EXISTS (SELECT 1 FROM meta_capi_claim(10,120,6) WHERE id = :'e1'));
SELECT pg_temp.chk('attempts are logged (503 then sent) with no secrets', (SELECT count(*)=2 AND bool_and(detail IS NULL OR detail !~* 'token|EAA') FROM meta_capi_attempts WHERE event_row_id = :'e1'));
SELECT id AS e2 FROM meta_capi_events WHERE status='sending' LIMIT 1 \gset
SELECT pg_temp.chk('rejected (4xx) is failed, not retried', meta_capi_finish(:'e2', 1, 'rejected', 400, 'meta_100', 'http 400', NULL) = 'failed');
SELECT id AS e3 FROM meta_capi_events WHERE status='sending' LIMIT 1 \gset
SELECT pg_temp.chk('attempts exhausted becomes dead', meta_capi_finish(:'e3', 1, 'retry', 500, 'http_500', 'x', now(), 1) = 'dead');
SELECT pg_temp.chk('fresh enqueue after sent/failed/dead does not resurrect events', meta_capi_enqueue() = 0);

-- 5. hourly limit + auth circuit breaker + manual kill switch
INSERT INTO order_confirmations (id, account_id, contact_id, confirmed_at, customer_name, phone, product, quantity, price, destination, seller_name, confirmed_by_name, request_key)
 VALUES ('d0000000-0000-4000-8000-000000000007', :'acct_a','c0000000-0000-4000-8000-0000000000a3', now(),'C','51900000003','Gel',1,30.00,'Lima','V','QA','k7'),
        ('d0000000-0000-4000-8000-000000000008', :'acct_a','c0000000-0000-4000-8000-0000000000a3', now(),'C','51900000003','Gel',1,31.00,'Lima','V','QA','k8');
SELECT pg_temp.chk('new orders are queued', meta_capi_enqueue() = 2);
UPDATE meta_capi_settings SET hourly_limit = 1 WHERE account_id = :'acct_a';
SELECT pg_temp.chk('hourly limit: attempts in the last hour already exceed it => nothing claimed', (SELECT count(*) FROM meta_capi_claim(10,120,6)) = 0);
UPDATE meta_capi_settings SET hourly_limit = 2000 WHERE account_id = :'acct_a';
SELECT id AS e4, attempts AS a4 FROM meta_capi_claim(1,120,6) \gset
SELECT meta_capi_finish(:'e4', :a4, 'auth', 401, 'meta_190', 'http 401 code 190', now()+interval '1 hour') AS authres \gset
SELECT pg_temp.chk('auth error keeps the event pending (retry later)', :'authres' = 'pending');
SELECT pg_temp.chk('auth error switches the account off (circuit breaker)', NOT (SELECT enabled FROM meta_capi_settings WHERE account_id=:'acct_a') AND (SELECT disabled_reason FROM meta_capi_settings WHERE account_id=:'acct_a')='auth_error');
SELECT pg_temp.chk('disabled account: enqueue and claim do nothing', meta_capi_enqueue() = 0 AND (SELECT count(*) FROM meta_capi_claim(10,120,6)) = 0);
UPDATE meta_capi_settings SET enabled = true, disabled_reason = NULL WHERE account_id = :'acct_a';
SELECT pg_temp.chk('manual disable returns true then false', meta_capi_disable(:'acct_a','manual') AND NOT meta_capi_disable(:'acct_a','manual'));

-- 6. report (as an authenticated member of A / of B / anonymous)
CREATE FUNCTION pg_temp.rep(p_user text, p_acct uuid) RETURNS jsonb LANGUAGE plpgsql AS $$ DECLARE j jsonb; BEGIN
  PERFORM set_config('request.jwt.claim.sub', p_user, true); PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role','authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT COALESCE(jsonb_agg(to_jsonb(x)), '[]') INTO j FROM ads_results_report(p_acct, now()-interval '30 days', now()+interval '2 days') x;
  RESET ROLE; RETURN j; END $$;
SELECT pg_temp.rep('a1000000-0000-4000-8000-000000000001', :'acct_a') AS repa \gset
SELECT pg_temp.chk('report: unattributed orders are in their own row (source NULL)', (:'repa'::jsonb) @> '[{"source_id": null, "orders": 1}]'::jsonb);
SELECT pg_temp.chk('report: orders of the same contact before/after a second ad are split by evidence (AD1: 2 orders, AD2: 1, AD3: 3)',
  (SELECT bool_and(ok) FROM (VALUES ((:'repa'::jsonb) @> '[{"source_id":"AD1","orders":2}]'::jsonb), ((:'repa'::jsonb) @> '[{"source_id":"AD2","orders":1}]'::jsonb), ((:'repa'::jsonb) @> '[{"source_id":"AD3","orders":3}]'::jsonb)) t(ok)));
SELECT pg_temp.chk('report: multi-product units and products by name', (:'repa'::jsonb) @> '[{"source_id":"AD2","units":3}]'::jsonb AND (:'repa'::jsonb) @> '[{"source_id":"AD2","products":[{"name":"Laser","units":2},{"name":"Gel","units":1}]}]'::jsonb);
SELECT pg_temp.chk('report: total distinct orders in A = 7 (no double counting)', (SELECT sum((x->>'orders')::int) = 7 FROM jsonb_array_elements(:'repa'::jsonb) x));
SELECT pg_temp.chk('report: account B data never leaks into A', NOT ((:'repa'::jsonb) @> '[{"source_id":"ADB"}]'::jsonb));
SELECT pg_temp.rep('b2000000-0000-4000-8000-000000000002', :'acct_a') AS repx \gset
SELECT pg_temp.chk('report: member of B asking for A gets nothing', :'repx'::jsonb = '[]'::jsonb);
SELECT pg_temp.rep('b2000000-0000-4000-8000-000000000002', :'acct_b') AS repb \gset
SELECT pg_temp.chk('report: B sees only its own ad', (:'repb'::jsonb) @> '[{"source_id":"ADB"}]'::jsonb AND NOT ((:'repb'::jsonb) @> '[{"source_id":"AD1"}]'::jsonb));

-- 7. RLS / grants (results are collected while the role is switched and recorded after RESET ROLE)
DO $$ DECLARE t boolean[] := '{}'; BEGIN
  PERFORM set_config('request.jwt.claim.sub','a1000000-0000-4000-8000-000000000001', true);
  SET LOCAL ROLE authenticated;
  BEGIN PERFORM access_token_enc FROM meta_capi_settings; t := t || false; EXCEPTION WHEN insufficient_privilege THEN t := t || true; END;
  BEGIN PERFORM meta_capi_enqueue(); t := t || false; EXCEPTION WHEN insufficient_privilege THEN t := t || true; END;
  BEGIN INSERT INTO meta_capi_events (account_id, order_id, event_name, event_id, ctwa_clid, event_time) VALUES (gen_random_uuid(), gen_random_uuid(), 'OrderCreated','x','x',now()); t := t || false; EXCEPTION WHEN insufficient_privilege THEN t := t || true; END;
  RESET ROLE;
  PERFORM pg_temp.chk('authenticated cannot read the encrypted token column', t[1]);
  PERFORM pg_temp.chk('authenticated cannot call the queue functions', t[2]);
  PERFORM pg_temp.chk('authenticated cannot write the queue', t[3]);
END $$;
SELECT 'RESULT ' || count(*) FILTER (WHERE ok) || ' passed, ' || count(*) FILTER (WHERE NOT ok) || ' failed' AS summary FROM r;
