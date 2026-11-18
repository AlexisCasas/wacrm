#!/usr/bin/env bash
# Read-only release gate for the live WACRM endpoint behind the shared Caddy.
#
#   guard-public-proxy.sh [live-container]     # default: wacrm-app-1
#   guard-public-proxy.sh --print-upstream     # print the host Caddy actually dials for the WACRM site, then exit
#
# CONTRACT: the name Caddy dials (the `reverse_proxy <host>:<port>` of the WACRM site block) MUST be the same
# name the deploy tooling publishes (PUBLIC_ALIAS) and MUST resolve, from the Caddy container, to the live app.
# Past outage: the live container lost the alias Caddy dialed, Caddy answered 502 ("lookup <alias> ... server
# misbehaving") while the app and the database were perfectly healthy. App readiness alone cannot see that.
#
# Never creates/starts/stops/removes a container, never touches a network, never prints a secret: it only runs
# `docker inspect`, one `docker exec <proxy> cat <Caddyfile>` (parsed locally; only host names are printed),
# one `docker exec <proxy> wget` GET and one loopback HTTPS GET.
set -euo pipefail

NET="${EDGE_NETWORK:-edge_proxy}"
PROXY="${PROXY_CONTAINER:-dentalpin-caddy-1}"
PUBLIC_HOST="${WACRM_PUBLIC_HOST:-crm.globaltechup.com}"
CADDYFILE_IN_PROXY="${CADDYFILE_IN_PROXY:-/etc/caddy/Caddyfile}"

valid_name() { [[ "$1" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]]; }
valid_name "$PROXY" || { echo "INVALID_PROXY"; exit 2; }
valid_name "$PUBLIC_HOST" || { echo "INVALID_PUBLIC_HOST"; exit 2; }
[[ "$CADDYFILE_IN_PROXY" =~ ^/[a-zA-Z0-9_./-]+$ ]] || { echo "INVALID_CADDYFILE_PATH"; exit 2; }

# "host:port" of the first reverse_proxy inside the site block whose address list contains $PUBLIC_HOST.
# Plain-Caddyfile parser (site blocks start at column 0 and end with a `}` at column 0). Anything else => empty.
configured_upstream() {
  docker exec "$PROXY" cat "$CADDYFILE_IN_PROXY" 2>/dev/null | awk -v host="$PUBLIC_HOST" '
    /^[^ \t#}].*\{[ \t]*$/ { inblk = 0; n = split($0, a, /[ \t,{]+/); for (i = 1; i <= n; i++) if (a[i] == host) inblk = 1; next }
    /^}/ { inblk = 0; next }
    inblk && $1 == "reverse_proxy" { u = $2; sub(/^https?:\/\//, "", u); print u; exit }
  '
}

# The exact destination Caddy dials, as host:port (Caddy's reverse_proxy defaults to port 80 when none is written).
UPSTREAM="$(configured_upstream || true)"
UP_HOST="${UPSTREAM%%:*}"
UP_PORT="${UPSTREAM#*:}"; [ "$UP_PORT" != "$UPSTREAM" ] || UP_PORT=80
if [ -z "$UP_HOST" ] || ! valid_name "$UP_HOST" || ! [[ "$UP_PORT" =~ ^[0-9]+$ ]]; then UP_HOST=""; fi
UPSTREAM="$UP_HOST:$UP_PORT"

if [ "${1:-}" = "--print-upstream" ]; then
  [ -n "$UP_HOST" ] || { echo "CADDY_UPSTREAM_UNKNOWN" >&2; exit 1; }
  echo "$UPSTREAM"
  exit 0
fi

APP="${1:-wacrm-app-1}"
ALIAS="${PUBLIC_ALIAS:-wacrm-app}"
valid_name "$APP" || { echo "INVALID_APP"; exit 2; }
valid_name "$ALIAS" || { echo "INVALID_ALIAS"; exit 2; }

[ "$(docker inspect -f '{{.State.Running}}' "$APP")" = true ] || { echo "APP_NOT_RUNNING"; exit 1; }
[ "$(docker inspect -f '{{.State.Running}}' "$PROXY")" = true ] || { echo "PROXY_NOT_RUNNING"; exit 1; }

# 1. The app is on the shared network under the public name. A container's own name is a DNS name on a
#    user-defined network, so a PUBLIC_ALIAS equal to the container name is satisfied by the name itself.
docker inspect "$APP" --format '{{json .NetworkSettings.Networks}}' |
  python3 -I -c '
import json, sys
net, alias, app = sys.argv[1:4]
endpoint = json.load(sys.stdin).get(net)
if not endpoint:
    sys.exit("APP_EDGE_NETWORK_MISSING")
if alias != app and alias not in (endpoint.get("Aliases") or []):
    sys.exit("LIVE_PUBLIC_ALIAS_MISSING")
' "$NET" "$ALIAS" "$APP"
docker inspect "$PROXY" --format '{{json .NetworkSettings.Networks}}' |
  python3 -I -c '
import json, sys
if sys.argv[1] not in json.load(sys.stdin):
    sys.exit("PROXY_EDGE_NETWORK_MISSING")
' "$NET"

# 2. What Caddy really dials is what we publish. Unknown or different => fail closed (no guessing).
[ -n "$UP_HOST" ] || { echo "CADDY_UPSTREAM_UNKNOWN"; exit 1; }
[ "$UP_HOST" = "$ALIAS" ] || { echo "CADDY_UPSTREAM_MISMATCH configured=$UP_HOST published=$ALIAS"; exit 1; }
echo "CADDY_UPSTREAM_CONTRACT=PASS ($UPSTREAM)"

# 3. The real shared Caddy can fetch WACRM at exactly the destination it dials. A healthy app, or a fetch by container name, is NOT enough.
docker exec "$PROXY" wget -q -T 8 -O /dev/null "http://$UPSTREAM/login" ||
  { echo "CADDY_PUBLIC_UPSTREAM=FAIL"; exit 1; }
echo "CADDY_PUBLIC_UPSTREAM=PASS"

# 4. HTTPS through Caddy on the VPS loopback, with the right SNI and Host (override with WACRM_PUBLIC_HOST).
code="$(curl --noproxy '*' --max-time 10 --silent --show-error --output /dev/null --write-out '%{http_code}' \
    --resolve "$PUBLIC_HOST:443:127.0.0.1" "https://$PUBLIC_HOST/login")" ||
  { echo "CADDY_HTTPS_ROUTE=FAIL"; exit 1; }
case "$code" in
  200|301|302|303|307|308) echo "CADDY_HTTPS_ROUTE=$code" ;;
  *) echo "CADDY_HTTPS_ROUTE=FAIL_HTTP_$code"; exit 1 ;;
esac

echo "WACRM_PUBLIC_ROUTE=PASS"
