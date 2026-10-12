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
psql_ < scripts/sql/e42b11-t01-t09.sql
