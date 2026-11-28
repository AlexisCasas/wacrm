#!/usr/bin/env bash
# The job is green only when every closing criterion is PASS.
set -uo pipefail
out="${1:?}"
if [ ! -f "$out/summary.json" ]; then echo "no summary: the QA did not run"; exit 1; fi
cat "$out/final-block.txt"
final="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["final"])' "$out/summary.json")"
[ "$final" = PASS ]
