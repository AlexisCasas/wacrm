#!/usr/bin/env bash
# STAGING ONLY: opts ONE synthetic account into the subflow-authoring pilot (by e-mail -> account id resolved in the
# staging database) and restarts the app container with FLOW_SUBFLOW_AUTHORING_ACCOUNT_IDS. `off` clears it.
set -euo pipefail
source "$(dirname "$0")/lib.sh"; load_env
if [ "${1:-}" = off ]; then : > "$STATE/app.env"; else
  ACC=$(psql_db -At -c "select p.account_id from public.profiles p join auth.users u on u.id=p.user_id where u.email='${1:?usage: pilot-flag.sh <email>|off}'")
  [ -n "$ACC" ] || { echo "no such staging user" >&2; exit 1; }
  printf 'FLOW_SUBFLOW_AUTHORING_ACCOUNT_IDS=%s\n' "$ACC" > "$STATE/app.env"; chmod 600 "$STATE/app.env"
fi
start_app
for _ in $(seq 1 60); do [ "$(curl -s -o /dev/null -w '%{http_code}' "$URL/login" || true)" = 200 ] && break; sleep 2; done
echo "app restarted; pilot flag: $( [ -s "$STATE/app.env" ] && echo "on for ${1}" || echo off)"
