#!/usr/bin/env bash
# Zero-downtime deploy of an already-built, already-loaded WACRM image (blue/green on the Docker network). See README.md.
#
#   deploy.sh <image:tag>              # DRY-RUN: preflight + plan only, mutates nothing
#   deploy.sh --execute <image:tag>    # does it
#
# Order: candidate (private alias) -> readiness gate -> DNS check -> public alias added (both serve) -> dual-serve window ->
# old gets SIGTERM and time to finish (it leaves DNS when it exits) -> old kept STOPPED for rollback -> names swapped so the host crons work.
# The old container is deliberately NOT disconnected from the network: that severs its in-flight connections (see lab-alias-flip.sh).
# Any failure before the old container is stopped leaves the old one serving and removes the candidate.
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$DIR/lib.sh"

EXECUTE=0
if [ "${1:-}" = "--execute" ]; then EXECUTE=1; shift; fi
IMAGE="${1:-}"; [ -n "$IMAGE" ] || die "usage: deploy.sh [--execute] <image:tag>"
need docker; need flock
export EXECUTE

exec 9>"$LOCK_FILE"; flock -n 9 || die "another deploy is running ($LOCK_FILE)"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
CAND="wacrm-app-cand-$TS"
OLD="$LIVE_NAME"
container_running "$OLD" || die "live container $OLD is not running: this script only does zero-downtime swaps; use the normal procedure to start from nothing"
docker image inspect "$IMAGE" >/dev/null 2>&1 || die "image $IMAGE is not loaded on this host"
[ "$(docker image inspect -f '{{.Id}}' "$IMAGE")" != "$(docker inspect -f '{{.Image}}' "$OLD")" ] || die "$IMAGE is already the running image"
docker network inspect "$EDGE_NETWORK" >/dev/null 2>&1 || die "network $EDGE_NETWORK not found"

# The live container's own compose definition: same files, same project working dir.
PROJECT_DIR="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$OLD")"
FILES_LABEL="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$OLD")"
[ -d "$PROJECT_DIR" ] && [ -n "$FILES_LABEL" ] || die "cannot read the live compose definition from $OLD labels"
COMPOSE_ARGS=()
IFS=',' read -r -a FILES <<<"$FILES_LABEL"
for f in "${FILES[@]}"; do
  # the previous release's image override is replaced by ours; every other overlay (prod, bsuid-vars, ...) is kept as is
  case "$f" in */new-image-override.yml) continue ;; esac
  [ -f "$f" ] || die "compose file from labels not found: $f"
  COMPOSE_ARGS+=(-f "$f")
done
IMAGE_OVERRIDE="$STATE_DIR/$TS-image-override.yml"
log "live=$OLD  image(old)=$(docker inspect -f '{{.Config.Image}}' "$OLD")  ->  image(new)=$IMAGE"
log "compose overlays kept: ${#COMPOSE_ARGS[@]} files; project dir $PROJECT_DIR"
log "plan: start $CAND (private alias) -> ready x$READY_PASSES -> DNS check -> alias $PUBLIC_ALIAS on candidate -> both serve ${DRAIN_SECONDS}s -> SIGTERM $OLD (grace ${STOP_GRACE}s, kept stopped) -> rename"

cleanup_candidate() {
  log "removing candidate $CAND (old container untouched)"
  docker rm -f "$CAND" >/dev/null 2>&1 || true
  docker compose -p "wacrm-cand-$TS" down --remove-orphans >/dev/null 2>&1 || true
}

if [ "$EXECUTE" != "1" ]; then
  log "DRY-RUN complete: nothing was changed. Re-run with --execute to deploy."
  exit 0
fi

mkdir -p "$STATE_DIR"
cat >"$IMAGE_OVERRIDE" <<YML
services:
  app:
    image: $IMAGE
YML
{
  echo "TS=$TS"; echo "OLD_NAME=$OLD"; echo "OLD_IMAGE=$(docker inspect -f '{{.Config.Image}}' "$OLD")"; echo "OLD_IMAGE_ID=$(docker inspect -f '{{.Image}}' "$OLD")"
  echo "NEW_IMAGE=$IMAGE"; echo "CAND=$CAND"
} >"$STATE_DIR/$TS.env"
cp "$STATE_DIR/$TS.env" "$STATE_DIR/last.env"

log "1/7 starting candidate $CAND"
( cd "$PROJECT_DIR" && CAND_NAME="$CAND" docker compose -p "wacrm-cand-$TS" "${COMPOSE_ARGS[@]}" -f "$IMAGE_OVERRIDE" -f "$DIR/candidate.override.yml" up -d --no-build --no-deps app ) || { cleanup_candidate; die "candidate failed to start"; }

log "2/7 readiness gate ($READY_PASSES consecutive 200s on $READY_PATH, timeout ${READY_TIMEOUT}s)"
wait_ready "$CAND" || { docker logs --tail 30 "$CAND" 2>&1 | sed -E 's/(eyJ[A-Za-z0-9_.-]{20,}|sk-[A-Za-z0-9]{10,})/<redacted>/g' | tail -30; cleanup_candidate; die "candidate never became ready; old container still serving"; }

log "3/7 DNS: the candidate resolves by its private alias, and the public alias still points only at the old container"
CAND_IP="$(container_ip "$CAND")"; OLD_IP="$(container_ip "$OLD")"
[ -n "$CAND_IP" ] && [ -n "$OLD_IP" ] || { cleanup_candidate; die "could not read container IPs on $EDGE_NETWORK"; }
[ "$(resolve_from_edge "$IMAGE" "$CAND")" = "$CAND_IP" ] || { cleanup_candidate; die "private alias does not resolve to the candidate"; }
[ "$(resolve_from_edge "$IMAGE" "$PUBLIC_ALIAS")" = "$OLD_IP" ] || { cleanup_candidate; die "public alias does not resolve to the old container only (unexpected topology)"; }

log "4/7 adding the public alias to the candidate: both containers now serve $PUBLIC_ALIAS"
# The candidate is already on the edge network with its private alias: re-attach it with both aliases (it is not public yet, so this is invisible).
docker network disconnect "$EDGE_NETWORK" "$CAND" && docker network connect --alias "$CAND" --alias "$PUBLIC_ALIAS" "$EDGE_NETWORK" "$CAND" || { cleanup_candidate; die "could not add the public alias"; }
GOT="$(resolve_from_edge "$IMAGE" "$PUBLIC_ALIAS" | tr '\n' ' ')"
case "$GOT" in *"$CAND_IP"*"$OLD_IP"*|*"$OLD_IP"*"$CAND_IP"*) log "alias resolves to both: $GOT" ;; *) log "WARN alias resolution after connect: '$GOT' (expected both $OLD_IP and $CAND_IP)" ;; esac
[ "$(ready_status "$CAND")" = "200" ] || { docker network disconnect "$EDGE_NETWORK" "$CAND" >/dev/null 2>&1 || true; cleanup_candidate; die "candidate stopped being ready after taking traffic; rolled back to old only"; }

log "5/7 both containers serve for ${DRAIN_SECONDS}s while both are checked (the old one is NOT disconnected from the network: that would cut its in-flight requests)"
for _ in $(seq 1 $((DRAIN_SECONDS/3 > 0 ? DRAIN_SECONDS/3 : 1))); do
  sleep 3
  [ "$(ready_status "$CAND")" = "200" ] || { log "candidate lost readiness while serving: stopping it, old keeps serving"; docker stop -t "$STOP_GRACE" "$CAND" >/dev/null 2>&1 || true; cleanup_candidate; die "candidate unhealthy under traffic; rolled back to old only"; }
done

log "6/7 SIGTERM to the old container (grace ${STOP_GRACE}s): it stops accepting, finishes in-flight requests and pending after() callbacks, then exits. Kept for rollback, not removed."
docker stop -t "$STOP_GRACE" "$OLD" >/dev/null
[ "$(docker inspect -f '{{.State.ExitCode}}' "$OLD")" = "0" ] || log "WARN old container exit code $(docker inspect -f '{{.State.ExitCode}}' "$OLD") (137 = killed after the grace window: raise STOP_GRACE)"
GOT="$(resolve_from_edge "$IMAGE" "$PUBLIC_ALIAS")"
[ "$GOT" = "$CAND_IP" ] || log "WARN public alias resolves to '$GOT', expected only $CAND_IP"

log "7/7 swapping names so the host crons (docker exec $LIVE_NAME) hit the new container"
docker rename "$OLD" "${OLD}-prev-$TS"
docker rename "$CAND" "$LIVE_NAME"
echo "PREV_NAME=${OLD}-prev-$TS" >>"$STATE_DIR/last.env"; echo "PREV_NAME=${OLD}-prev-$TS" >>"$STATE_DIR/$TS.env"
log "done. live=$LIVE_NAME image=$IMAGE. Previous container kept stopped as ${OLD}-prev-$TS. Verify: ops/deploy/verify-no-502.sh; roll back: ops/deploy/rollback.sh"
