#!/usr/bin/env bash
# Reproducible E4.2B1.1 QA: throwaway PostgreSQL 17 (supabase/postgres image),
# no published ports, no network, destroyed on exit. Every run is a fresh
# container so no fixture state can leak between runs.
set -euo pipefail
cd "$(dirname "$0")/../.."
IMAGE="${QA_PG_IMAGE:-supabase/postgres:17.6.1.136}"
NAME="e42b11-qa-$$"
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT
docker run -d --rm --name "$NAME" --network none -e POSTGRES_PASSWORD=qa "$IMAGE" >/dev/null
psql_() { docker exec -i -e PGOPTIONS="-c client_min_messages=${QA_MIN_MSG:-notice}" "$NAME" psql -U supabase_admin -h /var/run/postgresql -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
# The image restarts postgres once after init; wait until it stays up.
for _ in $(seq 1 90); do
  sleep 2
  if psql_ -Atc 'select 1' >/dev/null 2>&1; then sleep 3; psql_ -Atc 'select 1' >/dev/null 2>&1 && break; fi
done
psql_ -Atc 'select version()'
QA_MIN_MSG=warning psql_ < scripts/sql/e42b11-qa-bootstrap.sql
for f in supabase/migrations/*.sql; do QA_MIN_MSG=warning psql_ < "$f" >/dev/null || { echo "migration failed: $f" >&2; exit 1; }; done
echo "migrations 001..054 applied"

SQL=scripts/sql
LOG="$(mktemp)"; trap 'rm -f "$LOG"; docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT
QA_MIN_MSG=warning psql_ < "$SQL/e42b11-qa-helpers.sql"

# Phase 1 (T01-T11, T15-T18, T09 regression): one transaction, rolled back.
{ echo 'BEGIN;'; cat "$SQL/e42b11-fixtures.sql" "$SQL/e42b11-t01-t09.sql" "$SQL/e42b11-t02-t18.sql"; echo 'ROLLBACK;'; } \
  | psql_ -o /dev/null 2>&1 | tee -a "$LOG" | grep -E 'QA-RESULT|ERROR' || true

# Phase 2 (T12-T14): committed fixtures, two real concurrent sessions.
QA_MIN_MSG=warning psql_ -o /dev/null < "$SQL/e42b11-fixtures.sql"
"$SQL/e42b11-t12-t14.sh" "$NAME" 2>&1 | tee -a "$LOG"

# Verdict: every test T01..T18 must have reported PASS and nothing may FAIL.
status=0
echo "---- matrix"
for t in T01 T02 T03 T04 T05 T06 T07 T08 T09 T10 T11 T12 T13 T14 T15 T16 T17 T18; do
  line=$(grep -m1 "QA-RESULT $t PASS" "$LOG" || true)
  if [ -n "$line" ]; then echo "$t PASS"; else echo "$t MISSING/FAIL"; status=1; fi
done
if grep -q 'QA-RESULT .* FAIL\|ERROR:' "$LOG"; then status=1; fi
if [ "$status" = 0 ]; then echo "E4.2B1.1 FULL SQL QA PASS"; else echo "E4.2B1.1 SQL QA FAILED" >&2; fi
exit "$status"
