#!/bin/sh
# READ-ONLY. Prints every alert (CODE count sample) and exits 1 if any count is above zero. NOT scheduled by itself.
# Usage: alerts-p8.sh [hours] [known frame run id ...]   (known ids affect A4 only)
# (ALERT_DB_CONTAINER and ALERT_SQL_FILE exist only so the failure paths can be tested without touching the database.)
# Exit: 0 all zero, 1 at least one alert, 2 THE CHECK ITSELF FAILED (SQL error, database down, wrong output): never reported as "zero alerts".
HOURS="${1:-24}"; [ "$#" -gt 0 ] && shift
case "$HOURS" in ''|*[!0-9]*) echo "bad hours" >&2; exit 2;; esac
IGN="''"
for id in "$@"; do
  printf '%s' "$id" | grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' || { echo "bad run id" >&2; exit 2; }
  IGN="$IGN,'$id'"
done
# The session itself is read-only (default_transaction_read_only) and the role is the non-superuser "postgres" of the container.
OUT=$(docker exec -i -e PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=20000' "${ALERT_DB_CONTAINER:-supabase-db}" \
  psql -X -U postgres -d postgres -At -F '|' -v ON_ERROR_STOP=1 -v hours="$HOURS" -v known_frame_runs="$IGN" < "${ALERT_SQL_FILE:-$(dirname "$0")/alerts-p8.sql}" 2>&1)
RC=$?
[ "$RC" -eq 0 ] || { echo "CHECK_FAILED psql_rc=$RC $(printf '%s' "$OUT" | head -1 | cut -c1-120)" >&2; exit 2; }
[ "$(printf '%s\n' "$OUT" | grep -Ec '^A[1-6]_[a-z_]+\|[0-9]+\|')" -eq 6 ] || { echo "CHECK_FAILED unexpected output ($(printf '%s\n' "$OUT" | wc -l) lines)" >&2; exit 2; }
printf '%s\n' "$OUT" | awk -F'|' '{ printf "%-40s %s %s\n", $1, $2, $3; if ($2+0 > 0) bad=1 } END { exit bad }'
