#!/usr/bin/env bash
# Runs the repository's database-backed suites (skipped in ordinary CI) on the candidate. Any failing file is run again on the base commit,
# so that a failure that already existed is not blamed on the candidate. Results are recorded, they do not stop the run.
set -euo pipefail
: "${QA_DIR:?}"
here="$(cd "$(dirname "$0")" && pwd)"

run_suites() { # $1 = repo|base, $2 = output name, rest = files
  local dir="$1" name="$2"; shift 2
  local rc=0
  QA_SUBDIR="$dir" bash "$here/as-qa.sh" env -u SHALOM_CUSTOMER_MESSAGES_ENABLED -u WHATSAPP_CALLING_ENABLED -u WHATSAPP_TEMPLATES_DRY_RUN \
    timeout 600 node node_modules/vitest/vitest.mjs run "$@" --no-file-parallelism --reporter=default --reporter=json "--outputFile.json=$QA_DIR/results/$name.json" \
    >"$RUNNER_TEMP/$name.log" 2>&1 || rc=$?
  tail -n 40 "$RUNNER_TEMP/$name.log"
  echo "$name: vitest exit $rc (the report decides from its JSON output)"
  sudo test -f "$QA_DIR/results/$name.json" || { echo "$name produced no result file"; exit 1; }
  sudo install -m 0644 -o qarun -g qarun "$RUNNER_TEMP/$name.log" "$QA_DIR/results/$name.log"
}

mapfile -t files < <(find src/lib/orders src/lib/conversations -name '*.qa.test.ts' | sort)
echo "candidate: ${#files[@]} database suites"
run_suites repo vitest-candidate "${files[@]}"

failed="$(sudo python3 - "$QA_DIR/results/vitest-candidate.json" "$QA_DIR/repo/" <<'PY'
import json, sys, os
try:
    data = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
for suite in data.get('testResults', []):
    if suite.get('status') == 'failed':
        print(os.path.relpath(suite['name'], sys.argv[2]))
PY
)"
if [ -n "$failed" ]; then
  existing=()
  while IFS= read -r f; do [ -f "$QA_DIR/base/$f" ] && existing+=("$f"); done <<<"$failed"
  if [ "${#existing[@]}" -gt 0 ]; then
    echo "base: re-running ${#existing[@]} failing suites"
    supabase db reset --local --no-seed
    bash "$here/wait-api.sh"
    run_suites base vitest-base "${existing[@]}"
  fi
fi
