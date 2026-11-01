#!/bin/sh
# Automated test of scripts/ops/orders-cron/orders-health-monitor.sh WITHOUT a database, Docker or any production path: the health query, the global switch
# and every file the monitor reads or writes are replaced by stubs in a temp directory. Asserts exactly which alerts fire in each scenario.
# Usage: scripts/qa/orders-delivery/monitor-test.sh      Exit 0 = all scenarios as expected.
set -u
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"; MON="$REPO/scripts/ops/orders-cron/orders-health-monitor.sh"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT; fail=0
cat > "$T/health-stub.sh" <<'S'
#!/bin/sh
cat "$STUB_HEALTH"; exit "${STUB_RC:-0}"
S
chmod +x "$T/health-stub.sh"

# run <name> <accounts_on> <o_lines> <cron_file:yes|no> <cron_log_line|none> <log_age_min> <global_switch> <expected: OK | tokens...>
run() {
  name=$1; acc=$2; olines=$3; cronfile=$4; cronline=$5; age=$6; glob=$7; shift 7; want="$*"
  rm -f "$T"/state "$T"/log "$T"/cron.log "$T"/cron.d "$T"/lock
  { printf 'I_accounts_delivery_on %s accounts (information)\nI_held 2 orders\n' "$acc"; [ -n "$olines" ] && printf '%b' "$olines"; } > "$T/health.txt"
  [ "$cronfile" = yes ] && : > "$T/cron.d"
  if [ "$cronline" != none ]; then echo "2026-11-01T10:00:00Z $cronline" > "$T/cron.log"; [ "$age" -gt 0 ] && touch -d "$age minutes ago" "$T/cron.log"; fi
  STUB_HEALTH="$T/health.txt" ORDERS_HEALTH_CMD="$T/health-stub.sh" ORDERS_GLOBAL_CMD="echo $glob" \
  ORDERS_HEALTH_LOG="$T/log" ORDERS_HEALTH_STATE="$T/state" ORDERS_HEALTH_LOCK="$T/lock" ORDERS_CRON_FILE="$T/cron.d" ORDERS_CRON_LOG="$T/cron.log" \
  ORDERS_HEALTH_MIN_INTERVAL_SECS=0 "$MON"; code=$?
  line=$(tail -1 "$T/log" 2>/dev/null); ok=1
  if [ "$want" = OK ]; then case "$line" in *" OK "*) [ $code -eq 0 ] || ok=0;; *) ok=0;; esac
  else
    [ $code -eq 1 ] || ok=0
    for tok in $want; do case "$line" in *"$tok"*) ;; *) ok=0;; esac; done
    # nothing else may fire: strip the wanted tokens and check no other O-alert remains
    rest=$line; for tok in $want; do rest=$(echo "$rest" | sed "s/$tok//"); done
    echo "${rest%%|*}" | grep -qE ' O[0-9]+_' && ok=0
  fi
  if [ $ok -eq 1 ]; then echo "PASS: $name"; else echo "FAIL: $name -> exit=$code line=[$line]"; fail=1; fi
}
GOOD='2026-11-01T10:00:00Z rc=0 200 {"enabled":true,"claimed":0,"sent":0}'
OFF='rc=0 200 {"enabled":false,"claimed":0,"sent":0,"retried":0,"rejected":0,"dead":0,"reconciled":0}'

run "no active account, nothing installed: healthy" 0 "" no none 0 "" OK
run "no active account and the endpoint answers enabled:false: healthy (integration off on purpose)" 0 "" yes "$OFF" 0 "" OK
run "active account, cron running, endpoint enabled:true, global on: healthy" 1 "" yes "rc=0 200 {\"enabled\":true,\"claimed\":0}" 0 true OK
run "active account but the endpoint answers enabled:false: ALERT" 1 "" yes "$OFF" 0 true O9_endpoint_disabled_with_active_account=1
run "active account but the global switch is off in the container: ALERT" 1 "" yes "rc=0 200 {\"enabled\":true}" 0 "" O9_global_switch_off_with_active_account=1
run "active account, global value is not exactly true: ALERT" 1 "" yes "rc=0 200 {\"enabled\":true}" 0 false O9_global_switch_off_with_active_account=1
run "active account with no cron installed: ALERT" 1 "" no none 0 true O10_account_on_without_cron=1
run "active account, no cron AND global off: both alerts" 1 "" no none 0 "" O10_account_on_without_cron=1 O9_global_switch_off_with_active_account=1
run "active account, endpoint off AND global off: both O9 alerts" 1 "" yes "$OFF" 0 "" O9_endpoint_disabled_with_active_account=1 O9_global_switch_off_with_active_account=1
run "cron last run failed (rc=1): ALERT" 1 "" yes "rc=1 ERR AbortError" 0 true O9_cron_last_run_failed=1
run "cron log older than 5 min: ALERT" 1 "" yes "rc=0 200 {\"enabled\":true}" 20 true O8_cron_silent=1200s
run "cron installed but its log is missing: ALERT" 1 "" yes none 0 true O8_cron_log_missing=1
run "a failed order alerts even when the integration is healthy" 1 "O1_failed 1 rejected\n" yes "rc=0 200 {\"enabled\":true}" 0 true O1_failed=1
run "a held order touched alerts" 0 "O6_held_touched 1 held touched\n" no none 0 "" O6_held_touched=1

# the monitor must report its own problems, not hide them
printf 'boom\n' > "$T/health.txt"; rm -f "$T"/state "$T"/log "$T"/lock
STUB_HEALTH="$T/health.txt" STUB_RC=2 ORDERS_HEALTH_CMD="$T/health-stub.sh" ORDERS_HEALTH_LOG="$T/log" ORDERS_HEALTH_STATE="$T/state" ORDERS_HEALTH_LOCK="$T/lock" ORDERS_HEALTH_MIN_INTERVAL_SECS=0 "$MON"; code=$?
if [ $code -eq 2 ] && grep -q MONITOR_ERROR "$T/log"; then echo "PASS: a failing health query is a MONITOR_ERROR (exit 2), not 'healthy'"; else echo "FAIL: monitor error handling (exit=$code)"; fail=1; fi

# repeated alert is rate-limited to one full line, then STILL_FIRING
run "alert fires" 1 "" yes "$OFF" 0 true O9_endpoint_disabled_with_active_account=1
STUB_HEALTH="$T/health.txt" ORDERS_HEALTH_CMD="$T/health-stub.sh" ORDERS_GLOBAL_CMD="echo true" ORDERS_HEALTH_LOG="$T/log" ORDERS_HEALTH_STATE="$T/state" ORDERS_HEALTH_LOCK="$T/lock" ORDERS_CRON_FILE="$T/cron.d" ORDERS_CRON_LOG="$T/cron.log" ORDERS_HEALTH_MIN_INTERVAL_SECS=0 STUB_RC=0 "$MON" >/dev/null
printf 'I_accounts_delivery_on 1 x\n' > "$T/health.txt"
STUB_HEALTH="$T/health.txt" ORDERS_HEALTH_CMD="$T/health-stub.sh" ORDERS_GLOBAL_CMD="echo true" ORDERS_HEALTH_LOG="$T/log" ORDERS_HEALTH_STATE="$T/state" ORDERS_HEALTH_LOCK="$T/lock" ORDERS_CRON_FILE="$T/cron.d" ORDERS_CRON_LOG="$T/cron.log" ORDERS_HEALTH_MIN_INTERVAL_SECS=0 "$MON" >/dev/null
if tail -1 "$T/log" | grep -q STILL_FIRING; then echo "PASS: a persistent alert is logged once in full, then as STILL_FIRING"; else echo "FAIL: repeat limiting [$(tail -1 "$T/log")]"; fail=1; fi

[ $fail -eq 0 ] && echo "ALL PASSED" || { echo "FAILED"; exit 1; }
