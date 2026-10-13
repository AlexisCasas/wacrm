#!/usr/bin/env bash
# Shared settings for the isolated QA staging (source it). Everything is SYNTHETIC: random secrets generated on first use and kept
# in $STATE (git-ignored). Nothing here points at production, Meta or any real customer.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
STATE="${QA_STAGING_STATE:-$ROOT/.qa-staging}"
PORT="${QA_STAGING_PORT:-38088}"                # published on 127.0.0.1 ONLY (reach it from your PC with an SSH tunnel)
NET_INT=f3-stg-int; NET_FRONT=f3-stg-front
DB=f3-stg-db; AUTH=f3-stg-auth; REST=f3-stg-rest; GW=f3-stg-gw; APP=f3-stg-app; LOCALPROXY=f3-stg-localproxy
PG_IMAGE="${QA_PG_IMAGE:-supabase/postgres:17.6.1.136}"; AUTH_IMAGE="${QA_AUTH_IMAGE:-supabase/gotrue:v2.189.0}"
REST_IMAGE="${QA_POSTGREST_IMAGE:-postgrest/postgrest:v14.17}"; PW_IMAGE="${QA_PW_IMAGE:-mcr.microsoft.com/playwright:v1.49.1-noble}"; CADDY_IMAGE=caddy:2-alpine
URL="http://localhost:$PORT"

rand() { head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c "$1"; }
b64u() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
jwt() { # <role>  -> HS256 JWT valid for 10 years, signed with the staging secret
  local h p; h=$(printf '{"alg":"HS256","typ":"JWT"}' | b64u); p=$(printf '{"role":"%s","iss":"f3-staging","iat":%s,"exp":%s}' "$1" "$(date +%s)" "$(( $(date +%s) + 315360000 ))" | b64u)
  printf '%s.%s.%s' "$h" "$p" "$(printf '%s.%s' "$h" "$p" | openssl dgst -sha256 -hmac "$JWT_SECRET" -binary | b64u)"
}
load_env() {
  mkdir -p "$STATE"; chmod 700 "$STATE"
  if [ ! -f "$STATE/env" ]; then
    JWT_SECRET="f3stg$(rand 48)"; PG_PASSWORD="$(rand 24)"; ENCRYPTION_KEY="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"; META_APP_SECRET="f3-synthetic-$(rand 16)"
    USER_A_EMAIL="owner@pilot-staging.test"; USER_B_EMAIL="owner@other-staging.test"; USER_PASSWORD="Qa-$(rand 14)-9"
    ANON_KEY="$(jwt anon)"; SERVICE_KEY="$(jwt service_role)"
    umask 077; cat > "$STATE/env" <<EOT
JWT_SECRET='$JWT_SECRET'
PG_PASSWORD='$PG_PASSWORD'
ENCRYPTION_KEY='$ENCRYPTION_KEY'
META_APP_SECRET='$META_APP_SECRET'
USER_A_EMAIL='$USER_A_EMAIL'
USER_B_EMAIL='$USER_B_EMAIL'
USER_PASSWORD='$USER_PASSWORD'
ANON_KEY='$ANON_KEY'
SERVICE_KEY='$SERVICE_KEY'
EOT
  fi
  # shellcheck disable=SC1091
  . "$STATE/env"
}
psql_db() { docker exec -i "$DB" psql -U supabase_admin -h /var/run/postgresql -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
