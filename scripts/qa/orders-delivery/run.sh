#!/bin/sh
# Delivery-side QA on a DISPOSABLE Postgres (no network, no published ports, synthetic data, schema-only dump of the WACRM database):
#   * claim_order_deliveries never touches `held` orders (even once the account switch is on), ignores accounts without the switch, leases once;
#   * finish / acknowledge state machine (sent -> acknowledged only from sent; held can never be acknowledged);
#   * the health checks (scripts/ops/orders-cron/orders-health.sql) fire exactly on failed, dead, late pending, stuck sending, sent-not-acknowledged,
#     touched held, and stay silent on a clean state.
# Usage: WACRM_SCHEMA_DUMP=/path/schema.dump scripts/qa/orders-delivery/run.sh
set -eu
: "${WACRM_SCHEMA_DUMP:?}"
HERE="$(cd "$(dirname "$0")" && pwd)"; REPO="$(cd "$HERE/../../.." && pwd)"; NAME=qa-deliv-pg
docker rm -f $NAME >/dev/null 2>&1 || true
trap 'docker rm -f $NAME >/dev/null 2>&1 || true' EXIT
docker run -d --name $NAME --network none --memory 1g -e POSTGRES_PASSWORD=qa_synthetic_pw supabase/postgres:17.6.1.136 >/dev/null
until docker exec $NAME pg_isready -U postgres -q 2>/dev/null; do sleep 2; done; sleep 6
docker exec -i $NAME pg_restore -s -U supabase_admin -d postgres --no-owner < "$WACRM_SCHEMA_DUMP" 2>/dev/null || true
docker cp "$REPO/scripts/ops/orders-cron/orders-health.sql" $NAME:/tmp/orders-health.sql
docker exec -i $NAME psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q < "$HERE/delivery.sql"

# ---- Health checks: exact firing per crafted state (each scenario changes ONE thing, then restores).
Q() { docker exec -i $NAME psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q -c "$1" >/dev/null; }
H() { docker exec -i $NAME psql -U supabase_admin -d postgres -X -q -f /tmp/orders-health.sql; }
fail=0
expect() { # name, then alert codes expected to fire with their counts, e.g. O1_failed=1
  name=$1; shift; out=$(H); got=$(echo "$out" | awk '$1 ~ /^O[0-9]/ && $2+0 > 0 {printf "%s=%s ", $1, $2}'); want="$*"; [ -n "$want" ] && want="$want "
  if [ "$got" = "$want" ]; then echo "NOTICE:  PASS: health: $name (${got:-no alert})"; else echo "FAIL: health: $name: wanted [$want] got [$got]"; fail=1; fi
}
expect "after the delivery scenarios only the rejected order alerts" O1_failed=1
Q "UPDATE order_confirmations SET delivery_status='dead' WHERE request_key='rej1'"; expect "a dead order fires O2 (and O1 clears)" O2_dead=1
Q "UPDATE order_confirmations SET delivery_status='sent', sent_at=now()-interval '3 minutes' WHERE request_key='rej1'"; expect "sent 3 min ago is not yet an alert"
Q "UPDATE order_confirmations SET sent_at=now()-interval '20 minutes' WHERE request_key='rej1'"; expect "sent 20 min ago and not acknowledged fires O5" O5_sent_not_acknowledged=1
Q "UPDATE order_confirmations SET delivery_status='sending', locked_until=now()-interval '10 minutes', sent_at=NULL WHERE request_key='rej1'"; expect "a lease expired 10 min ago fires O4" O4_sending_stuck=1
Q "UPDATE order_confirmations SET delivery_status='acknowledged', locked_until=NULL WHERE request_key='rej1'"; expect "everything acknowledged: clean"
Q "UPDATE order_confirmations SET next_attempt_at=now()-interval '2 minutes' WHERE request_key='q-pending-off'"; expect "a pending order due 2 min ago is not yet an alert"
Q "UPDATE order_confirmations SET next_attempt_at=now()-interval '10 minutes' WHERE request_key='q-pending-off'"; expect "a pending order due 10 min ago fires O3 (cron not running)" O3_pending_late=1
Q "UPDATE order_confirmations SET delivery_status='acknowledged' WHERE request_key='q-pending-off'"; expect "clean again"
Q "UPDATE order_confirmations SET attempts=1 WHERE request_key='held2'"; expect "a held order with an attempt fires O6" O6_held_touched=1
Q "UPDATE order_confirmations SET attempts=0 WHERE request_key='held2'"; expect "held restored: clean"
Q "INSERT INTO order_confirmation_deliveries (order_id, account_id, attempt, started_at, outcome) SELECT id, account_id, 9, now()-interval '10 minutes', 'started' FROM order_confirmations WHERE request_key='new1'"; expect "an attempt left open for 10 min fires O7" O7_open_attempts_stale=1
H | grep -E '^I_' | sed 's/^/INFO: /'
[ "$fail" -eq 0 ] || { echo "FAILED"; exit 1; }
echo "ALL PASSED"
