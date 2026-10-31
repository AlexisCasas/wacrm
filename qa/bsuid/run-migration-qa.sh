#!/usr/bin/env bash
# Applies migration 077 to a DISPOSABLE copy of the schema and runs migration-077.test.sql.
# Usage: SCHEMA_DUMP=/path/to/pg_dump-custom-format.dump qa/bsuid/run-migration-qa.sh
# Never touches a real database: the container has no network and is removed at the end.
set -uo pipefail
: "${SCHEMA_DUMP:?set SCHEMA_DUMP to a pg_dump -Fc file of the schema at migration 076}"
HERE=$(cd "$(dirname "$0")" && pwd); MIG="$HERE/../../supabase/migrations/077_contact_identities_bsuid.sql"; MIG78="$HERE/../../supabase/migrations/078_bsuid_flow_authorizations.sql"; MIG79="$HERE/../../supabase/migrations/079_bsuid_flow_volume_caps.sql"; MIG80="$HERE/../../supabase/migrations/080_bsuid_agent_replies_policy.sql"
C=wa-bsuid-qa-pg; W=$(mktemp -d); cp "$SCHEMA_DUMP" "$W/full.dump"; cp "$HERE/flow_pilot.sh" "$HERE/bsuid_watch.sh" "$W/"; cp "$MIG79" "$HERE/migration-079.test.sql" "$MIG80" "$HERE/migration-080.test.sql" "$W/"; cp "$MIG" "$MIG78" "$HERE/migration-077.test.sql" "$HERE/migration-078.test.sql" "$HERE/pilot_list.sql" "$W/"
trap 'docker rm -f $C >/dev/null 2>&1; shred -u "$W/full.dump" 2>/dev/null; rm -rf "$W"' EXIT
docker rm -f $C >/dev/null 2>&1
docker run -d --name $C --network none -e POSTGRES_PASSWORD=x -v "$W":/w:ro postgres:17-alpine >/dev/null
for i in $(seq 1 40); do docker exec $C pg_isready -U postgres -q && break; sleep 1; done; sleep 2
docker exec $C psql -U postgres -qc "create database v"
docker exec -i $C psql -U postgres -d v -q <<'SQL'
create schema auth; create table auth.users(id uuid primary key, email text);
create schema extensions; create extension if not exists pgcrypto schema extensions;
create function extensions.uuid_generate_v4() returns uuid language sql as 'select gen_random_uuid()';
-- roles that exist on Supabase; the migration grants to / revokes from them
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
SQL
# schema for everything in public, DATA only for the tables the migration touches (keeps real contacts for the "untouched" check)
docker exec $C pg_restore -U postgres -d v --no-owner --no-privileges -n public /w/full.dump 2>&1 | grep -c "^pg_restore: error" | sed 's/^/schema restore errors (tolerated if unrelated): /'
echo "== contacts before: $(docker exec $C psql -U postgres -d v -At -c 'select count(*) from contacts')"
echo "== apply 077 (1st)"; docker exec -i $C psql -U postgres -d v -X -v ON_ERROR_STOP=1 -q < "$W/077_contact_identities_bsuid.sql" && echo applied
echo "== apply 077 (2nd, idempotency)"; docker exec -i $C psql -U postgres -d v -X -v ON_ERROR_STOP=1 -q < "$W/077_contact_identities_bsuid.sql" && echo applied-again
echo "== checks"; docker exec -i $C psql -U postgres -d v -X -q -f /w/migration-077.test.sql 2>&1 | grep -E "PASS|FAIL|ERROR" 
echo "== concurrency: 2 sessions x 25 calls, same BSUID"
for s in 1 2; do (for i in $(seq 1 25); do docker exec $C psql -U postgres -d v -Atq -c "select 1 from resolve_bsuid_contact('a1a1a1a1-0000-4000-8000-00000000000a','aaaaaaaa-0000-4000-8000-000000000001','PE.RACE000000001',null,null,'Race')" >/dev/null; done) & done; wait
echo "contacts for the raced BSUID: $(docker exec $C psql -U postgres -d v -At -c "select count(*) from contact_identities where value='PE.RACE000000001'")  (expected 1)"
echo "contacts named Race: $(docker exec $C psql -U postgres -d v -At -c "select count(*) from contacts where name='Race'")  (expected 1)"
echo "== concurrency: 2 sessions x 15 consume calls with ONE authorization"
docker exec $C psql -U postgres -d v -Atq -c "select authorize_bsuid_send('a1a1a1a1-0000-4000-8000-00000000000a', (select contact_id from contact_identities where value='PE.RACE000000001'), 1, 'race')" >/dev/null
for s in 1 2; do (for i in $(seq 1 15); do docker exec $C psql -U postgres -d v -Atq -c "select consume_bsuid_send('a1a1a1a1-0000-4000-8000-00000000000a', (select contact_id from contact_identities where value='PE.RACE000000001'), 'manual_reply')" >> "$W/consume.$s" 2>/dev/null; done) & done; wait
echo "consumed (expected 1): $(docker exec $C psql -U postgres -d v -At -c "select count(*) from contact_identity_audit where event='send_consumed' and contact_id=(select contact_id from contact_identities where value='PE.RACE000000001')")"
echo "== pilot_list.sql (the operator's read-only query) runs and masks:"
docker exec $C psql -U postgres -d v -X -P pager=off -v account=a1a1a1a1-0000-4000-8000-00000000000a -v hours=24 -f /w/pilot_list.sql 2>&1 | head -8
echo "== operator guard (same query as 06_pilot.sh grant): 1 for a phone-less contact of the account, 0 for a phone contact and for another account"
VQ="select count(*) from contacts c join contact_identities i on i.contact_id=c.id and i.account_id=c.account_id and i.kind='bsuid' and i.superseded_at is null where c.id='%s' and c.account_id='%s' and c.phone_optional"
RC=$(docker exec $C psql -U postgres -d v -At -c "select contact_id from contact_identities where value='PE.RACE000000001'")
PC=$(docker exec $C psql -U postgres -d v -At -c "select id from contacts where name='Phone Only'")
printf "  phone-less, own account: %s (expected 1)\n" "$(docker exec $C psql -U postgres -d v -At -c "$(printf "$VQ" "$RC" a1a1a1a1-0000-4000-8000-00000000000a)")"
printf "  phone contact: %s (expected 0)\n" "$(docker exec $C psql -U postgres -d v -At -c "$(printf "$VQ" "$PC" a1a1a1a1-0000-4000-8000-00000000000a)")"
printf "  phone-less, OTHER account id: %s (expected 0)\n" "$(docker exec $C psql -U postgres -d v -At -c "$(printf "$VQ" "$RC" b2b2b2b2-0000-4000-8000-00000000000b)")"

echo "== apply 078 (1st) and (2nd, idempotency), then its checks"
docker exec -i $C psql -U postgres -d v -X -v ON_ERROR_STOP=1 -q < "$W/078_bsuid_flow_authorizations.sql" && echo "078 applied"
docker exec -i $C psql -U postgres -d v -X -v ON_ERROR_STOP=1 -q < "$W/078_bsuid_flow_authorizations.sql" && echo "078 applied again"
docker exec -i $C psql -U postgres -d v -X -q -f /w/migration-078.test.sql 2>&1 | grep -E "PASS|FAIL|ERROR"
echo "== apply 079 (1st) and (2nd, idempotency), then its checks"
docker exec -i $C psql -U postgres -d v -X -v ON_ERROR_STOP=1 -q < "$W/079_bsuid_flow_volume_caps.sql" && echo "079 applied"
docker exec -i $C psql -U postgres -d v -X -v ON_ERROR_STOP=1 -q < "$W/079_bsuid_flow_volume_caps.sql" && echo "079 applied again"
docker exec -i $C psql -U postgres -d v -X -q -f /w/migration-079.test.sql 2>&1 | grep -E "PASS|FAIL|ERROR"
echo "== apply 080 (1st) and (2nd, idempotency), then its checks"
docker exec -i $C psql -U postgres -d v -X -v ON_ERROR_STOP=1 -q < "$W/080_bsuid_agent_replies_policy.sql" && echo "080 applied"
docker exec -i $C psql -U postgres -d v -X -v ON_ERROR_STOP=1 -q < "$W/080_bsuid_agent_replies_policy.sql" && echo "080 applied again"
docker exec -i $C psql -U postgres -d v -X -q -f /w/migration-080.test.sql 2>&1 | grep -E "PASS|FAIL|ERROR"

echo "== operator script flow_pilot.sh against the disposable database"
FP() { FLOW_PILOT_CONTAINER=$C FLOW_PILOT_DB=v FLOW_PILOT_LOG=$W/fp.log bash "$W/flow_pilot.sh" "$@"; }
QA_A=a1a1a1a1-0000-4000-8000-00000000000a; QA_F1=f1f1f1f1-0000-4000-8000-000000000001
docker exec $C psql -U postgres -d v -Atq -c "delete from bsuid_flow_authorizations; delete from bsuid_flow_settings; delete from bsuid_pilot_scopes"
FP status >/dev/null 2>&1 && echo "PASS status runs" || echo "FAIL status"
echo "not typed" | FP authorize $QA_A $QA_F1 >/dev/null 2>&1; echo "authorizations after an UNCONFIRMED authorize (expected 0): $(docker exec $C psql -U postgres -d v -At -c 'select count(*) from bsuid_flow_authorizations')"
printf 'AUTHORIZE %s\n' "${QA_F1:0:8}" | FP authorize $QA_A $QA_F1 --hours 2 >/dev/null 2>&1; echo "authorizations after a CONFIRMED authorize (expected 1, enabled, text only, expiring): $(docker exec $C psql -U postgres -d v -At -c "select count(*)||' '||bool_and(enabled)||' '||bool_and(allow_text and not allow_media and not allow_audio)||' '||bool_and(expires_at is not null) from bsuid_flow_authorizations")"
FP flows $QA_A on >/dev/null 2>&1; echo "master switch (expected t): $(docker exec $C psql -U postgres -d v -At -c "select flows_enabled from bsuid_flow_settings where account_id='$QA_A'")"
echo "flow of ANOTHER account is refused (expected 1 line 'not an ACTIVE flow'): $(echo x | FP authorize b2b2b2b2-0000-4000-8000-00000000000b $QA_F1 2>&1 | grep -c 'not an ACTIVE flow')"
FP kill $QA_A >/dev/null 2>&1; echo "after kill (expected f and 0 enabled): $(docker exec $C psql -U postgres -d v -At -c "select (select flows_enabled from bsuid_flow_settings where account_id='$QA_A')||' '||(select count(*) from bsuid_flow_authorizations where enabled)")"
echo "scope with a triple that is not in whatsapp_config is refused (expected 1): $(FP scope $QA_A 1111111111 2222222222 off 2>&1 | grep -c 'not in whatsapp_config')"

echo "== endruns: closes the active (deferred) runs of ONE contact and nothing else"
docker exec $C psql -U postgres -d v -Atq -c "delete from flow_runs where account_id='$QA_A'; insert into flows(id,user_id,name,trigger_type,trigger_config,status,account_id) values ('f3f3f3f3-0000-4000-8000-000000000003','aaaaaaaa-0000-4000-8000-000000000001','QA flow 3','keyword','{}','active','$QA_A') on conflict do nothing"
EC1=$(docker exec $C psql -U postgres -d v -Atq -c "select contact_id from resolve_bsuid_contact('$QA_A','aaaaaaaa-0000-4000-8000-000000000001','PE.E4QA00000000001',null,'e1','E1')")
EC2=$(docker exec $C psql -U postgres -d v -Atq -c "select contact_id from resolve_bsuid_contact('$QA_A','aaaaaaaa-0000-4000-8000-000000000001','PE.E4QA00000000002',null,'e2','E2')")
docker exec $C psql -U postgres -d v -Atq -c "insert into flow_runs(flow_id,user_id,account_id,contact_id,status,wait_until,wait_node_key) values ('f3f3f3f3-0000-4000-8000-000000000003','aaaaaaaa-0000-4000-8000-000000000001','$QA_A','$EC1','active',now()+interval '2 hours','delay_7'),('f3f3f3f3-0000-4000-8000-000000000003','aaaaaaaa-0000-4000-8000-000000000001','$QA_A','$EC2','active',now()+interval '2 hours','delay_7')"
echo "wrong confirmation changes nothing (expected 2 active): $(echo nope | FP endruns $QA_A $EC1 >/dev/null 2>&1; docker exec $C psql -U postgres -d v -At -c "select count(*) from flow_runs where status='active'")"
printf 'END %s\n' "${EC1:0:8}" | FP endruns $QA_A $EC1 >/dev/null 2>&1
echo "after a confirmed endruns for contact 1 (expected: contact1 completed/canary_closed_by_operator/no wait, contact2 still active with its wait): $(docker exec $C psql -U postgres -d v -At -c "select (select status||'/'||end_reason||'/'||(wait_until is null) from flow_runs where contact_id='$EC1')||' ; '||(select status||'/'||(wait_until is not null) from flow_runs where contact_id='$EC2')")"
echo "another account's contact id is refused (expected 'no active run'): $(echo x | FP endruns b2b2b2b2-0000-4000-8000-00000000000b $EC2 2>&1 | grep -c 'no active run')"

echo "== safe-flows / batch: eligibility by node types, only eligible flows are authorized"
docker exec $C psql -U postgres -d v -Atq -c "delete from bsuid_flow_authorizations; delete from flow_nodes where flow_id in ('f4f4f4f4-0000-4000-8000-000000000004','f5f5f5f5-0000-4000-8000-000000000005','f6f6f6f6-0000-4000-8000-000000000006'); delete from flows where id in ('f4f4f4f4-0000-4000-8000-000000000004','f5f5f5f5-0000-4000-8000-000000000005','f6f6f6f6-0000-4000-8000-000000000006');
 insert into flows(id,user_id,name,trigger_type,trigger_config,status,account_id) values ('f4f4f4f4-0000-4000-8000-000000000004','aaaaaaaa-0000-4000-8000-000000000001','QA simple product','keyword','{}','active','$QA_A'),('f5f5f5f5-0000-4000-8000-000000000005','aaaaaaaa-0000-4000-8000-000000000001','QA with tag','keyword','{}','active','$QA_A'),('f6f6f6f6-0000-4000-8000-000000000006','aaaaaaaa-0000-4000-8000-000000000001','QA long wait','keyword','{}','active','$QA_A');
 insert into flow_nodes(flow_id,node_key,node_type,config) values ('f4f4f4f4-0000-4000-8000-000000000004','s','start','{}'),('f4f4f4f4-0000-4000-8000-000000000004','m','send_message','{\"text\":\"hola\"}'),('f4f4f4f4-0000-4000-8000-000000000004','d','delay','{\"seconds\":3}'),('f4f4f4f4-0000-4000-8000-000000000004','i','send_media','{\"media_type\":\"image\"}'),('f4f4f4f4-0000-4000-8000-000000000004','e','end','{}'),
  ('f5f5f5f5-0000-4000-8000-000000000005','m','send_message','{}'),('f5f5f5f5-0000-4000-8000-000000000005','t','set_tag','{}'),
  ('f6f6f6f6-0000-4000-8000-000000000006','m','send_message','{}'),('f6f6f6f6-0000-4000-8000-000000000006','d','delay','{\"seconds\":700}')"
V=$(FP safe-flows $QA_A 2>&1); echo "eligible: $(echo "$V" | grep 'QA simple product' | grep -c eligible) (expected 1) ; set_tag flow excluded: $(echo "$V" | grep 'QA with tag' | grep -c 'node types: set_tag') (expected 1) ; long wait excluded: $(echo "$V" | grep 'QA long wait' | grep -c 'longer than 10') (expected 1)"
echo "wrong confirmation changes nothing (expected 0): $(echo nope | FP batch $QA_A 5 >/dev/null 2>&1; docker exec $C psql -U postgres -d v -At -c 'select count(*) from bsuid_flow_authorizations')"
printf 'BATCH 1\n' | FP batch $QA_A 5 --media >/dev/null 2>&1; echo "after a confirmed batch (expected 1 row, the simple flow only, enabled, media on, whole account): $(docker exec $C psql -U postgres -d v -At -c "select count(*)||' '||bool_and(flow_id='f4f4f4f4-0000-4000-8000-000000000004')||' '||bool_and(enabled and allow_media and contact_id is null) from bsuid_flow_authorizations")"
echo "a second batch finds nothing new (expected 1 line): $(echo x | FP batch $QA_A 5 2>&1 | grep -c 'no eligible flow left')"

echo "== bsuid_watch.sh: alerts and the circuit breaker (disposable database)"
WATCH() { WATCH_CONTAINER=$C WATCH_DB=v WATCH_LOG=$W/watch.log WATCH_LOCK=$W/watch.lock WATCH_KILL_CMD="bash $W/flow_pilot.sh kill" FLOW_PILOT_CONTAINER=$C FLOW_PILOT_DB=v FLOW_PILOT_LOG=$W/fp.log bash "$W/bsuid_watch.sh" "$@"; }
docker exec $C psql -U postgres -d v -Atq -c "delete from flow_runs where account_id='$QA_A'; delete from messages where conversation_id in (select id from conversations where account_id='$QA_A'); delete from contact_identity_audit where account_id='$QA_A'; delete from bsuid_flow_authorizations; insert into bsuid_flow_settings(account_id,flows_enabled) values ('$QA_A',true) on conflict (account_id) do update set flows_enabled=true, max_account_sends_per_hour=1200; insert into bsuid_flow_authorizations(account_id,flow_id,enabled) values ('$QA_A','f4f4f4f4-0000-4000-8000-000000000004',true)"
WC=$(docker exec $C psql -U postgres -d v -Atq -c "select contact_id from resolve_bsuid_contact('$QA_A','aaaaaaaa-0000-4000-8000-000000000001','PE.W4QA00000000001',null,'w1','W1')")
docker exec $C psql -U postgres -d v -Atq -c "insert into conversations(account_id,user_id,contact_id) values ('$QA_A','aaaaaaaa-0000-4000-8000-000000000001','$WC') on conflict do nothing"
WATCH; echo "quiet: exit $? and log says OK: $(tail -1 $W/watch.log | grep -c ' OK ')"
FR(){ docker exec $C psql -U postgres -d v -Atq -c "insert into flow_runs(flow_id,user_id,account_id,contact_id,status,end_reason,ended_at) select 'f4f4f4f4-0000-4000-8000-000000000004','aaaaaaaa-0000-4000-8000-000000000001','$QA_A',contact_id,'failed','send_media_failed',now() from (select '$WC'::uuid contact_id from generate_series(1,$1)) g"; }
FR 2; WATCH; echo "2 failed runs: ALERT-free (expected exit 0): $?  master still on: $(docker exec $C psql -U postgres -d v -At -c "select flows_enabled from bsuid_flow_settings where account_id='$QA_A'")"
FR 1; WATCH --no-kill; R=$?; echo "3 failed runs with --no-kill: exit $R (expected 1), would-trip logged: $(tail -1 $W/watch.log | grep -c BREAKER_WOULD_TRIP), master still on: $(docker exec $C psql -U postgres -d v -At -c "select flows_enabled from bsuid_flow_settings where account_id='$QA_A'")"
WATCH; R=$?; echo "3 failed runs, breaker armed: exit $R (expected 1); log: $(tail -1 $W/watch.log | grep -c BREAKER_TRIPPED) tripped; master now: $(docker exec $C psql -U postgres -d v -At -c "select flows_enabled from bsuid_flow_settings where account_id='$QA_A'") (expected f); enabled authorizations: $(docker exec $C psql -U postgres -d v -At -c "select count(*) from bsuid_flow_authorizations where enabled") (expected 0); contact still there: $(docker exec $C psql -U postgres -d v -At -c "select count(*) from contacts where id='$WC'")"
WATCH; echo "after the breaker (switch off) the watch has nothing to watch: $(tail -1 $W/watch.log | grep -c 'has the BSUID Flow switch on')"
docker exec $C psql -U postgres -d v -Atq -c "delete from flow_runs where account_id='$QA_A'; update bsuid_flow_settings set flows_enabled=true where account_id='$QA_A'; insert into messages(conversation_id,sender_type,content_text,media_url,created_at) select id,'bot','img','https://cdn.test/a.jpg',now() from conversations where contact_id='$WC' union all select id,'bot','img','https://cdn.test/a.jpg',now() from conversations where contact_id='$WC'"
WATCH; R=$?; echo "duplicate media within 10 min: exit $R (expected 1), A2 raised: $(tail -1 $W/watch.log | grep -c 'A2(duplicate_media=1)'), breaker: $(tail -1 $W/watch.log | grep -c BREAKER_TRIPPED)"

echo "== bsuid_watch.sh: account isolation (WATCH_ACCOUNTS) — a failing account that is not watched is never touched"
QA_B=b2b2b2b2-0000-4000-8000-00000000000b; QA_FB=fbfbfbfb-0000-4000-8000-0000000000bb
docker exec $C psql -U postgres -d v -Atq -c "delete from flow_runs; delete from messages; delete from bsuid_flow_authorizations; delete from bsuid_flow_settings; insert into bsuid_flow_settings(account_id,flows_enabled) values ('$QA_A',true),('$QA_B',true); insert into bsuid_flow_authorizations(account_id,flow_id,enabled) values ('$QA_B','$QA_FB',true), ('$QA_A','f4f4f4f4-0000-4000-8000-000000000004',true)"
BC=$(docker exec $C psql -U postgres -d v -Atq -c "select contact_id from resolve_bsuid_contact('$QA_B','bbbbbbbb-0000-4000-8000-000000000002','PE.W4QB00000000001',null,'b1','B1')")
docker exec $C psql -U postgres -d v -Atq -c "insert into flow_runs(flow_id,user_id,account_id,contact_id,status,end_reason,ended_at) select '$QA_FB','bbbbbbbb-0000-4000-8000-000000000002','$QA_B','$BC','failed','send_media_failed',now() from generate_series(1,3)"
WATCH_ACCOUNTS=$QA_A WATCH_VIA=cron WATCH; R=$?; echo "failing account B NOT watched (WATCH_ACCOUNTS=A): exit $R (expected 0); B master still on: $(docker exec $C psql -U postgres -d v -At -c "select flows_enabled from bsuid_flow_settings where account_id='$QA_B'") (expected t); log records via=cron: $(tail -1 $W/watch.log | grep -c 'via=cron'); log mentions B: $(tail -1 $W/watch.log | grep -c ${QA_B:0:8}) (expected 0)"
WATCH_ACCOUNTS=$QA_B WATCH; R=$?; echo "failing account B watched: exit $R (expected 1); B master now: $(docker exec $C psql -U postgres -d v -At -c "select flows_enabled from bsuid_flow_settings where account_id='$QA_B'") (expected f); A master untouched: $(docker exec $C psql -U postgres -d v -At -c "select flows_enabled from bsuid_flow_settings where account_id='$QA_A'") (expected t); A authorizations enabled: $(docker exec $C psql -U postgres -d v -At -c "select count(*) from bsuid_flow_authorizations where account_id='$QA_A' and enabled") (expected 1); B contact kept: $(docker exec $C psql -U postgres -d v -At -c "select count(*) from contacts where id='$BC'")"
WATCH_ACCOUNTS=$QA_FB WATCH; echo "a WATCH_ACCOUNTS value that is not a watched account does nothing: $(tail -1 $W/watch.log | grep -c 'no watched account')"
