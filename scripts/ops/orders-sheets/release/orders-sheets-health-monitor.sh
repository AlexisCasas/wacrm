#!/bin/sh
# READ-ONLY monitor for the Sheets export (same pattern as orders-health-monitor.sh): one local log line per run, nothing is sent anywhere.
# ALERT when: any S* code > 0, the sync cron log is older than 6 min or its last line is not rc=0 (HTTP 200), or the last reconcile line is older than 75 min / not rc=0.
# The cron answers HTTP 500 (rc=1) for: a failed account, layout mismatch, an altered row, dead jobs or reconciliation differences ("attention"); expected retries stay rc=0.
# Exit: 0 clean, 1 alert, 2 monitor problem.   Stop it with:  rm /etc/cron.d/wacrm-orders-sheets-health
umask 027
DIR="$(cd "$(dirname "$0")" && pwd)"; LOG=${SHEETS_HEALTH_LOG:-/var/log/wacrm-orders-sheets-health.log}; CRON_LOG=${SHEETS_CRON_LOG:-/var/log/wacrm-orders-sheets-cron.log}
LOCK=/run/lock/wacrm-orders-sheets-health.lock; exec 9>"$LOCK" || exit 2; flock -n 9 || exit 0
ts=$(date -u +%FT%TZ); now=$(date +%s)
out=$(${SHEETS_HEALTH_CMD:-"$DIR/orders-sheets-health.sh"} 2>&1) || { echo "$ts MONITOR_ERROR $(echo "$out" | head -1 | tr -cd '[:print:]' | cut -c1-120)" >> "$LOG"; exit 2; }
firing=$(echo "$out" | awk '$1 ~ /^S[0-9]/ && $2+0 > 0 {print $1"="$2}')
on=$(echo "$out" | awk '$1=="I_enabled_destinations"{print $2}')
if [ "${on:-0}" -gt 0 ]; then
  if [ ! -f "$CRON_LOG" ]; then firing="$firing S6_cron_log_missing=1"; else
    s=$(grep ' mode=sync ' "$CRON_LOG" | tail -1); r=$(grep ' mode=reconcile ' "$CRON_LOG" | tail -1)
    [ -z "$s" ] && firing="$firing S7_no_sync_run=1" || {
      st=$(date -d "$(echo "$s" | cut -d' ' -f1)" +%s 2>/dev/null || echo 0); [ $((now - st)) -gt 360 ] && firing="$firing S7_sync_silent=$((now - st))s"
      echo "$s" | grep -q ' rc=0 ' || firing="$firing S8_sync_last_run_failed=1"; }
    [ -z "$r" ] && firing="$firing S9_no_reconcile_run=1" || {
      rt=$(date -d "$(echo "$r" | cut -d' ' -f1)" +%s 2>/dev/null || echo 0); [ $((now - rt)) -gt 4500 ] && firing="$firing S9_reconcile_silent=$((now - rt))s"
      echo "$r" | grep -q ' rc=0 ' || firing="$firing S10_reconcile_last_run_failed=1"; }
  fi
fi
firing=$(echo $firing)
if [ -n "$firing" ]; then echo "$ts ALERT $firing enabled=$on $(echo "$out" | awk '$1=="I_exported"{print "exported="$2}')" >> "$LOG"; exit 1
else echo "$ts OK enabled=$on $(echo "$out" | awk '$1=="I_exported"{print "exported="$2}')" >> "$LOG"; exit 0; fi
