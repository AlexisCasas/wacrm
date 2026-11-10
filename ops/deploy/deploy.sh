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
# This tag is persisted in a sourced rollback manifest: forbid shell metacharacters.
[[ "$IMAGE" =~ ^[a-zA-Z0-9][a-zA-Z0-9._:/@-]*$ ]] || die "unsafe Docker image reference"
# The candidate is built from this release and must provide the DB-backed readiness route.
# The home page redirects to dashboard/login and could return 200 with the DB unavailable.
[ "$READY_PATH" = "/api/health/ready" ] || die "READY_PATH is not a database readiness gate; use exactly /api/health/ready for the candidate"
need docker; need flock
export EXECUTE

exec 9>"$LOCK_FILE"; flock -n 9 || die "another deploy is running ($LOCK_FILE)"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
# Docker Compose project names are lowercase, even though Docker container names
# themselves may contain uppercase timestamp separators.
COMPOSE_PROJECT="wacrm-cand-${TS,,}"
CAND="wacrm-app-cand-$TS"
OLD="$LIVE_NAME"
container_running "$OLD" || die "live container $OLD is not running: this script only does zero-downtime swaps; use the normal procedure to start from nothing"
docker image inspect "$IMAGE" >/dev/null 2>&1 || die "image $IMAGE is not loaded on this host"
[ "$(docker image inspect -f '{{.Id}}' "$IMAGE")" != "$(docker inspect -f '{{.Image}}' "$OLD")" ] || die "$IMAGE is already the running image"
docker network inspect "$EDGE_NETWORK" >/dev/null 2>&1 || die "network $EDGE_NETWORK not found"
# A deploy is not safe if there is no database-backed rollback readiness
# for the previous image. The first rollout uses a read-only REST fallback.
[ "$(rollback_ready_status "$OLD")" = "200" ] ||
  die "old image has no working DB-backed rollback readiness: first deploy blocked"
# The base Compose file publishes HOST_PORT:3000. Two instances cannot bind the
# same host port, and the new candidate deliberately has no host publication.
# Do not silently retire an endpoint consumed by other host-side integrations.
PUBLISHED_PORTS="$(docker port "$OLD" 2>/dev/null || true)"
if [ -n "$PUBLISHED_PORTS" ]; then
  log "HOST PORT IMPACT: $OLD currently publishes: $PUBLISHED_PORTS"
  [ "${ALLOW_DROP_HOST_PORTS:-0}" = "1" ] ||
    die "candidate uses edge_proxy only and would remove the host-published port after cutover. Verify every host-port client and explicitly set ALLOW_DROP_HOST_PORTS=1 only when approved"
fi

# The live container's own compose definition: same files, same project working dir.
PROJECT_DIR="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$OLD")"
FILES_LABEL="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$OLD")"
[ -d "$PROJECT_DIR" ] && [ -n "$FILES_LABEL" ] || die "cannot read the live compose definition from $OLD labels"
COMPOSE_ARGS=()
IFS=',' read -r -a FILES <<<"$FILES_LABEL"
for f in "${FILES[@]}"; do
  # the previous release's image override is replaced by ours; every other overlay (prod, bsuid-vars, ...) is kept as is
  # When our previous candidate became the live container, its Compose labels
  # include our old generated image override and candidate overlay. Never
  # accumulate those overlays: exactly one of each belongs to this release.
  case "$f" in
    */new-image-override.yml|"$STATE_DIR"/*-image-override.yml|"$DIR/candidate.override.yml") continue ;;
  esac
  [ -f "$f" ] || die "compose file from labels not found: $f"
  COMPOSE_ARGS+=(-f "$f")
done
# Validate the live overlays and support for Compose !override BEFORE changing
# state. This requires Docker Compose >= 2.24.4.
( cd "$PROJECT_DIR" && CAND_NAME="$CAND" docker compose -p "$COMPOSE_PROJECT" "${COMPOSE_ARGS[@]}" -f "$DIR/candidate.override.yml" config -q ) ||
  die "candidate Compose overlay invalid, or Docker Compose too old for !override"
IMAGE_OVERRIDE="$STATE_DIR/$TS-image-override.yml"
log "live=$OLD  image(old)=$(docker inspect -f '{{.Config.Image}}' "$OLD")  ->  image(new)=$IMAGE"
log "compose overlays kept: ${#COMPOSE_ARGS[@]} files; project dir $PROJECT_DIR"
log "plan: start $CAND (private alias) -> ready x$READY_PASSES -> DNS check -> alias $PUBLIC_ALIAS on candidate -> both serve ${DRAIN_SECONDS}s -> SIGTERM $OLD (grace ${STOP_GRACE}s, kept stopped) -> rename"

cleanup_candidate() {
  log "removing candidate $CAND (old container untouched)"
  docker rm -f "$CAND" >/dev/null 2>&1 || true
  ( cd "$PROJECT_DIR" && CAND_NAME="$CAND" docker compose -p "$COMPOSE_PROJECT" "${COMPOSE_ARGS[@]}" -f "$IMAGE_OVERRIDE" -f "$DIR/candidate.override.yml" down --remove-orphans ) >/dev/null 2>&1 || true
}

if [ "$EXECUTE" != "1" ]; then
  log "DRY-RUN complete: nothing was changed. Re-run with --execute to deploy."
  exit 0
fi

# Gate against the REAL Docker Engine before touching the live container.
# Tests force-disconnect/reconnect of an isolated stopped node container and
# confirms public DNS does not expose it after restart.
bash "$DIR/lab-private-rollback.sh" "$IMAGE" ||
  die "this Docker Engine cannot safely park a stopped image; no live change"

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

# Validate the *final* composed candidate after generating its image override.
( cd "$PROJECT_DIR" && CAND_NAME="$CAND" docker compose -p "$COMPOSE_PROJECT" "${COMPOSE_ARGS[@]}" -f "$IMAGE_OVERRIDE" -f "$DIR/candidate.override.yml" config -q ) ||
  { cleanup_candidate; die "final candidate Compose configuration invalid"; }

log "1/7 starting candidate $CAND"
( cd "$PROJECT_DIR" && CAND_NAME="$CAND" docker compose -p "$COMPOSE_PROJECT" "${COMPOSE_ARGS[@]}" -f "$IMAGE_OVERRIDE" -f "$DIR/candidate.override.yml" up -d --no-build --no-deps app ) || { cleanup_candidate; die "candidate failed to start"; }

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
# Disconnect/reconnect can assign the candidate a *different* IP.
CAND_IP="$(container_ip "$CAND")"
GOT="$(resolve_from_edge "$IMAGE" "$PUBLIC_ALIAS")"
if ! { grep -Fxq "$CAND_IP" <<<"$GOT" && grep -Fxq "$OLD_IP" <<<"$GOT"; }; then
  cleanup_candidate
  die "public alias does not resolve to BOTH old and candidate; traffic was not switched"
fi
log "alias resolves to both containers"
[ "$(ready_status "$CAND")" = "200" ] || { docker network disconnect "$EDGE_NETWORK" "$CAND" >/dev/null 2>&1 || true; cleanup_candidate; die "candidate stopped being ready after taking traffic; rolled back to old only"; }

log "5/7 both containers serve for ${DRAIN_SECONDS}s while both are checked (the old one is NOT disconnected from the network: that would cut its in-flight requests)"
for _ in $(seq 1 $((DRAIN_SECONDS/3 > 0 ? DRAIN_SECONDS/3 : 1))); do
  sleep 3
  [ "$(ready_status "$CAND")" = "200" ] || { log "candidate lost readiness while serving: stopping it, old keeps serving"; docker stop -t "$STOP_GRACE" "$CAND" >/dev/null 2>&1 || true; cleanup_candidate; die "candidate unhealthy under traffic; rolled back to old only"; }
done

log "6/7 swapping names WHILE both are healthy and running so cron's live name never points to a stopped process"
PREV_NAME="${OLD}-prev-$TS"
SWAP_RESULT=0
swap_running_live_name "$PREV_NAME" "$CAND" "$LIVE_NAME" || SWAP_RESULT=$?
if [ "$SWAP_RESULT" != "0" ]; then
  if [ "$SWAP_RESULT" = "1" ] || [ "$SWAP_RESULT" = "2" ]; then
    # The old image still owns LIVE_NAME and is running; remove candidate only
    # after its graceful stop. No rollback manifest was published.
    log "ABORT: name handoff failed, original live container recovered (code=$SWAP_RESULT)"
    docker stop -t "$STOP_GRACE" "$CAND" >/dev/null 2>&1 || true
    cleanup_candidate
    die "name handoff failed safely; old image remains live; inspect Docker before retry"
  fi
  die "CRITICAL: ambiguous Docker rename or precondition failure (code=$SWAP_RESULT); both containers preserved for manual repair; DO NOT retry"
fi
# Candidate is now wacrm-app-1, still RUNNING and DB-ready.
[ "$(ready_status "$LIVE_NAME")" = "200" ] ||
  die "CRITICAL: candidate lost readiness after name swap; old running as $PREV_NAME; manual intervention required"

log "7/7 SIGTERM to previous container (grace ${STOP_GRACE}s); candidate remains running under live cron name"
docker stop -t "$STOP_GRACE" "$PREV_NAME" >/dev/null ||
  die "CRITICAL: previous container did not stop cleanly; candidate stays live; manual inspection required"
[ "$(docker inspect -f '{{.State.ExitCode}}' "$PREV_NAME")" = "0" ] ||
  log "WARN previous container exit code $(docker inspect -f '{{.State.ExitCode}}' "$PREV_NAME") (137 = grace exceeded)"
PARK_OK=1
if ! park_stopped_previous "$PREV_NAME" "$PREV_NAME"; then
  PARK_OK=0
  log "CRITICAL: previous image could not be parked privately; automatic rollback disabled. Candidate serves traffic."
fi
# Only the current RUNNING candidate should be reachable by public alias.
LIVE_IP="$(container_ip "$LIVE_NAME")"
GOT="$(resolve_from_edge "$IMAGE" "$PUBLIC_ALIAS")"
[ "$GOT" = "$LIVE_IP" ] ||
  log "WARN public alias resolved to '$GOT', expected only active candidate (verify DNS before rollout)"

if [ "$PARK_OK" = "1" ]; then
  echo "PREV_NAME=$PREV_NAME" >>"$STATE_DIR/$TS.env"
else
  echo "ROLLBACK_DISABLED=1" >>"$STATE_DIR/$TS.env"
fi
cp "$STATE_DIR/$TS.env" "$STATE_DIR/.last.env.tmp-$TS"
mv -f "$STATE_DIR/.last.env.tmp-$TS" "$STATE_DIR/last.env"
if [ "$PARK_OK" != "1" ]; then
  die "cutover serving new image, but rollback is DISABLED; do not run rollback.sh or retry deployment until manual repair"
fi
log "done. live=$LIVE_NAME image=$IMAGE. Previous container parked privately and stopped as $PREV_NAME. Verify: ops/deploy/verify-no-502.sh; rollback via ops/deploy/rollback.sh"
