#!/usr/bin/env bash
# The job is red unless the QA actually ran and ended PASS or PARTIAL.
set -uo pipefail
out="${1:?}"
if [ ! -f "$out/summary.json" ]; then echo "no summary: the QA did not run"; exit 1; fi
final="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["final"])' "$out/summary.json")"
cat "$out/final-block.txt"
case "$final" in PASS|PARTIAL) exit 0 ;; *) exit 1 ;; esac
