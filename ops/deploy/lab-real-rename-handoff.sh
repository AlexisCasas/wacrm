#!/usr/bin/env bash
# Real Docker Engine fault-injection lab. Uses only disposable containers with
# unique qa-rename-* names; no production container, port, network or alias.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$DIR/lib.sh"
IMAGE="${1:-node:20-alpine}"
PREFIX="qa-rename-${GITHUB_RUN_ID:-local}-${RANDOM}-$$"
OLD_ID=""
CAND_ID=""
FAULT_FROM=""
FAULT_TO=""
cleanup() {
  [ -z "$OLD_ID" ] || command docker rm -f "$OLD_ID" >/dev/null 2>&1 || true
  [ -z "$CAND_ID" ] || command docker rm -f "$CAND_ID" >/dev/null 2>&1 || true
  OLD_ID=""
  CAND_ID=""
}
trap cleanup EXIT

# Only inject the named rename failure; ALL other operations go to the real
# Docker binary. The tested helper in lib.sh is unmodified.
docker() {
  if [ "${1:-}" = rename ] &&
     [ "${2:-}" = "$FAULT_FROM" ] &&
     [ "${3:-}" = "$FAULT_TO" ]; then
    return 1
  fi
  command docker "$@"
}

assert_container() {
  local id="$1" wanted="$2" actual
  actual="$(command docker inspect -f '{{.Name}}:{{.State.Running}}' "$id")"
  [ "$actual" = "/$wanted:true" ] || {
    echo "OPS_REAL_RENAME_FAIL: expected $wanted running, got $actual" >&2
    exit 1
  }
}
assert_missing() {
  if command docker inspect "$1" >/dev/null 2>&1; then
    echo "OPS_REAL_RENAME_FAIL: unexpected occupied name $1" >&2
    exit 1
  fi
}
launch_pair() {
  local suffix="$1"
  LIVE="$PREFIX-$suffix-live"
  CAND="$PREFIX-$suffix-cand"
  PREV="$PREFIX-$suffix-prev"
  OLD_ID="$(command docker run -d --name "$LIVE" --entrypoint node "$IMAGE" -e 'setInterval(()=>{},10000)')"
  CAND_ID="$(command docker run -d --name "$CAND" --entrypoint node "$IMAGE" -e 'setInterval(()=>{},10000)')"
  assert_container "$OLD_ID" "$LIVE"
  assert_container "$CAND_ID" "$CAND"
}

# Successful handoff: both containers remain RUNNING throughout name exchange.
launch_pair success
swap_running_live_name "$PREV" "$CAND" "$LIVE"
assert_container "$OLD_ID" "$PREV"
assert_container "$CAND_ID" "$LIVE"
assert_missing "$CAND"
echo "OPS_REAL_RENAME_SUCCESS=PASS"
cleanup

# Failed first rename: old container remains running under the live name.
launch_pair first
FAULT_FROM="$LIVE"
FAULT_TO="$PREV"
rc=0
swap_running_live_name "$PREV" "$CAND" "$LIVE" || rc=$?
[ "$rc" = 1 ] || { echo "OPS_REAL_RENAME_FIRST_RC=$rc" >&2; exit 1; }
assert_container "$OLD_ID" "$LIVE"
assert_container "$CAND_ID" "$CAND"
assert_missing "$PREV"
echo "OPS_REAL_RENAME_FIRST_FAILURE=PASS"
cleanup

# Failed second rename: old instance is renamed back to the LIVE cron name.
launch_pair second
FAULT_FROM="$CAND"
FAULT_TO="$LIVE"
rc=0
swap_running_live_name "$PREV" "$CAND" "$LIVE" || rc=$?
[ "$rc" = 2 ] || { echo "OPS_REAL_RENAME_SECOND_RC=$rc" >&2; exit 1; }
assert_container "$OLD_ID" "$LIVE"
assert_container "$CAND_ID" "$CAND"
assert_missing "$PREV"
echo "OPS_REAL_RENAME_SECOND_RECOVERED=PASS"
