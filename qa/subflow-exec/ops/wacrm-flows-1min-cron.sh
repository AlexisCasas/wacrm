#!/bin/sh
# PREPARED, NOT INSTALLED. Once a minute: resume durable waits that are due and recover runs a dead process left stranded.
# It calls ONLY the two new endpoints. The shared 5-minute sweep (/api/flows/cron, /api/automations/cron) keeps its own cadence and
# is not touched. While FLOW_EXECUTION_SCOPE is not "all" and no execution list is set, both answer {"enabled":false} without
# touching the database; with "all" they serve exactly the accounts the DATABASE has enabled (migrations 070 / 071).
CONTAINER="wacrm-app-1"
docker exec "$CONTAINER" node -e "
const h={headers:{'x-cron-secret':process.env.AUTOMATION_CRON_SECRET}};
Promise.all([
  fetch('http://127.0.0.1:3000/api/flows/waits/cron',h).then(async r=>console.log('waits',r.status,await r.text())),
  fetch('http://127.0.0.1:3000/api/flows/recovery/cron',h).then(async r=>console.log('recovery',r.status,await r.text())),
]).catch(e=>{console.error(e);process.exit(1)})
"
