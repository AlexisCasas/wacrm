#!/usr/bin/env bash
# Inbox contact-fields editor RLS/CAS QA on a disposable PostgreSQL 17 + PostgREST (--internal network, synthetic data).
# PostgreSQL 17 (migrations 001..069) behind a real PostgREST on an --internal Docker network (no ports, no internet, no Meta).
set -euo pipefail
cd "$(dirname "$0")/../.."
IMAGE="${QA_PG_IMAGE:-supabase/postgres:17.6.1.136}"; REST_IMAGE="${QA_POSTGREST_IMAGE:-postgrest/postgrest:v14.17}"
ID=$$; NET="cf-rls-net-$ID"; DB="cf-rls-db-$ID"; REST="cf-rls-rest-$ID"
SECRET="qa-only-$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40)"
cleanup() { docker rm -f "$REST" "$DB" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; }; trap cleanup EXIT
docker network create --internal "$NET" >/dev/null
docker run -d --name "$DB" --network "$NET" -e POSTGRES_PASSWORD=qa "$IMAGE" >/dev/null
psql_() { docker exec -i "$DB" psql -U supabase_admin -h /var/run/postgresql -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
for _ in $(seq 1 120); do sleep 1; log="$(docker logs "$DB" 2>&1 || true)"
  if grep -q 'PostgreSQL init process complete' <<<"$log" && [ "$(grep -c 'ready to accept connections' <<<"$log")" -ge 2 ] && psql_ -Atc 'select 1' >/dev/null 2>&1; then break; fi; done
QA_MIN=warning; export PGOPTIONS="-c client_min_messages=warning"
psql_ < qa/flows-safe-save/bootstrap.sql >/dev/null; for f in supabase/migrations/*.sql; do psql_ < "$f" >/dev/null 2>&1 || { echo "migration failed: $f" >&2; exit 1; }; done
psql_ -c "ALTER ROLE authenticator WITH LOGIN PASSWORD 'qa'" >/dev/null
psql_ -c "CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS \$\$ select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid \$\$" >/dev/null
psql_ < qa/flows-safe-save/fixtures.sql >/dev/null
docker run -d --name "$REST" --network "$NET" -e PGRST_DB_URI="postgres://authenticator:qa@$DB:5432/postgres" -e PGRST_DB_SCHEMAS=public -e PGRST_DB_ANON_ROLE=anon -e PGRST_JWT_SECRET="$SECRET" -e PGRST_ADMIN_SERVER_PORT=3001 "$REST_IMAGE" >/dev/null
IP=$(docker inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" "$REST")
for _ in $(seq 1 60); do [ "$(curl -s -o /dev/null -w '%{http_code}' "http://$IP:3001/ready" 2>/dev/null)" = 200 ] && break; sleep 1; done
export QA_REST_URL="http://$IP:3000" QA_JWT_SECRET="$SECRET" QA_PG_CONTAINER="$DB" QA_ENGINE_ADMIN_NOW=1
set +e
npx vitest run src/lib/contacts/contact-fields.rls.http.test.ts --reporter=verbose --no-file-parallelism 2>&1 | tee /tmp/cf-rlsine-$ID.log | grep -E "QA-RESULT|Tests |×|AssertionError|Error:"
RC=${PIPESTATUS[0]}; rm -f /tmp/cf-rlsine-$ID.log
[ "$RC" = 0 ] && echo "CONTACT FIELDS RLS QA PASS" || { echo "CONTACT FIELDS RLS QA FAILED" >&2; exit 1; }
