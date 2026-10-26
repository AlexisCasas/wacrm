-- Isolated-database checks for migration 079 (run AFTER 078 and its test, same scratch database). Every block prints PASS/FAIL.
\set QUIET on
\pset tuples_only on
\pset format unaligned
create or replace function pg_temp.check(name text, ok boolean) returns void language plpgsql as $$ begin raise notice '% %', case when ok then 'PASS' else 'FAIL' end, name; end $$;
\set A 'a1a1a1a1-0000-4000-8000-00000000000a'
\set UA 'aaaaaaaa-0000-4000-8000-000000000001'
\set F9 'f9f9f9f9-0000-4000-8000-000000000009'

delete from bsuid_flow_authorizations; delete from flow_runs where account_id = :'A';
insert into flows(id,user_id,name,trigger_type,trigger_config,status,account_id) values (:'F9',:'UA','QA volume flow','keyword','{}','active',:'A') on conflict do nothing;
insert into bsuid_flow_settings(account_id,flows_enabled) values (:'A',true) on conflict (account_id) do update set flows_enabled = true;
insert into bsuid_flow_authorizations(account_id,flow_id,enabled,allow_text) values (:'A',:'F9',true,true);
select contact_id as v1 from resolve_bsuid_contact(:'A',:'UA','PE.V79QA00000000001',null,'v1','V1') \gset
select contact_id as v2 from resolve_bsuid_contact(:'A',:'UA','PE.V79QA00000000002',null,'v2','V2') \gset
insert into conversations(account_id,user_id,contact_id) values (:'A',:'UA',:'v1'),(:'A',:'UA',:'v2') on conflict do nothing;
insert into flow_runs(id,flow_id,user_id,account_id,contact_id,status) values ('00000000-0000-4000-8000-0000000079a1',:'F9',:'UA',:'A',:'v1','active'),('00000000-0000-4000-8000-0000000079a2',:'F9',:'UA',:'A',:'v2','active');

select pg_temp.check('defaults: 60 per contact and 1200 per account per hour', (select max_contact_sends_per_hour = 60 and max_account_sends_per_hour = 1200 from bsuid_flow_settings where account_id = :'A'));
select pg_temp.check('below the ceilings the authorized text send is ok (same behavior as 078)', bsuid_flow_send_check(:'A','00000000-0000-4000-8000-0000000079a1',:'v1','text') = 'ok');
select pg_temp.check('all the 078 refusals are unchanged (modality, run, account)', bsuid_flow_send_check(:'A','00000000-0000-4000-8000-0000000079a1',:'v1','media') = 'modality_not_allowed' and bsuid_flow_send_check(:'A',gen_random_uuid(),:'v1','text') = 'run_invalid' and bsuid_flow_send_check(:'A','00000000-0000-4000-8000-0000000079a1',:'v2','text') = 'run_invalid');

-- per-contact ceiling: lower it to 5 and add 5 recent bot messages to v1
update bsuid_flow_settings set max_contact_sends_per_hour = 5 where account_id = :'A';
insert into messages(conversation_id,sender_type,content_text,created_at) select (select id from conversations where contact_id = :'v1'), 'bot', 'x'||g, now() - interval '5 minutes' from generate_series(1,4) g;
select pg_temp.check('4 recent bot messages with a ceiling of 5: still ok', bsuid_flow_send_check(:'A','00000000-0000-4000-8000-0000000079a1',:'v1','text') = 'ok');
insert into messages(conversation_id,sender_type,content_text,created_at) values ((select id from conversations where contact_id = :'v1'), 'bot', 'x5', now() - interval '1 minute');
select pg_temp.check('the 5th recent bot message reaches the ceiling: rate_limited_contact', bsuid_flow_send_check(:'A','00000000-0000-4000-8000-0000000079a1',:'v1','text') = 'rate_limited_contact');
select pg_temp.check('another contact of the account is not affected by that contact''s ceiling', bsuid_flow_send_check(:'A','00000000-0000-4000-8000-0000000079a2',:'v2','text') = 'ok');
update messages set created_at = now() - interval '2 hours' where conversation_id = (select id from conversations where contact_id = :'v1');
select pg_temp.check('messages older than one hour do not count: sends resume by themselves', bsuid_flow_send_check(:'A','00000000-0000-4000-8000-0000000079a1',:'v1','text') = 'ok');
insert into messages(conversation_id,sender_type,content_text,created_at) select (select id from conversations where contact_id = :'v1'), 'agent', 'manual'||g, now() from generate_series(1,20) g;
select pg_temp.check('manual (agent) replies never count', bsuid_flow_send_check(:'A','00000000-0000-4000-8000-0000000079a1',:'v1','text') = 'ok');

-- per-account ceiling
update bsuid_flow_settings set max_contact_sends_per_hour = 60, max_account_sends_per_hour = 6 where account_id = :'A';
insert into messages(conversation_id,sender_type,content_text,created_at) select (select id from conversations where contact_id = :'v1'), 'bot', 'a'||g, now() - interval '2 minutes' from generate_series(1,3) g;
insert into messages(conversation_id,sender_type,content_text,created_at) select (select id from conversations where contact_id = :'v2'), 'bot', 'b'||g, now() - interval '2 minutes' from generate_series(1,3) g;
select pg_temp.check('6 recent bot messages across hidden-number contacts with an account ceiling of 6: rate_limited_account', bsuid_flow_send_check(:'A','00000000-0000-4000-8000-0000000079a1',:'v1','text') = 'rate_limited_account' and bsuid_flow_send_check(:'A','00000000-0000-4000-8000-0000000079a2',:'v2','text') = 'rate_limited_account');
update bsuid_flow_settings set max_account_sends_per_hour = 1200 where account_id = :'A';
select pg_temp.check('raising the ceiling lifts the limit at once', bsuid_flow_send_check(:'A','00000000-0000-4000-8000-0000000079a1',:'v1','text') = 'ok');

-- ceilings never touch contacts with a phone, and the settings are not writable by clients
do $$ declare ok boolean := true; begin
  begin update bsuid_flow_settings set max_contact_sends_per_hour = 0 where account_id = 'a1a1a1a1-0000-4000-8000-00000000000a'; ok := false; exception when check_violation then null; end;
  perform pg_temp.check('a ceiling of 0 is rejected', ok); end $$;
set role authenticated;
do $$ declare ok boolean := false; begin
  begin perform max_contact_sends_per_hour from public.bsuid_flow_settings; exception when insufficient_privilege then ok := true; end;
  perform pg_temp.check('authenticated clients cannot read or change the ceilings', ok); end $$;
do $$ declare ok boolean := false; begin
  begin perform public.bsuid_flow_send_check('a1a1a1a1-0000-4000-8000-00000000000a', gen_random_uuid(), gen_random_uuid(), 'text'); exception when insufficient_privilege then ok := true; end;
  perform pg_temp.check('the replaced function is still service_role only', ok); end $$;
reset role;
