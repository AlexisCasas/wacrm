#!/bin/sh
# Meta Ads sync tick (cron, every 5 minutes). Calls GET /api/meta-ads/cron INSIDE the app container with the app's own AUTOMATION_CRON_SECRET (the secret never leaves the
# container and never appears here). Each job only runs when its own schedule is due (campaigns/adsets/catalog 60 min, insights/ranges 180 min), so most ticks do nothing.
# Writes ONE sanitized line: timestamp, rc, HTTP status and the counters returned by the route. A failure only logs; it never restarts or touches the app.
# Overlap is prevented by the flock in /etc/cron.d/wacrm-meta-ads; the timeout below bounds a stuck tick.
TIMEOUT_S="${META_SYNC_TIMEOUT:-150}"
out=$(timeout "$TIMEOUT_S" docker exec wacrm-app-1 node -e "
fetch('http://127.0.0.1:3000/api/meta-ads/cron',{headers:{'x-cron-secret':process.env.AUTOMATION_CRON_SECRET},signal:AbortSignal.timeout(140000)})
  .then(async r=>{const t=await r.text();console.log(r.status,t.slice(0,700));process.exit(r.status===200?0:1)})
  .catch(e=>{console.log('ERR',e.name);process.exit(1)})
" 2>&1); rc=$?
# printable characters only, bounded, and any token-like string masked (defence in depth: the route never returns one)
line=$(printf '%s' "$out" | tr -cd '[:print:]' | sed -E 's/EAA[A-Za-z0-9_-]{10,}/[masked]/g; s/(Bearer|Authorization)[^ ]*/[masked]/gI' | cut -c1-760)
echo "$(date -u +%FT%TZ) rc=$rc $line"
exit $rc
