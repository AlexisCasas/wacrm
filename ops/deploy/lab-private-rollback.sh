#!/usr/bin/env bash
# Disposable rollback-alias research: NEVER target real WACRM services.
set -euo pipefail
IMAGE="node:20-alpine"
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
# Can a stopped previous image be isolated before a restart?
if ! docker network disconnect -f "$NET" "$OLD"; then
  echo "ROLLBACK_ALIAS_PREP=UNSUPPORTED: Docker rejected network disconnect of stopped container"
  exit 1
fi
docker network connect --alias "$OLD" "$NET" "$OLD"
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
