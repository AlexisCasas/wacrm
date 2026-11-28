#!/usr/bin/env bash
# Builds the report and refuses to publish anything that contains a credential of this run. The scan result is written into the report only after
# the scan passed, and the final files are scanned again.
set -euo pipefail
out="${1:?output directory}"
: "${QA_DIR:?}" "${RUNNER_TEMP:?}"
mkdir -p "$out"
rm -f "$out/SCAN_OK"
secrets="$RUNNER_TEMP/scan-secrets"
trap 'rm -f "$secrets"' EXIT
: >"$secrets"
if [ -f "$RUNNER_TEMP/qa-env.sh" ]; then
  sed -nE 's/^(LOCAL_ANON|LOCAL_SERVICE|ENCRYPTION_KEY|META_APP_SECRET|AUTOMATION_CRON_SECRET)=//p' "$RUNNER_TEMP/qa-env.sh" >>"$secrets"
fi
if sudo test -f "$QA_DIR/private/world.json"; then
  sudo python3 -I -c 'import json,sys
print("\n".join(u["password"] for u in json.load(open(sys.argv[1]))["users"].values()))' "$QA_DIR/private/world.json" >>"$secrets"
fi
ARTIFACT_SCAN=NOT_RUN node scripts/qa/log00h/report.mjs "$out"
if ! python3 scripts/qa/log00h/scan.py "$out" "$secrets"; then
  ARTIFACT_SCAN=FAIL node scripts/qa/log00h/report.mjs "$out"
  exit 1
fi
ARTIFACT_SCAN=PASS node scripts/qa/log00h/report.mjs "$out"
python3 scripts/qa/log00h/scan.py "$out" "$secrets"
echo ok >"$out/SCAN_OK"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  { echo '```text'; cat "$out/final-block.txt"; echo '```'; } >>"$GITHUB_STEP_SUMMARY"
fi
