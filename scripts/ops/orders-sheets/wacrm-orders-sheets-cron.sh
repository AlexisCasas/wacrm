#!/bin/sh
# PREPARED, NOT INSTALLED. Every 2 minutes: export acknowledged orders to Google Sheets (GET /api/orders/sheets-export/cron). Independent of wacrm-orders-cron.sh (InkaClick).
# Install only with authorization:  copy to /usr/local/bin/wacrm-orders-sheets-cron.sh (0755) and add /etc/cron.d/wacrm-orders-sheets (see below). Stop: rm /etc/cron.d/wacrm-orders-sheets
#   */2 * * * * root flock -n /var/lock/wacrm-orders-sheets.lock /usr/local/bin/wacrm-orders-sheets-cron.sh >> /var/log/wacrm-orders-sheets-cron.log 2>&1
# One log line per run: counters only (no names, DNI, phones, no spreadsheet ids).
MODE="${1:-sync}"
CONTAINER="wacrm-app-1"
out=$(timeout 150 docker exec -e MODE="$MODE" "$CONTAINER" node -e "
fetch('http://127.0.0.1:3000/api/orders/sheets-export/cron?mode='+process.env.MODE,{headers:{'x-cron-secret':process.env.AUTOMATION_CRON_SECRET},signal:AbortSignal.timeout(140000)})
  .then(async r=>{const t=await r.text();console.log(r.status,t.slice(0,300));process.exit(r.status===200?0:1)})
  .catch(e=>{console.log('ERR',e.name);process.exit(1)})
" 2>&1); rc=$?
echo "$(date -u +%FT%TZ) mode=$MODE rc=$rc $(echo "$out" | tr -cd '[:print:]' | cut -c1-320)"
exit $rc
