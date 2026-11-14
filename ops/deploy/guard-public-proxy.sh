#!/usr/bin/env bash
# Read-only release gate for the live WACRM endpoint behind the shared Caddy.
# Usage: guard-public-proxy.sh [live-container]   (default: wacrm-app-1)
# Never creates/restarts/disconnects a container, changes a network or reads secrets.
set -euo pipefail

APP="${1:-wacrm-app-1}"
NET="${EDGE_NETWORK:-edge_proxy}"
ALIAS="${PUBLIC_ALIAS:-wacrm-app}"
PROXY="${PROXY_CONTAINER:-dentalpin-caddy-1}"
PORT="${APP_PORT:-3000}"

[[ "$APP" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || { echo "INVALID_APP"; exit 2; }
[[ "$ALIAS" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || { echo "INVALID_ALIAS"; exit 2; }
[[ "$PORT" =~ ^[0-9]+$ ]] || { echo "INVALID_PORT"; exit 2; }

[ "$(docker inspect -f '{{.State.Running}}' "$APP")" = true ] || { echo "APP_NOT_RUNNING"; exit 1; }
[ "$(docker inspect -f '{{.State.Running}}' "$PROXY")" = true ] || { echo "PROXY_NOT_RUNNING"; exit 1; }

docker inspect "$APP" --format '{{json .NetworkSettings.Networks}}' |
  python3 -c '
import json,sys
net,alias=sys.argv[1:3]
networks=json.load(sys.stdin)
endpoint=networks.get(net)
if not endpoint:
    sys.exit("APP_EDGE_NETWORK_MISSING")
if alias not in (endpoint.get("Aliases") or []):
    sys.exit("LIVE_PUBLIC_ALIAS_MISSING")
' "$NET" "$ALIAS"
docker inspect "$PROXY" --format '{{json .NetworkSettings.Networks}}' |
  python3 -c '
import json,sys
net=sys.argv[1]
if net not in json.load(sys.stdin):
    sys.exit("PROXY_EDGE_NETWORK_MISSING")
' "$NET"

# The actual shared Caddy container must be able to fetch WACRM by its configured
# upstream name. A healthy app or direct container-name fetch alone is NOT enough.
docker exec "$PROXY" wget -q -T 8 -O /dev/null "http://$ALIAS:$PORT/login" ||
  { echo "CADDY_PUBLIC_UPSTREAM=FAIL"; exit 1; }
echo "CADDY_PUBLIC_UPSTREAM=PASS"

# Check HTTPS on the VPS loopback through Caddy, with correct SNI + Host.
# Override WACRM_PUBLIC_HOST if the public domain changes.
PUBLIC_HOST="${WACRM_PUBLIC_HOST:-crm.globaltechup.com}"
if [ -n "$PUBLIC_HOST" ]; then
  [[ "$PUBLIC_HOST" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]] || { echo "INVALID_PUBLIC_HOST"; exit 2; }
  need_code="$(curl --noproxy '*' --max-time 10 --silent --show-error --output /dev/null --write-out '%{http_code}' \
      --resolve "$PUBLIC_HOST:443:127.0.0.1" "https://$PUBLIC_HOST/login")" ||
    { echo "CADDY_HTTPS_ROUTE=FAIL"; exit 1; }
  case "$need_code" in
    200|301|302|303|307|308) echo "CADDY_HTTPS_ROUTE=$need_code" ;;
    *) echo "CADDY_HTTPS_ROUTE=FAIL_HTTP_$need_code"; exit 1 ;;
  esac
fi

echo "WACRM_PUBLIC_ROUTE=PASS"
