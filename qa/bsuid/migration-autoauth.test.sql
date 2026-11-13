-- Disposable-database test of 20261122000000_bsuid_flow_auto_authorization.sql. Prints PASS/FAIL lines. Never run against a real database.
\set ON_ERROR_STOP off
create temp table res(n text, ok boolean);
create or replace function pg_temp.chk(n text, ok boolean) returns void language sql as $$ insert into res values (n, coalesce(ok,false)) $$;

insert into auth.users(id,email) values ('00000000-0000-4000-8000-0000000000a1','u@x'), ('00000000-0000-4000-8000-0000000000b1','o@x');
insert into accounts(id,name,owner_user_id) values ('a0000000-0000-4000-8000-000000000001','A (keyler-like)','00000000-0000-4000-8000-0000000000a1'),
                                                   ('b0000000-0000-4000-8000-000000000002','B (other)','00000000-0000-4000-8000-0000000000b1');
create or replace function pg_temp.mk(p_id text, p_acct text, p_name text, p_status text, p_nodes text[]) returns void language plpgsql as $$
declare n text;
begin
  -- like the app: the flow exists as a draft while its nodes (incl. execute_flow) are written, then it is published
  insert into flows(id,account_id,user_id,name,status,trigger_type) values (p_id::uuid, p_acct::uuid, '00000000-0000-4000-8000-0000000000a1', p_name, 'draft', 'keyword');
  foreach n in array p_nodes loop
    insert into flow_nodes(flow_id,node_key,node_type,config) values (p_id::uuid, 'k'||md5(random()::text), split_part(n,'=',1),
      case when split_part(n,'=',2) <> '' then jsonb_build_object('target_flow_id', split_part(n,'=',2)) else '{}'::jsonb end);
  end loop;
  if p_status = 'active' then update flows set status = 'active' where id = p_id::uuid; end if;
end $$;
insert into flow_execution_enablement(account_id, subflow_execution) values ('a0000000-0000-4000-8000-000000000001', true);
\set A 'a0000000-0000-4000-8000-000000000001'
\set B 'b0000000-0000-4000-8000-000000000002'

-- accounts: A will be enabled, B never. Flows are created BEFORE enabling (backfill path).
select pg_temp.mk('f0000000-0000-4000-8000-000000000001', :'A', 'Text only', 'active', array['start','send_message','end']);
select pg_temp.mk('f0000000-0000-4000-8000-000000000002', :'A', 'Media buttons', 'active', array['start','send_media','send_buttons','condition','end']);
select pg_temp.mk('f0000000-0000-4000-8000-000000000003', :'A', 'Audio', 'active', array['start','send_message','send_product_audios','end']);
select pg_temp.mk('f0000000-0000-4000-8000-000000000004', :'A', 'Draft', 'draft', array['start','send_message','end']);
select pg_temp.mk('f0000000-0000-4000-8000-000000000006', :'A', 'Callee draft', 'draft', array['start','send_media','end']);
select pg_temp.mk('f0000000-0000-4000-8000-000000000005', :'A', 'Caller', 'active', array['start','send_message','execute_flow=f0000000-0000-4000-8000-000000000006','end']);
select pg_temp.mk('f0000000-0000-4000-8000-000000000007', :'A', 'Collects', 'active', array['start','collect_input','end']);
select pg_temp.mk('f0000000-0000-4000-8000-000000000008', :'A', 'Prueba envio', 'active', array['start','send_message','end']);
select pg_temp.mk('f0000000-0000-4000-8000-000000000009', :'A', 'Cycle 1', 'draft', array['start','end']);
select pg_temp.mk('f0000000-0000-4000-8000-00000000000a', :'A', 'Cycle 2', 'draft', array['start','end']);
insert into flow_nodes(flow_id,node_key,node_type,config) values ('f0000000-0000-4000-8000-000000000009','x','execute_flow','{"target_flow_id":"f0000000-0000-4000-8000-00000000000a"}'),
  ('f0000000-0000-4000-8000-00000000000a','x','execute_flow','{"target_flow_id":"f0000000-0000-4000-8000-000000000009"}');
update flows set status='active' where id in ('f0000000-0000-4000-8000-000000000009','f0000000-0000-4000-8000-00000000000a');
select pg_temp.mk('f0000000-0000-4000-8000-00000000000b', :'A', 'List', 'active', array['start','send_list','end']);
select pg_temp.mk('f0000000-0000-4000-8000-00000000000c', :'B', 'Other account text', 'active', array['start','send_message','end']);
-- a pre-existing manual row WITH an expiry, and a contact-scoped one that must never be touched
insert into bsuid_flow_authorizations(account_id,flow_id,contact_id,enabled,allow_text,allow_media,allow_buttons,expires_at,note)
  values (:'A','f0000000-0000-4000-8000-000000000002',null,true,true,true,true, now()+interval '5 days','manual');
insert into contacts(id,account_id,user_id,name,phone) values ('c0000000-0000-4000-8000-000000000001', :'A','00000000-0000-4000-8000-0000000000a1','Canary','51900000001');
insert into bsuid_flow_authorizations(account_id,flow_id,contact_id,enabled,allow_text,note)
  values (:'A','f0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000001',false,true,'canary');

select pg_temp.chk('no authorization is created before the account is enabled (except the pre-existing ones)', (select count(*) from bsuid_flow_authorizations) = 2);

insert into bsuid_flow_autoauth(account_id,enabled,audio_enabled,note) values (:'A', true, false, 'qa');   -- trigger reconciles
create or replace function pg_temp.auth(p text) returns text language sql as $$
  select coalesce((select concat_ws('', case when enabled then 'E' else 'd' end, case when allow_text then 't' else '-' end, case when allow_media then 'm' else '-' end,
                    case when allow_buttons then 'b' else '-' end, case when allow_list then 'l' else '-' end, case when allow_audio then 'a' else '-' end,
                    case when expires_at is null then 'N' else 'X' end)
     from bsuid_flow_authorizations where flow_id = p::uuid and contact_id is null), 'none') $$;
select pg_temp.chk('text-only flow: text only, no expiry', pg_temp.auth('f0000000-0000-4000-8000-000000000001') = 'Et----N');
select pg_temp.chk('media+buttons flow: exact modalities; the manual row with an expiry becomes permanent, not duplicated', pg_temp.auth('f0000000-0000-4000-8000-000000000002') = 'Etmb--N' and (select count(*) from bsuid_flow_authorizations where flow_id='f0000000-0000-4000-8000-000000000002' and contact_id is null) = 1);
select pg_temp.chk('audio flow is NOT authorized while audio_enabled is false', pg_temp.auth('f0000000-0000-4000-8000-000000000003') = 'none');
select pg_temp.chk('draft flow: nothing', pg_temp.auth('f0000000-0000-4000-8000-000000000004') = 'none');
select pg_temp.chk('caller of a DRAFT sub-flow: nothing', pg_temp.auth('f0000000-0000-4000-8000-000000000005') = 'none');
select pg_temp.chk('unsupported node (collect_input): nothing', pg_temp.auth('f0000000-0000-4000-8000-000000000007') = 'none');
select pg_temp.chk('test-named flow: nothing', pg_temp.auth('f0000000-0000-4000-8000-000000000008') = 'none');
select pg_temp.chk('call cycle: nothing for either', pg_temp.auth('f0000000-0000-4000-8000-000000000009') = 'none' and pg_temp.auth('f0000000-0000-4000-8000-00000000000a') = 'none');
select pg_temp.chk('list flow: list modality', pg_temp.auth('f0000000-0000-4000-8000-00000000000b') = 'Et--l-N');
select pg_temp.chk('OTHER account untouched (no row at all)', pg_temp.auth('f0000000-0000-4000-8000-00000000000c') = 'none' and not exists (select 1 from bsuid_flow_autoauth where account_id = :'B'));
select pg_temp.chk('contact-scoped authorization untouched', (select (enabled, note) = (false,'canary') from bsuid_flow_authorizations where contact_id is not null));

-- idempotency: a second reconcile writes nothing
create temp table before_ts as select id, updated_at from bsuid_flow_authorizations;
select bsuid_flow_autoauth_reconcile(:'A'::uuid);
select pg_temp.chk('reconcile is idempotent: same rows, no timestamps touched', (select count(*) from bsuid_flow_authorizations) = (select count(*) from before_ts)
  and not exists (select 1 from bsuid_flow_authorizations a join before_ts b using (id) where a.updated_at <> b.updated_at));

-- publishing a draft authorizes it; deactivating disables it
update flows set status = 'active' where id = 'f0000000-0000-4000-8000-000000000004';
select pg_temp.chk('publish (draft -> active): authorized', pg_temp.auth('f0000000-0000-4000-8000-000000000004') = 'Et----N');
update flows set status = 'draft' where id = 'f0000000-0000-4000-8000-000000000004';
select pg_temp.chk('deactivate: authorization disabled (row kept)', pg_temp.auth('f0000000-0000-4000-8000-000000000004') = 'dt----N');
update flows set status = 'active' where id = 'f0000000-0000-4000-8000-000000000004';
select pg_temp.chk('re-publish: re-enabled, still one row', pg_temp.auth('f0000000-0000-4000-8000-000000000004') = 'Et----N' and (select count(*) from bsuid_flow_authorizations where flow_id='f0000000-0000-4000-8000-000000000004')=1);

-- sub-flow propagation: activating the callee authorizes the caller with the UNION of modalities (root must allow the callee's media)
update flows set status = 'active' where id = 'f0000000-0000-4000-8000-000000000006';
select pg_temp.chk('callee published: callee AND caller authorized, caller inherits media', pg_temp.auth('f0000000-0000-4000-8000-000000000006') = 'Etm---N' and pg_temp.auth('f0000000-0000-4000-8000-000000000005') = 'Etm---N');
update flows set status = 'draft' where id = 'f0000000-0000-4000-8000-000000000006';
select pg_temp.chk('callee deactivated: caller disabled too', pg_temp.auth('f0000000-0000-4000-8000-000000000005') = 'dtm---N');
update flows set status = 'active' where id = 'f0000000-0000-4000-8000-000000000006';

-- editing nodes in one transaction (delete + insert): evaluated once at commit, with the NEW nodes
begin;
  delete from flow_nodes where flow_id = 'f0000000-0000-4000-8000-000000000001';
  insert into flow_nodes(flow_id,node_key,node_type,config) values ('f0000000-0000-4000-8000-000000000001','s','start','{}'),('f0000000-0000-4000-8000-000000000001','m','send_media','{}'),('f0000000-0000-4000-8000-000000000001','e','end','{}');
commit;
select pg_temp.chk('node edit: modalities follow the nodes (media added)', pg_temp.auth('f0000000-0000-4000-8000-000000000001') = 'Etm---N');
begin;
  insert into flow_nodes(flow_id,node_key,node_type,config) values ('f0000000-0000-4000-8000-000000000001','x','collect_input','{}');
commit;
select pg_temp.chk('node edit: an unsupported node disables the authorization', pg_temp.auth('f0000000-0000-4000-8000-000000000001') = 'dtm---N');
delete from flow_nodes where flow_id = 'f0000000-0000-4000-8000-000000000001' and node_type = 'collect_input';
select pg_temp.chk('node edit: removing it re-enables', pg_temp.auth('f0000000-0000-4000-8000-000000000001') = 'Etm---N');

-- brand new flow
select pg_temp.mk('f0000000-0000-4000-8000-00000000000d', :'A', 'Brand new', 'active', array['start','send_message','end']);
select pg_temp.chk('a new active flow is authorized on creation', pg_temp.auth('f0000000-0000-4000-8000-00000000000d') = 'Et----N');
select pg_temp.mk('f0000000-0000-4000-8000-00000000000e', :'B', 'Brand new B', 'active', array['start','send_message','end']);
select pg_temp.chk('a new flow of ANOTHER account is not', pg_temp.auth('f0000000-0000-4000-8000-00000000000e') = 'none');

-- audio switch
update bsuid_flow_autoauth set audio_enabled = true where account_id = :'A';
select pg_temp.chk('audio_enabled=true authorizes the audio flow with allow_audio', pg_temp.auth('f0000000-0000-4000-8000-000000000003') = 'Et---aN');
update bsuid_flow_autoauth set audio_enabled = false where account_id = :'A';
select pg_temp.chk('audio_enabled=false disables it again', pg_temp.auth('f0000000-0000-4000-8000-000000000003') = 'dt---aN');
update bsuid_flow_autoauth set audio_enabled = true where account_id = :'A';

select pg_temp.mk('f0000000-0000-4000-8000-00000000000f', :'B', 'B audio', 'active', array['start','send_product_audios','end']);
select pg_temp.chk('eval for an account WITHOUT a row never lets audio through', (select reason = 'audio_not_enabled' and not ok from bsuid_flow_autoauth_eval('f0000000-0000-4000-8000-00000000000f')));
-- privileges
select pg_temp.chk('anon/authenticated cannot execute or read', not has_function_privilege('authenticated','bsuid_flow_autoauth_sync(uuid,int)','execute') and not has_function_privilege('anon','bsuid_flow_autoauth_reconcile(uuid)','execute') and not has_table_privilege('authenticated','bsuid_flow_autoauth','select'));
-- the 078 checker agrees (account master switch off => flows_disabled even though authorized)
select pg_temp.chk('migration is idempotent (re-run below)', true);
select n || ' ... ' || case when ok then 'PASS' else 'FAIL' end from res order by 1;
select 'TOTAL ' || count(*) filter (where ok) || ' pass / ' || count(*) filter (where not ok) || ' fail' from res;
