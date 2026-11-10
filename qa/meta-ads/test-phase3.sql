-- Checks after 20261116 + 20261117 + 20261118. Synthetic data only. "Today" = 2026-11-10 (D).
--   7D  = 2026-11-03..2026-11-09    30D = 2026-10-11..2026-11-09    90D = 2026-08-12..2026-11-09
\set ON_ERROR_STOP on
RESET ROLE;

-- ===== objects, types, constraints =====
SELECT qa.ok('p3 new tables and function exist', to_regclass('public.meta_ads_insights_range') IS NOT NULL AND to_regclass('public.meta_ads_actions_range') IS NOT NULL AND to_regprocedure('public.meta_ads_range_metrics(uuid,integer,date,date,text)') IS NOT NULL);
SELECT qa.eq('p3 type ' || t || '.' || c, format($q$SELECT format_type(a.atttypid, a.atttypmod) FROM pg_attribute a WHERE a.attrelid='public.%s'::regclass AND a.attname='%s' AND NOT a.attisdropped$q$, t, c), ty)
FROM (VALUES
  ('meta_ads_insights_range','entity_id','text'), ('meta_ads_insights_range','level','text'), ('meta_ads_insights_range','days','integer'), ('meta_ads_insights_range','since','date'), ('meta_ads_insights_range','until','date'),
  ('meta_ads_insights_range','spend','numeric(18,4)'), ('meta_ads_insights_range','impressions','bigint'), ('meta_ads_insights_range','clicks','bigint'), ('meta_ads_insights_range','reach','bigint'),
  ('meta_ads_insights_range','frequency','numeric(12,4)'), ('meta_ads_insights_range','inline_link_clicks','bigint'), ('meta_ads_insights_range','outbound_clicks','bigint'), ('meta_ads_insights_range','currency','text'),
  ('meta_ads_actions_range','action_type','text'), ('meta_ads_actions_range','value','numeric(20,4)'), ('meta_ads_actions_range','entity_id','text'),
  ('meta_ads_campaigns','objective','text'), ('meta_ads_campaigns','buying_type','text'), ('meta_ads_campaigns','daily_budget','bigint'), ('meta_ads_campaigns','lifetime_budget','bigint'),
  ('meta_ads_campaigns','start_time','timestamp with time zone'), ('meta_ads_campaigns','stop_time','timestamp with time zone'), ('meta_ads_campaigns','updated_time','timestamp with time zone'),
  ('meta_ads_adsets','optimization_goal','text'), ('meta_ads_adsets','billing_event','text'), ('meta_ads_adsets','bid_strategy','text'), ('meta_ads_adsets','daily_budget','bigint'),
  ('meta_ads_adsets','end_time','timestamp with time zone'), ('meta_ads_adsets','updated_time','timestamp with time zone')
) v(t, c, ty);
SELECT qa.ok('p3 no float/real/double column in any meta_ads table', NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name LIKE 'meta_ads_%' AND data_type IN ('real','double precision')));
SELECT qa.eq('p3 PK insights_range', $q$SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.meta_ads_insights_range'::regclass AND contype='p'$q$, 'PRIMARY KEY (account_id, level, entity_id, days)');
SELECT qa.eq('p3 PK actions_range', $q$SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.meta_ads_actions_range'::regclass AND contype='p'$q$, 'PRIMARY KEY (account_id, level, entity_id, days, action_type)');
SELECT qa.eq('p3 FK insights_range -> accounts ON DELETE CASCADE', $q$SELECT count(*)::text FROM pg_constraint WHERE conrelid='public.meta_ads_insights_range'::regclass AND contype='f' AND confrelid='public.accounts'::regclass AND confdeltype='c'$q$, '1');
SELECT qa.eq('p3 FK actions_range -> its range row ON DELETE CASCADE', $q$SELECT count(*)::text FROM pg_constraint WHERE conrelid='public.meta_ads_actions_range'::regclass AND contype='f' AND confrelid='public.meta_ads_insights_range'::regclass AND confdeltype='c'$q$, '1');
SELECT qa.eq('p3 job CHECK allows the five jobs', $q$SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='meta_ads_sync_state_job'$q$, $q$CHECK ((job = ANY (ARRAY['catalog'::text, 'adsets'::text, 'campaigns'::text, 'insights'::text, 'ranges'::text])))$q$);

-- ===== seed (superuser; synthetic) =====
TRUNCATE public.meta_ads_settings, public.meta_ads_ads, public.meta_ads_sync_state, public.meta_ads_campaigns, public.meta_ads_adsets, public.meta_ads_insights_daily, public.meta_ads_reconciliation, public.meta_ads_insights_range CASCADE;
INSERT INTO public.meta_ads_settings (account_id, ad_account_id, access_token_enc, token_status) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '409949686293101', 'aabbccddeeff001122334455:deadbeef:00112233445566778899aabbccddeeff', 'valid'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '555555555555555', 'bbbbbbbbbbbbbbbbbbbbbbbb:cafe:ffeeddccbbaa99887766554433221100', 'valid');
-- secondary catalog details (campaign + ad set): realistic values from the live audit
INSERT INTO public.meta_ads_campaigns (account_id, campaign_id, name, status, effective_status, objective, buying_type, daily_budget, lifetime_budget, start_time, stop_time, created_time, updated_time) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '120256298878110285', 'Rectificadora 120', 'ACTIVE', 'ACTIVE', 'MESSAGES', 'AUCTION', 5000, NULL, '2026-11-01 10:00:00-05', NULL, '2026-10-30 09:00:00-05', '2026-11-09 18:00:00-05');
INSERT INTO public.meta_ads_adsets (account_id, adset_id, name, campaign_id, status, effective_status, optimization_goal, billing_event, bid_strategy, daily_budget, start_time, end_time, created_time, updated_time) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '120256298878120285', 'RECTIFICADORA', '120256298878110285', 'ACTIVE', 'ACTIVE', 'CONVERSATIONS', 'IMPRESSIONS', NULL, NULL, '2026-11-01 10:00:00-05', NULL, '2026-10-30 09:00:00-05', '2026-11-09 18:00:00-05');
SELECT qa.eq('p3 catalog details stored (objective, buying_type, budget minor units, times)', $q$SELECT objective||'|'||buying_type||'|'||daily_budget||'|'||coalesce(lifetime_budget::text,'-')||'|'||(stop_time IS NULL)::text FROM public.meta_ads_campaigns$q$, 'MESSAGES|AUCTION|5000|-|true');
SELECT qa.eq('p3 ad set details stored (optimization_goal, billing_event)', $q$SELECT optimization_goal||'|'||billing_event||'|'||coalesce(bid_strategy,'-') FROM public.meta_ads_adsets$q$, 'CONVERSATIONS|IMPRESSIONS|-');

-- AD1 daily reach 800 x 7 days (sum 5600) vs the AGGREGATED reach 5200 for the same window: reach is not additive.
INSERT INTO public.meta_ads_insights_daily (account_id, ad_id, date, campaign_id, adset_id, impressions, clicks, spend, currency, reach)
SELECT 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '120232883780380285', DATE '2026-11-03' + g, '120256298878110285', '120256298878120285', 1000, 20, 10.00, 'PEN', 800 FROM generate_series(0, 6) g;
INSERT INTO public.meta_ads_insights_range (account_id, level, entity_id, days, since, until, spend, impressions, clicks, reach, frequency, ctr, cpc, cpm, inline_link_clicks, outbound_clicks, currency) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'account',  '409949686293101', 7, '2026-11-03', '2026-11-09', 83.5, 8600, 142, 6000, 1.4333, 1.651163, 0.588028, 9.709302, 120, 100, 'PEN'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'campaign', '120256298878110285', 7, '2026-11-03', '2026-11-09', 70, 7000, 140, 5200, 1.3462, 2, 0.5, 10, 120, 100, 'PEN'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'adset',    '120256298878120285', 7, '2026-11-03', '2026-11-09', 70, 7000, 140, 5200, 1.3462, 2, 0.5, 10, 120, 100, 'PEN'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'ad',       '120232883780380285', 7, '2026-11-03', '2026-11-09', 70, 7000, 140, 5200, 1.3462, 2, 0.5, 10, 120, 100, 'PEN'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'ad',       '120239084979500285', 7, '2026-11-03', '2026-11-09', 13.5, 1600, 2, 1500, 1.0667, 0.125, 6.75, 8.4375, NULL, NULL, 'PEN'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'ad',       '120232883780380285', 30, '2026-10-11', '2026-11-09', 300, 30000, 600, 20000, 1.5, 2, 0.5, 10, 500, 450, 'PEN'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'ad',       '120232883780380285', 90, '2026-08-12', '2026-11-09', 900, 90000, 1800, 40000, 2.25, 2, 0.5, 10, 1500, 1300, 'PEN'),
  -- STALE window for AD2 30D (the window moved one day since this row was written): must be ignored, never shown as current.
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'ad',       '120239084979500285', 30, '2026-10-10', '2026-11-08', 16, 2000, 0, 1900, 1.0526, 0, NULL, 8, NULL, NULL, 'PEN'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'ad',       '120232883780380285', 7, '2026-11-03', '2026-11-09', 777, 777, 77, 1, 777, 9, 9, 9, 7, 7, 'PEN');
-- Actions of AD1 (7D): the real messaging types, plus lead ALIASES that must stay separate (never merged), plus other results.
INSERT INTO public.meta_ads_actions_range (account_id, level, entity_id, days, action_type, since, until, value) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','ad','120232883780380285',7,'onsite_conversion.messaging_conversation_started_7d','2026-11-03','2026-11-09',40),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','ad','120232883780380285',7,'onsite_conversion.total_messaging_connection','2026-11-03','2026-11-09',55),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','ad','120232883780380285',7,'onsite_conversion.messaging_first_reply','2026-11-03','2026-11-09',30),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','ad','120232883780380285',7,'onsite_conversion.messaging_user_depth_2_message_send','2026-11-03','2026-11-09',20),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','ad','120232883780380285',7,'onsite_conversion.messaging_user_depth_3_message_send','2026-11-03','2026-11-09',10),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','ad','120232883780380285',7,'lead','2026-11-03','2026-11-09',1),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','ad','120232883780380285',7,'onsite_web_lead','2026-11-03','2026-11-09',1),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','ad','120232883780380285',7,'onsite_conversion.lead_grouped','2026-11-03','2026-11-09',1),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','ad','120232883780380285',7,'video_view','2026-11-03','2026-11-09',900),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','ad','120232883780380285',7,'link_click','2026-11-03','2026-11-09',120),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','account','409949686293101',7,'onsite_conversion.messaging_conversation_started_7d','2026-11-03','2026-11-09',40);

-- ===== meta_ads_range_metrics as the agent of A =====
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-0000000000a1', false);
BEGIN READ ONLY;
SELECT qa.eq('7D ad rows: 2 (AD1, AD2)', $q$SELECT count(*) FROM meta_ads_range_metrics('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',7,'2026-11-03','2026-11-09','ad')$q$, '2');
SELECT qa.eq('REACH is Meta''s aggregated 5200, NOT the 5600 sum of the daily rows', $q$SELECT reach::text FROM meta_ads_range_metrics('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',7,'2026-11-03','2026-11-09','ad') WHERE id='120232883780380285'$q$, '5200');
SELECT qa.eq('the daily rows really would have summed to 5600 (proves the difference is real)', $q$SELECT sum(reach)::text FROM public.meta_ads_insights_daily WHERE ad_id='120232883780380285' AND date BETWEEN '2026-11-03' AND '2026-11-09'$q$, '5600');
SELECT qa.eq('FREQUENCY = impressions / reach (AD1 and AD2, to 4 decimals)', $q$SELECT string_agg((round(impressions::numeric/reach,4) = frequency)::text, ',' ORDER BY id) FROM meta_ads_range_metrics('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',7,'2026-11-03','2026-11-09','ad')$q$, 'true,true');
SELECT qa.eq('account reach 6000 is its own aggregate: NOT the sum of the ads (5200+1500=6700)', $q$SELECT (SELECT reach FROM meta_ads_range_metrics('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',7,'2026-11-03','2026-11-09','account'))::text||' vs '||(SELECT sum(reach) FROM meta_ads_range_metrics('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',7,'2026-11-03','2026-11-09','ad'))::text$q$, '6000 vs 6700');
SELECT qa.eq('account row is keyed by the Ad Account id', $q$SELECT id FROM meta_ads_range_metrics('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',7,'2026-11-03','2026-11-09','account')$q$, '409949686293101');
SELECT qa.eq('link clicks / outbound clicks / clicks kept apart (AD1)', $q$SELECT clicks||'|'||inline_link_clicks||'|'||outbound_clicks FROM meta_ads_range_metrics('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',7,'2026-11-03','2026-11-09','ad') WHERE id='120232883780380285'$q$, '140|120|100');
SELECT qa.eq('missing link/outbound values stay NULL (AD2), never 0', $q$SELECT (inline_link_clicks IS NULL)::text||','||(outbound_clicks IS NULL)::text FROM meta_ads_range_metrics('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',7,'2026-11-03','2026-11-09','ad') WHERE id='120239084979500285'$q$, 'true,true');
SELECT qa.eq('campaign / adset levels', $q$SELECT (SELECT count(*) FROM meta_ads_range_metrics('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',7,'2026-11-03','2026-11-09','campaign'))||'/'||(SELECT count(*) FROM meta_ads_range_metrics('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',7,'2026-11-03','2026-11-09','adset'))$q$, '1/1');
-- actions
SELECT qa.eq('ACTIONS: AD1 has exactly the 10 stored action types, as one jsonb object', $q$SELECT (SELECT count(*) FROM jsonb_object_keys(actions))::text FROM meta_ads_range_metrics('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',7,'2026-11-03','2026-11-09','ad') WHERE id='120232883780380285'$q$, '10');
SELECT qa.eq('ACTIONS: the five messaging action types keep their values', $q$SELECT concat_ws('|', actions->>'onsite_conversion.messaging_conversation_started_7d', actions->>'onsite_conversion.total_messaging_connection', actions->>'onsite_conversion.messaging_first_reply', actions->>'onsite_conversion.messaging_user_depth_2_message_send', actions->>'onsite_conversion.messaging_user_depth_3_message_send') FROM meta_ads_range_metrics('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',7,'2026-11-03','2026-11-09','ad') WHERE id='120232883780380285'$q$, '40.0000|55.0000|30.0000|20.0000|10.0000');
SELECT qa.eq('ACTIONS: lead aliases stay SEPARATE (1,1,1) and no combined lead key exists', $q$SELECT concat_ws('|', actions->>'lead', actions->>'onsite_web_lead', actions->>'onsite_conversion.lead_grouped', (actions ? 'leads')::text, (actions ? 'leads_total')::text) FROM meta_ads_range_metrics('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',7,'2026-11-03','2026-11-09','ad') WHERE id='120232883780380285'$q$, '1.0000|1.0000|1.0000|false|false');
SELECT qa.eq('ACTIONS: an entity without actions gets an empty object, not NULL', $q$SELECT actions::text FROM meta_ads_range_metrics('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',7,'2026-11-03','2026-11-09','ad') WHERE id='120239084979500285'$q$, '{}');
SELECT qa.eq('ACTIONS: account-level actions are their own rows (not derived from the ads)', $q$SELECT actions->>'onsite_conversion.messaging_conversation_started_7d' FROM meta_ads_range_metrics('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',7,'2026-11-03','2026-11-09','account')$q$, '40.0000');
-- 7 / 30 / 90 and window matching
SELECT qa.eq('30D AD1 row (own window)', $q$SELECT reach||'|'||frequency||'|'||inline_link_clicks||'|'||outbound_clicks FROM meta_ads_range_metrics('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',30,'2026-10-11','2026-11-09','ad') WHERE id='120232883780380285'$q$, '20000|1.5000|500|450');
SELECT qa.eq('90D AD1 row (own window)', $q$SELECT reach||'|'||frequency||'|'||inline_link_clicks||'|'||outbound_clicks FROM meta_ads_range_metrics('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',90,'2026-08-12','2026-11-09','ad') WHERE id='120232883780380285'$q$, '40000|2.2500|1500|1300');
SELECT qa.eq('reach differs per window (never derived from another window): 7D 5200 / 30D 20000 / 90D 40000', $q$SELECT string_agg(reach::text, ' / ' ORDER BY days) FROM (SELECT 7 days, reach FROM meta_ads_range_metrics('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',7,'2026-11-03','2026-11-09','ad') WHERE id='120232883780380285' UNION ALL SELECT 30, reach FROM meta_ads_range_metrics('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',30,'2026-10-11','2026-11-09','ad') WHERE id='120232883780380285' UNION ALL SELECT 90, reach FROM meta_ads_range_metrics('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',90,'2026-08-12','2026-11-09','ad') WHERE id='120232883780380285') x$q$, '5200 / 20000 / 40000');
SELECT qa.eq('STALE window is ignored: AD2 30D written for 10-10..11-08 is not returned for 10-11..11-09', $q$SELECT count(*) FROM meta_ads_range_metrics('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',30,'2026-10-11','2026-11-09','ad') WHERE id='120239084979500285'$q$, '0');
SELECT qa.eq('a window that includes today (D-7..D) matches nothing', $q$SELECT count(*) FROM meta_ads_range_metrics('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',7,'2026-11-03','2026-11-10','ad')$q$, '0');
SELECT qa.eq('wrong days for a stored window matches nothing', $q$SELECT count(*) FROM meta_ads_range_metrics('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',30,'2026-11-03','2026-11-09','ad')$q$, '0');
SELECT qa.eq('unknown level returns nothing', $q$SELECT count(*) FROM meta_ads_range_metrics('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',7,'2026-11-03','2026-11-09','nope')$q$, '0');
SELECT qa.eq('another account id returns nothing for this caller', $q$SELECT count(*) FROM meta_ads_range_metrics('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',7,'2026-11-03','2026-11-09','ad')$q$, '0');
SELECT qa.eq('same ad id in another tenant never leaks into A (AD1 reach is A''s 5200)', $q$SELECT count(*)||'|'||max(reach) FROM meta_ads_range_metrics('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',7,'2026-11-03','2026-11-09','ad') WHERE id='120232883780380285'$q$, '1|5200');
SELECT qa.ok('function result exposes no token column; body aggregates only actions (jsonb_object_agg), never reach', pg_get_function_result('public.meta_ads_range_metrics(uuid,integer,date,date,text)'::regprocedure) !~* 'token' AND (SELECT prosrc !~* 'sum\s*\(' FROM pg_proc WHERE oid='public.meta_ads_range_metrics(uuid,integer,date,date,text)'::regprocedure));
COMMIT;
RESET ROLE;

-- ===== tenancy, roles =====
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'b0000000-0000-4000-8000-0000000000b2', false);
SELECT qa.eq('agent of B sees only B''s range row (reach 1)', $q$SELECT count(*)||'|'||max(reach) FROM meta_ads_range_metrics('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',7,'2026-11-03','2026-11-09','ad')$q$, '1|1');
SELECT qa.eq('agent of B through the tables (RLS): only B rows', 'SELECT count(DISTINCT account_id) FROM public.meta_ads_insights_range', '1');
SELECT qa.eq('agent of B cannot read A''s actions', 'SELECT count(*) FROM public.meta_ads_actions_range', '0');
SELECT set_config('request.jwt.claim.sub', 'c0000000-0000-4000-8000-0000000000c3', false);
SELECT qa.eq('viewer of A (below agent) gets nothing from the function', $q$SELECT count(*) FROM meta_ads_range_metrics('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',7,'2026-11-03','2026-11-09','ad')$q$, '0');
SELECT qa.eq('viewer of A sees no rows in the new tables', 'SELECT (SELECT count(*) FROM public.meta_ads_insights_range)+(SELECT count(*) FROM public.meta_ads_actions_range)', '0');
SELECT set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-0000000000a1', false);
SELECT qa.raises('authenticated cannot insert a range row', $q$INSERT INTO public.meta_ads_insights_range (account_id, level, entity_id, days, since, until, currency) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','ad','120232883780380999',7,'2026-11-03','2026-11-09','PEN')$q$, '42501');
SELECT qa.raises('authenticated cannot update range rows', $q$UPDATE public.meta_ads_insights_range SET reach = 1$q$, '42501');
SELECT qa.raises('authenticated cannot delete range rows', 'DELETE FROM public.meta_ads_insights_range', '42501');
SELECT qa.raises('authenticated cannot write actions', $q$DELETE FROM public.meta_ads_actions_range$q$, '42501');
SELECT qa.raises('TOKEN: authenticated still cannot read access_token_enc', 'SELECT access_token_enc FROM public.meta_ads_settings', '42501');
RESET ROLE;
SET ROLE anon;
SELECT qa.raises('anon: range table', 'SELECT 1 FROM public.meta_ads_insights_range', '42501');
SELECT qa.raises('anon: actions table', 'SELECT 1 FROM public.meta_ads_actions_range', '42501');
SELECT qa.raises('anon: range function', $q$SELECT * FROM meta_ads_range_metrics('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',7,'2026-11-03','2026-11-09','ad')$q$, '42501');
RESET ROLE;
SET ROLE service_role;
SELECT qa.eq('service_role reads every tenant (BYPASSRLS) and the technical tables', 'SELECT count(*) FROM public.meta_ads_insights_range', '9');
RESET ROLE;

-- ===== privilege matrix, RLS, function properties =====
SELECT qa.ok('GRANTS anon: nothing on the 2 new tables', NOT EXISTS (SELECT 1 FROM unnest(ARRAY['meta_ads_insights_range','meta_ads_actions_range']) t, unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p WHERE has_table_privilege('anon','public.'||t,p)));
SELECT qa.ok('GRANTS authenticated: SELECT only on the 2 new tables', NOT EXISTS (SELECT 1 FROM unnest(ARRAY['meta_ads_insights_range','meta_ads_actions_range']) t, unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p WHERE has_table_privilege('authenticated','public.'||t,p)) AND has_table_privilege('authenticated','public.meta_ads_insights_range','SELECT') AND has_table_privilege('authenticated','public.meta_ads_actions_range','SELECT'));
SELECT qa.ok('GRANTS service_role: full access on the 2 new tables', NOT EXISTS (SELECT 1 FROM unnest(ARRAY['meta_ads_insights_range','meta_ads_actions_range']) t, unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p WHERE NOT has_table_privilege('service_role','public.'||t,p)));
SELECT qa.ok('RLS enabled on all 9 meta_ads tables', (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname LIKE 'meta_ads_%' AND c.relkind='r' AND c.relrowsecurity) = 9 AND (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname LIKE 'meta_ads_%' AND c.relkind='r') = 9);
SELECT qa.ok('RLS: 7 policies in total, all SELECT-only, none on settings/sync_state', (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename LIKE 'meta_ads_%') = 7 AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename LIKE 'meta_ads_%' AND (cmd <> 'SELECT' OR tablename IN ('meta_ads_settings','meta_ads_sync_state'))));
SELECT qa.ok('FUNCTION: anon none; authenticated + service_role execute; invoker, stable, search_path pinned', NOT has_function_privilege('anon','public.meta_ads_range_metrics(uuid,integer,date,date,text)','EXECUTE') AND has_function_privilege('authenticated','public.meta_ads_range_metrics(uuid,integer,date,date,text)','EXECUTE') AND has_function_privilege('service_role','public.meta_ads_range_metrics(uuid,integer,date,date,text)','EXECUTE')
  AND (SELECT NOT prosecdef AND provolatile='s' AND proconfig::text LIKE '%search_path=public%' FROM pg_proc WHERE oid='public.meta_ads_range_metrics(uuid,integer,date,date,text)'::regprocedure));
SELECT qa.ok('20261118 touched no pre-existing WACRM function: the four report functions still have their original signatures', to_regprocedure('public.meta_ads_performance(uuid,date,date,text)') IS NOT NULL AND to_regprocedure('public.ads_results_meta_catalog(uuid,text[])') IS NOT NULL AND to_regprocedure('public.meta_ads_insights_totals(uuid,date,date)') IS NOT NULL);

-- ===== CHECK / FK / PK behaviour =====
SELECT qa.raises('CHECK level', $q$INSERT INTO public.meta_ads_insights_range (account_id, level, entity_id, days, since, until, currency) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','page','120232883780380999',7,'2026-11-03','2026-11-09','PEN')$q$, '23514');
SELECT qa.raises('CHECK days must be 7/30/90', $q$INSERT INTO public.meta_ads_insights_range (account_id, level, entity_id, days, since, until, currency) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','ad','120232883780380999',14,'2026-11-03','2026-11-09','PEN')$q$, '23514');
SELECT qa.raises('CHECK entity_id numeric', $q$INSERT INTO public.meta_ads_insights_range (account_id, level, entity_id, days, since, until, currency) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','ad','abc',7,'2026-11-03','2026-11-09','PEN')$q$, '23514');
SELECT qa.raises('CHECK until >= since', $q$INSERT INTO public.meta_ads_insights_range (account_id, level, entity_id, days, since, until, currency) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','ad','120232883780380999',7,'2026-11-09','2026-11-03','PEN')$q$, '23514');
SELECT qa.raises('CHECK negative reach', $q$INSERT INTO public.meta_ads_insights_range (account_id, level, entity_id, days, since, until, reach, currency) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','ad','120232883780380999',7,'2026-11-03','2026-11-09',-1,'PEN')$q$, '23514');
SELECT qa.raises('CHECK currency upper-case', $q$INSERT INTO public.meta_ads_insights_range (account_id, level, entity_id, days, since, until, currency) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','ad','120232883780380999',7,'2026-11-03','2026-11-09','pen')$q$, '23514');
SELECT qa.raises('NOT NULL currency', $q$INSERT INTO public.meta_ads_insights_range (account_id, level, entity_id, days, since, until) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','ad','120232883780380999',7,'2026-11-03','2026-11-09')$q$, '23502');
SELECT qa.raises('PK duplicate range row', $q$INSERT INTO public.meta_ads_insights_range (account_id, level, entity_id, days, since, until, currency) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','ad','120232883780380285',7,'2026-11-03','2026-11-09','PEN')$q$, '23505');
SELECT qa.raises('FK range row -> unknown account', $q$INSERT INTO public.meta_ads_insights_range (account_id, level, entity_id, days, since, until, currency) VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','ad','120232883780380285',7,'2026-11-03','2026-11-09','PEN')$q$, '23503');
SELECT qa.raises('FK: an action cannot exist without its range row', $q$INSERT INTO public.meta_ads_actions_range VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','ad','120232883780380999',7,'lead','2026-11-03','2026-11-09',1)$q$, '23503');
SELECT qa.raises('CHECK action_type charset', $q$INSERT INTO public.meta_ads_actions_range VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','ad','120232883780380285',7,'bad type;drop','2026-11-03','2026-11-09',1)$q$, '23514');
SELECT qa.raises('CHECK negative action value', $q$INSERT INTO public.meta_ads_actions_range VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','ad','120232883780380285',7,'lead_x','2026-11-03','2026-11-09',-1)$q$, '23514');
SELECT qa.raises('PK duplicate action', $q$INSERT INTO public.meta_ads_actions_range VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','ad','120232883780380285',7,'lead','2026-11-03','2026-11-09',9)$q$, '23505');
SELECT qa.raises('job CHECK: unknown job still rejected', $q$INSERT INTO public.meta_ads_sync_state (account_id, job) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','nope')$q$, '23514');
INSERT INTO public.meta_ads_sync_state (account_id, job) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','ranges');
SELECT qa.eq('job ranges accepted', $q$SELECT count(*) FROM public.meta_ads_sync_state WHERE job='ranges'$q$, '1');

-- ===== upsert replaces the window in place; actions follow their range row =====
INSERT INTO public.meta_ads_insights_range (account_id, level, entity_id, days, since, until, reach, currency) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','ad','120239084979500285',30,'2026-10-11','2026-11-09',1800,'PEN')
  ON CONFLICT (account_id, level, entity_id, days) DO UPDATE SET since = EXCLUDED.since, until = EXCLUDED.until, reach = EXCLUDED.reach, synced_at = now();
SELECT qa.eq('upsert on the 4-column PK: one row per (account, level, entity, days); the new window replaced the stale one', $q$SELECT count(*)||'|'||max(since)||'|'||max(reach) FROM public.meta_ads_insights_range WHERE entity_id='120239084979500285' AND days=30$q$, '1|2026-10-11|1800');
SELECT qa.eq('...and the function now returns it for the new window and nothing for the old one', $q$SELECT (SELECT count(*) FROM meta_ads_range_metrics('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',30,'2026-10-11','2026-11-09','ad') WHERE id='120239084979500285')||'/'||(SELECT count(*) FROM meta_ads_range_metrics('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',30,'2026-10-10','2026-11-08','ad') WHERE id='120239084979500285')$q$, '1/0');
INSERT INTO public.meta_ads_actions_range VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','ad','120239084979500285',7,'video_view','2026-11-03','2026-11-09',5);
SET ROLE service_role;
-- (sync prune) rows not refreshed by a completed unit are removed: same statement the app runs after a COMPLETE unit
DELETE FROM public.meta_ads_insights_range WHERE account_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' AND level='ad' AND days=7 AND entity_id='120239084979500285';
RESET ROLE;
SELECT qa.eq('deleting a range row cascades ONLY its own actions (AD1 keeps 10, AD2 loses its action and its range row)', $q$SELECT (SELECT count(*) FROM public.meta_ads_actions_range WHERE entity_id='120232883780380285')||'/'||(SELECT count(*) FROM public.meta_ads_actions_range WHERE entity_id='120239084979500285')||'/'||(SELECT count(*) FROM public.meta_ads_insights_range WHERE entity_id='120239084979500285' AND days=7)$q$, '10/0/0');

-- ===== cascade by account =====
INSERT INTO auth.users (id) VALUES ('d0000000-0000-4000-8000-0000000000d4');
INSERT INTO public.accounts (id, name, owner_user_id) VALUES ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'Z', 'd0000000-0000-4000-8000-0000000000d4');
INSERT INTO public.meta_ads_insights_range (account_id, level, entity_id, days, since, until, currency) VALUES ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','ad','120232883780380285',7,'2026-11-03','2026-11-09','PEN');
INSERT INTO public.meta_ads_actions_range VALUES ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','ad','120232883780380285',7,'lead','2026-11-03','2026-11-09',1);
DELETE FROM public.accounts WHERE id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
SELECT qa.eq('ON DELETE CASCADE empties both new tables for the deleted account', $q$SELECT (SELECT count(*) FROM public.meta_ads_insights_range WHERE account_id='dddddddd-dddd-4ddd-8ddd-dddddddddddd')+(SELECT count(*) FROM public.meta_ads_actions_range WHERE account_id='dddddddd-dddd-4ddd-8ddd-dddddddddddd')$q$, '0');
DELETE FROM auth.users WHERE id = 'd0000000-0000-4000-8000-0000000000d4';
