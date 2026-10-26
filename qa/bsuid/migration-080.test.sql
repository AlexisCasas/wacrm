-- Isolated-database checks for migration 080 (run AFTER 077-079 and their tests). Every block prints PASS/FAIL.
\set QUIET on
\pset tuples_only on
\pset format unaligned
create or replace function pg_temp.check(name text, ok boolean) returns void language plpgsql as $$ begin raise notice '% %', case when ok then 'PASS' else 'FAIL' end, name; end $$;
\set A 'a1a1a1a1-0000-4000-8000-00000000000a'
\set B 'b2b2b2b2-0000-4000-8000-00000000000b'
\set UA 'aaaaaaaa-0000-4000-8000-000000000001'
\set UB 'bbbbbbbb-0000-4000-8000-000000000002'
\set PNA '7700000000000001'
\set WBA '7800000000000001'

delete from whatsapp_config where account_id in (:'A', :'B');
insert into whatsapp_config(user_id,phone_number_id,waba_id,access_token,status,account_id) values (:'UA', :'PNA', :'WBA', 'enc', 'connected', :'A');
delete from bsuid_pilot_scopes where account_id in (:'A', :'B');
select contact_id as p1 from resolve_bsuid_contact(:'A',:'UA','PE.P80QA00000000001',null,'p1','P1') \gset
select contact_id as p2 from resolve_bsuid_contact(:'A',:'UA','PE.P80QA00000000002',null,'p2','P2') \gset
select contact_id as pb from resolve_bsuid_contact(:'B',:'UB','PE.P80QB00000000001',null,'pb','PB') \gset
insert into conversations(account_id,user_id,contact_id) values (:'A',:'UA',:'p1'),(:'A',:'UA',:'p2'),(:'B',:'UB',:'pb') on conflict do nothing;
insert into messages(conversation_id,sender_type,content_text,created_at) select id,'customer','hola',now() - interval '10 minutes' from conversations where contact_id in (:'p1',:'p2',:'pb');

select pg_temp.check('columns exist with CLOSED defaults (false, 60)', (select count(*) from information_schema.columns where table_name='bsuid_pilot_scopes' and column_name in ('agents_reply_without_credit','max_agent_replies_per_contact_hour'))=2);
insert into bsuid_pilot_scopes(account_id,phone_number_id,waba_id,enabled) values (:'A', :'PNA', :'WBA', true);
select pg_temp.check('a new scope has the policy OFF by default', (select not agents_reply_without_credit and max_agent_replies_per_contact_hour=60 from bsuid_pilot_scopes where account_id=:'A'));
select pg_temp.check('policy off + no credit: refused (previous behavior)', not consume_bsuid_send(:'A',:'p1','manual_reply'));

update bsuid_pilot_scopes set agents_reply_without_credit = true where account_id = :'A';
select consume_bsuid_send(:'A',:'p1','manual_reply') as r1 \gset
select consume_bsuid_send(:'A',:'p1','manual_reply') as r2 \gset
select pg_temp.check('policy ON: a manual reply is allowed with no credit, repeatedly, and no credit is spent', :'r1' = 't' and :'r2' = 't' and (select send_authorized_remaining from contact_identities where contact_id=:'p1' and kind='bsuid')=0);
select pg_temp.check('every use is audited as send_policy_allowed (no message content, no id in the detail)', (select count(*) from contact_identity_audit where contact_id=:'p1' and event='send_policy_allowed')=2 and (select detail from contact_identity_audit where contact_id=:'p1' and event='send_policy_allowed' limit 1) = '{"policy": "agents_reply_without_credit"}'::jsonb);
select pg_temp.check('any origin other than manual_reply is refused (automated, flow, api, empty)', not consume_bsuid_send(:'A',:'p1','automated') and not consume_bsuid_send(:'A',:'p1','flow') and not consume_bsuid_send(:'A',:'p1','api') and not consume_bsuid_send(:'A',:'p1',''));
select pg_temp.check('a contact of ANOTHER account cannot be reached through this account''s policy', not consume_bsuid_send(:'A',:'pb','manual_reply'));
select pg_temp.check('the other account (no scope, no policy) is untouched: refused without credit', not consume_bsuid_send(:'B',:'pb','manual_reply'));

-- 24 h window
update messages set created_at = now() - interval '23 hours 50 minutes' where conversation_id = (select id from conversations where contact_id=:'p2');
select pg_temp.check('customer wrote 23 h 50 min ago: window open, allowed', consume_bsuid_send(:'A',:'p2','manual_reply'));
update messages set created_at = now() - interval '24 hours 10 minutes' where conversation_id = (select id from conversations where contact_id=:'p2');
select pg_temp.check('customer wrote 24 h 10 min ago: window closed, refused (Meta would refuse it too)', not consume_bsuid_send(:'A',:'p2','manual_reply'));
update contact_identities set send_authorized_remaining = 1 where contact_id=:'p2' and kind='bsuid';
select consume_bsuid_send(:'A',:'p2','manual_reply') as rc \gset
select pg_temp.check('window closed but an operator credit exists: the credit path still works (previous behavior preserved)', :'rc' = 't' and (select send_authorized_remaining from contact_identities where contact_id=:'p2' and kind='bsuid')=0);
update messages set created_at = now() - interval '5 minutes' where conversation_id = (select id from conversations where contact_id=:'p2');

-- identity must be ACTIVE
update contact_identities set superseded_at = now() where contact_id=:'p2' and kind='bsuid';
select pg_temp.check('no ACTIVE BSUID identity (superseded): refused', not consume_bsuid_send(:'A',:'p2','manual_reply'));
update contact_identities set superseded_at = null where contact_id=:'p2' and kind='bsuid';

-- hourly cap per contact (agent messages only)
update bsuid_pilot_scopes set max_agent_replies_per_contact_hour = 3 where account_id=:'A';
insert into messages(conversation_id,sender_type,content_text,created_at) select (select id from conversations where contact_id=:'p2'),'agent','r'||g, now() - interval '10 minutes' from generate_series(1,2) g;
select pg_temp.check('2 agent replies in the last hour with a cap of 3: allowed', consume_bsuid_send(:'A',:'p2','manual_reply'));
insert into messages(conversation_id,sender_type,content_text,created_at) values ((select id from conversations where contact_id=:'p2'),'agent','r3', now() - interval '5 minutes');
select pg_temp.check('the 3rd reply reaches the cap: refused until the hour rolls', not consume_bsuid_send(:'A',:'p2','manual_reply'));
select pg_temp.check('the cap is per contact: another contact of the account is not affected', consume_bsuid_send(:'A',:'p1','manual_reply'));
update messages set created_at = now() - interval '2 hours' where sender_type='agent' and conversation_id = (select id from conversations where contact_id=:'p2');
select pg_temp.check('replies older than one hour do not count', consume_bsuid_send(:'A',:'p2','manual_reply'));

-- the scope must match the account's OWN number, be enabled and have the flag
update bsuid_pilot_scopes set enabled = false where account_id=:'A';
select pg_temp.check('scope disabled: policy does not apply', not consume_bsuid_send(:'A',:'p1','manual_reply'));
update bsuid_pilot_scopes set enabled = true, waba_id = '7899999999999999' where account_id=:'A';
select pg_temp.check('scope WABA different from the number''s configuration: policy does not apply', not consume_bsuid_send(:'A',:'p1','manual_reply'));
update bsuid_pilot_scopes set waba_id = :'WBA', agents_reply_without_credit = false where account_id=:'A';
select pg_temp.check('flag switched off again (kill switch): back to credit-only at once', not consume_bsuid_send(:'A',:'p1','manual_reply'));
delete from whatsapp_config where account_id=:'A';
update bsuid_pilot_scopes set agents_reply_without_credit = true where account_id=:'A';
select pg_temp.check('account without a WhatsApp configuration row: policy does not apply', not consume_bsuid_send(:'A',:'p1','manual_reply'));

-- permissions unchanged and idempotent re-application is run by the caller
set role authenticated;
do $$ declare ok boolean := false; begin
  begin perform public.consume_bsuid_send('a1a1a1a1-0000-4000-8000-00000000000a', gen_random_uuid(), 'manual_reply'); exception when insufficient_privilege then ok := true; end;
  perform pg_temp.check('the replaced function is still service_role only (a client cannot call it)', ok); end $$;
do $$ declare ok boolean := false; begin
  begin update public.bsuid_pilot_scopes set agents_reply_without_credit = true; exception when insufficient_privilege then ok := true; end;
  perform pg_temp.check('a client cannot switch the policy on', ok); end $$;
reset role;
