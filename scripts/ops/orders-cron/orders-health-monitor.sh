#!/bin/sh
# READ-ONLY monitor for the order delivery (same pattern as alerts-p8-monitor.sh): SELECTs only, one local log line per run, nothing is sent anywhere,
# no secrets are read or printed. One run at a time (flock) and a minimum interval between runs. Also checks that the delivery cron is alive (its
# log must have been written in the last $CRON_MAX_AGE_SECS) when /etc/cron.d/wacrm-orders is installed.
# Exit: 0 clean, 1 alert firing, 2 monitor problem.   Stop it with:  rm /etc/cron.d/wacrm-orders-health
umask 027
DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="${ORDERS_HEALTH_LOG:-/var/log/wacrm-orders-health.log}"
CRON_LOG="${ORDERS_CRON_LOG:-/var/log/wacrm-orders-cron.log}"
CRON_FILE="${ORDERS_CRON_FILE:-/etc/cron.d/wacrm-orders}"
STATE="${ORDERS_HEALTH_STATE:-/var/lib/wacrm-orders-health.state}"
LOCK="${ORDERS_HEALTH_LOCK:-/run/lock/wacrm-orders-health.lock}"
MIN_INTERVAL="${ORDERS_HEALTH_MIN_INTERVAL_SECS:-240}"; CRON_MAX_AGE="${CRON_MAX_AGE_SECS:-300}"; REPEAT_SECS="${ORDERS_HEALTH_REPEAT_SECS:-3600}"
exec 9>"$LOCK" || exit 2
flock -n 9 || exit 0
now=$(date +%s); ts=$(date -u +%FT%TZ)
last=$(sed -n 1p "$STATE" 2>/dev/null); last=${last:-0}
[ $((now - last)) -lt "$MIN_INTERVAL" ] && exit 0
out=$("$DIR/orders-health.sh" 2>&1); rc=$?
if [ "$rc" -gt 1 ]; then echo "$ts MONITOR_ERROR $(echo "$out" | head -1 | tr -cd '[:print:]' | cut -c1-160)" >> "$LOG"; exit 2; fi
firing=$(echo "$out" | awk '$1 ~ /^O[0-9]/ && $2+0 > 0 {print $1"="$2}')
if [ -f "$CRON_FILE" ]; then
  if [ ! -f "$CRON_LOG" ]; then firing="$firing O8_cron_log_missing=1"
  else
    age=$((now - $(stat -c %Y "$CRON_LOG")))
    [ "$age" -gt "$CRON_MAX_AGE" ] && firing="$firing O8_cron_silent=${age}s"
    # the last cron line must be a success (rc=0) and must not report the integration as disabled while an account has delivery on
    tail -1 "$CRON_LOG" | grep -q ' rc=0 ' || firing="$firing O9_cron_last_run_failed=1"
  fi
fi
firing=$(echo "$firing" | tr -s ' ' | sed 's/^ //')
info=$(echo "$out" | awk '$1 ~ /^I_/ {printf "%s=%s ", substr($1,3), $2}')
if [ -z "$firing" ]; then
  echo "$ts OK $info" >> "$LOG"; printf '%s\n%s\n%s\n' "$now" ok "$now" > "$STATE"; exit 0
fi
sig=$(echo "$firing" | cksum | cut -d' ' -f1)
prev_sig=$(sed -n 2p "$STATE" 2>/dev/null); prev_at=$(sed -n 3p "$STATE" 2>/dev/null); prev_at=${prev_at:-0}
if [ "$sig" = "$prev_sig" ] && [ $((now - prev_at)) -lt "$REPEAT_SECS" ]; then
  echo "$ts STILL_FIRING $firing" >> "$LOG"; sig_at=$prev_at
else
  echo "$ts ALERT $firing | $info" >> "$LOG"; sig_at=$now
fi
printf '%s\n%s\n%s\n' "$now" "$sig" "$sig_at" > "$STATE"; exit 1
