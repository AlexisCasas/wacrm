#!/bin/sh
# PREPARED, NOT INSTALLED. Resumes durable waits once a minute. Same style as /usr/local/bin/wacrm-cron.sh.
# It calls ONLY /api/flows/waits/cron, so the shared 5-minute sweep (/api/flows/cron, /api/automations/cron) keeps its cadence.
# While FLOW_DURABLE_WAIT_EXECUTION_ACCOUNT_IDS is empty the endpoint answers {"enabled":false} without touching the database.
CONTAINER="wacrm-app-1"
docker exec "$CONTAINER" node -e "
fetch('http://127.0.0.1:3000/api/flows/waits/cron',{headers:{'x-cron-secret':process.env.AUTOMATION_CRON_SECRET}})
  .then(async r => console.log('waits',r.status,await r.text()))
  .catch(e => { console.error(e); process.exit(1) })
"
