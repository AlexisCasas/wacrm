#!/usr/bin/env bash
# Engine integration QA for subflow execution with return (P8): the REAL engine (dispatchInboundToFlows / resumeDueFlowWaits) against a disposable
# PostgreSQL 17 (migrations 001..069) behind a real PostgREST on an --internal Docker network (no ports, no internet, no Meta).
# Sends are simulated (vi.mock of meta-send). Usage: qa/subflow-exec/run-engine-qa.sh [--e4-migrations <dir with 052..066 *.sql>]
# With --e4-migrations the order is 001-051, E4 052-066, then 067-069 (the "E4 first" compatibility scenario).
set -euo pipefail
cd "$(dirname "$0")/../.."
E4=""; [ "${1:-}" = "--e4-migrations" ] && E4="$2"
IMAGE="${QA_PG_IMAGE:-supabase/postgres:17.6.1.136}"; REST_IMAGE="${QA_POSTGREST_IMAGE:-postgrest/postgrest:v14.17}"
ID=$$; NET="sf-eng-net-$ID"; DB="sf-eng-db-$ID"; REST="sf-eng-rest-$ID"
SECRET="qa-only-$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40)"
cleanup() { docker rm -f "$REST" "$DB" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; }; trap cleanup EXIT
docker network create --internal "$NET" >/dev/null
docker run -d --name "$DB" --network "$NET" -e POSTGRES_PASSWORD=qa "$IMAGE" >/dev/null
psql_() { docker exec -i "$DB" psql -U supabase_admin -h /var/run/postgresql -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
for _ in $(seq 1 120); do sleep 1; log="$(docker logs "$DB" 2>&1 || true)"
  if grep -q 'PostgreSQL init process complete' <<<"$log" && [ "$(grep -c 'ready to accept connections' <<<"$log")" -ge 2 ] && psql_ -Atc 'select 1' >/dev/null 2>&1; then break; fi; done
QA_MIN=warning; export PGOPTIONS="-c client_min_messages=warning"
psql_ < qa/flows-safe-save/bootstrap.sql >/dev/null; MIGS=$(ls supabase/migrations/*.sql)
if [ -n "$E4" ]; then MIGS="$(ls supabase/migrations/*.sql | awk -F/ '$3 < "052"') $(ls "$E4"/05[2-9]_*.sql "$E4"/06[0-6]_*.sql) $(ls supabase/migrations/067_*.sql supabase/migrations/068_*.sql supabase/migrations/069_*.sql supabase/migrations/070_*.sql supabase/migrations/071_*.sql supabase/migrations/072_*.sql)"; fi
for f in $MIGS; do psql_ < "$f" >/dev/null 2>&1 || { echo "migration failed: $f" >&2; exit 1; }; done
psql_ -c "ALTER ROLE authenticator WITH LOGIN PASSWORD 'qa'" >/dev/null
psql_ -c "CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS \$\$ select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid \$\$" >/dev/null
psql_ < qa/flows-safe-save/fixtures.sql >/dev/null
docker run -d --name "$REST" --network "$NET" -e PGRST_DB_URI="postgres://authenticator:qa@$DB:5432/postgres" -e PGRST_DB_SCHEMAS=public -e PGRST_DB_ANON_ROLE=anon -e PGRST_JWT_SECRET="$SECRET" -e PGRST_ADMIN_SERVER_PORT=3001 "$REST_IMAGE" >/dev/null
IP=$(docker inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" "$REST")
for _ in $(seq 1 60); do [ "$(curl -s -o /dev/null -w '%{http_code}' "http://$IP:3001/ready" 2>/dev/null)" = 200 ] && break; sleep 1; done
export QA_REST_URL="http://$IP:3000" QA_JWT_SECRET="$SECRET" QA_PG_CONTAINER="$DB" QA_ENGINE_ADMIN_NOW=1
set +e
npx vitest run src/lib/flows/subflow-exec.engine.http.test.ts --reporter=verbose --no-file-parallelism 2>&1 | tee /tmp/sf-engine-$ID.log | grep -E "QA-RESULT|Tests |×|AssertionError|Error:"
RC=${PIPESTATUS[0]}; rm -f /tmp/sf-engine-$ID.log
[ "$RC" = 0 ] && echo "SUBFLOW EXEC ENGINE QA PASS" || { echo "SUBFLOW EXEC ENGINE QA FAILED" >&2; exit 1; }
