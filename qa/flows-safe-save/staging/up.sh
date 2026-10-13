#!/usr/bin/env bash
# Starts the isolated QA staging for the safe-save functional QA:
#   db (PostgreSQL 17, migrations 001..067) + GoTrue + PostgREST + the built app + a path gateway published on 127.0.0.1:$PORT only.
# Backend containers live on an --internal Docker network: no route to the internet, to Meta or to any production service.
set -euo pipefail
source "$(dirname "$0")/lib.sh"; load_env
HERE="$(dirname "$0")"
[ -d "$ROOT/.next" ] || { echo "run staging/build-app.sh first" >&2; exit 1; }
"$HERE/down.sh" >/dev/null 2>&1 || true
docker network create --internal "$NET_INT" >/dev/null; docker network create "$NET_FRONT" >/dev/null

docker run -d --name "$DB" --network "$NET_INT" -e POSTGRES_PASSWORD="$PG_PASSWORD" "$PG_IMAGE" >/dev/null
for _ in $(seq 1 120); do sleep 1; log="$(docker logs "$DB" 2>&1 || true)"
  if grep -q 'PostgreSQL init process complete' <<<"$log" && [ "$(grep -c 'ready to accept connections' <<<"$log")" -ge 2 ] && psql_db -Atc 'select 1' >/dev/null 2>&1; then break; fi; done
psql_db < "$ROOT/qa/flows-safe-save/bootstrap.sql" >/dev/null
for f in "$ROOT"/supabase/migrations/*.sql; do psql_db < "$f" >/dev/null || { echo "migration failed: $f" >&2; exit 1; }; done
psql_db -c "ALTER ROLE authenticator WITH LOGIN PASSWORD '$PG_PASSWORD'; ALTER ROLE supabase_auth_admin WITH LOGIN PASSWORD '$PG_PASSWORD'" >/dev/null
# the bare image ships the legacy auth.uid(); GoTrue-managed Supabase uses the claims-aware body
psql_db -c "CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS \$\$ select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid \$\$" >/dev/null

docker run -d --name "$AUTH" --network "$NET_INT" \
  -e GOTRUE_API_HOST=0.0.0.0 -e GOTRUE_API_PORT=9999 -e API_EXTERNAL_URL="$URL" -e GOTRUE_SITE_URL="$URL" \
  -e GOTRUE_DB_DRIVER=postgres -e GOTRUE_DB_DATABASE_URL="postgres://supabase_auth_admin:$PG_PASSWORD@$DB:5432/postgres?search_path=auth" \
  -e GOTRUE_JWT_SECRET="$JWT_SECRET" -e GOTRUE_JWT_EXP=3600 -e GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated \
  -e GOTRUE_DISABLE_SIGNUP=false -e GOTRUE_EXTERNAL_EMAIL_ENABLED=true -e GOTRUE_MAILER_AUTOCONFIRM=true -e GOTRUE_SMTP_HOST= \
  "$AUTH_IMAGE" >/dev/null
docker run -d --name "$REST" --network "$NET_INT" -e PGRST_DB_URI="postgres://authenticator:$PG_PASSWORD@$DB:5432/postgres" \
  -e PGRST_DB_SCHEMAS=public -e PGRST_DB_ANON_ROLE=anon -e PGRST_JWT_SECRET="$JWT_SECRET" -e PGRST_ADMIN_SERVER_PORT=3001 "$REST_IMAGE" >/dev/null

# `localhost:$PORT` must mean the same thing for the browser (through the published port) and for the server (this proxy)
cat > "$STATE/Caddyfile.gw" <<EOT
:8000 {
  handle /auth/v1/* {
    uri strip_prefix /auth/v1
    reverse_proxy $AUTH:9999
  }
  handle /rest/v1/* {
    uri strip_prefix /rest/v1
    reverse_proxy $REST:3000
  }
  handle {
    reverse_proxy $APP:3000
  }
}
EOT
cat > "$STATE/Caddyfile.local" <<EOT
:$PORT {
  reverse_proxy $GW:8000
}
EOT
docker run -d --name "$GW" --network "$NET_FRONT" -p "127.0.0.1:$PORT:8000" -v "$STATE/Caddyfile.gw":/etc/caddy/Caddyfile:ro "$CADDY_IMAGE" >/dev/null
docker network connect "$NET_INT" "$GW"
start_app

echo "waiting for services..."
for _ in $(seq 1 90); do
  a=$(curl -s -o /dev/null -w '%{http_code}' "$URL/auth/v1/health" || true); r=$(curl -s -o /dev/null -w '%{http_code}' "$URL/rest/v1/" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY" || true); p=$(curl -s -o /dev/null -w '%{http_code}' "$URL/login" || true)
  [ "$a" = 200 ] && [ "$r" = 200 ] && [ "$p" = 200 ] && break; sleep 2
done
echo "auth=$a rest=$r app=$p"; [ "$a" = 200 ] && [ "$r" = 200 ] && [ "$p" = 200 ] || { echo "staging did not become ready" >&2; docker logs --tail 15 "$AUTH" >&2; exit 1; }
"$HERE/seed.sh"
echo "STAGING READY: $URL  (127.0.0.1 only; tunnel with: ssh -L $PORT:127.0.0.1:$PORT <vps>)"
