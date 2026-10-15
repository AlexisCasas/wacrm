#!/bin/sh
# READ-ONLY monitor for the P6-P8 alerts (A1-A6). It only runs SELECTs (through alerts-p8.sh) and writes ONE local log file.
# Nothing is sent anywhere, no secrets are read or printed. NOT installed anywhere; see the cron example next to it.
# Rate limits: a lock (one run at a time), a minimum interval between runs, and the same set of alerts is logged in full at most once per
# $REPEAT_SECS (a "still firing" one-liner otherwise), so a stuck alert cannot fill the disk.
# Exit: 0 clean (or only known historic frames), 1 alert firing, 2 monitor problem.
DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="${ALERT_LOG:-/var/log/wacrm-alerts-p8.log}"
STATE="${ALERT_STATE:-/var/lib/wacrm-alerts-p8.state}"
HOURS="${ALERT_HOURS:-24}"; MIN_INTERVAL="${ALERT_MIN_INTERVAL_SECS:-540}"; REPEAT_SECS="${ALERT_REPEAT_SECS:-3600}"
KNOWN="${ALERT_KNOWN_FILE:-$DIR/known-frames.txt}"
LOCK="${ALERT_LOCK:-/tmp/wacrm-alerts-p8.lock}"
exec 9>"$LOCK" || exit 2
flock -n 9 || exit 0
now=$(date +%s)
last=$(sed -n 1p "$STATE" 2>/dev/null); last=${last:-0}
[ $((now - last)) -lt "$MIN_INTERVAL" ] && exit 0
ids=$(grep -Eo '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' "$KNOWN" 2>/dev/null | tr '\n' ' ')
out=$("$DIR/alerts-p8.sh" "$HOURS" $ids 2>&1); rc=$?
ts=$(date -u +%FT%TZ)
if [ "$rc" -gt 1 ]; then echo "$ts MONITOR_ERROR $(echo "$out" | head -1 | cut -c1-200)" >> "$LOG"; exit 2; fi
if [ "$rc" -eq 0 ]; then
  sig=ok
  echo "$ts OK $(echo "$out" | awk '{printf "%s=%s ", substr($1,1,2), $2}')" >> "$LOG"
else
  firing=$(echo "$out" | awk '$2+0>0 {print $1"="$2" "$3}')
  sig=$(echo "$firing" | cksum | cut -d' ' -f1)
  prev_sig=$(sed -n 2p "$STATE" 2>/dev/null); prev_at=$(sed -n 3p "$STATE" 2>/dev/null); prev_at=${prev_at:-0}
  if [ "$sig" = "$prev_sig" ] && [ $((now - prev_at)) -lt "$REPEAT_SECS" ]; then
    echo "$ts STILL_FIRING $(echo "$firing" | awk '{print $1}' | tr '\n' ' ')" >> "$LOG"; sig_at=$prev_at
  else
    echo "$firing" | while IFS= read -r l; do echo "$ts ALERT $l"; done >> "$LOG"; sig_at=$now
  fi
  printf '%s\n%s\n%s\n' "$now" "$sig" "${sig_at:-$now}" > "$STATE"; exit 1
fi
printf '%s\n%s\n%s\n' "$now" "$sig" "$now" > "$STATE"; exit 0
