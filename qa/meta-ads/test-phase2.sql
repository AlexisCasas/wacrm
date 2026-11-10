-- Checks after 20261116 + 20261117. Synthetic data only. "Today" is fixed at 2026-11-10 (D), so every window is reproducible.
--   7D  = D-7  .. D-1 = 2026-11-03 .. 2026-11-09      30D = 2026-10-11 .. 2026-11-09      90D = 2026-08-12 .. 2026-11-09      (today D is NEVER included)
\set ON_ERROR_STOP on
RESET ROLE;

-- ===== objects, types, constraints =====
SELECT qa.ok('p2 all 7 tables exist', (SELECT count(*) FROM unnest(ARRAY['meta_ads_settings','meta_ads_ads','meta_ads_sync_state','meta_ads_campaigns','meta_ads_adsets','meta_ads_insights_daily','meta_ads_reconciliation']) t WHERE to_regclass('public.'||t) IS NOT NULL) = 7);
SELECT qa.ok('p2 all 3 functions exist', to_regprocedure('public.ads_results_meta_catalog(uuid,text[])') IS NOT NULL AND to_regprocedure('public.meta_ads_performance(uuid,date,date,text)') IS NOT NULL AND to_regprocedure('public.meta_ads_insights_totals(uuid,date,date)') IS NOT NULL);
-- column types: Meta ids are text, spend is numeric, date is date, counters are bigint.
SELECT qa.eq('p2 type ' || t || '.' || c, format($q$SELECT format_type(a.atttypid, a.atttypmod) FROM pg_attribute a WHERE a.attrelid='public.%s'::regclass AND a.attname='%s' AND NOT a.attisdropped$q$, t, c), ty)
FROM (VALUES
  ('meta_ads_ads','ad_id','text'), ('meta_ads_adsets','adset_id','text'), ('meta_ads_adsets','campaign_id','text'), ('meta_ads_campaigns','campaign_id','text'),
  ('meta_ads_insights_daily','ad_id','text'), ('meta_ads_insights_daily','adset_id','text'), ('meta_ads_insights_daily','campaign_id','text'),
  ('meta_ads_insights_daily','date','date'), ('meta_ads_insights_daily','spend','numeric(18,4)'), ('meta_ads_insights_daily','impressions','bigint'),
  ('meta_ads_insights_daily','clicks','bigint'), ('meta_ads_insights_daily','reach','bigint'), ('meta_ads_insights_daily','currency','text'),
  ('meta_ads_reconciliation','local_spend','numeric(18,4)'), ('meta_ads_reconciliation','meta_spend','numeric(18,4)'), ('meta_ads_reconciliation','meta_clicks','bigint'),
  ('meta_ads_sync_state','covered_from','date'), ('meta_ads_sync_state','covered_to','date'), ('meta_ads_settings','access_token_enc','text'), ('meta_ads_settings','ad_account_id','text')
) v(t, c, ty);
SELECT qa.ok('p2 no float/real/double column in any meta_ads table', NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name LIKE 'meta_ads_%' AND data_type IN ('real','double precision')));
-- primary keys
SELECT qa.eq('p2 PK ' || t, format($q$SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.%s'::regclass AND contype='p'$q$, t), pk)
FROM (VALUES
  ('meta_ads_settings','PRIMARY KEY (account_id)'), ('meta_ads_ads','PRIMARY KEY (account_id, ad_id)'), ('meta_ads_sync_state','PRIMARY KEY (account_id, job)'),
  ('meta_ads_campaigns','PRIMARY KEY (account_id, campaign_id)'), ('meta_ads_adsets','PRIMARY KEY (account_id, adset_id)'),
  ('meta_ads_insights_daily','PRIMARY KEY (account_id, ad_id, date)'), ('meta_ads_reconciliation','PRIMARY KEY (account_id, window_days)')
) v(t, pk);
-- foreign keys: every table points to accounts(id) ON DELETE CASCADE
SELECT qa.eq('p2 FK ' || t, format($q$SELECT count(*) FILTER (WHERE confrelid='public.accounts'::regclass AND confdeltype='c' AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=conrelid AND attname='account_id')]) || '/' || count(*) FROM pg_constraint WHERE conrelid='public.%s'::regclass AND contype='f'$q$, t), '1/1')
FROM unnest(ARRAY['meta_ads_settings','meta_ads_ads','meta_ads_sync_state','meta_ads_campaigns','meta_ads_adsets','meta_ads_insights_daily','meta_ads_reconciliation']) t;
SELECT qa.eq('p2 job CHECK now allows the four jobs', $q$SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='meta_ads_sync_state_job'$q$, $q$CHECK ((job = ANY (ARRAY['catalog'::text, 'adsets'::text, 'campaigns'::text, 'insights'::text])))$q$);

-- ===== seed (superuser; synthetic) =====
TRUNCATE public.meta_ads_settings, public.meta_ads_ads, public.meta_ads_sync_state, public.meta_ads_campaigns, public.meta_ads_adsets, public.meta_ads_insights_daily, public.meta_ads_reconciliation CASCADE;
INSERT INTO public.meta_ads_settings (account_id, ad_account_id, access_token_enc, token_status) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '409949686293101', 'aabbccddeeff001122334455:deadbeef:00112233445566778899aabbccddeeff', 'valid'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '555555555555555', 'bbbbbbbbbbbbbbbbbbbbbbbb:cafe:ffeeddccbbaa99887766554433221100', 'valid');
-- Two campaigns and two ad sets with the SAME NAME (ids are the keys, never names); 3 + 1 ads.
INSERT INTO public.meta_ads_campaigns (account_id, campaign_id, name, status, effective_status) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '120256298878110285', 'Campaña Duplicada', 'ACTIVE', 'ACTIVE'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '120256297069270285', 'Campaña Duplicada', 'PAUSED', 'PAUSED');
INSERT INTO public.meta_ads_adsets (account_id, adset_id, name, campaign_id, status, effective_status) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '120256298878120285', 'Conjunto Duplicado', '120256298878110285', 'ACTIVE', 'ACTIVE'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '120256297702420285', 'Conjunto Duplicado', '120256297069270285', 'PAUSED', 'PAUSED');
-- Partial catalog: AD3 and AD4 are NOT in meta_ads_ads.
INSERT INTO public.meta_ads_ads (account_id, ad_id, name, adset_id, adset_name, campaign_id, campaign_name, status, effective_status) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '120232883780380285', 'Anuncio Uno', '120256298878120285', 'Conjunto Duplicado', '120256298878110285', 'Campaña Duplicada', 'ACTIVE', 'ACTIVE'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '120239084979500285', 'Anuncio Duplicado', '120256297702420285', 'Conjunto Duplicado', '120256297069270285', 'Campaña Duplicada', 'PAUSED', 'PAUSED');
CREATE TEMP TABLE d AS SELECT DATE '2026-11-10' AS today;
-- AD1: normal, EVERY day from D-100 to D-1: spend 10.00, 1000 impressions, 20 clicks, reach 800. Today (D): huge values that must never be counted.
INSERT INTO public.meta_ads_insights_daily (account_id, ad_id, date, campaign_id, adset_id, ad_name, adset_name, campaign_name, impressions, clicks, spend, currency, reach)
SELECT 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '120232883780380285', d.today - k, '120256298878110285', '120256298878120285', 'Snapshot viejo de Uno', 'Conjunto Duplicado', 'Campaña Duplicada', 1000, 20, 10.00, 'PEN', 800
FROM d, generate_series(1, 100) k;
INSERT INTO public.meta_ads_insights_daily (account_id, ad_id, date, campaign_id, adset_id, impressions, clicks, spend, currency, reach)
SELECT 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '120232883780380285', d.today, '120256298878110285', '120256298878120285', 999999, 99999, 9999.00, 'PEN', 5000 FROM d;
-- AD2: 0 CLICKS, only some days (k = 1, 3, 5, 10, 40): 500 impressions, spend 4.00.
INSERT INTO public.meta_ads_insights_daily (account_id, ad_id, date, campaign_id, adset_id, ad_name, adset_name, campaign_name, impressions, clicks, spend, currency, reach)
SELECT 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '120239084979500285', d.today - k, '120256297069270285', '120256297702420285', 'Anuncio Duplicado', 'Conjunto Duplicado', 'Campaña Duplicada', 500, 0, 4.00, 'PEN', 400
FROM d, unnest(ARRAY[1, 3, 5, 10, 40]) k;
-- AD3: 0 IMPRESSIONS (and 0 clicks, 0 spend), days k = 2, 4, 20. Not in the catalog; same display name as AD2.
INSERT INTO public.meta_ads_insights_daily (account_id, ad_id, date, campaign_id, adset_id, ad_name, adset_name, campaign_name, impressions, clicks, spend, currency, reach)
SELECT 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '120256299148760285', d.today - k, '120256297069270285', '120256297702420285', 'Anuncio Duplicado', 'Conjunto Duplicado', 'Campaña Duplicada', 0, 0, 0.00, 'PEN', 0
FROM d, unnest(ARRAY[2, 4, 20]) k;
-- AD4: not in the catalog and with NO names at all, one day (k = 6).
INSERT INTO public.meta_ads_insights_daily (account_id, ad_id, date, campaign_id, adset_id, impressions, clicks, spend, currency, reach)
SELECT 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '120255157385110285', d.today - 6, '120256297069270285', '120256297702420285', 100, 2, 1.50, 'PEN', 90 FROM d;
-- Another tenant with the SAME ad id and big numbers: must never leak into A.
INSERT INTO public.meta_ads_insights_daily (account_id, ad_id, date, campaign_id, adset_id, impressions, clicks, spend, currency, reach)
SELECT 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '120232883780380285', d.today - k, '120256298878110285', '120256298878120285', 777, 77, 777.00, 'PEN', 700 FROM d, generate_series(1, 7) k;

-- ===== meta_ads_performance as the agent of A =====
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-0000000000a1', false);
BEGIN READ ONLY;
-- 7D (explicit expectations)
SELECT qa.eq('7D campaign: 2 rows (grouped by id, although both are named "Campaña Duplicada")', $q$SELECT count(*) FROM meta_ads_performance('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','2026-11-03','2026-11-09','campaign')$q$, '2');
SELECT qa.eq('7D campaign C1 = AD1 only: spend|impr|clicks|status', $q$SELECT spend||'|'||impressions||'|'||clicks||'|'||status FROM meta_ads_performance('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','2026-11-03','2026-11-09','campaign') WHERE id='120256298878110285'$q$, '70.0000|7000|140|ACTIVE');
SELECT qa.eq('7D campaign C2 = AD2+AD3+AD4: spend|impr|clicks|status', $q$SELECT spend||'|'||impressions||'|'||clicks||'|'||status FROM meta_ads_performance('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','2026-11-03','2026-11-09','campaign') WHERE id='120256297069270285'$q$, '13.5000|1600|2|PAUSED');
SELECT qa.eq('7D adset: 2 rows grouped by adset_id (same name)', $q$SELECT count(*) FROM meta_ads_performance('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','2026-11-03','2026-11-09','adset')$q$, '2');
SELECT qa.eq('7D adset S1', $q$SELECT spend||'|'||impressions||'|'||clicks||'|'||campaign_id FROM meta_ads_performance('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','2026-11-03','2026-11-09','adset') WHERE id='120256298878120285'$q$, '70.0000|7000|140|120256298878110285');
SELECT qa.eq('7D adset S2', $q$SELECT spend||'|'||impressions||'|'||clicks||'|'||campaign_id||'|'||status FROM meta_ads_performance('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','2026-11-03','2026-11-09','adset') WHERE id='120256297702420285'$q$, '13.5000|1600|2|120256297069270285|PAUSED');
SELECT qa.eq('7D ad: 4 rows keyed by ad_id (AD2 and AD3 share a name)', $q$SELECT count(*) FROM meta_ads_performance('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','2026-11-03','2026-11-09','ad')$q$, '4');
SELECT qa.eq('7D ad AD1 normal (catalog name wins over the old insights snapshot)', $q$SELECT name||'|'||spend||'|'||impressions||'|'||clicks||'|'||active_days||'|'||status FROM meta_ads_performance('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','2026-11-03','2026-11-09','ad') WHERE id='120232883780380285'$q$, 'Anuncio Uno|70.0000|7000|140|7|ACTIVE');
SELECT qa.eq('7D ad AD2: ZERO CLICKS, missing days (3 of 7)', $q$SELECT spend||'|'||impressions||'|'||clicks||'|'||active_days FROM meta_ads_performance('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','2026-11-03','2026-11-09','ad') WHERE id='120239084979500285'$q$, '12.0000|1500|0|3');
SELECT qa.eq('7D ad AD3: ZERO IMPRESSIONS, not in catalog => name from insights, status NULL', $q$SELECT name||'|'||spend||'|'||impressions||'|'||clicks||'|'||active_days||'|'||coalesce(status,'<null>') FROM meta_ads_performance('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','2026-11-03','2026-11-09','ad') WHERE id='120256299148760285'$q$, 'Anuncio Duplicado|0.0000|0|0|2|<null>');
SELECT qa.eq('7D ad AD4: no name anywhere => NULL name (the app says "Anuncio no sincronizado")', $q$SELECT coalesce(name,'<null>')||'|'||spend||'|'||impressions||'|'||clicks FROM meta_ads_performance('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','2026-11-03','2026-11-09','ad') WHERE id='120255157385110285'$q$, '<null>|1.5000|100|2');
-- the three levels add up to the same totals; the other tenant and TODAY never leak in
SELECT qa.eq('7D totals identical at every level (spend|impr|clicks)', $q$SELECT string_agg(DISTINCT s, ' / ') FROM (SELECT l, sum(spend)||'|'||sum(impressions)||'|'||sum(clicks) AS s FROM (SELECT 'c' l, * FROM meta_ads_performance('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','2026-11-03','2026-11-09','campaign') UNION ALL SELECT 's', * FROM meta_ads_performance('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','2026-11-03','2026-11-09','adset') UNION ALL SELECT 'a', * FROM meta_ads_performance('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','2026-11-03','2026-11-09','ad')) x GROUP BY l) y$q$, '83.5000|8600|142');
SELECT qa.eq('window ending TODAY would add the 9999.00 row: proves 7D=D-7..D-1 excludes D', $q$SELECT sum(spend) FROM meta_ads_performance('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','2026-11-03','2026-11-10','ad')$q$, '10082.5000');
SELECT qa.eq('window starting one day earlier (D-8) would add 10.00 + nothing else: 7D starts exactly at D-7', $q$SELECT sum(spend) FROM meta_ads_performance('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','2026-11-02','2026-11-09','ad')$q$, '93.5000');
SELECT qa.eq('unknown level returns nothing', $q$SELECT count(*) FROM meta_ads_performance('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','2026-11-03','2026-11-09','nope')$q$, '0');
SELECT qa.eq('another account id returns nothing for this caller', $q$SELECT count(*) FROM meta_ads_performance('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','2026-11-03','2026-11-09','ad')$q$, '0');
-- 30D and 90D: explicit expectations for AD1/AD2 + comparison with an independent reference over the raw table
SELECT qa.eq('30D ad AD1 (30 days) and AD2 (4 days: k=1,3,5,10)', $q$SELECT string_agg(id||'='||spend||'|'||impressions||'|'||clicks||'|'||active_days, ' ; ' ORDER BY id) FROM meta_ads_performance('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','2026-10-11','2026-11-09','ad') WHERE id IN ('120232883780380285','120239084979500285')$q$,
  '120232883780380285=300.0000|30000|600|30 ; 120239084979500285=16.0000|2000|0|4');
SELECT qa.eq('90D ad AD1 (90 days, D-91 and older excluded) and AD2 (5 days)', $q$SELECT string_agg(id||'='||spend||'|'||impressions||'|'||clicks||'|'||active_days, ' ; ' ORDER BY id) FROM meta_ads_performance('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','2026-08-12','2026-11-09','ad') WHERE id IN ('120232883780380285','120239084979500285')$q$,
  '120232883780380285=900.0000|90000|1800|90 ; 120239084979500285=20.0000|2500|0|5');
SELECT qa.eq('90D window would lose a day if it started at D-89 / gain one at D-91 (AD1 active days 89 / 91)', $q$SELECT (SELECT active_days FROM meta_ads_performance('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','2026-08-13','2026-11-09','ad') WHERE id='120232883780380285') || '/' || (SELECT active_days FROM meta_ads_performance('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','2026-08-11','2026-11-09','ad') WHERE id='120232883780380285')$q$, '89/91');
SELECT qa.eq('reference check 7D/30D/90D: function totals == independent SUM over the raw table for D-N..D-1', $q$
  SELECT string_agg(n::text||':'||(f.s = r.s)::text, ',' ORDER BY n) FROM unnest(ARRAY[7,30,90]) n,
  LATERAL (SELECT sum(spend)||'|'||sum(impressions)||'|'||sum(clicks) s FROM meta_ads_performance('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', DATE '2026-11-10' - n, DATE '2026-11-10' - 1, 'ad')) f,
  LATERAL (SELECT sum(spend)||'|'||sum(impressions)||'|'||sum(clicks) s FROM public.meta_ads_insights_daily WHERE account_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' AND date >= DATE '2026-11-10' - n AND date <= DATE '2026-11-10' - 1) r$q$, '7:true,30:true,90:true');
SELECT qa.eq('window dates really covered by the data (AD1): 7D', $q$SELECT min(date)||'..'||max(date)||' ('||count(*)||' days)' FROM public.meta_ads_insights_daily WHERE account_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' AND ad_id='120232883780380285' AND date BETWEEN '2026-11-03' AND '2026-11-09'$q$, '2026-11-03..2026-11-09 (7 days)');
SELECT qa.eq('window dates really covered by the data (AD1): 30D', $q$SELECT min(date)||'..'||max(date)||' ('||count(*)||' days)' FROM public.meta_ads_insights_daily WHERE account_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' AND ad_id='120232883780380285' AND date BETWEEN '2026-10-11' AND '2026-11-09'$q$, '2026-10-11..2026-11-09 (30 days)');
SELECT qa.eq('window dates really covered by the data (AD1): 90D', $q$SELECT min(date)||'..'||max(date)||' ('||count(*)||' days)' FROM public.meta_ads_insights_daily WHERE account_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' AND ad_id='120232883780380285' AND date BETWEEN '2026-08-12' AND '2026-11-09'$q$, '2026-08-12..2026-11-09 (90 days)');

-- ===== ratios: the same formulas as the app (performance.ts) computed with NULLIF; division by zero is NULL, never an error, NaN or Infinity =====
SELECT qa.eq('CTR/CPC/CPM per ad (7D): AD1 | AD2 zero clicks | AD3 zero impressions | AD4', $q$
  SELECT string_agg(coalesce(round(100.0*clicks/nullif(impressions,0),4)::text,'-')||'/'||coalesce(round(spend/nullif(clicks,0),4)::text,'-')||'/'||coalesce(round(1000.0*spend/nullif(impressions,0),4)::text,'-'), ' ; ' ORDER BY id)
  FROM meta_ads_performance('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','2026-11-03','2026-11-09','ad')$q$,
  -- order by id: 120232883780380285 (AD1) ; 120239084979500285 (AD2) ; 120255157385110285 (AD4) ; 120256299148760285 (AD3)
  '2.0000/0.5000/10.0000 ; 0.0000/-/8.0000 ; 2.0000/0.7500/15.0000 ; -/-/-');
SELECT qa.eq('CTR/CPC/CPM of the 7D totals are computed from the SUMS (142/8600, 83.5/142, 83.5/8600) not averaged', $q$
  SELECT round(100.0*sum(clicks)/nullif(sum(impressions),0),4)||'/'||round(sum(spend)/nullif(sum(clicks),0),4)||'/'||round(1000.0*sum(spend)/nullif(sum(impressions),0),4)
  FROM meta_ads_performance('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','2026-11-03','2026-11-09','ad')$q$, '1.6512/0.5880/9.7093');
SELECT qa.eq('no NaN / Infinity in any 7/30/90 result of any level', $q$
  SELECT count(*) FROM (SELECT * FROM unnest(ARRAY[7,30,90]) n, unnest(ARRAY['campaign','adset','ad']) l,
    LATERAL meta_ads_performance('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', DATE '2026-11-10' - n, DATE '2026-11-10' - 1, l)) z
  WHERE spend = 'NaN'::numeric OR spend IN ('Infinity'::numeric, '-Infinity'::numeric)$q$, '0');
SELECT qa.raises('plain SQL division by zero is a real error (that is why the ratios use NULLIF / null in the app)', 'SELECT 1::numeric / 0', '22012');
SELECT qa.ok('performance function exposes no reach column and no token/ratio column', (SELECT pg_get_function_result('public.meta_ads_performance(uuid,date,date,text)'::regprocedure)) !~* '(reach|token|ctr|cpc|cpm)');
SELECT qa.eq('reach is not summed anywhere: AD1 7D has reach 800*7=5600 stored daily, and the function result has no reach to read', $q$SELECT sum(reach) FROM public.meta_ads_insights_daily WHERE account_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' AND ad_id='120232883780380285' AND date BETWEEN '2026-11-03' AND '2026-11-09'$q$, '5600');
COMMIT;
RESET ROLE;

-- ===== meta_ads_insights_totals (service_role only) =====
SET ROLE service_role;
SELECT qa.eq('totals RPC 7D == sum of the performance levels', $q$SELECT spend||'|'||impressions||'|'||clicks FROM meta_ads_insights_totals('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','2026-11-03','2026-11-09')$q$, '83.5000|8600|142');
SELECT qa.eq('totals RPC 30D / 90D', $q$SELECT (SELECT spend||'|'||impressions||'|'||clicks FROM meta_ads_insights_totals('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','2026-10-11','2026-11-09')) || ' ; ' || (SELECT spend||'|'||impressions||'|'||clicks FROM meta_ads_insights_totals('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','2026-08-12','2026-11-09'))$q$, '317.5000|32100|602 ; 921.5000|92600|1802');
SELECT qa.eq('totals RPC is per account (B has its own numbers) and an empty range is zeros, not NULL', $q$SELECT (SELECT spend FROM meta_ads_insights_totals('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','2026-11-03','2026-11-09')) || ' ; ' || (SELECT spend||'|'||impressions||'|'||clicks FROM meta_ads_insights_totals('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','2030-01-01','2030-01-07'))$q$, '5439.0000 ; 0|0|0');
RESET ROLE;
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-0000000000a1', false);
SELECT qa.raises('totals RPC is NOT callable by authenticated', $q$SELECT * FROM meta_ads_insights_totals('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','2026-11-03','2026-11-09')$q$, '42501');
RESET ROLE;
SET ROLE anon;
SELECT qa.raises('totals RPC is NOT callable by anon', $q$SELECT * FROM meta_ads_insights_totals('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','2026-11-03','2026-11-09')$q$, '42501');
SELECT qa.raises('performance RPC is NOT callable by anon', $q$SELECT * FROM meta_ads_performance('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','2026-11-03','2026-11-09','ad')$q$, '42501');
SELECT qa.raises('catalog RPC is NOT callable by anon', $q$SELECT * FROM ads_results_meta_catalog('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ARRAY['120232883780380285'])$q$, '42501');
RESET ROLE;

-- ===== tenancy / RLS at runtime =====
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'b0000000-0000-4000-8000-0000000000b2', false);
SELECT qa.eq('agent of B: performance for B sees only B (777*7 = 5439)', $q$SELECT sum(spend) FROM meta_ads_performance('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','2026-11-03','2026-11-09','ad')$q$, '5439.0000');
SELECT qa.eq('agent of B asking for A gets nothing', $q$SELECT count(*) FROM meta_ads_performance('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','2026-11-03','2026-11-09','ad')$q$, '0');
SELECT qa.eq('agent of B sees only its own insights rows through the table (RLS)', 'SELECT count(DISTINCT account_id) FROM public.meta_ads_insights_daily', '1');
SELECT set_config('request.jwt.claim.sub', 'c0000000-0000-4000-8000-0000000000c3', false);
SELECT qa.eq('viewer of A (below agent) gets nothing from performance', $q$SELECT count(*) FROM meta_ads_performance('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','2026-11-03','2026-11-09','ad')$q$, '0');
SELECT qa.eq('viewer of A sees no rows in any new table', $q$SELECT (SELECT count(*) FROM public.meta_ads_insights_daily)+(SELECT count(*) FROM public.meta_ads_campaigns)+(SELECT count(*) FROM public.meta_ads_adsets)+(SELECT count(*) FROM public.meta_ads_reconciliation)$q$, '0');
SELECT set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-0000000000a1', false);
SELECT qa.raises('authenticated cannot insert insights', $q$INSERT INTO public.meta_ads_insights_daily (account_id, ad_id, date, currency) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','120232883780380285','2026-01-01','PEN')$q$, '42501');
SELECT qa.raises('authenticated cannot update insights', $q$UPDATE public.meta_ads_insights_daily SET spend = 0$q$, '42501');
SELECT qa.raises('authenticated cannot delete insights', 'DELETE FROM public.meta_ads_insights_daily', '42501');
SELECT qa.raises('authenticated cannot write reconciliation', $q$DELETE FROM public.meta_ads_reconciliation$q$, '42501');
SELECT qa.raises('TOKEN: authenticated still cannot read access_token_enc (after 20261117)', 'SELECT access_token_enc FROM public.meta_ads_settings', '42501');
SELECT qa.raises('authenticated cannot read sync_state (covered_from/to, errors)', 'SELECT * FROM public.meta_ads_sync_state', '42501');
SELECT qa.raises('authenticated cannot read the new settings column insights_interval_minutes', 'SELECT insights_interval_minutes FROM public.meta_ads_settings', '42501');
RESET ROLE;
SET ROLE anon;
SELECT qa.raises('anon: no new table readable', 'SELECT 1 FROM public.meta_ads_insights_daily', '42501');
SELECT qa.raises('anon: campaigns', 'SELECT 1 FROM public.meta_ads_campaigns', '42501');
SELECT qa.raises('anon: adsets', 'SELECT 1 FROM public.meta_ads_adsets', '42501');
SELECT qa.raises('anon: reconciliation', 'SELECT 1 FROM public.meta_ads_reconciliation', '42501');
RESET ROLE;

-- ===== catalog RPC still works after 20261117 =====
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-0000000000a1', false);
SELECT qa.eq('catalog RPC after 20261117 (AD3/AD4 absent from the catalog => no rows, nothing invented)', $q$SELECT count(*) FROM ads_results_meta_catalog('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ARRAY['120232883780380285','120239084979500285','120256299148760285','120255157385110285'])$q$, '2');
RESET ROLE;

-- ===== catalog-level grants (privilege matrix) =====
SELECT qa.ok('GRANTS anon: no privilege of any kind on the 7 tables', NOT EXISTS (SELECT 1 FROM unnest(ARRAY['meta_ads_settings','meta_ads_ads','meta_ads_sync_state','meta_ads_campaigns','meta_ads_adsets','meta_ads_insights_daily','meta_ads_reconciliation']) t, unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p WHERE has_table_privilege('anon', 'public.'||t, p)));
SELECT qa.ok('GRANTS authenticated: SELECT only on ads/campaigns/adsets/insights/reconciliation; nothing else, nothing on settings/sync_state', NOT EXISTS (SELECT 1 FROM unnest(ARRAY['meta_ads_settings','meta_ads_ads','meta_ads_sync_state','meta_ads_campaigns','meta_ads_adsets','meta_ads_insights_daily','meta_ads_reconciliation']) t, unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
   WHERE has_table_privilege('authenticated', 'public.'||t, p) AND NOT (p = 'SELECT' AND t IN ('meta_ads_ads','meta_ads_campaigns','meta_ads_adsets','meta_ads_insights_daily','meta_ads_reconciliation'))));
SELECT qa.ok('GRANTS authenticated can SELECT the 5 readable tables', (SELECT bool_and(has_table_privilege('authenticated','public.'||t,'SELECT')) FROM unnest(ARRAY['meta_ads_ads','meta_ads_campaigns','meta_ads_adsets','meta_ads_insights_daily','meta_ads_reconciliation']) t));
SELECT qa.ok('GRANTS authenticated has no column privilege on settings/sync_state (access_token_enc included)', NOT has_any_column_privilege('authenticated','public.meta_ads_settings','SELECT') AND NOT has_column_privilege('authenticated','public.meta_ads_settings','access_token_enc','SELECT') AND NOT has_any_column_privilege('authenticated','public.meta_ads_sync_state','SELECT'));
SELECT qa.ok('GRANTS service_role: full technical access on all 7 tables', NOT EXISTS (SELECT 1 FROM unnest(ARRAY['meta_ads_settings','meta_ads_ads','meta_ads_sync_state','meta_ads_campaigns','meta_ads_adsets','meta_ads_insights_daily','meta_ads_reconciliation']) t, unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p WHERE NOT has_table_privilege('service_role', 'public.'||t, p)));
SELECT qa.ok('RLS enabled on all 7 tables', (SELECT bool_and(relrowsecurity) FROM pg_class WHERE oid = ANY (ARRAY['public.meta_ads_settings','public.meta_ads_ads','public.meta_ads_sync_state','public.meta_ads_campaigns','public.meta_ads_adsets','public.meta_ads_insights_daily','public.meta_ads_reconciliation']::regclass[])));
SELECT qa.ok('RLS: policies exist ONLY on the 5 member-readable tables, all SELECT-only; none on settings/sync_state', (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename LIKE 'meta_ads_%') = 5 AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename LIKE 'meta_ads_%' AND (cmd <> 'SELECT' OR tablename IN ('meta_ads_settings','meta_ads_sync_state'))));
SELECT qa.ok('FUNCTION grants: anon none; authenticated only catalog + performance; service_role all three', 
  NOT has_function_privilege('anon','public.ads_results_meta_catalog(uuid,text[])','EXECUTE') AND NOT has_function_privilege('anon','public.meta_ads_performance(uuid,date,date,text)','EXECUTE') AND NOT has_function_privilege('anon','public.meta_ads_insights_totals(uuid,date,date)','EXECUTE')
  AND has_function_privilege('authenticated','public.ads_results_meta_catalog(uuid,text[])','EXECUTE') AND has_function_privilege('authenticated','public.meta_ads_performance(uuid,date,date,text)','EXECUTE') AND NOT has_function_privilege('authenticated','public.meta_ads_insights_totals(uuid,date,date)','EXECUTE')
  AND has_function_privilege('service_role','public.ads_results_meta_catalog(uuid,text[])','EXECUTE') AND has_function_privilege('service_role','public.meta_ads_performance(uuid,date,date,text)','EXECUTE') AND has_function_privilege('service_role','public.meta_ads_insights_totals(uuid,date,date)','EXECUTE'));
SELECT qa.ok('FUNCTIONS: SECURITY INVOKER (not definer), STABLE, search_path pinned, language sql (no writes possible)', (SELECT bool_and(NOT prosecdef AND provolatile = 's' AND proconfig::text LIKE '%search_path=public%') FROM pg_proc WHERE oid = ANY (ARRAY['public.ads_results_meta_catalog(uuid,text[])','public.meta_ads_performance(uuid,date,date,text)','public.meta_ads_insights_totals(uuid,date,date)']::regprocedure[])));
SELECT qa.ok('FUNCTIONS: no result column exposes access_token_enc / any token', (SELECT bool_and(pg_get_function_result(oid) !~* 'token') FROM pg_proc WHERE oid = ANY (ARRAY['public.ads_results_meta_catalog(uuid,text[])','public.meta_ads_performance(uuid,date,date,text)','public.meta_ads_insights_totals(uuid,date,date)']::regprocedure[])));

-- ===== CHECK constraints (each must reject bad input, each valid job must pass) =====
SELECT qa.raises('CHECK job: unknown job rejected', $q$INSERT INTO public.meta_ads_sync_state (account_id, job) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','nope')$q$, '23514');
INSERT INTO public.meta_ads_sync_state (account_id, job) SELECT 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', j FROM unnest(ARRAY['catalog','adsets','campaigns','insights']) j;
SELECT qa.eq('CHECK job: catalog/adsets/campaigns/insights accepted', $q$SELECT count(*) FROM public.meta_ads_sync_state$q$, '4');
SELECT qa.raises('CHECK status: unknown sync status rejected', $q$UPDATE public.meta_ads_sync_state SET status='weird'$q$, '23514');
SELECT qa.raises('CHECK currency lower-case (insights)', $q$INSERT INTO public.meta_ads_insights_daily (account_id, ad_id, date, currency) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','120232883780380285','2026-01-01','pen')$q$, '23514');
SELECT qa.raises('CHECK currency lower-case (settings)', $q$UPDATE public.meta_ads_settings SET currency='pen'$q$, '23514');
SELECT qa.raises('CHECK ad_id must be numeric text', $q$INSERT INTO public.meta_ads_insights_daily (account_id, ad_id, date, currency) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','abc','2026-01-01','PEN')$q$, '23514');
SELECT qa.raises('CHECK negative spend rejected', $q$INSERT INTO public.meta_ads_insights_daily (account_id, ad_id, date, currency, spend) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','120232883780380285','2026-01-01','PEN',-1)$q$, '23514');
SELECT qa.raises('NOT NULL currency on insights', $q$INSERT INTO public.meta_ads_insights_daily (account_id, ad_id, date) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','120232883780380285','2026-01-01')$q$, '23502');
SELECT qa.raises('NOT NULL date on insights', $q$INSERT INTO public.meta_ads_insights_daily (account_id, ad_id, currency) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','120232883780380285','PEN')$q$, '23502');
SELECT qa.raises('PK: duplicate (account, ad, date) rejected', $q$INSERT INTO public.meta_ads_insights_daily (account_id, ad_id, date, currency) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','120232883780380285','2026-11-09','PEN')$q$, '23505');
SELECT qa.raises('FK: unknown account rejected', $q$INSERT INTO public.meta_ads_campaigns (account_id, campaign_id) VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','120256298878110285')$q$, '23503');
SELECT qa.raises('CHECK campaign/adset ids numeric', $q$INSERT INTO public.meta_ads_campaigns (account_id, campaign_id) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','x1')$q$, '23514');
SELECT qa.raises('CHECK reconciliation window must be 7/30/90', $q$INSERT INTO public.meta_ads_reconciliation VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',14,'2026-11-01','2026-11-09',0,0,0,0,0,0,true,now())$q$, '23514');
SELECT qa.raises('CHECK settings.enabled needs ad account + token (known account)', $q$UPDATE public.meta_ads_settings SET enabled = true, access_token_enc = NULL WHERE account_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'$q$, '23514');
SELECT qa.raises('CHECK api_version format', $q$UPDATE public.meta_ads_settings SET api_version='v27'$q$, '23514');
SELECT qa.raises('CHECK insights_interval_minutes between 15 and 1440', $q$UPDATE public.meta_ads_settings SET insights_interval_minutes = 5$q$, '23514');
SELECT qa.raises('CHECK ad_account_id numeric', $q$UPDATE public.meta_ads_settings SET ad_account_id = 'act_1'$q$, '23514');
SELECT qa.eq('defaults: insights_interval 180, catalog 60, enabled false, token_status valid/unverified, currency PEN, tz America/Bogota, api v27.0', $q$SELECT insights_interval_minutes||'|'||catalog_interval_minutes||'|'||enabled||'|'||currency||'|'||account_timezone||'|'||api_version FROM public.meta_ads_settings WHERE account_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'$q$, '180|60|false|PEN|America/Bogota|v27.0');

-- ===== idempotent upsert on the real PK, spend stays exact =====
INSERT INTO public.meta_ads_insights_daily (account_id, ad_id, date, currency, spend, impressions, clicks, reach) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','120232883780380285','2025-01-01','PEN',102.50,19819,392,18646)
  ON CONFLICT (account_id, ad_id, date) DO UPDATE SET spend = EXCLUDED.spend;
INSERT INTO public.meta_ads_insights_daily (account_id, ad_id, date, currency, spend, impressions, clicks, reach) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','120232883780380285','2025-01-01','PEN','102.55',19819,392,18646)
  ON CONFLICT (account_id, ad_id, date) DO UPDATE SET spend = EXCLUDED.spend;
SELECT qa.eq('upsert on PK restates in place: one row, spend 102.5500 (decimal string in, exact decimal out)', $q$SELECT count(*)||'|'||max(spend) FROM public.meta_ads_insights_daily WHERE date='2025-01-01'$q$, '1|102.5500');

-- ===== cascade: deleting an account removes everything it owns in the 7 tables =====
INSERT INTO auth.users (id) VALUES ('d0000000-0000-4000-8000-0000000000d4');
INSERT INTO public.accounts (id, name, owner_user_id) VALUES ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'Z', 'd0000000-0000-4000-8000-0000000000d4');
INSERT INTO public.meta_ads_settings (account_id) VALUES ('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
INSERT INTO public.meta_ads_ads (account_id, ad_id) VALUES ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','120232883780380285');
INSERT INTO public.meta_ads_sync_state (account_id, job) VALUES ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','insights');
INSERT INTO public.meta_ads_campaigns (account_id, campaign_id) VALUES ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','120256298878110285');
INSERT INTO public.meta_ads_adsets (account_id, adset_id) VALUES ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','120256298878120285');
INSERT INTO public.meta_ads_insights_daily (account_id, ad_id, date, currency) VALUES ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','120232883780380285','2026-11-09','PEN');
INSERT INTO public.meta_ads_reconciliation VALUES ('dddddddd-dddd-4ddd-8ddd-dddddddddddd',7,'2026-11-03','2026-11-09',1,1,1,1,1,1,true,now());
DELETE FROM public.accounts WHERE id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
SELECT qa.eq('ON DELETE CASCADE empties all 7 tables for the deleted account', $q$SELECT (SELECT count(*) FROM public.meta_ads_settings WHERE account_id='dddddddd-dddd-4ddd-8ddd-dddddddddddd')+(SELECT count(*) FROM public.meta_ads_ads WHERE account_id='dddddddd-dddd-4ddd-8ddd-dddddddddddd')+(SELECT count(*) FROM public.meta_ads_sync_state WHERE account_id='dddddddd-dddd-4ddd-8ddd-dddddddddddd')+(SELECT count(*) FROM public.meta_ads_campaigns WHERE account_id='dddddddd-dddd-4ddd-8ddd-dddddddddddd')+(SELECT count(*) FROM public.meta_ads_adsets WHERE account_id='dddddddd-dddd-4ddd-8ddd-dddddddddddd')+(SELECT count(*) FROM public.meta_ads_insights_daily WHERE account_id='dddddddd-dddd-4ddd-8ddd-dddddddddddd')+(SELECT count(*) FROM public.meta_ads_reconciliation WHERE account_id='dddddddd-dddd-4ddd-8ddd-dddddddddddd')$q$, '0');
DELETE FROM auth.users WHERE id = 'd0000000-0000-4000-8000-0000000000d4';
