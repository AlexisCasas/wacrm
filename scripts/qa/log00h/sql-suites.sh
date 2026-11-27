#!/usr/bin/env bash
# The repository's own SQL assertion suites. Each one opens a transaction and ends in ROLLBACK. Results are recorded, they do not stop the run.
set -uo pipefail
: "${QA_DB_URL:?}" "${QA_RESULTS:?}"
case "$QA_DB_URL" in *@127.0.0.1:54322/*|*@localhost:54322/*) ;; *) echo "refusing a non-local database"; exit 2 ;; esac
out="$QA_RESULTS/sql-suites.tsv"
: >"$out"
for name in verify-schema verify-order-confirmations conversation-handoff-test conversation-routing-test order-logistics-test; do
  log="$QA_RESULTS/sql-$name.log"
  if psql "$QA_DB_URL" -X -q -v ON_ERROR_STOP=1 -f "supabase/ci/$name.sql" >"$log" 2>&1; then rc=PASS; else rc=FAIL; fi
  printf '%s\t%s\t%s\n' "$name" "$rc" "$(grep -m1 -E 'ERROR' "$log" | cut -c1-300)" >>"$out"
  echo "$rc $name"
done
