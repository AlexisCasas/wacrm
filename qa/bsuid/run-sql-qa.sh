#!/usr/bin/env bash
# FAST variant of run-migration-qa.sh: restores the schema dump into a disposable database, applies 077-080 (each twice for idempotency) and runs the SQL checks
# of 077, 078, 079 and 080 only (no shell concurrency loops, no operator-script tests). Usage: SCHEMA_DUMP=/path/to/pre-077-dump qa/bsuid/run-sql-qa.sh
set -uo pipefail
: "${SCHEMA_DUMP:?set SCHEMA_DUMP to a pg_dump -Fc file of the schema at migration 076}"
HERE=$(cd "$(dirname "$0")" && pwd); M="$HERE/../../supabase/migrations"
C=wa-bsuid-qa-sql; W=$(mktemp -d); cp "$SCHEMA_DUMP" "$W/full.dump"; cp "$HERE/flow_pilot.sh" "$W/"; cp $M/077_*.sql $M/078_*.sql $M/079_*.sql $M/080_*.sql "$HERE"/migration-07[789].test.sql "$HERE"/migration-080.test.sql "$W/"
trap 'docker rm -f $C >/dev/null 2>&1; shred -u "$W/full.dump" 2>/dev/null; rm -rf "$W"' EXIT
docker rm -f $C >/dev/null 2>&1
docker run -d --name $C --network none -e POSTGRES_PASSWORD=x -v "$W":/w:ro postgres:17-alpine >/dev/null
for i in $(seq 1 40); do docker exec $C pg_isready -U postgres -q && break; sleep 1; done; sleep 2
docker exec $C psql -U postgres -qc "create database v"
docker exec -i $C psql -U postgres -d v -q <<'SQL'
create schema auth; create table auth.users(id uuid primary key, email text);
create schema extensions; create extension if not exists pgcrypto schema extensions;
create function extensions.uuid_generate_v4() returns uuid language sql as 'select gen_random_uuid()';
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
SQL
docker exec $C pg_restore -U postgres -d v --no-owner --no-privileges -n public /w/full.dump 2>&1 | grep -c "^pg_restore: error" | sed 's/^/schema restore errors (tolerated if unrelated): /'
ap(){ docker exec -i $C psql -U postgres -d v -X -v ON_ERROR_STOP=1 -q < "$W/$1" >/dev/null && docker exec -i $C psql -U postgres -d v -X -v ON_ERROR_STOP=1 -q < "$W/$1" >/dev/null && echo "applied twice: $1"; }
ap 077_contact_identities_bsuid.sql; docker exec -i $C psql -U postgres -d v -X -q -f /w/migration-077.test.sql 2>&1 | grep -E "FAIL|ERROR" | sed 's/^/077 /'; echo "077 checks run (FAIL/ERROR lines above, none = clean)"
ap 078_bsuid_flow_authorizations.sql; docker exec -i $C psql -U postgres -d v -X -q -f /w/migration-078.test.sql 2>&1 | grep -E "PASS|FAIL|ERROR"
ap 079_bsuid_flow_volume_caps.sql; docker exec -i $C psql -U postgres -d v -X -q -f /w/migration-079.test.sql 2>&1 | grep -E "PASS|FAIL|ERROR"
ap 080_bsuid_agent_replies_policy.sql; docker exec -i $C psql -U postgres -d v -X -q -f /w/migration-080.test.sql 2>&1 | grep -E "PASS|FAIL|ERROR"

echo "== flow_pilot.sh agents-reply (operator switch)"
FP() { FLOW_PILOT_CONTAINER=$C FLOW_PILOT_DB=v FLOW_PILOT_LOG=$W/fp.log bash "$W/flow_pilot.sh" "$@"; }
QA=a1a1a1a1-0000-4000-8000-00000000000a
docker exec $C psql -U postgres -d v -Atq -c "delete from whatsapp_config where account_id='$QA'; insert into whatsapp_config(user_id,phone_number_id,waba_id,access_token,status,account_id) values ('aaaaaaaa-0000-4000-8000-000000000001','7700000000000001','7800000000000001','enc','connected','$QA'); delete from bsuid_pilot_scopes where account_id='$QA'; insert into bsuid_pilot_scopes(account_id,phone_number_id,waba_id,enabled) values ('$QA','7700000000000001','7800000000000001',true)"
echo "wrong confirmation changes nothing (expected f): $(echo nope | FP agents-reply $QA on >/dev/null 2>&1; docker exec $C psql -U postgres -d v -At -c "select agents_reply_without_credit from bsuid_pilot_scopes where account_id='$QA'")"
printf 'AGENTS a1a1a1a1\n' | FP agents-reply $QA on --cap 30 >/dev/null 2>&1; echo "confirmed on with cap 30 (expected t/30): $(docker exec $C psql -U postgres -d v -At -c "select agents_reply_without_credit||'/'||max_agent_replies_per_contact_hour from bsuid_pilot_scopes where account_id='$QA'")"
FP agents-reply $QA off >/dev/null 2>&1; echo "off needs no confirmation (expected f): $(docker exec $C psql -U postgres -d v -At -c "select agents_reply_without_credit from bsuid_pilot_scopes where account_id='$QA'")"
docker exec $C psql -U postgres -d v -Atq -c "update bsuid_pilot_scopes set enabled=false where account_id='$QA'"
echo "a disabled scope is refused (expected 1): $(echo x | FP agents-reply $QA on 2>&1 | grep -c 'no ENABLED BSUID scope')"
