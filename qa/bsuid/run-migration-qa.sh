#!/usr/bin/env bash
# Applies migration 077 to a DISPOSABLE copy of the schema and runs migration-077.test.sql.
# Usage: SCHEMA_DUMP=/path/to/pg_dump-custom-format.dump qa/bsuid/run-migration-qa.sh
# Never touches a real database: the container has no network and is removed at the end.
set -uo pipefail
: "${SCHEMA_DUMP:?set SCHEMA_DUMP to a pg_dump -Fc file of the schema at migration 076}"
HERE=$(cd "$(dirname "$0")" && pwd); MIG="$HERE/../../supabase/migrations/077_contact_identities_bsuid.sql"
C=wa-bsuid-qa-pg; W=$(mktemp -d); cp "$SCHEMA_DUMP" "$W/full.dump"; cp "$MIG" "$HERE/migration-077.test.sql" "$W/"
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
