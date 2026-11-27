#!/usr/bin/env bash
# Gathers the evidence, builds the report and refuses to publish anything that contains a credential of this run.
set -uo pipefail
out="${1:?output directory}"
: "${QA_DIR:?}" "${RUNNER_TEMP:?}"
mkdir -p "$out"
if [ -d "$QA_DIR/results" ]; then sudo cp -r "$QA_DIR/results/." "$out/"; fi
docker ps --format '{{.Names}}\t{{.Image}}' >"$out/services.tsv" 2>/dev/null || true
sudo chown -R "$(id -u):$(id -g)" "$out"
node scripts/qa/log00h/report.mjs "$out" || echo "report generation failed"
secrets="$RUNNER_TEMP/scan-secrets"
{
  cat "$RUNNER_TEMP/qa-env.sh" 2>/dev/null | grep -E '^(LOCAL_ANON|LOCAL_SERVICE|ENCRYPTION_KEY|META_APP_SECRET|AUTOMATION_CRON_SECRET)=' | sed -E 's/^[A-Z_]+=//'
  sudo python3 -c 'import json,sys
try:
    [print(u["password"]) for u in json.load(open(sys.argv[1]))["users"].values()]
except Exception: pass' "$QA_DIR/private/world.json" 2>/dev/null
} >"$secrets"
rm -f "$out/SCAN_OK"
if python3 scripts/qa/log00h/scan.py "$out" "$secrets"; then
  echo ok >"$out/SCAN_OK"
fi
rm -f "$secrets"
if [ -f "$out/summary.json" ]; then cat "$out/final-block.txt"; fi
if [ -n "${GITHUB_STEP_SUMMARY:-}" ] && [ -f "$out/final-block.txt" ] && [ -f "$out/SCAN_OK" ]; then
  { echo '```text'; cat "$out/final-block.txt"; echo '```'; } >>"$GITHUB_STEP_SUMMARY"
fi
