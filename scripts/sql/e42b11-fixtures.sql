-- Shared fixtures for the E4.2B1.1 suites, built on the real schema.
-- Requires e42b11-qa-helpers.sql. Account A = user 1000..01, account B =
-- user 1000..02 (the signup trigger provisions account + profile).
--   A: flows 5000..01 active+published, ..02 draft (never published),
--      ..03 archived (was published), ..04 active without a version,
--      ..05 / ..06 published with an invalid entry cursor (missing / null).
--   A contacts 3000..01-08, conversations 4000..0N for contact 3000..0N (N<=4).
--   B: flow 6000..01 published, contact 7000..01, conversation 8000..01 (that
--      contact), conversation 8000..02 (account B but pointing at A contact 08).
INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) VALUES
 ('10000000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','qa-a@example.test','{"full_name":"QA A"}'::jsonb, now(), now()),
 ('10000000-0000-4000-8000-000000000002','00000000-0000-0000-0000-000000000000','authenticated','authenticated','qa-b@example.test','{"full_name":"QA B"}'::jsonb, now(), now());

SELECT account_id AS acct FROM public.profiles WHERE user_id='10000000-0000-4000-8000-000000000001' \gset
SELECT account_id AS acct_b FROM public.profiles WHERE user_id='10000000-0000-4000-8000-000000000002' \gset

INSERT INTO public.contacts (id, user_id, account_id, phone, name)
SELECT ('30000000-0000-4000-8000-00000000000' || n)::uuid, '10000000-0000-4000-8000-000000000001', :'acct', '+1555000000' || n, 'Contact ' || n
FROM generate_series(1,8) n;
INSERT INTO public.contacts (id, user_id, account_id, phone, name)
VALUES ('70000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002',:'acct_b','+15551000001','Contact B1');

INSERT INTO public.conversations (id, user_id, account_id, contact_id)
SELECT ('40000000-0000-4000-8000-00000000000' || n)::uuid, '10000000-0000-4000-8000-000000000001', :'acct',
       ('30000000-0000-4000-8000-00000000000' || n)::uuid
FROM generate_series(1,4) n;
INSERT INTO public.conversations (id, user_id, account_id, contact_id) VALUES
 ('80000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002',:'acct_b','70000000-0000-4000-8000-000000000001'),
 ('80000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002',:'acct_b','30000000-0000-4000-8000-000000000008');

INSERT INTO public.flows (id, user_id, account_id, name, trigger_type, entry_node_id) VALUES
 ('50000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',:'acct','QA active','manual','start'),
 ('50000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001',:'acct','QA draft','manual','start'),
 ('50000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001',:'acct','QA archived','manual','start'),
 ('50000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000001',:'acct','QA bad entry','manual','missing'),
 ('50000000-0000-4000-8000-000000000006','10000000-0000-4000-8000-000000000001',:'acct','QA null entry','manual',NULL),
 ('60000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002',:'acct_b','QA other account','manual','start');
INSERT INTO public.flow_nodes (flow_id, node_key, node_type, config)
SELECT f, k, t, CASE t WHEN 'start' THEN '{"next_node_key":"end"}'::jsonb ELSE '{}'::jsonb END
FROM unnest(ARRAY[
  '50000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000002','50000000-0000-4000-8000-000000000003',
  '50000000-0000-4000-8000-000000000005','50000000-0000-4000-8000-000000000006','60000000-0000-4000-8000-000000000001']::uuid[]) f,
  (VALUES ('start','start'),('end','end')) v(k,t);

SELECT public.qa_publish('50000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001');
SELECT public.qa_publish('50000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001');
SELECT public.qa_publish('50000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000001');
SELECT public.qa_publish('50000000-0000-4000-8000-000000000006','10000000-0000-4000-8000-000000000001');
SELECT public.qa_publish('60000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002');
-- Archive flow ..03 (keeps its published version) and create flow ..04, which
-- is active without a version; only possible by impersonating the publish API.
UPDATE public.flows SET status='archived' WHERE id='50000000-0000-4000-8000-000000000003';
SELECT set_config('app.flow_publication','on',false);
INSERT INTO public.flows (id, user_id, account_id, name, trigger_type, entry_node_id, status)
VALUES ('50000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000001',:'acct','QA active no version','manual','start','active');
SELECT set_config('app.flow_publication','off',false);
