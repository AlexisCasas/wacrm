#!/usr/bin/env bash
# F06 Security Gate: real PostgREST + synthetic JWTs on an isolated Docker network. Usage: scripts/sql/run-security-gate.sh
# Nothing is published, nothing leaves the host, no production credential or service is used, Meta is never contacted.
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/sql/qa-lib.sh
source scripts/sql/qa-http-lib.sh
qa_http_start
QA_PG_CONTAINER="$NAME" npx vitest run src/lib/flows/versioned-security-gate.http.test.ts src/lib/flows/versioned-security-gate-grants.http.test.ts --reporter=verbose --no-file-parallelism 2>&1 | tee -a "$LOG"
[ "${PIPESTATUS[0]}" = 0 ] || echo "ERROR: vitest failed for the security gate" | tee -a "$LOG"
echo "-- PostgREST log (errors only):"; docker logs "$QA_HTTP_REST" 2>&1 | grep -iE "error|fatal" | head -5 || true
qa_verdict "F06 SECURITY GATE (HTTP/JWT)" H01 H02 H03 H03b H04 H05 H05b H06 H07 H08 H09 M01A M01B M02 M03 M04 M05a M05b H10 C01 C02 C03 C04 C05 C06 C07 C08 G01 G02 G03
