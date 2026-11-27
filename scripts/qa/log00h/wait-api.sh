#!/usr/bin/env bash
# After a start or reset, wait until REST, Auth and Storage answer through the local gateway.
set -euo pipefail
set -a; . "${RUNNER_TEMP:?}/supabase.env"; set +a
base=http://127.0.0.1:55321
for attempt in $(seq 1 60); do
  rest=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" "$base/rest/v1/accounts?select=id&limit=1" || true)
  auth=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H "apikey: $ANON_KEY" "$base/auth/v1/health" || true)
  storage=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" "$base/storage/v1/bucket" || true)
  if [ "$rest" = 200 ] && [ "$auth" = 200 ] && [ "$storage" = 200 ]; then echo "API ready after $attempt attempts"; exit 0; fi
  sleep 3
done
echo "API not ready: rest=$rest auth=$auth storage=$storage"; exit 1
