#!/usr/bin/env bash
# F06 Security Gate plumbing (source it after qa-lib.sh): the QA PostgreSQL 17 plus a REAL PostgREST on an `--internal`
# Docker network (no published ports, no route out, no production credentials). The JWT secret is synthetic and exists only
# in the QA process environment. Nothing here talks to Meta or to any production service.
REST_IMAGE="${QA_POSTGREST_IMAGE:-postgrest/postgrest:v14.17}"
QA_HTTP_NET="e4sg-net-$$"; QA_HTTP_REST="e4sg-rest-$$"
QA_JWT_SECRET="${QA_JWT_SECRET:-qa-only-synthetic-jwt-secret-$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40)}"
trap 'rm -f "$LOG"; docker rm -f "$QA_HTTP_REST" "$NAME" >/dev/null 2>&1 || true; docker network rm "$QA_HTTP_NET" >/dev/null 2>&1 || true' EXIT

qa_http_start() {
  docker network create --internal "$QA_HTTP_NET" >/dev/null
  QA_NETWORK="$QA_HTTP_NET" qa_start
  qa_commit_fixtures
  QA_MIN_MSG=warning psql_ -c "ALTER ROLE authenticator WITH LOGIN PASSWORD 'qa'" >/dev/null   # QA-only password: the bare image sets none
  # QA fidelity: the bare image ships the legacy auth.uid() (request.jwt.claim.sub only). PostgREST >= 12 sets only the
  # request.jwt.claims JSON, so with the legacy body every RLS policy fails CLOSED (see test H10). Install the definition a
  # GoTrue-managed Supabase uses. Production's body is NOT inspected here (no production access): see the report.
  QA_MIN_MSG=warning psql_ -c "CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS \$\$ select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid \$\$" >/dev/null
  docker run -d --rm --name "$QA_HTTP_REST" --network "$QA_HTTP_NET" \
    -e PGRST_DB_URI="postgres://authenticator:qa@$NAME:5432/postgres" -e PGRST_DB_SCHEMAS=public -e PGRST_DB_ANON_ROLE=anon \
    -e PGRST_JWT_SECRET="$QA_JWT_SECRET" -e PGRST_DB_CHANNEL_ENABLED=true -e PGRST_ADMIN_SERVER_PORT=3001 "$REST_IMAGE" >/dev/null
  QA_REST_IP=$(docker inspect -f "{{(index .NetworkSettings.Networks \"$QA_HTTP_NET\").IPAddress}}" "$QA_HTTP_REST")
  local _; for _ in $(seq 1 60); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "http://$QA_REST_IP:3001/ready" 2>/dev/null)" = 200 ] && break; sleep 1
  done
  [ "$(curl -s -o /dev/null -w '%{http_code}' "http://$QA_REST_IP:3001/ready")" = 200 ] || { docker logs "$QA_HTTP_REST" 2>&1 | tail -5; echo "PostgREST did not become ready" >&2; return 1; }
  export QA_REST_URL="http://$QA_REST_IP:3000" QA_REST_ADMIN_URL="http://$QA_REST_IP:3001" QA_JWT_SECRET QA_PG_CONTAINER="$NAME"
  echo "PostgREST ready at $QA_REST_URL (internal network $QA_HTTP_NET, $(docker inspect -f '{{.Config.Image}}' "$QA_HTTP_REST"))"
}
