#!/usr/bin/env bash
# Disposable rollback-alias research: NEVER target real WACRM services.
set -euo pipefail
IMAGE="${1:-node:20-alpine}"
NET="qa-rollback-$RANDOM-$$"
OLD="$NET-old"; CURRENT="$NET-current"; PUBLIC="qa-public-app"
cleanup() {
  docker rm -f "$OLD" "$CURRENT" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker network create "$NET" >/dev/null
SERVER='const http=require("http");http.createServer((req,res)=>res.end(process.env.ID)).listen(3000,"0.0.0.0")'
docker run -d --name "$OLD" --network "$NET" --network-alias "$PUBLIC" -e ID=old --entrypoint node "$IMAGE" -e "$SERVER" >/dev/null
docker run -d --name "$CURRENT" --network "$NET" --network-alias "$PUBLIC" -e ID=current --entrypoint node "$IMAGE" -e "$SERVER" >/dev/null
docker stop "$OLD" >/dev/null
# Use the exact helper the production script calls, not a separate imitation.
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EDGE_NETWORK="$NET"; PUBLIC_ALIAS="$PUBLIC"
. "$DIR/lib.sh"
if ! park_stopped_previous "$OLD" "$OLD"; then
  echo "ROLLBACK_ALIAS_PREP=UNSUPPORTED: previous image cannot be restarted with private alias"
  exit 1
fi
docker start "$OLD" >/dev/null
# The old must NOT be visible at the public name before passing readiness.
IPS="$(docker run --rm --network "$NET" --entrypoint node "$IMAGE" -e \
  "require('dns').promises.lookup('$PUBLIC',{all:true,family:4}).then(a=>console.log(a.map(x=>x.address).join(' '))).catch(()=>process.exit(1))")"
CURRENT_IP="$(docker inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" "$CURRENT")"
OLD_IP="$(docker inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" "$OLD")"
[ "$IPS" = "$CURRENT_IP" ] && [ "$OLD_IP" != "$CURRENT_IP" ] || {
  echo "ROLLBACK_ALIAS_PREP=FAIL: old container publicly visible before readiness"; exit 1;
}
echo "ROLLBACK_ALIAS_PREP=PASS: old restarted private"
# Simulate publication after readiness, then a failed rollback and re-parking.
docker network disconnect "$NET" "$OLD"
docker network connect --alias "$PUBLIC" --alias "$OLD" "$NET" "$OLD"
GOT="$(docker run --rm --network "$NET" --entrypoint node "$IMAGE" -e \
  "require('dns').promises.lookup('$PUBLIC',{all:true,family:4}).then(a=>console.log(a.map(x=>x.address).sort().join(' '))).catch(()=>process.exit(1))")"
OLD_IP="$(docker inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" "$OLD")"
[ "$(printf '%s\n' "$GOT" | wc -w)" -eq 2 ] || {
  echo "ROLLBACK_PUBLISH=FAIL: expected both ready and current aliases"; exit 1;
}
docker stop "$OLD" >/dev/null
park_stopped_previous "$OLD" "$OLD"
docker start "$OLD" >/dev/null
AFTER="$(docker run --rm --network "$NET" --entrypoint node "$IMAGE" -e \
  "require('dns').promises.lookup('$PUBLIC',{all:true,family:4}).then(a=>console.log(a.map(x=>x.address).join(' '))).catch(()=>process.exit(1))")"
CURRENT_IP="$(docker inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" "$CURRENT")"
[ "$AFTER" = "$CURRENT_IP" ] || {
  echo "ROLLBACK_ABORT=FAIL: previously published image leaked into public alias"; exit 1;
}
echo "ROLLBACK_PUBLISH_AND_ABORT=PASS: ready-only publication and re-park"
