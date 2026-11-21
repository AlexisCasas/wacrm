#!/usr/bin/env bash
# Validate the OLD WACRM image against an ALREADY-PREPARED isolated,
# post-Calling-migration database. Read-only: never starts or stops anything.
set -euo pipefail
fail() { printf 'RC2_LEGACY_POST_MIGRATION=NO_GO: %s\n' "$1" >&2; exit 1; }
APP="${RC2_LEGACY_CONTAINER:-}"
DB="${RC2_REHEARSAL_DB_CONTAINER:-}"
NET="${RC2_INTERNAL_NETWORK:-}"
[ -n "$APP" ] && [ -n "$DB" ] && [ -n "$NET" ] ||
  fail 'set RC2_LEGACY_CONTAINER, RC2_REHEARSAL_DB_CONTAINER, RC2_INTERNAL_NETWORK'
[[ "$APP" =~ ^rc2-[a-zA-Z0-9_.-]+$ ]] || fail 'legacy test container must use rc2- prefix'
[[ "$DB" =~ ^rc2-[a-zA-Z0-9_.-]+$ ]] || fail 'test DB must use rc2- prefix'
[[ "$NET" =~ ^rc2-[a-zA-Z0-9_.-]+$ ]] || fail 'isolated network must use rc2- prefix'
[ "$APP" != "$DB" ] || fail 'test app and DB are the same container'
[ "$(docker network inspect -f '{{.Internal}}' "$NET" 2>/dev/null)" = true ] ||
  fail 'network must be Docker internal=true (no external egress)'
for CONTAINER in "$APP" "$DB"; do
  [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" = true ] ||
    fail "isolated test container is not running: $CONTAINER"
  NETWORKS="$(docker inspect -f '{{json .NetworkSettings.Networks}}' "$CONTAINER")"
  RC2_NETWORKS_JSON="$NETWORKS" python3 - "$NET" <<'PY' ||
import json
import os
import sys
networks = json.loads(os.environ["RC2_NETWORKS_JSON"] or "{}")
sys.exit(0 if list(networks.keys()) == [sys.argv[1]] else 1)
PY
    fail "test container $CONTAINER is attached to another network"
done
BASE_TAG="wacrm-app:p0-total-correction-300284e6"
EXPECTED="$(docker image inspect -f '{{.Id}}' "$BASE_TAG" 2>/dev/null)" ||
  fail 'previous product image is not loaded'
ACTUAL="$(docker inspect -f '{{.Image}}' "$APP")"
[ "$ACTUAL" = "$EXPECTED" ] || fail 'legacy container does not run the exact previous image'
CALLING_TABLES="$(docker exec -e PGOPTIONS='-c default_transaction_read_only=on' "$DB" \
  psql -XAt -U postgres -d postgres -v ON_ERROR_STOP=1 -c "
    SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relname IN (
      'whatsapp_call_sessions','whatsapp_call_events',
      'whatsapp_call_permissions','whatsapp_call_permission_requests',
      'whatsapp_call_outbound_attempts');" 2>/dev/null)" ||
  fail 'cannot inspect isolated migrated DB'
[ "$CALLING_TABLES" = 5 ] ||
  fail 'restored DB does not contain all five Calling tables'
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
# Uses the same DB-backed readiness contract as production rollback.sh.
# Because APP has ONLY an internal Docker network, its configured Supabase
# endpoint must resolve INSIDE the test stack; no Meta/production egress.
source "$ROOT/ops/deploy/lib.sh"
STATUS="$(rollback_ready_status "$APP")" ||
  fail 'legacy DB-backed readiness probe failed'
[ "$STATUS" = 200 ] ||
  fail "legacy image failed DB-backed readiness on isolated migrated DB ($STATUS)"
echo 'RC2_LEGACY_POST_MIGRATION=PASS_ISOLATED_DB_READINESS'
echo 'RC2_LEGACY_BUSINESS_SMOKE=PENDING: separately verify orders/flows read-only'
echo 'RC2_STORAGE_SNAPSHOT=PENDING: not addressed by a container probe'
