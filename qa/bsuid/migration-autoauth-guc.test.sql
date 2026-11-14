-- Disposable-database test of 20261124000000_fix_bsuid_autoauth_node_trigger_key.sql. Prints PASS/FAIL lines. Never run against a real database.
-- Uses EXPLICIT transactions so the deferred node trigger runs at COMMIT exactly like the app's replace_flow_draft_atomic call.
-- Run twice against the same schema: BEFORE the migration the "digit" checks must FAIL (reproduces the bug), AFTER they must PASS.
\set ON_ERROR_STOP off
\pset tuples_only on
insert into auth.users(id,email) values ('00000000-0000-4000-8000-0000000000a1','u@x') on conflict do nothing;
insert into accounts(id,name,owner_user_id) values ('a0000000-0000-4000-8000-000000000001','A','00000000-0000-4000-8000-0000000000a1') on conflict do nothing;
insert into bsuid_flow_autoauth(account_id, enabled, audio_enabled) values ('a0000000-0000-4000-8000-000000000001', true, false) on conflict (account_id) do update set enabled = true;
create temp table res(n text, ok boolean);
create or replace function pg_temp.chk(n text, ok boolean) returns void language sql as $$ insert into res values (n, coalesce(ok,false)) $$;
create or replace function pg_temp.mkflow(p_id uuid, p_name text) returns void language sql as $$
  insert into flows(id,account_id,user_id,name,status,trigger_type) values (p_id, 'a0000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1', p_name, 'draft', 'keyword') $$;
\set NODES1 '[{"node_key":"start","node_type":"start","config":{}},{"node_key":"m","node_type":"send_message","config":{}},{"node_key":"i","node_type":"send_media","config":{}},{"node_key":"end","node_type":"end","config":{}}]'
\set NODES2 '[{"node_key":"start","node_type":"start","config":{}},{"node_key":"m","node_type":"send_message","config":{}},{"node_key":"end","node_type":"end","config":{}}]'

select pg_temp.mkflow('0ccac5ae-8f7b-4ebb-9f60-e77f296533c9','digit-0 (the real reported id shape)');
select pg_temp.mkflow('9a000000-8f7b-4ebb-9f60-e77f296533c9','digit-9');
select pg_temp.mkflow('a0ccac5a-8f7b-4ebb-9f60-e77f296533c9','letter-a');
select pg_temp.mkflow('f0000000-8f7b-4ebb-9f60-e77f296533c9','letter-f');

-- 1. Editor save (header + replace-all nodes) in ONE transaction, committed (deferred trigger runs at COMMIT)
begin; select replace_flow_draft_atomic('a0000000-0000-4000-8000-000000000001','0ccac5ae-8f7b-4ebb-9f60-e77f296533c9','{"name":"saved"}',:'NODES1'::jsonb); commit;
select pg_temp.chk('digit-start flow: first save commits and stores 4 nodes', (select count(*)=4 from flow_nodes where flow_id='0ccac5ae-8f7b-4ebb-9f60-e77f296533c9'));
begin; select replace_flow_draft_atomic('a0000000-0000-4000-8000-000000000001','0ccac5ae-8f7b-4ebb-9f60-e77f296533c9','{}',:'NODES2'::jsonb); commit;
select pg_temp.chk('digit-start flow: second save (replace all) commits and stores 3 nodes', (select count(*)=3 from flow_nodes where flow_id='0ccac5ae-8f7b-4ebb-9f60-e77f296533c9'));
begin; select replace_flow_draft_atomic('a0000000-0000-4000-8000-000000000001','9a000000-8f7b-4ebb-9f60-e77f296533c9','{}',:'NODES1'::jsonb); commit;
select pg_temp.chk('digit-9 flow: save commits', (select count(*)=4 from flow_nodes where flow_id='9a000000-8f7b-4ebb-9f60-e77f296533c9'));
begin; select replace_flow_draft_atomic('a0000000-0000-4000-8000-000000000001','a0ccac5a-8f7b-4ebb-9f60-e77f296533c9','{}',:'NODES1'::jsonb); commit;
select pg_temp.chk('letter-start flow: save still commits (no regression)', (select count(*)=4 from flow_nodes where flow_id='a0ccac5a-8f7b-4ebb-9f60-e77f296533c9'));

-- 2. Publish a digit-start flow: the per-flow sync must create exactly ONE authorization covering media (the autoauth behaviour is unchanged)
update flows set status='active' where id='0ccac5ae-8f7b-4ebb-9f60-e77f296533c9';
-- (its current nodes are start/send_message/end after the second save: text only)
select pg_temp.chk('digit-start flow publishes and is auto-authorized once, no expiry, text only',
  (select count(*)=1 and bool_and(enabled and expires_at is null and allow_text and not allow_media and not allow_buttons and not allow_audio) from bsuid_flow_authorizations where flow_id='0ccac5ae-8f7b-4ebb-9f60-e77f296533c9'));

-- 3. Editing nodes of the now-ACTIVE digit-start flow re-evaluates once and keeps one authorization
begin; delete from flow_nodes where flow_id='0ccac5ae-8f7b-4ebb-9f60-e77f296533c9' and node_key='i'; insert into flow_nodes(flow_id,node_key,node_type,config) values ('0ccac5ae-8f7b-4ebb-9f60-e77f296533c9','b','send_buttons','{}'); commit;
select pg_temp.chk('active digit-start flow: node edit commits; still exactly one authorization (no duplicate)',
  (select count(*)=1 from bsuid_flow_authorizations where flow_id='0ccac5ae-8f7b-4ebb-9f60-e77f296533c9') and (select allow_buttons from bsuid_flow_authorizations where flow_id='0ccac5ae-8f7b-4ebb-9f60-e77f296533c9' limit 1));

-- 4. Delete the flow (cascade deletes its nodes: the trigger fires on DELETE too)
begin; delete from flows where id='9a000000-8f7b-4ebb-9f60-e77f296533c9'; commit;
select pg_temp.chk('digit-start flow can be deleted (cascade of nodes)', not exists (select 1 from flows where id='9a000000-8f7b-4ebb-9f60-e77f296533c9') and not exists (select 1 from flow_nodes where flow_id='9a000000-8f7b-4ebb-9f60-e77f296533c9'));

-- 5. All sixteen first characters
do $$ declare ch text; fid uuid; bad text := ''; begin
  foreach ch in array array['0','1','2','3','4','5','6','7','8','9','a','b','c','d','e','f'] loop
    fid := (ch || substr(gen_random_uuid()::text, 2))::uuid;
    insert into flows(id,account_id,user_id,name,status,trigger_type) values (fid,'a0000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','hex-'||ch,'draft','keyword');
    set constraints bsuid_flow_autoauth_node immediate;
    begin perform replace_flow_draft_atomic('a0000000-0000-4000-8000-000000000001', fid, '{}'::jsonb, '[{"node_key":"start","node_type":"start","config":{}},{"node_key":"end","node_type":"end","config":{}}]'::jsonb);
    exception when others then bad := bad || ch || ':' || sqlstate || ' '; end;
  end loop;
  insert into res values ('all 16 possible first characters save without error', bad = ''); if bad <> '' then raise notice 'failed: %', bad; end if;
end $$;

-- 6. The failure leaves the previous version intact (atomic): force a bad node and check nothing changed
begin; select replace_flow_draft_atomic('a0000000-0000-4000-8000-000000000001','a0ccac5a-8f7b-4ebb-9f60-e77f296533c9','{}','[{"node_key":"start","node_type":"not_a_type","config":{}}]'::jsonb); commit;
select pg_temp.chk('invalid node aborts the save and the previous nodes stay', (select count(*)=4 from flow_nodes where flow_id='a0ccac5a-8f7b-4ebb-9f60-e77f296533c9'));

-- 7. other accounts untouched: authorizations only exist for the test account's flows
select pg_temp.chk('no authorization row was created for any other account', not exists (select 1 from bsuid_flow_authorizations a where a.account_id <> 'a0000000-0000-4000-8000-000000000001' and a.created_at > now() - interval '5 minutes'));

select case when ok then 'PASS' else 'FAIL' end || '  ' || n from res order by ok, n;
select 'TOTAL ' || count(*) filter (where ok) || ' pass / ' || count(*) filter (where not ok) || ' fail' from res;
