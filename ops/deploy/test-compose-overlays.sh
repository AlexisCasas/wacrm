#!/usr/bin/env bash
# Local, Docker-free regression suite for the live Compose overlay filter.
# Run: bash ops/deploy/test-compose-overlays.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=compose-overlays.sh
. "$HERE/compose-overlays.sh"

ROOT="$(mktemp -d)"
trap 'rm -rf -- "$ROOT"' EXIT

TEMPLATE="$ROOT/reviewed/candidate.override.yml"
LEGACY="$ROOT/old-release/ops/candidate.override.yml"
BASE="$ROOT/live/docker-compose.yml"
PROD="$ROOT/live/docker-compose.prod.yml"
BSUID="$ROOT/live/docker-compose.bsuid-vars.yml"
IMAGE_OVERRIDE="$ROOT/deploy-state/20261114-image-override.yml"
NEW_IMAGE_OVERRIDE="$ROOT/old-release/new-image-override.yml"
OTHER="$ROOT/other/candidate.override.yml"
mkdir -p -- "$(dirname "$TEMPLATE")" "$(dirname "$LEGACY")" "$(dirname "$BASE")" "$(dirname "$IMAGE_OVERRIDE")" "$(dirname "$OTHER")"
printf '%s\n' 'services:' '  app:' '    container_name: ${CAND_NAME}' >"$TEMPLATE"
cp -- "$TEMPLATE" "$LEGACY"
printf '%s\n' 'services: {}' >"$BASE"
printf '%s\n' 'services: {}' >"$PROD"
printf '%s\n' 'services: {}' >"$BSUID"
printf '%s\n' 'services: {}' >"$IMAGE_OVERRIDE"
printf '%s\n' 'services: {}' >"$NEW_IMAGE_OVERRIDE"
printf '%s\n' 'services: {}' >"$OTHER"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
expect_args() {
  local -a want=("$@")
  [ "${#COMPOSE_ARGS[@]}" -eq "${#want[@]}" ] || fail "Compose argument count"
  local i
  for ((i=0; i<${#want[@]}; i++)); do
    [ "${COMPOSE_ARGS[$i]}" = "${want[$i]}" ] || fail "Compose argument order at index $i"
  done
}

# Identical legacy template is dropped; production/BSUID overlays retained
# in their original order. Generated image overrides are never accumulated.
FILES="$BASE,$PROD,$BSUID,$LEGACY,$IMAGE_OVERRIDE,$NEW_IMAGE_OVERRIDE,$TEMPLATE"
select_live_compose_files "$FILES" "$TEMPLATE" "$(dirname "$IMAGE_OVERRIDE")"
expect_args -f "$BASE" -f "$PROD" -f "$BSUID"
echo "PASS: old/current candidates dropped, prod and BSUID retained"

# An arbitrary overlay with the same basename in an unrelated directory
# must not be silently dropped by a broad */candidate.override.yml glob.
select_live_compose_files "$BASE,$OTHER,$BSUID" "$TEMPLATE" "$(dirname "$IMAGE_OVERRIDE")"
expect_args -f "$BASE" -f "$OTHER" -f "$BSUID"
echo "PASS: unrelated candidate.override.yml preserved"

# A divergent old candidate must BLOCK even a dry-run, before any mutation.
printf '%s\n' '    environment:' '      IMPORTANT_CONFIG: different' >>"$LEGACY"
if select_live_compose_files "$FILES" "$TEMPLATE" "$(dirname "$IMAGE_OVERRIDE")" 2>"$ROOT/error"; then
  fail "different historical candidate overlay was accepted"
fi
grep -Fq 'differs from current template' "$ROOT/error" || fail "missing divergence diagnostic"
[ "${#COMPOSE_ARGS[@]}" -eq 0 ] || fail "partial overlays survived a failed selection"
echo "PASS: historical differences fail closed"

# A missing/symlinked old candidate cannot silently disappear.
rm -f -- "$LEGACY"
if select_live_compose_files "$FILES" "$TEMPLATE" "$(dirname "$IMAGE_OVERRIDE")" 2>"$ROOT/error"; then
  fail "missing previous candidate was accepted"
fi
ln -s -- "$TEMPLATE" "$LEGACY"
if select_live_compose_files "$FILES" "$TEMPLATE" "$(dirname "$IMAGE_OVERRIDE")" 2>"$ROOT/error"; then
  fail "symlinked previous candidate was accepted"
fi
rm -- "$LEGACY"
cp -- "$TEMPLATE" "$LEGACY"
echo "PASS: missing/symlinked legacy candidates rejected"

# A production overlay must never be omitted when missing/unreadable.
rm -- "$BSUID"
if select_live_compose_files "$FILES" "$TEMPLATE" "$(dirname "$IMAGE_OVERRIDE")" 2>"$ROOT/error"; then
  fail "missing BSUID overlay was accepted"
fi
echo "PASS: missing production overlay blocks"

# No base config must fail, even if the only label is a candidate.
if select_live_compose_files "$LEGACY,$TEMPLATE" "$TEMPLATE" "$(dirname "$IMAGE_OVERRIDE")" 2>"$ROOT/error"; then
  fail "empty base Compose set was accepted"
fi
echo "PASS: empty base config blocks"

echo "PASS: all Compose overlay selection regression tests"
