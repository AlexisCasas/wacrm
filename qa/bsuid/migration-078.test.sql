-- Isolated-database checks for migration 078 (run AFTER 077 and its test, in the same scratch database). Every block prints PASS/FAIL.
\set QUIET on
\pset tuples_only on
\pset format unaligned
create or replace function pg_temp.check(name text, ok boolean) returns void language plpgsql as $$ begin raise notice '% %', case when ok then 'PASS' else 'FAIL' end, name; end $$;
\set A 'a1a1a1a1-0000-4000-8000-00000000000a'
\set B 'b2b2b2b2-0000-4000-8000-00000000000b'
\set UA 'aaaaaaaa-0000-4000-8000-000000000001'
\set UB 'bbbbbbbb-0000-4000-8000-000000000002'
\set F1 'f1f1f1f1-0000-4000-8000-000000000001'
\set F2 'f2f2f2f2-0000-4000-8000-000000000002'
\set FB 'fbfbfbfb-0000-4000-8000-0000000000bb'

-- fixtures: flows in A (F1 active, F2 active) and in B (FB), two BSUID-only contacts in A, one in B
insert into flows(id,user_id,name,trigger_type,trigger_config,status,account_id) values
 (:'F1',:'UA','QA flow 1','keyword','{}','active',:'A'),(:'F2',:'UA','QA flow 2','keyword','{}','active',:'A'),(:'FB',:'UB','QA flow B','keyword','{}','active',:'B');
select contact_id as c1 from resolve_bsuid_contact(:'A',:'UA','PE.F3QA00000000001',null,'ana','Ana') \gset
select contact_id as c2 from resolve_bsuid_contact(:'A',:'UA','PE.F3QA00000000002',null,'beto','Beto') \gset
select contact_id as cb from resolve_bsuid_contact(:'B',:'UB','PE.F3QA00000000003',null,'cami','Cami') \gset
select set_config('qa.c1', :'c1', false), set_config('qa.c2', :'c2', false);

-- 1 closed by default, RLS on, no access for clients
select pg_temp.check('RLS is enabled on the three tables', (select count(*) from pg_class where relname in ('bsuid_pilot_scopes','bsuid_flow_settings','bsuid_flow_authorizations') and relrowsecurity)=3);
insert into bsuid_flow_settings(account_id) values (:'A');
insert into bsuid_flow_authorizations(account_id,flow_id) values (:'A',:'F1');
select pg_temp.check('defaults are CLOSED: master switch off, authorization disabled, text only', (select not flows_enabled from bsuid_flow_settings where account_id=:'A') and (select not enabled and allow_text and not allow_media and not allow_buttons and not allow_list and not allow_audio from bsuid_flow_authorizations where account_id=:'A'));
select pg_temp.check('with the defaults nothing is authorized (scope empty)', bsuid_flow_scope(:'A',:'c1') = '{}');
do $$ declare ok boolean := true; begin
  begin insert into bsuid_pilot_scopes(account_id,phone_number_id,waba_id) values ('a1a1a1a1-0000-4000-8000-00000000000a','not-a-number','123456'); ok := false; exception when check_violation then null; end;
  perform pg_temp.check('a pilot scope needs numeric phone_number_id and WABA', ok); end $$;
insert into bsuid_pilot_scopes(account_id,phone_number_id,waba_id) values (:'A','1000000000000001','3000000000000001');
select pg_temp.check('a new pilot scope is DISABLED by default', (select not enabled from bsuid_pilot_scopes where account_id=:'A'));

set role authenticated;
select set_config('request.jwt.claim.sub', :'UA', false);
do $$ declare n int := 0; t text; begin
  foreach t in array array['bsuid_pilot_scopes','bsuid_flow_settings','bsuid_flow_authorizations'] loop
    begin execute format('select count(*) from public.%I', t); exception when insufficient_privilege then n := n + 1; end;
    begin execute format('insert into public.%I default values', t); exception when insufficient_privilege then n := n + 1; when others then null; end;
    begin execute format('update public.%I set updated_at = now()', t); exception when insufficient_privilege then n := n + 1; end;
    begin execute format('delete from public.%I', t); exception when insufficient_privilege then n := n + 1; end;
  end loop;
  perform pg_temp.check('an authenticated user can neither read, insert, update nor delete any of the three tables (12 denials)', n = 12); end $$;
do $$ declare n int := 0; begin
  begin perform bsuid_flow_scope('a1a1a1a1-0000-4000-8000-00000000000a', current_setting('qa.c1')::uuid); exception when insufficient_privilege then n := n + 1; end;
  begin perform bsuid_flow_send_check('a1a1a1a1-0000-4000-8000-00000000000a', gen_random_uuid(), current_setting('qa.c1')::uuid, 'text'); exception when insufficient_privilege then n := n + 1; end;
  perform pg_temp.check('an authenticated user cannot call either check function (the browser cannot ask or declare)', n = 2); end $$;
reset role;
set role anon;
do $$ declare n int := 0; begin
  begin perform bsuid_flow_scope('a1a1a1a1-0000-4000-8000-00000000000a', gen_random_uuid()); exception when insufficient_privilege then n := n + 1; end;
  begin perform count(*) from public.bsuid_flow_settings; exception when insufficient_privilege then n := n + 1; end;
  perform pg_temp.check('anon has no access either', n = 2); end $$;
reset role;

-- 2 integrity: no cross-account authorization is storable
do $$ declare ok boolean := true; begin
  begin insert into bsuid_flow_authorizations(account_id,flow_id) values ('b2b2b2b2-0000-4000-8000-00000000000b','f1f1f1f1-0000-4000-8000-000000000001'); ok := false; exception when insufficient_privilege then null; end;
  perform pg_temp.check('an account cannot authorize a flow of ANOTHER account', ok); end $$;
do $$ declare ok boolean := true; begin
  begin insert into bsuid_flow_authorizations(account_id,flow_id,contact_id) values ('a1a1a1a1-0000-4000-8000-00000000000a','f2f2f2f2-0000-4000-8000-000000000002', current_setting('qa.c1')::uuid), ('a1a1a1a1-0000-4000-8000-00000000000a','f2f2f2f2-0000-4000-8000-000000000002', (select contact_id from contact_identities where value='PE.F3QA00000000003'));
    ok := false; exception when insufficient_privilege then null; end;
  perform pg_temp.check('an authorization cannot name a contact of ANOTHER account', ok); end $$;
do $$ declare ok boolean := true; begin
  begin insert into bsuid_flow_authorizations(account_id,flow_id) values ('a1a1a1a1-0000-4000-8000-00000000000a','f1f1f1f1-0000-4000-8000-000000000001'); ok := false; exception when unique_violation then null; end;
  perform pg_temp.check('one whole-account authorization per flow (unique)', ok); end $$;

-- 3 bsuid_flow_scope
update bsuid_flow_authorizations set enabled = true where flow_id = :'F1';
select pg_temp.check('authorization enabled but master switch OFF -> empty scope', bsuid_flow_scope(:'A',:'c1') = '{}');
update bsuid_flow_settings set flows_enabled = true where account_id = :'A';
select pg_temp.check('master switch on + authorization enabled -> the flow', bsuid_flow_scope(:'A',:'c1') = array[:'F1'::uuid]);
select pg_temp.check('the same scope serves the other BSUID contact of the account (whole-account authorization)', bsuid_flow_scope(:'A',:'c2') = array[:'F1'::uuid]);
select pg_temp.check('a contact of another account gets nothing from this account''s authorization', bsuid_flow_scope(:'A',:'cb') = '{}');
update bsuid_flow_authorizations set expires_at = now() - interval '1 minute' where flow_id = :'F1';
select pg_temp.check('an expired authorization is out of scope', bsuid_flow_scope(:'A',:'c1') = '{}');
update bsuid_flow_authorizations set expires_at = now() + interval '1 hour' where flow_id = :'F1';
select pg_temp.check('a future expiry is in scope', bsuid_flow_scope(:'A',:'c1') = array[:'F1'::uuid]);
update flows set status = 'draft' where id = :'F1';
select pg_temp.check('a flow that is not active is out of scope', bsuid_flow_scope(:'A',:'c1') = '{}');
update flows set status = 'active' where id = :'F1';
update bsuid_flow_authorizations set expires_at = null, contact_id = :'c1' where flow_id = :'F1';
select pg_temp.check('canary: authorization for ONE contact serves that contact', bsuid_flow_scope(:'A',:'c1') = array[:'F1'::uuid]);
select pg_temp.check('canary: and not the other contact', bsuid_flow_scope(:'A',:'c2') = '{}');
update bsuid_flow_authorizations set contact_id = null where flow_id = :'F1';

-- 4 bsuid_flow_send_check
insert into flow_runs(id,flow_id,user_id,account_id,contact_id,status) values ('00000000-0000-4000-8000-0000000000a1',:'F1',:'UA',:'A',:'c1','active');
select pg_temp.check('active run of an authorized flow: text is ok', bsuid_flow_send_check(:'A','00000000-0000-4000-8000-0000000000a1',:'c1','text') = 'ok');
select pg_temp.check('media / buttons / list / audio are refused until their flag is on', (select array_agg(bsuid_flow_send_check(:'A','00000000-0000-4000-8000-0000000000a1',:'c1',m)) from unnest(array['media','buttons','list','audio']) m) = array['modality_not_allowed','modality_not_allowed','modality_not_allowed','modality_not_allowed']);
update bsuid_flow_authorizations set allow_media = true where flow_id = :'F1';
select pg_temp.check('turning media on opens media only', bsuid_flow_send_check(:'A','00000000-0000-4000-8000-0000000000a1',:'c1','media') = 'ok' and bsuid_flow_send_check(:'A','00000000-0000-4000-8000-0000000000a1',:'c1','audio') = 'modality_not_allowed');
select pg_temp.check('an unknown modality is refused', bsuid_flow_send_check(:'A','00000000-0000-4000-8000-0000000000a1',:'c1','sticker') = 'bad_modality' and bsuid_flow_send_check(:'A','00000000-0000-4000-8000-0000000000a1',:'c1',null) = 'bad_modality');
select pg_temp.check('a run id of ANOTHER contact is refused', bsuid_flow_send_check(:'A','00000000-0000-4000-8000-0000000000a1',:'c2','text') = 'run_invalid');
select pg_temp.check('the right run under the WRONG account is refused', bsuid_flow_send_check(:'B','00000000-0000-4000-8000-0000000000a1',:'c1','text') = 'run_invalid');
select pg_temp.check('a run id that does not exist is refused', bsuid_flow_send_check(:'A',gen_random_uuid(),:'c1','text') = 'run_invalid');
update bsuid_flow_settings set flows_enabled = false where account_id = :'A';
select pg_temp.check('KILL SWITCH: master switch off refuses the very next send of a run in progress', bsuid_flow_send_check(:'A','00000000-0000-4000-8000-0000000000a1',:'c1','text') = 'flows_disabled');
update bsuid_flow_settings set flows_enabled = true where account_id = :'A';
update bsuid_flow_authorizations set enabled = false where flow_id = :'F1';
select pg_temp.check('KILL SWITCH per flow: disabling the flow refuses the next send', bsuid_flow_send_check(:'A','00000000-0000-4000-8000-0000000000a1',:'c1','text') = 'flow_not_authorized');
update bsuid_flow_authorizations set enabled = true where flow_id = :'F1';
-- call stack: run inside F2 called by F1
update flow_runs set current_flow_id = :'F2' where id = '00000000-0000-4000-8000-0000000000a1';
insert into flow_run_subflow_frames(account_id,flow_run_id,depth,caller_flow_id,call_node_key,return_node_key,callee_flow_id,caller_graph_hash,callee_graph_hash,on_customer_reply)
  values (:'A','00000000-0000-4000-8000-0000000000a1',1,:'F1','call','back',:'F2','h1','h2','stop');
select pg_temp.check('a run inside a CALLED flow that is not authorized is refused (every flow of the stack must be)', bsuid_flow_send_check(:'A','00000000-0000-4000-8000-0000000000a1',:'c1','text') = 'flow_not_authorized');
insert into bsuid_flow_authorizations(account_id,flow_id,enabled) values (:'A',:'F2',true);
select pg_temp.check('once the called flow is authorized too, the run may send', bsuid_flow_send_check(:'A','00000000-0000-4000-8000-0000000000a1',:'c1','text') = 'ok');
update bsuid_flow_authorizations set allow_media = false where flow_id = :'F2';
select pg_temp.check('modality is checked on EVERY flow of the stack (media allowed on F1 only -> refused)', bsuid_flow_send_check(:'A','00000000-0000-4000-8000-0000000000a1',:'c1','media') = 'modality_not_allowed');
update flow_runs set status = 'completed', ended_at = now() where id = '00000000-0000-4000-8000-0000000000a1';
select pg_temp.check('a completed run cannot send', bsuid_flow_send_check(:'A','00000000-0000-4000-8000-0000000000a1',:'c1','text') = 'run_invalid');

-- 5 canary precedence and cascades
update flow_runs set status = 'active', ended_at = null, current_flow_id = null where id = '00000000-0000-4000-8000-0000000000a1';
delete from flow_run_subflow_frames where flow_run_id = '00000000-0000-4000-8000-0000000000a1';
insert into bsuid_flow_authorizations(account_id,flow_id,contact_id,enabled,allow_text,allow_media) values (:'A',:'F1',:'c1',true,true,true) on conflict do nothing;
select pg_temp.check('a contact-specific authorization is used before the whole-account one for the same flow', bsuid_flow_send_check(:'A','00000000-0000-4000-8000-0000000000a1',:'c1','media') = 'ok');
delete from contacts where id = :'c1';
select pg_temp.check('deleting a contact deletes its canary authorizations', (select count(*) from bsuid_flow_authorizations where contact_id = :'c1') = 0);
delete from flows where id = :'F2';
select pg_temp.check('deleting a flow deletes its authorizations', (select count(*) from bsuid_flow_authorizations where flow_id = :'F2') = 0);

-- 6 service_role can use everything the server needs
set role service_role;
select pg_temp.check('service_role reads the tables and runs both functions', (select count(*) from bsuid_flow_settings) >= 1 and bsuid_flow_scope(:'A',:'c2') is not null and bsuid_flow_send_check(:'A',gen_random_uuid(),:'c2','text') = 'run_invalid');
reset role;
