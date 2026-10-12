#!/usr/bin/env bash
# Shared plumbing for the E4.2 SQL QA runners (source it, do not execute).
# Each run is a throwaway PostgreSQL 17 container (supabase/postgres image):
# no published ports, no network, destroyed on exit, always from a clean DB.
SQL=scripts/sql
IMAGE="${QA_PG_IMAGE:-supabase/postgres:17.6.1.136}"
NAME="e42-qa-$$"
LOG="$(mktemp)"
trap 'rm -f "$LOG"; docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT

psql_() { docker exec -i -e PGOPTIONS="-c client_min_messages=${QA_MIN_MSG:-notice}" "$NAME" psql -U supabase_admin -h /var/run/postgresql -d postgres -v ON_ERROR_STOP=1 -q "$@"; }

# Starts the container, waits for the post-init restart to settle, then applies
# the QA bootstrap, every migration in order, and the assertion helpers.
qa_start() {
  docker run -d --rm --name "$NAME" --network none -e POSTGRES_PASSWORD=qa "$IMAGE" >/dev/null
  local _
  for _ in $(seq 1 90); do
    sleep 2
    if psql_ -Atc 'select 1' >/dev/null 2>&1; then sleep 3; psql_ -Atc 'select 1' >/dev/null 2>&1 && break; fi
  done
  psql_ -Atc 'select version()'
  QA_MIN_MSG=warning psql_ < "$SQL/e42b11-qa-bootstrap.sql"
  local f n=0
  for f in supabase/migrations/*.sql; do
    QA_MIN_MSG=warning psql_ < "$f" >/dev/null || { echo "migration failed: $f" >&2; exit 1; }
    n=$((n+1))
  done
  echo "migrations applied: $n files (last: $(basename "$f"))"
  QA_MIN_MSG=warning psql_ < "$SQL/e42b11-qa-helpers.sql"
}

# qa_txn_phase <sql files...>: fixtures + files in one transaction, rolled back.
qa_txn_phase() {
  { echo 'BEGIN;'; cat "$SQL/e42b11-fixtures.sql" "$@"; echo 'ROLLBACK;'; } \
    | psql_ -o /dev/null 2>&1 | tee -a "$LOG" | grep -E 'QA-RESULT|ERROR' || true
}
qa_commit_fixtures() { QA_MIN_MSG=warning psql_ -o /dev/null < "$SQL/e42b11-fixtures.sql"; }
qa_conc() { "$SQL/$1" "$NAME" 2>&1 | tee -a "$LOG"; }

# qa_verdict <label> <test ids...>: every id needs a PASS line and nothing may FAIL.
qa_verdict() {
  local label="$1"; shift; local status=0 t
  echo "---- matrix"
  for t in "$@"; do
    if grep -q "QA-RESULT $t PASS" "$LOG"; then echo "$t PASS"; else echo "$t MISSING/FAIL"; status=1; fi
  done
  if grep -q 'QA-RESULT .* FAIL\|ERROR:' "$LOG"; then status=1; fi
  if [ "$status" = 0 ]; then echo "$label PASS"; else echo "$label FAILED" >&2; fi
  return "$status"
}
