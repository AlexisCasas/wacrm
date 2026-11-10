#!/usr/bin/env bash
# Shared helpers for the zero-downtime WACRM deploy. Sourced, never executed. No secrets are read or printed.
set -euo pipefail

: "${LIVE_NAME:=wacrm-app-1}"          # the container the host crons `docker exec` into (/usr/local/bin/wacrm-*cron.sh)
: "${EDGE_NETWORK:=edge_proxy}"        # network shared with the reverse proxy (Caddy)
: "${PUBLIC_ALIAS:=wacrm-app}"         # the upstream name Caddy resolves: reverse_proxy wacrm-app:3000
: "${APP_PORT:=3000}"
: "${READY_PATH:=/api/health/ready}"
: "${DRAIN_SECONDS:=15}"               # keep-alive connections to the old container settle before it is stopped
: "${STOP_GRACE:=40}"                  # SIGTERM -> SIGKILL window: Next finishes in-flight requests and pending after() callbacks
: "${READY_PASSES:=3}"                 # consecutive readiness passes required
: "${READY_TIMEOUT:=150}"              # seconds to wait for the candidate
: "${STATE_DIR:=/opt/backups/wacrm/deploy-state}"
: "${LOCK_FILE:=/var/lock/wacrm-deploy.lock}"

log()  { printf '%s [deploy] %s\n' "$(date -u +%FT%TZ)" "$*"; }
die()  { log "ABORT: $*"; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing command: $1"; }

# EXECUTE=1 mutates; anything else prints what would happen. Mutating commands go through `run`.
run() { if [ "${EXECUTE:-0}" = "1" ]; then "$@"; else log "DRY-RUN: $*"; fi; }

container_exists()  { docker inspect "$1" >/dev/null 2>&1; }
container_running() { [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null || echo false)" = "true" ]; }
container_ip()      { docker inspect -f "{{(index .NetworkSettings.Networks \"$EDGE_NETWORK\").IPAddress}}" "$1" 2>/dev/null; }

# Fetch READY_PATH from INSIDE a container (no published port is needed). Prints the HTTP status, or 000.
ready_status() {
  docker exec "$1" node -e "
    const c=new AbortController(); setTimeout(()=>c.abort(),4000);
    fetch('http://127.0.0.1:${APP_PORT}${READY_PATH}',{signal:c.signal}).then(r=>{console.log(r.status)}).catch(()=>console.log('000'))" 2>/dev/null || echo 000
}

# All addresses a throwaway container on the edge network gets for NAME (what Caddy's dialer would get). One IP per line, sorted.
resolve_from_edge() {
  docker run --rm --network "$EDGE_NETWORK" --entrypoint node "$1" -e "
    require('dns').promises.lookup('$2',{all:true,family:4}).then(r=>console.log(r.map(a=>a.address).sort().join('\n'))).catch(()=>{})" 2>/dev/null
}

wait_ready() {  # $1 container
  local passes=0 waited=0
  while [ "$waited" -lt "$READY_TIMEOUT" ]; do
    if container_running "$1" && [ "$(ready_status "$1")" = "200" ]; then passes=$((passes+1)); else passes=0; fi
    [ "$passes" -ge "$READY_PASSES" ] && return 0
    sleep 2; waited=$((waited+2))
  done
  return 1
}
