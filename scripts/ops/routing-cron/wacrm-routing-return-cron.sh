#!/bin/sh
# PREPARED, NOT INSTALLED (PR-05C). Every minute: one tick of the automatic return Logistica -> Comercial (GET /api/conversations/routing/cron, same
# x-cron-secret as the other crons). The rule itself is durable in the database (order_finalizations): a missed tick only delays the return to the next one.
# Independent of Shalom. One line per run, counters only (no names, phones or ids).
CONTAINER="wacrm-app-1"
out=$(timeout 50 docker exec "$CONTAINER" node -e "
fetch('http://127.0.0.1:3000/api/conversations/routing/cron',{headers:{'x-cron-secret':process.env.AUTOMATION_CRON_SECRET},signal:AbortSignal.timeout(45000)})
  .then(async r=>{const t=await r.text();console.log(r.status,t.slice(0,200));process.exit(r.status===200?0:1)})
  .catch(e=>{console.log('ERR',e.name);process.exit(1)})
" 2>&1); rc=$?
echo "$(date -u +%FT%TZ) rc=$rc $(echo "$out" | tr -cd '[:print:]' | cut -c1-220)"
exit $rc
