#!/usr/bin/env bash
# Pure mock lab: NEVER talks to Docker Engine or real WACRM containers.
# Tests exact lib.sh helper with a fake Docker CLI and no mutations.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$DIR/lib.sh"

declare -A names
fail_pattern=""
rename_attempts=0

reset_state() {
  names=([wacrm-app-1]="running-old" [candidate]="running-new")
  fail_pattern="${1:-}"
  rename_attempts=0
}
container_running() {
  [ -n "${names[$1]:-}" ] && [[ "${names[$1]}" == running-* ]]
}
docker() {
  [ "$1" = rename ] || { echo "unexpected Docker operation $1" >&2; return 99; }
  local from="$2" to="$3"
  rename_attempts=$((rename_attempts+1))
  [ "$from:$to" != "$fail_pattern" ] || return 1
  [ -n "${names[$from]:-}" ] && [ -z "${names[$to]:-}" ] || return 1
  names[$to]="${names[$from]}"
  unset 'names[$from]'
}
assert_state() {
  local expected_old="$1" expected_new="$2" expected_previous="${3:-}"
  [ "${names[wacrm-app-1]:-}" = "$expected_old" ] ||
    { echo "FAIL live name: got ${names[wacrm-app-1]:-missing}" >&2; exit 1; }
  [ "${names[candidate]:-}" = "$expected_new" ] ||
    { echo "FAIL candidate name: got ${names[candidate]:-missing}" >&2; exit 1; }
  [ "${names[previous]:-}" = "$expected_previous" ] ||
    { echo "FAIL previous name: got ${names[previous]:-missing}" >&2; exit 1; }
}
check_result() {
  local expected="$1"; shift
  local rc=0
  swap_running_live_name previous candidate wacrm-app-1 || rc=$?
  [ "$rc" = "$expected" ] ||
    { echo "FAIL result: expected $expected, got $rc" >&2; exit 1; }
}

reset_state
check_result 0
assert_state "running-new" "" "running-old"
echo "OPS_SWAP_SUCCESS=PASS"

reset_state 'wacrm-app-1:previous'
check_result 1
assert_state "running-old" "running-new" ""
echo "OPS_SWAP_FIRST_RENAME_FAIL=PASS"

reset_state 'candidate:wacrm-app-1'
check_result 2
assert_state "running-old" "running-new" ""
echo "OPS_SWAP_SECOND_RENAME_RECOVERY=PASS"

reset_state
names[candidate]="stopped"
check_result 4
assert_state "running-old" "stopped" ""
echo "OPS_SWAP_PRECONDITION=PASS"

# A persistent restoration failure should not be misreported as safe.
reset_state 'candidate:wacrm-app-1'
# The mock above covers safe recovery. Force the restoration to fail too.
docker() {
  [ "$1" = rename ] || return 99
  local from="$2" to="$3"
  rename_attempts=$((rename_attempts+1))
  case "$from:$to" in candidate:wacrm-app-1|previous:wacrm-app-1) return 1 ;; esac
  [ -n "${names[$from]:-}" ] && [ -z "${names[$to]:-}" ] || return 1
  names[$to]="${names[$from]}"
  unset 'names[$from]'
}
check_result 3
[ -z "${names[wacrm-app-1]:-}" ] &&
[ "${names[previous]}" = "running-old" ] &&
[ "${names[candidate]}" = "running-new" ] ||
  { echo "FAIL ambiguous failure state" >&2; exit 1; }
echo "OPS_SWAP_UNRECOVERABLE=PASS"
