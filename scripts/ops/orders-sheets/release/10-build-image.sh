#!/usr/bin/env bash
# Builds wacrm-app:sheets-keyler-<sha8> from the EXACT candidate commit in a throw-away worktree. Does not touch /opt/apps/wacrm, the running container,
# the database or any other image. The image is labelled with the commit AND its git TREE; 40-gate-image.sh requires main's tree (after PR #82 and the
# dashboard branch are merged) to be identical to the label, otherwise the image is not what was integrated and must be rebuilt.
#   ./10-build-image.sh <candidate-commit>
. "$(dirname "$0")/lib.sh"
C=${1:?usage: 10-build-image.sh <candidate-commit>}; SHA=$(git -C $REPO rev-parse "$C^{commit}") || exit 1; TREE=$(tree_of $SHA)
echo $SHA > $D/CANDIDATE.sha; echo $TREE > $D/CANDIDATE.tree; . "$(dirname "$0")/lib.sh"
[ -d $WT ] || git -C $REPO worktree add --detach $WT $SHA
[ "$(git -C $WT rev-parse HEAD)" = "$SHA" ] && [ -z "$(git -C $WT status --porcelain)" ] || { echo "worktree not clean at $SHA"; exit 1; }
cat > $D/build-override.yml <<EOT
services:
  app:
    env_file: !reset []
    build:
      context: $WT
      labels:
        org.opencontainers.image.revision: "$SHA"
        org.opencontainers.image.source: "https://github.com/AlexisCasas/wacrm"
        io.wacrm.source-tree: "$TREE"
        io.wacrm.release: "keyler-sheets (PR #82 + meta-pricing dashboard + PR #81 code)"
EOT
log "build start $SHA tree $TREE"
docker compose -p wacrm-build --project-directory $WT --env-file $ENV_FILE -f $WT/docker-compose.yml -f $D/build-override.yml build app > $D/build.log 2>&1; rc=$?
[ $rc -eq 0 ] || { log "build FAILED rc=$rc (see build.log)"; exit $rc; }
docker tag wacrm-build-app $NEW_IMAGE
docker image inspect $NEW_IMAGE --format '{{.Id}}' > $D/NEW_IMAGE_ID
docker image inspect $NEW_IMAGE --format 'id={{.Id}} revision={{index .Config.Labels "org.opencontainers.image.revision"}} tree={{index .Config.Labels "io.wacrm.source-tree"}}' | tee -a $D/deploy.log
mkdir -p $D/image; docker save $NEW_IMAGE | gzip -6 > $D/image/wacrm-app_sheets-keyler-$S8.tar.gz; (cd $D/image && sha256sum *.tar.gz > SHA256SUMS)
log "build OK -> $NEW_IMAGE (a safety archive was saved; the 04:13 UTC prune removes UNUSED images older than 24 h)"
