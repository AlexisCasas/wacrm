#!/usr/bin/env bash
# Roll back to the previous container kept by deploy.sh (stopped, not removed). Same blue/green mechanics in reverse.
# (A stopped container rejoins its networks with its aliases when started, so no network command is normally needed.)
#
#   rollback.sh                 # DRY-RUN
#   rollback.sh --execute       # does it
# Uses $STATE_DIR/last.env (written by deploy.sh). The previous container is started, must pass readiness, takes the public alias, and only
# then does the failed release leave it; the failed release is kept stopped (as <name>-failed-<ts>) for inspection.
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$DIR/lib.sh"
EXECUTE=0; if [ "${1:-}" = "--execute" ]; then EXECUTE=1; shift; fi
export EXECUTE
need docker; need flock
exec 9>"$LOCK_FILE"; flock -n 9 || die "another deploy/rollback is running"
[ -f "$STATE_DIR/last.env" ] || die "no $STATE_DIR/last.env: nothing to roll back to"
# shellcheck disable=SC1091
. "$STATE_DIR/last.env"
[ "${ROLLBACK_DISABLED:-0}" != "1" ] || die "the previous release could not be parked privately; automatic rollback is disabled"
[ -n "${PREV_NAME:-}" ] || die "last.env has no PREV_NAME (the deploy did not finish its last step)"
container_exists "$PREV_NAME" || die "previous container $PREV_NAME no longer exists"
! container_running "$PREV_NAME" || die "previous container already running; rollback state is inconsistent"
is_private_rollback_container "$PREV_NAME" ||
  die "previous image still holds public alias or is not privately connected; refusing to expose an unready backend"
FAILED="$LIVE_NAME"; container_running "$FAILED" || die "current $FAILED is not running"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
log "rollback: $FAILED (image $(docker inspect -f '{{.Config.Image}}' "$FAILED")) -> $PREV_NAME (image $OLD_IMAGE)"
[ "$EXECUTE" = "1" ] || { log "DRY-RUN complete: nothing was changed. Re-run with --execute."; exit 0; }

abort_previous() {
  local reason="$1"
  log "ABORT rollback: $reason; current release is still serving"
  docker stop -t "$STOP_GRACE" "$PREV_NAME" >/dev/null 2>&1 || true
  park_stopped_previous "$PREV_NAME" "$PREV_NAME" ||
    log "CRITICAL: previous image could not be reparked; do not restart manually"
  die "$reason"
}
log "1/5 starting previously parked container privately (no public alias yet)"
docker start "$PREV_NAME" >/dev/null
is_private_rollback_container "$PREV_NAME" ||
  abort_previous "old image became publicly visible before readiness"
log "2/5 readiness (legacy DB-backed probe supported)"
wait_ready "$PREV_NAME" rollback_ready_status ||
  abort_previous "previous container did not become DB-ready"
IMG="$(docker inspect -f '{{.Image}}' "$PREV_NAME")"
PREV_IP="$(container_ip "$PREV_NAME")"
log "3/5 publish public alias only AFTER readiness has passed"
# Previous is private; disconnecting it cannot interrupt public requests.
docker network disconnect "$EDGE_NETWORK" "$PREV_NAME" ||
  abort_previous "previous private network detach failed"
docker network connect --alias "$PUBLIC_ALIAS" --alias "$PREV_NAME" "$EDGE_NETWORK" "$PREV_NAME" ||
  abort_previous "could not publish ready previous image"
# After a reconnect Docker may assign a new IP. Check both participants
# before ever stopping the currently-serving release.
PREV_IP="$(container_ip "$PREV_NAME")"
FAILED_IP="$(container_ip "$FAILED")"
GOT="$(resolve_from_edge "$IMG" "$PUBLIC_ALIAS")"
if ! { grep -Fxq "$PREV_IP" <<<"$GOT" && grep -Fxq "$FAILED_IP" <<<"$GOT"; }; then
  abort_previous "rollback alias is not dual-serving; current release preserved"
fi
log "rollback alias validated for both live and previous containers"
log "4/5 waiting ${DRAIN_SECONDS}s for dual-serve before name swap"
sleep "$DRAIN_SECONDS"
[ "$(rollback_ready_status "$PREV_NAME")" = "200" ] ||
  abort_previous "previous image lost DB readiness while dual-serving"

log "5/5 swapping names while both images still run; only then stop failed image"
FAILED_NAME="${LIVE_NAME}-failed-$TS"
SWAP_RESULT=0
swap_running_live_name "$FAILED_NAME" "$PREV_NAME" "$LIVE_NAME" || SWAP_RESULT=$?
if [ "$SWAP_RESULT" != "0" ]; then
  if [ "$SWAP_RESULT" = "1" ] || [ "$SWAP_RESULT" = "2" ]; then
    # Existing release is still the running live cron target; abort safely
    # and restore the previous image to its private rollback endpoint.
    abort_previous "rollback rename failed safely; current release remains live (code=$SWAP_RESULT)"
  fi
  die "CRITICAL: ambiguous rollback name handoff (code=$SWAP_RESULT); both instances left for manual repair"
fi
if [ "$(rollback_ready_status "$LIVE_NAME")" != "200" ]; then
  log "CRITICAL: previous image lost readiness after rollback name swap; restoring running current release"
  REVERSE_RESULT=0
  swap_running_live_name "$PREV_NAME" "$FAILED_NAME" "$LIVE_NAME" || REVERSE_RESULT=$?
  if [ "$REVERSE_RESULT" = "0" ]; then
    abort_previous "previous image failed post-swap readiness; current release restored as $LIVE_NAME"
  fi
  die "CRITICAL: rollback readiness failure and reverse name handoff failed (code=$REVERSE_RESULT); manual intervention required"
fi
docker stop -t "$STOP_GRACE" "$FAILED_NAME" >/dev/null ||
  die "CRITICAL: failed image could not be stopped; prior image stays live; manual inspection required"
# An already executed rollback cannot be reused to restart a stale image.
grep -vE '^(PREV_NAME|ROLLBACK_DISABLED|FAILED_NAME)=' "$STATE_DIR/last.env" >"$STATE_DIR/.last.env.rollback-$TS"
echo "FAILED_NAME=${LIVE_NAME}-failed-$TS" >>"$STATE_DIR/.last.env.rollback-$TS"
mv -f "$STATE_DIR/.last.env.rollback-$TS" "$STATE_DIR/last.env"
log "rolled back. live=$LIVE_NAME image=$OLD_IMAGE. Failed release kept stopped as ${LIVE_NAME}-failed-$TS. Verify with verify-no-502.sh"
