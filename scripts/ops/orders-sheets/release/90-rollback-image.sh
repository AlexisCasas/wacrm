#!/usr/bin/env bash
# Rolls the app back to $OLD_IMAGE (the image running before this deploy; see lib.sh / release.conf). If the 04:13 UTC prune removed it, it is
# reloaded from the verified docker-save archive first. NO database change is involved or needed: the old code ignores the new functions and
# behaves exactly as before with the migration applied (verified). Requires CONFIRM=yes. Does not touch any switch of any account.
. "$(dirname "$0")/lib.sh"; need_confirm
if ! docker image inspect $OLD_IMAGE >/dev/null 2>&1; then
  log "old image missing: docker load from archive"
  (cd $D/image && sha256sum -c SHA256SUMS --quiet) || { echo "archive checksum FAILED"; exit 1; }
  gunzip -c $OLD_IMAGE_TAR | docker load
fi
[ "$(docker image inspect $OLD_IMAGE --format '{{.Id}}')" = "$OLD_IMAGE_ID" ] || { echo "old image id mismatch"; exit 1; }
printf 'services:\n  app:\n    image: %s\n' "$OLD_IMAGE" > $D/rollback-image-override.yml
log "rollback -> $OLD_IMAGE"
cd /opt/apps/wacrm && docker compose $COMPOSE_BASE -f $D/rollback-image-override.yml up -d --no-deps --no-build app 2>&1 | grep -v 'variable is not set' | tee -a $D/deploy.log
for i in $(seq 1 30); do s=$(docker inspect wacrm-app-1 --format '{{.State.Health.Status}}'); [ "$s" = healthy ] && break; sleep 5; done
log "after rollback: $(docker inspect wacrm-app-1 --format '{{.Config.Image}} {{.State.Health.Status}}')"
echo "Rollback of the IMAGE only. The Sheets tables/functions and the 3 env variables stay (inert: the old image never reads them). 95-disable-export.sh stops the exporter; sql/91-drop-sheet-objects.sql ONLY if explicitly decided."
