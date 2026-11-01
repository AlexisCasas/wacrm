#!/usr/bin/env bash
# Two-account isolation QA for the "Pedidos confirmados" history, against a DISPOSABLE Postgres (no network, no published ports, synthetic data).
# The schema comes from a SCHEMA-ONLY dump of the WACRM database (no rows): WACRM_SCHEMA_DUMP=/path/schema.dump (pg_dump -Fc --schema-only -n public).
# Exercises the real row-level policies by switching to the `authenticated` role with a synthetic JWT subject, running the SAME query shape as
# GET /api/orders/history. Prints PASS lines; any failed assertion aborts with a non-zero exit.
set -euo pipefail
: "${WACRM_SCHEMA_DUMP:?}"
HERE="$(cd "$(dirname "$0")" && pwd)"; NAME=qa-hist-pg
docker rm -f $NAME >/dev/null 2>&1 || true
trap 'docker rm -f $NAME >/dev/null 2>&1 || true' EXIT
docker run -d --name $NAME --network none --memory 1g -e POSTGRES_PASSWORD=qa_synthetic_pw supabase/postgres:17.6.1.136 >/dev/null
until docker exec $NAME pg_isready -U postgres -q 2>/dev/null; do sleep 2; done; sleep 6
docker exec -i $NAME pg_restore -s -U supabase_admin -d postgres --no-owner < "$WACRM_SCHEMA_DUMP" 2>/dev/null || true
docker exec -i $NAME psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q < "$HERE/rls.sql"
