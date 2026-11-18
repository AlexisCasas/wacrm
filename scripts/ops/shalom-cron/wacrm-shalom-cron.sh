#!/bin/sh
# PREPARED, NOT INSTALLED (PR-05). Every 15 minutes: one tracking tick (GET /api/orders/shalom/cron, same x-cron-secret as the other crons).
# Calls ONLY that endpoint. With the GLOBAL kill switch off (SHALOM_TRACKING_ENABLED not "true") the tick makes NO query to Shalom; the provider is
# "not_configured" unless the app runs the local FAKE one (never in production). One line per run, counters only (no names, DNI, phones or tokens).
# PRE-DEPLOY BLOCKER: do NOT install while InkaClick polls the same guides: decide first which system owns the polling.
CONTAINER="wacrm-app-1"
out=$(timeout 140 docker exec "$CONTAINER" node -e "
fetch('http://127.0.0.1:3000/api/orders/shalom/cron',{headers:{'x-cron-secret':process.env.AUTOMATION_CRON_SECRET},signal:AbortSignal.timeout(130000)})
  .then(async r=>{const t=await r.text();console.log(r.status,t.slice(0,400));process.exit(r.status===200?0:1)})
  .catch(e=>{console.log('ERR',e.name);process.exit(1)})
" 2>&1); rc=$?
echo "$(date -u +%FT%TZ) rc=$rc $(echo "$out" | tr -cd '[:print:]' | cut -c1-420)"
exit $rc
