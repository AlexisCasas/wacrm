-- Checks right after 20261116000000_meta_ads_catalog.sql (nothing from 20261117 applied yet).
\set ON_ERROR_STOP on
RESET ROLE;
SELECT qa.ok('p1 tables exist', to_regclass('public.meta_ads_settings') IS NOT NULL AND to_regclass('public.meta_ads_ads') IS NOT NULL AND to_regclass('public.meta_ads_sync_state') IS NOT NULL);
SELECT qa.ok('p1 ads_results_meta_catalog exists', to_regprocedure('public.ads_results_meta_catalog(uuid,text[])') IS NOT NULL);
SELECT qa.ok('p1 insights objects do NOT exist yet', to_regclass('public.meta_ads_insights_daily') IS NULL AND to_regclass('public.meta_ads_campaigns') IS NULL AND to_regclass('public.meta_ads_adsets') IS NULL AND to_regclass('public.meta_ads_reconciliation') IS NULL AND to_regprocedure('public.meta_ads_performance(uuid,date,date,text)') IS NULL);
SELECT qa.eq('p1 job CHECK is catalog-only', $q$SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='meta_ads_sync_state_job'$q$, $q$CHECK ((job = 'catalog'::text))$q$);
SELECT qa.ok('p1 no spend/impressions/clicks/reach column anywhere in the catalog tables', NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name LIKE 'meta_ads_%' AND column_name IN ('spend','impressions','clicks','reach')));

TRUNCATE public.meta_ads_settings, public.meta_ads_ads, public.meta_ads_sync_state CASCADE;
INSERT INTO public.meta_ads_settings (account_id, ad_account_id, access_token_enc, token_status) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '409949686293101', 'aabbccddeeff001122334455:deadbeef:00112233445566778899aabbccddeeff', 'valid'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '555555555555555', 'bbbbbbbbbbbbbbbbbbbbbbbb:cafe:ffeeddccbbaa99887766554433221100', 'valid');
INSERT INTO public.meta_ads_ads (account_id, ad_id, name, status, effective_status) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '120232883780380285', 'Anuncio Uno', 'ACTIVE', 'ACTIVE'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '120239084979500285', 'Anuncio Dos', 'PAUSED', 'PAUSED'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '120232883780380285', 'Anuncio de B (mismo id)', 'ACTIVE', 'ACTIVE');
INSERT INTO public.meta_ads_sync_state (account_id, job) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'catalog');
SELECT qa.raises('p1 job insights rejected before 20261117', $q$INSERT INTO public.meta_ads_sync_state (account_id, job) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','insights')$q$, '23514');

-- anon: nothing.
SET ROLE anon;
SELECT qa.raises('p1 anon cannot read settings', 'SELECT 1 FROM public.meta_ads_settings', '42501');
SELECT qa.raises('p1 anon cannot read ads', 'SELECT 1 FROM public.meta_ads_ads', '42501');
SELECT qa.raises('p1 anon cannot read sync_state', 'SELECT 1 FROM public.meta_ads_sync_state', '42501');
SELECT qa.raises('p1 anon cannot call the catalog RPC', $q$SELECT * FROM public.ads_results_meta_catalog('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ARRAY['120232883780380285'])$q$, '42501');
RESET ROLE;

-- authenticated agent of A.
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-0000000000a1', false);
SELECT qa.raises('p1 TOKEN: authenticated cannot read access_token_enc', 'SELECT access_token_enc FROM public.meta_ads_settings', '42501');
SELECT qa.raises('p1 TOKEN: authenticated cannot read settings at all (SELECT *)', 'SELECT * FROM public.meta_ads_settings', '42501');
SELECT qa.raises('p1 authenticated cannot read sync_state', 'SELECT 1 FROM public.meta_ads_sync_state', '42501');
SELECT qa.raises('p1 authenticated cannot write ads', $q$INSERT INTO public.meta_ads_ads (account_id, ad_id) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','120232883780380999')$q$, '42501');
SELECT qa.raises('p1 authenticated cannot update ads', $q$UPDATE public.meta_ads_ads SET name='x'$q$, '42501');
SELECT qa.raises('p1 authenticated cannot delete ads', 'DELETE FROM public.meta_ads_ads', '42501');
SELECT qa.eq('p1 RLS: agent of A sees only A''s catalog rows', 'SELECT count(*) FROM public.meta_ads_ads', '2');
SELECT qa.eq('p1 catalog RPC returns the requested ads of the caller''s account (name from the catalog)', $q$SELECT string_agg(name, ',' ORDER BY name) FROM public.ads_results_meta_catalog('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ARRAY['120232883780380285','120239084979500285','120256299148760285'])$q$, 'Anuncio Dos,Anuncio Uno');
SELECT qa.eq('p1 catalog RPC cannot be pointed at another account', $q$SELECT count(*) FROM public.ads_results_meta_catalog('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', ARRAY['120232883780380285'])$q$, '0');
SELECT qa.eq('p1 catalog RPC with NULL ids is empty', $q$SELECT count(*) FROM public.ads_results_meta_catalog('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', NULL)$q$, '0');
SELECT qa.eq('p1 catalog RPC caps the id list at 500 (501st id is ignored)', $q$SELECT count(*) FROM public.ads_results_meta_catalog('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', (SELECT array_agg(lpad(g::text, 10, '9')) || ARRAY['120232883780380285'] FROM generate_series(1, 500) g))$q$, '0');
-- read-only: the function runs inside a READ ONLY transaction.
BEGIN READ ONLY;
SELECT qa.eq('p1 catalog RPC works in a READ ONLY transaction', $q$SELECT count(*) FROM public.ads_results_meta_catalog('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ARRAY['120232883780380285'])$q$, '1');
COMMIT;
RESET ROLE;

-- viewer of A (below agent) and agent of B.
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c0000000-0000-4000-8000-0000000000c3', false);
SELECT qa.eq('p1 viewer of A sees no catalog rows (policy needs agent+)', 'SELECT count(*) FROM public.meta_ads_ads', '0');
SELECT qa.eq('p1 viewer of A gets nothing from the catalog RPC', $q$SELECT count(*) FROM public.ads_results_meta_catalog('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ARRAY['120232883780380285'])$q$, '0');
SELECT set_config('request.jwt.claim.sub', 'b0000000-0000-4000-8000-0000000000b2', false);
SELECT qa.eq('p1 agent of B sees only B''s row', $q$SELECT string_agg(name, ',') FROM public.meta_ads_ads$q$, 'Anuncio de B (mismo id)');
RESET ROLE;

-- service_role: technical access.
SET ROLE service_role;
SELECT qa.eq('p1 service_role reads every account (BYPASSRLS)', 'SELECT count(*) FROM public.meta_ads_ads', '3');
SELECT qa.eq('p1 service_role reads the stored token column', $q$SELECT count(*) FROM public.meta_ads_settings WHERE access_token_enc IS NOT NULL$q$, '2');
RESET ROLE;
