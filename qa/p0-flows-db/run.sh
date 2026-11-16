#!/usr/bin/env bash
# WACRM P0: run real Flow engine integration tests against disposable Postgres 17
# and PostgREST. Meta sends are mocked by the test file.
# Intended for GitHub-hosted runners, not the production VPS.
set -euo pipefail

: "$QA_PROJECT_ROOT"
: "$QA_TEST_FILE"
case "$QA_TEST_FILE" in
  src/lib/flows/subflow-exec.engine.http.test.ts|src/lib/flows/replace-waiting-run.engine.http.test.ts) ;;
  *) echo "QA ERROR: unapproved test target" >&2; exit 2 ;;
esac

cd "$QA_PROJECT_ROOT"
PG_IMAGE="supabase/postgres:17.6.1.136"
REST_IMAGE="postgrest/postgrest:v14.17"
ID="p0-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$$"
NET="p0-flow-net-$ID"
DB="p0-flow-pg-$ID"
REST="p0-flow-rest-$ID"
SECRET="$(openssl rand -hex 32)"
LOG="$(mktemp)"
MIG_LOG="$(mktemp)"
cleanup() {
  docker rm -f "$REST" "$DB" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -f "$LOG" "$MIG_LOG"
}
trap cleanup EXIT
echo "QA ISOLATED: target=$QA_TEST_FILE; runner=$GITHUB_RUN_ID; no external WhatsApp endpoints"
docker network create --internal "$NET" >/dev/null
docker run -d --name "$DB" --network "$NET" -e POSTGRES_PASSWORD=qa "$PG_IMAGE" >/dev/null
psql_() { docker exec -i "$DB" psql -U supabase_admin -h /var/run/postgresql -d postgres -X -v ON_ERROR_STOP=1 -q "$@"; }

# The image briefly accepts connections during initdb, then restarts into its
# final service. Starting migrations on the temporary postmaster races the
# graphql schema-version sequence and fails with a stale OID.
# Match the proven gate in qa/replace-waiting/run-engine-qa.sh.
ready=0
for _ in $(seq 1 150); do
  log="$(docker logs "$DB" 2>&1 || true)"
  if grep -q 'PostgreSQL init process complete' <<<"$log" &&
     [ "$(grep -c 'ready to accept connections' <<<"$log" || true)" -ge 2 ] &&
     psql_ -Atc 'select 1' >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" != 1 ]; then echo "QA ERROR: PostgreSQL init did not complete" >&2; docker logs --tail 60 "$DB" >&2; exit 1; fi
export PGOPTIONS="-c client_min_messages=warning"
psql_ < qa/flows-safe-save/bootstrap.sql >/dev/null
count=0
for f in supabase/migrations/*.sql; do
  if ! psql_ < "$f" > "$MIG_LOG" 2>&1; then
    echo "QA ERROR: migration failed: $f" >&2
    tail -n 35 "$MIG_LOG" >&2
    exit 1
  fi
  count=$((count + 1))
done
echo "QA: applied $count migration files to isolated database"
psql_ -c "ALTER ROLE authenticator WITH LOGIN PASSWORD 'qa'" >/dev/null
psql_ -c "CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS \$\$ select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid \$\$" >/dev/null
psql_ < qa/flows-safe-save/fixtures.sql >/dev/null

docker run -d --name "$REST" --network "$NET" \
  -e PGRST_DB_URI="postgres://authenticator:qa@$DB:5432/postgres" \
  -e PGRST_DB_SCHEMAS=public -e PGRST_DB_ANON_ROLE=anon \
  -e PGRST_JWT_SECRET="$SECRET" -e PGRST_ADMIN_SERVER_PORT=3001 \
  "$REST_IMAGE" >/dev/null
IP=$(docker inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" "$REST")
ready=0
for _ in $(seq 1 90); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "http://$IP:3001/ready" 2>/dev/null)" = 200 ]; then ready=1; break; fi
  sleep 1
done
if [ "$ready" != 1 ]; then echo "QA ERROR: PostgREST not ready" >&2; docker logs --tail 60 "$REST" >&2; exit 1; fi

export QA_REST_URL="http://$IP:3000"
export QA_JWT_SECRET="$SECRET"
export QA_PG_CONTAINER="$DB"
export QA_ENGINE_ADMIN_NOW=1
# Node 20 supports a built-in WebSocket behind this flag. supabase-js builds
# its Realtime client while the integration test creates a DB client, even
# though these tests make no Realtime connections.
export NODE_OPTIONS="--experimental-websocket"
node -e 'if (typeof WebSocket !== "function") process.exit(1)'
set +e
npx vitest run "$QA_TEST_FILE" --reporter=verbose --no-file-parallelism 2>&1 | tee "$LOG"
rc=$?
set -e
if [ "$rc" -ne 0 ]; then echo "QA FAILED: Vitest exit $rc" >&2; exit "$rc"; fi
if ! grep -q '^.*QA-RESULT' "$LOG"; then echo "QA FAILED: no integration scenario executed" >&2; exit 1; fi
if [ "$QA_TEST_FILE" = "src/lib/flows/subflow-exec.engine.http.test.ts" ]; then
  if ! grep -q 'QA-RESULT S01 PASS' "$LOG" || ! grep -q 'QA-RESULT S29 PASS' "$LOG"; then
    echo "QA FAILED: expected S01 and S29 evidence missing" >&2; exit 1
  fi
fi
echo "QA_ISOLATED_FLOW_INTEGRATION=PASS"
