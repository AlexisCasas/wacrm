#!/usr/bin/env bash
# Real-browser QA of the "Run another flow" flow search (B01..B10) on the isolated staging.
# Needs: qa/flows-safe-save/staging/{build-app,up}.sh then pilot-flag.sh <account A e-mail> (see the pilot QA).
set -euo pipefail
cd "$(dirname "$0")/../.."
PILOT_SCRIPT=search.mjs PILOT_MATRIX="B01 B02 B03 B04 B05 B06 B07 B07b B08 B09 B10 B-kbd B-perf" exec qa/subflow-pilot/run-pilot.sh
