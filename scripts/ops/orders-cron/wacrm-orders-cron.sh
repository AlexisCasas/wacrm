#!/bin/sh
# Once a minute: deliver due orders to InkaClick and reconcile the ones already sent (GET /api/orders/cron, same x-cron-secret as the other crons).
# Calls ONLY that endpoint. The shared 5-minute sweep and the flows crons are not touched. With the global switch off (INKACLICK_ORDERS_ENABLED not "true")
# or without an enabled account it answers {"enabled":..., "claimed":0,...} and changes nothing. One line per run, counters only (no names, DNI or phones).
CONTAINER="wacrm-app-1"
out=$(timeout 100 docker exec "$CONTAINER" node -e "
fetch('http://127.0.0.1:3000/api/orders/cron',{headers:{'x-cron-secret':process.env.AUTOMATION_CRON_SECRET},signal:AbortSignal.timeout(90000)})
  .then(async r=>{const t=await r.text();console.log(r.status,t.slice(0,300));process.exit(r.status===200?0:1)})
  .catch(e=>{console.log('ERR',e.name);process.exit(1)})
" 2>&1); rc=$?
echo "$(date -u +%FT%TZ) rc=$rc $(echo "$out" | tr -cd '[:print:]' | cut -c1-320)"
exit $rc
