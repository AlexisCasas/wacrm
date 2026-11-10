#!/usr/bin/env bash
# ISOLATED lab for the traffic switch. Touches no real container or network: it creates a throwaway network, two tiny Node HTTP servers
# (using the node binary of an image that is already on the host) and one client, and removes everything at the end.
#
# It reproduces the mechanics of deploy.sh steps 4-6: public alias added to the candidate, old stopped with SIGTERM while a slow request is
# in flight. Variant disconnect-first shows why the old container is NOT detached from the network before it is stopped. The client keeps keep-alive connections (like Caddy) and fires ~50 req/s the whole time.
#
#   lab-alias-flip.sh <image-with-node>      e.g. wacrm-app:contacts-bulk-delete-d0131f2a
set -euo pipefail
IMAGE="${1:?usage: lab-alias-flip.sh <image-with-node> [sigterm-first|disconnect-first]}"
VARIANT="${2:-sigterm-first}"
N="wacrm-deploy-lab-$$"; PUB="lab-app"
cleanup() { docker rm -f "$N-a" "$N-b" "$N-client" >/dev/null 2>&1 || true; docker network rm "$N" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker network create "$N" >/dev/null

SERVER='
const http=require("http");const id=process.env.ID;let active=0;
const s=http.createServer((req,res)=>{active++;const done=()=>{active--;};
  if(req.url==="/slow"){setTimeout(()=>{res.end(id+":slow-done");done()},3000);return}
  res.end(id);done()});
s.keepAliveTimeout=5000;
process.on("SIGTERM",()=>{ // graceful: stop accepting, drop idle keep-alives, wait for in-flight requests, then exit
  s.close(()=>process.exit(0)); if(s.closeIdleConnections) s.closeIdleConnections();
  const t=setInterval(()=>{if(s.closeIdleConnections)s.closeIdleConnections()},200); t.unref(); });
s.listen(3000,()=>console.log("up"));'
for x in a b; do
  extra=(); [ "$x" = a ] && extra=(--network-alias "$PUB")
  docker run -d --name "$N-$x" --network "$N" "${extra[@]}" --network-alias "$N-$x" -e ID="$x" --entrypoint node "$IMAGE" -e "$SERVER" >/dev/null
  # b starts on the network WITHOUT the public alias (a candidate that has not taken traffic yet)
done
sleep 2
CLIENT='
const counts={};let fail=0,total=0;const fails={};
const hit=async()=>{total++;try{const r=await fetch("http://'"$PUB"':3000/");const t=await r.text();counts[t]=(counts[t]||0)+1}catch(e){fail++;const k=(e.cause&&e.cause.code)||e.message;fails[k]=(fails[k]||0)+1}};
const t=setInterval(hit,20);
// 12 slow (3s) requests fired just before the old container is stopped: they are in flight on whichever container served them
const slow={ok:0,failed:0,failures:{}};
setTimeout(()=>{for(let i=0;i<12;i++)fetch("http://'"$PUB"':3000/slow").then(r=>r.text()).then(()=>slow.ok++).catch(e=>{slow.failed++;const k=(e.cause&&e.cause.code)||e.message;slow.failures[k]=(slow.failures[k]||0)+1})},6500);
setTimeout(()=>{clearInterval(t);setTimeout(()=>{console.log(JSON.stringify({total,fail,fails,counts,slow}));process.exit(0)},500)},16000);'
docker run -d --name "$N-client" --network "$N" --entrypoint node "$IMAGE" -e "$CLIENT" >/dev/null

sleep 4;  echo "[$VARIANT] t=4s   serving: a only"
echo "[$VARIANT] t=4s   candidate b takes the public alias (both serve)";  docker network disconnect "$N" "$N-b"; docker network connect --alias "$N-b" --alias "$PUB" "$N" "$N-b"
sleep 3
if [ "$VARIANT" = "disconnect-first" ]; then
  echo "[$VARIANT] t=7s   old a is disconnected from the network (the rejected approach)"; docker network disconnect "$N" "$N-a"
  sleep 2
fi
echo "[$VARIANT] t=9s   old a gets SIGTERM (graceful)"; docker stop -t 20 "$N-a" >/dev/null
docker wait "$N-client" >/dev/null
echo "RESULT[$VARIANT]: $(docker logs "$N-client" 2>&1 | tail -1)"
