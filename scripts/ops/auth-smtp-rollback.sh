#!/usr/bin/env bash
# Restores the .env saved by auth-smtp-apply.sh and recreates ONLY the auth service. Same overrides as the apply script.
set -euo pipefail
STACK_DIR="${STACK_DIR:-/opt/apps/supabase}"
COMPOSE_FILES="${COMPOSE_FILES:-docker-compose.yml:docker-compose.edge-proxy.yml}"
AUTH_SERVICE="${AUTH_SERVICE:-auth}"; AUTH_CONTAINER="${AUTH_CONTAINER:-supabase-auth}"
cd "$STACK_DIR"; umask 077
BACKUP="${1:-$(cat "$STACK_DIR/.smtp-last-backup")}"; [ -f "$BACKUP" ] || { echo "ERROR: backup $BACKUP not found"; exit 1; }
FILES=(); IFS=: read -ra CF <<< "$COMPOSE_FILES"; for f in "${CF[@]}"; do FILES+=(-f "$f"); done
cp -p "$BACKUP" "$STACK_DIR/.env"; chmod 600 "$STACK_DIR/.env"
docker compose "${FILES[@]}" up -d --no-deps --force-recreate "$AUTH_SERVICE"
for _ in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$AUTH_CONTAINER" 2>/dev/null)" = healthy ] && { echo "Rolled back from $BACKUP; $AUTH_CONTAINER healthy"; exit 0; }; sleep 2; done
echo "Rolled back but $AUTH_CONTAINER is not healthy yet - check: docker logs $AUTH_CONTAINER"; exit 1
