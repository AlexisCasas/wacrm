-- Synthetic data only, disposable PostgreSQL. Each check prints PASS/FAIL.
\set ON_ERROR_STOP off
CREATE TEMP TABLE r(name text, ok boolean);
CREATE FUNCTION pg_temp.chk(n text, ok boolean) RETURNS void LANGUAGE plpgsql AS $$ BEGIN INSERT INTO r VALUES (n, COALESCE(ok,false)); RAISE NOTICE '% %', CASE WHEN COALESCE(ok,false) THEN 'PASS' ELSE 'FAIL' END, n; END $$;

INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) VALUES
 ('a1000000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','qa-a@example.test','{"full_name":"QA A"}'::jsonb, now(), now()),
 ('b2000000-0000-4000-8000-000000000002','00000000-0000-0000-0000-000000000000','authenticated','authenticated','qa-b@example.test','{"full_name":"QA B"}'::jsonb, now(), now());
SELECT account_id AS acct_a FROM public.profiles WHERE user_id='a1000000-0000-4000-8000-000000000001' \gset
SELECT account_id AS acct_b FROM public.profiles WHERE user_id='b2000000-0000-4000-8000-000000000002' \gset

INSERT INTO public.contacts (id, account_id, user_id, phone, name) VALUES
 ('c0000000-0000-4000-8000-0000000000a1', :'acct_a','a1000000-0000-4000-8000-000000000001','51900000001','c1'),
 ('c0000000-0000-4000-8000-0000000000a2', :'acct_a','a1000000-0000-4000-8000-000000000001','51900000002','c2'),
 ('c0000000-0000-4000-8000-0000000000a3', :'acct_a','a1000000-0000-4000-8000-000000000001','51900000003','c3'),
 ('c0000000-0000-4000-8000-0000000000b1', :'acct_b','b2000000-0000-4000-8000-000000000002','51900000009','cb');
INSERT INTO public.contact_ad_attributions (contact_id, account_id, source_id, ctwa_clid, headline, captured_at) VALUES
 ('c0000000-0000-4000-8000-0000000000a1', :'acct_a','AD1','CL1','Oferta', now()-interval '20 days'),
 ('c0000000-0000-4000-8000-0000000000a3', :'acct_a','AD1','CL3','Oferta', now()-interval '20 days');

INSERT INTO public.order_confirmations (id, account_id, contact_id, confirmed_at, customer_name, phone, product, quantity, price, destination, seller_name, confirmed_by_name, request_key) VALUES
 ('d0000000-0000-4000-8000-000000000001', :'acct_a','c0000000-0000-4000-8000-0000000000a1', now()-interval '1 day','C','51900000001','2 x Laser'||E'\n'||'1 x Gel',3,250.00,'Lima','V','QA','k1'),
 ('d0000000-0000-4000-8000-000000000002', :'acct_a','c0000000-0000-4000-8000-0000000000a1', now()-interval '2 days','C','51900000001','Laser',1,100.00,'Lima','V','QA','k2'),
 ('d0000000-0000-4000-8000-000000000003', :'acct_a','c0000000-0000-4000-8000-0000000000a2', now()-interval '3 days','C','51900000002','laser ',1,90.00,'Lima','V','QA','k3'),
 ('d0000000-0000-4000-8000-000000000004', :'acct_a','c0000000-0000-4000-8000-0000000000a2', now()-interval '40 days','C','51900000002','Gel',1,50.00,'Lima','V','QA','k4'),
 ('d0000000-0000-4000-8000-000000000005', :'acct_a','c0000000-0000-4000-8000-0000000000a3', now()-interval '1 day','C','51900000003','Gel + Gel',3,140.00,'Lima','V','QA','k5'),
 ('d0000000-0000-4000-8000-000000000006', :'acct_b','c0000000-0000-4000-8000-0000000000b1', now()-interval '1 day','C','51900000009','Laser',5,999.00,'Lima','V','QA','k6');
INSERT INTO public.order_confirmation_items (order_id, account_id, line_number, product_name, quantity, unit_price) VALUES
 ('d0000000-0000-4000-8000-000000000001', :'acct_a',1,'Laser',2,100.00), ('d0000000-0000-4000-8000-000000000001', :'acct_a',2,'Gel',1,50.00),
 ('d0000000-0000-4000-8000-000000000002', :'acct_a',1,'Laser',1,100.00),
 ('d0000000-0000-4000-8000-000000000005', :'acct_a',1,'Gel',1,50.00), ('d0000000-0000-4000-8000-000000000005', :'acct_a',2,'Gel',2,45.00),
 ('d0000000-0000-4000-8000-000000000006', :'acct_b',1,'Laser',5,199.80);

CREATE FUNCTION pg_temp.asuser(p_user text, p_sql text) RETURNS jsonb LANGUAGE plpgsql AS $$ DECLARE j jsonb; BEGIN
  PERFORM set_config('request.jwt.claim.sub', p_user, true); PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role','authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  EXECUTE 'SELECT COALESCE(jsonb_agg(to_jsonb(x)), ''[]'') FROM (' || p_sql || ') x' INTO j;
  RESET ROLE; RETURN j; END $$;

SELECT pg_temp.asuser('a1000000-0000-4000-8000-000000000001', format($q$SELECT * FROM ads_results_by_product(%L, now()-interval '30 days', now()+interval '1 day')$q$, :'acct_a')) AS p30 \gset
SELECT pg_temp.asuser('a1000000-0000-4000-8000-000000000001', format($q$SELECT * FROM ads_results_by_product(%L, now()-interval '90 days', now()+interval '1 day')$q$, :'acct_a')) AS p90 \gset
SELECT pg_temp.asuser('a1000000-0000-4000-8000-000000000001', format($q$SELECT * FROM ads_results_by_product(%L, now()-interval '7 days', now()+interval '1 day')$q$, :'acct_a')) AS p7 \gset

SELECT pg_temp.chk('Laser 30d: 2 buyers, 3 orders, 4 units, sales 390 (item-level + legacy header), 1 legacy order, name variants merged',
  (:'p30'::jsonb) @> '[{"product":"Laser","buyers":2,"orders":3,"units":4,"sales":390.00,"legacy_orders":1}]'::jsonb);
SELECT pg_temp.chk('Gel 30d: 2 buyers, 2 orders (same order with 2 Gel lines counts once), 4 units, sales 190',
  (:'p30'::jsonb) @> '[{"product":"Gel","buyers":2,"orders":2,"units":4,"sales":190.00,"legacy_orders":0}]'::jsonb);
SELECT pg_temp.chk('same buyer, two orders of Laser: buyers stays distinct (c1 counted once, c2 via legacy)', (SELECT (x->>'buyers')::int = 2 AND (x->>'orders')::int = 3 FROM jsonb_array_elements(:'p30'::jsonb) x WHERE x->>'product'='Laser'));
SELECT pg_temp.chk('multi-product order: sales assigned by item subtotal (Laser 200 + Gel 50), nothing prorated',
  (SELECT bool_and(ok) FROM (VALUES ((:'p7'::jsonb) @> '[{"product":"Laser","sales":390.00}]'::jsonb), ((:'p7'::jsonb) @> '[{"product":"Gel","sales":190.00}]'::jsonb)) t(ok)));
SELECT pg_temp.chk('sorted by sales DESC', (SELECT (:'p30'::jsonb)->0->>'product' = 'Laser'));
SELECT pg_temp.chk('90d includes the 40-day-old legacy Gel order; 30d does not',
  (:'p90'::jsonb) @> '[{"product":"Gel","orders":3,"units":5,"sales":240.00,"legacy_orders":1}]'::jsonb);
SELECT pg_temp.chk('sum of product sales (30d) = sum of order prices (30d) = 580: no double counting, no loss',
  (SELECT SUM((x->>'sales')::numeric) = 580 FROM jsonb_array_elements(:'p30'::jsonb) x));
SELECT pg_temp.chk('account B order never leaks into A', NOT ((:'p30'::jsonb) @> '[{"units":5}]'::jsonb) AND NOT ((:'p90'::jsonb)::text LIKE '%999%'));

SELECT pg_temp.asuser('b2000000-0000-4000-8000-000000000002', format($q$SELECT * FROM ads_results_by_product(%L, now()-interval '30 days', now()+interval '1 day')$q$, :'acct_a')) AS px \gset
SELECT pg_temp.chk('member of B asking for A gets nothing', :'px'::jsonb = '[]'::jsonb);
SELECT pg_temp.asuser('b2000000-0000-4000-8000-000000000002', format($q$SELECT * FROM ads_results_by_product(%L, now()-interval '30 days', now()+interval '1 day')$q$, :'acct_b')) AS pb \gset
SELECT pg_temp.chk('B sees only its own product', :'pb'::jsonb @> '[{"product":"Laser","units":5,"sales":999.00}]'::jsonb AND jsonb_array_length(:'pb'::jsonb) = 1);


-- existing report untouched and consistent
SELECT pg_temp.asuser('a1000000-0000-4000-8000-000000000001', format($q$SELECT * FROM ads_results_report(%L, now()-interval '30 days', now()+interval '1 day')$q$, :'acct_a')) AS rep \gset
SELECT pg_temp.chk('existing ads_results_report still returns AD1 with 3 orders and amount 490', :'rep'::jsonb @> '[{"source_id":"AD1","orders":3,"order_amount":490.00}]'::jsonb);

SELECT pg_temp.chk('function is read-only: STABLE and SECURITY INVOKER', (SELECT provolatile = 's' AND NOT prosecdef FROM pg_proc WHERE proname = 'ads_results_by_product'));
SELECT pg_temp.chk('only service_role/authenticated can execute (no PUBLIC/anon grant)', (SELECT NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND has_function_privilege('service_role', p.oid, 'EXECUTE') FROM pg_proc p WHERE p.proname = 'ads_results_by_product'));
DO $$ DECLARE t boolean[] := '{}'; BEGIN
  SET LOCAL ROLE anon;
  BEGIN PERFORM * FROM ads_results_by_product(gen_random_uuid(), now()-interval '1 day', now()); t[1] := false; EXCEPTION WHEN insufficient_privilege THEN t[1] := true; END;
  RESET ROLE;
  PERFORM pg_temp.chk('anon cannot execute the product function', t[1]);
END $$;

-- ================= ads_results_product_ad_breakdown (product -> ad drilldown) =================
-- Extra synthetic scenario on account A (added AFTER every check above, so those expectations are untouched):
--   c4 clicked AD2 (10 days ago) and bought Laser (order 7, AD2); c1 clicked AD2 again 12 h ago and bought Laser once more (order 8 => AD2) while his
--   earlier Laser orders (1, 2) resolve to AD1 => the same buyer appears under two ads. Order 3 ('laser ' legacy header, contact c2 without click) is unattributed.
INSERT INTO public.contacts (id, account_id, user_id, phone, name) VALUES
 ('c0000000-0000-4000-8000-0000000000a4', :'acct_a','a1000000-0000-4000-8000-000000000001','51900000004','c4');
INSERT INTO public.contact_ad_attributions (contact_id, account_id, source_id, ctwa_clid, headline, captured_at) VALUES
 ('c0000000-0000-4000-8000-0000000000a4', :'acct_a','AD2','CL4','Segundo', now()-interval '10 days');
INSERT INTO public.contact_ad_clicks (account_id, contact_id, ctwa_clid, source_id, captured_at) VALUES
 (:'acct_a','c0000000-0000-4000-8000-0000000000a1','CL1b','AD2', now()-interval '12 hours');
INSERT INTO public.order_confirmations (id, account_id, contact_id, confirmed_at, customer_name, phone, product, quantity, price, destination, seller_name, confirmed_by_name, request_key) VALUES
 ('d0000000-0000-4000-8000-000000000007', :'acct_a','c0000000-0000-4000-8000-0000000000a4', now()-interval '2 days','C','51900000004','Laser',1,100.00,'Lima','V','QA','k7'),
 ('d0000000-0000-4000-8000-000000000008', :'acct_a','c0000000-0000-4000-8000-0000000000a1', now()-interval '6 hours','C','51900000001','Laser',1,100.00,'Lima','V','QA','k8');
INSERT INTO public.order_confirmation_items (order_id, account_id, line_number, product_name, quantity, unit_price) VALUES
 ('d0000000-0000-4000-8000-000000000007', :'acct_a',1,'Laser',1,100.00), ('d0000000-0000-4000-8000-000000000008', :'acct_a',1,'Laser',1,100.00);

SELECT pg_temp.asuser('a1000000-0000-4000-8000-000000000001', format($q$SELECT * FROM ads_results_product_ad_breakdown(%L, now()-interval '30 days', now()+interval '1 day')$q$, :'acct_a')) AS bd30 \gset
SELECT pg_temp.asuser('a1000000-0000-4000-8000-000000000001', format($q$SELECT * FROM ads_results_product_ad_breakdown(%L, now()-interval '90 days', now()+interval '1 day')$q$, :'acct_a')) AS bd90 \gset
SELECT pg_temp.asuser('a1000000-0000-4000-8000-000000000001', format($q$SELECT * FROM ads_results_by_product(%L, now()-interval '90 days', now()+interval '1 day')$q$, :'acct_a')) AS bp90 \gset
SELECT pg_temp.asuser('a1000000-0000-4000-8000-000000000001', format($q$SELECT * FROM ads_results_report(%L, now()-interval '90 days', now()+interval '1 day')$q$, :'acct_a')) AS rp90 \gset

SELECT pg_temp.chk('breakdown: same orders/units/sales per product as ads_results_by_product (90d, every product)',
  (SELECT bool_and(p.orders = a.o AND p.units = a.u AND p.sales = a.s) AND count(*) = (SELECT count(*) FROM jsonb_array_elements(:'bp90'::jsonb))
   FROM jsonb_to_recordset(:'bp90'::jsonb) AS p(product text, orders bigint, units bigint, sales numeric)
   JOIN (SELECT b.product, sum(b.orders) o, sum(b.units) u, sum(b.sales) s FROM jsonb_to_recordset(:'bd90'::jsonb) AS b(product text, source_id text, orders bigint, units bigint, sales numeric) GROUP BY b.product) a USING (product)));
SELECT pg_temp.chk('breakdown: same product display names as ads_results_by_product (no extra, no missing)',
  (SELECT array_agg(DISTINCT product ORDER BY product) FROM jsonb_to_recordset(:'bd90'::jsonb) AS b(product text)) = (SELECT array_agg(product ORDER BY product) FROM jsonb_to_recordset(:'bp90'::jsonb) AS p(product text)));
SELECT pg_temp.chk('breakdown: per ad (incl. the unattributed bucket) units and amounts equal ads_results_report => SAME order->ad resolution',
  (SELECT bool_and(coalesce(r.units,-1) = a.u AND coalesce(r.order_amount,-1) = a.s) FROM
     (SELECT b.source_id, sum(b.units) u, sum(b.sales) s FROM jsonb_to_recordset(:'bd90'::jsonb) AS b(source_id text, units bigint, sales numeric) GROUP BY b.source_id) a
     LEFT JOIN jsonb_to_recordset(:'rp90'::jsonb) AS r(source_id text, units bigint, order_amount numeric) ON coalesce(r.source_id,'~') = coalesce(a.source_id,'~')));
SELECT pg_temp.chk('Laser (30d): AD1 = 1 buyer, 2 orders, 3 units, 300 (multi-product order 1 keeps its own Laser subtotal)',
  (:'bd30'::jsonb) @> '[{"product":"Laser","source_id":"AD1","buyers":1,"orders":2,"units":3,"sales":300.00}]'::jsonb);
SELECT pg_temp.chk('Laser (30d): AD2 = 2 buyers (c4 and c1), 2 orders, 2 units, 200',
  (:'bd30'::jsonb) @> '[{"product":"Laser","source_id":"AD2","buyers":2,"orders":2,"units":2,"sales":200.00}]'::jsonb);
SELECT pg_temp.chk('Laser (30d): unattributed bucket = legacy header order 3 (name variant "laser " merged), 90',
  (:'bd30'::jsonb) @> '[{"product":"Laser","source_id":null,"buyers":1,"orders":1,"units":1,"sales":90.00}]'::jsonb);
SELECT pg_temp.chk('repeated buyer across ads: Laser buckets add 4 buyers but the product has 3 distinct buyers',
  (SELECT sum((x->>'buyers')::int) FROM jsonb_array_elements(:'bd30'::jsonb) x WHERE x->>'product'='Laser') = 4
  AND (SELECT (x->>'buyers')::int FROM jsonb_array_elements(:'bp90'::jsonb) x WHERE x->>'product'='Laser') = 3);
SELECT pg_temp.chk('Gel (30d): product with ONE ad (AD1) and nothing unattributed: 2 buyers, 2 orders, 4 units, 190 (two Gel lines of order 5 count once as an order)',
  (:'bd30'::jsonb) @> '[{"product":"Gel","source_id":"AD1","buyers":2,"orders":2,"units":4,"sales":190.00}]'::jsonb
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(:'bd30'::jsonb) x WHERE x->>'product'='Gel' AND x->>'source_id' IS NULL));
SELECT pg_temp.chk('Gel (90d): ad + unattributed (40-day-old legacy order 4): AD1 190 and NULL 50',
  (:'bd90'::jsonb) @> '[{"product":"Gel","source_id":"AD1","sales":190.00},{"product":"Gel","source_id":null,"orders":1,"units":1,"sales":50.00}]'::jsonb);
SELECT pg_temp.chk('window is [from,to): a 1-hour window around order 8 only contains order 8',
  (SELECT jsonb_array_length(pg_temp.asuser('a1000000-0000-4000-8000-000000000001', format($q$SELECT * FROM ads_results_product_ad_breakdown(%L, now()-interval '7 hours', now()-interval '5 hours')$q$, :'acct_a'))) = 1));
SELECT pg_temp.asuser('b2000000-0000-4000-8000-000000000002', format($q$SELECT * FROM ads_results_product_ad_breakdown(%L, now()-interval '90 days', now()+interval '1 day')$q$, :'acct_a')) AS bdx \gset
SELECT pg_temp.chk('breakdown: member of B asking for A gets nothing', :'bdx'::jsonb = '[]'::jsonb);
SELECT pg_temp.asuser('b2000000-0000-4000-8000-000000000002', format($q$SELECT * FROM ads_results_product_ad_breakdown(%L, now()-interval '90 days', now()+interval '1 day')$q$, :'acct_b')) AS bdb \gset
SELECT pg_temp.chk('breakdown: B sees only its own order, unattributed (no click evidence)', :'bdb'::jsonb @> '[{"product":"Laser","source_id":null,"units":5,"sales":999.00}]'::jsonb AND jsonb_array_length(:'bdb'::jsonb) = 1);
SELECT pg_temp.chk('breakdown function is read-only: STABLE, SECURITY INVOKER, no anon/PUBLIC grant',
  (SELECT provolatile = 's' AND NOT prosecdef AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND has_function_privilege('service_role', p.oid, 'EXECUTE')
   FROM pg_proc p WHERE p.proname = 'ads_results_product_ad_breakdown'));
DO $$ DECLARE t boolean[] := '{}'; BEGIN
  SET LOCAL ROLE anon;
  BEGIN PERFORM * FROM ads_results_product_ad_breakdown(gen_random_uuid(), now()-interval '1 day', now()); t[1] := false; EXCEPTION WHEN insufficient_privilege THEN t[1] := true; END;
  RESET ROLE;
  PERFORM pg_temp.chk('anon cannot execute the breakdown function', t[1]);
END $$;
SELECT 'RESULT ' || count(*) FILTER (WHERE ok) || ' passed, ' || count(*) FILTER (WHERE NOT ok) || ' failed' AS summary FROM r;
