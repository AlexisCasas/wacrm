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
[ -n "${PREV_NAME:-}" ] || die "last.env has no PREV_NAME (the deploy did not finish its last step)"
container_exists "$PREV_NAME" || die "previous container $PREV_NAME no longer exists"
FAILED="$LIVE_NAME"; container_running "$FAILED" || die "current $FAILED is not running"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
log "rollback: $FAILED (image $(docker inspect -f '{{.Config.Image}}' "$FAILED")) -> $PREV_NAME (image $OLD_IMAGE)"
[ "$EXECUTE" = "1" ] || { log "DRY-RUN complete: nothing was changed. Re-run with --execute."; exit 0; }

log "1/5 starting the previous container (a stopped container rejoins the networks it was on, with its aliases, so it serves $PUBLIC_ALIAS again alongside the failed release)"
docker start "$PREV_NAME" >/dev/null
log "2/5 readiness"
wait_ready "$PREV_NAME" rollback_ready_status || { log "previous container did not become ready; stopping it again, current release untouched"; docker stop -t "$STOP_GRACE" "$PREV_NAME" >/dev/null 2>&1 || true; die "rollback aborted"; }
IMG="$(docker inspect -f '{{.Image}}' "$PREV_NAME")"
PREV_IP="$(container_ip "$PREV_NAME")"
log "3/5 public alias check"
case "$(resolve_from_edge "$IMG" "$PUBLIC_ALIAS" | tr '\n' ' ')" in
  *"$PREV_IP"*) ;;
  *) log "alias did not come back with the container: adding it"; docker network disconnect "$EDGE_NETWORK" "$PREV_NAME" && docker network connect --alias "$PUBLIC_ALIAS" --alias "$PREV_NAME" "$EDGE_NETWORK" "$PREV_NAME" ;;
esac
# After a reconnect Docker may assign a new IP. Check both participants
# before ever stopping the currently-serving release.
PREV_IP="$(container_ip "$PREV_NAME")"
FAILED_IP="$(container_ip "$FAILED")"
GOT="$(resolve_from_edge "$IMG" "$PUBLIC_ALIAS")"
if ! { grep -Fxq "$PREV_IP" <<<"$GOT" && grep -Fxq "$FAILED_IP" <<<"$GOT"; }; then
  log "rollback alias is not dual-serving; stopping previous candidate and preserving current release"
  docker stop -t "$STOP_GRACE" "$PREV_NAME" >/dev/null 2>&1 || true
  die "rollback aborted before stopping current release"
fi
log "rollback alias validated for both live and previous containers"
log "4/5 SIGTERM to the failed release after a ${DRAIN_SECONDS}s dual-serve window (grace ${STOP_GRACE}s)"
sleep "$DRAIN_SECONDS"
[ "$(rollback_ready_status "$PREV_NAME")" = "200" ] || { log "previous container lost readiness; stopping it so current release serves alone"; docker stop -t "$STOP_GRACE" "$PREV_NAME" >/dev/null 2>&1 || true; die "rollback aborted"; }
docker stop -t "$STOP_GRACE" "$FAILED" >/dev/null
log "5/5 swapping names"
docker rename "$FAILED" "${LIVE_NAME}-failed-$TS"
docker rename "$PREV_NAME" "$LIVE_NAME"
sed -i '/^PREV_NAME=/d' "$STATE_DIR/last.env"; echo "FAILED_NAME=${LIVE_NAME}-failed-$TS" >>"$STATE_DIR/last.env"
log "rolled back. live=$LIVE_NAME image=$OLD_IMAGE. Failed release kept stopped as ${LIVE_NAME}-failed-$TS. Verify with verify-no-502.sh"
