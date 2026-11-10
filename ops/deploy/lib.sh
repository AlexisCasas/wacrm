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

# The previous image MUST restart without the public Caddy alias. Docker
# reconnects stopped containers to their saved networks upon docker start.
# Reconfigure its endpoint only AFTER the old process has gracefully stopped.
network_aliases_json() {
  docker inspect -f "{{json (index .NetworkSettings.Networks \"$EDGE_NETWORK\").Aliases}}" "$1" 2>/dev/null
}
is_private_rollback_container() {
  local aliases
  aliases="$(network_aliases_json "$1")" || return 1
  [ -n "$aliases" ] && [ "$aliases" != "null" ] || return 1
  ! grep -Fq "\"$PUBLIC_ALIAS\"" <<<"$aliases"
}
park_stopped_previous() {  # $1 stopped container, $2 private alias
  local container="$1" private="$2"
  ! container_running "$container" || return 1
  # --force supports stopped endpoint removal on the tested Docker Engine.
  # Gate its behavior on the VPS through disposable lab-private-rollback.sh.
  docker network disconnect -f "$EDGE_NETWORK" "$container" || return 1
  docker network connect --alias "$private" "$EDGE_NETWORK" "$container" || return 1
  is_private_rollback_container "$container" || return 1
}
retry_rename() {  # $1 old name, $2 new name
  local try_idx
  for try_idx in 1 2 3; do
    docker rename "$1" "$2" && return 0
    sleep 1
  done
  return 1
}

# Fetch READY_PATH from INSIDE a container (no published port is needed). Prints the HTTP status, or 000.
ready_status() {
  docker exec "$1" node -e "
    const c=new AbortController();const t=setTimeout(()=>c.abort(),4000);
    fetch('http://127.0.0.1:${APP_PORT}${READY_PATH}',{signal:c.signal})
      .then(r=>{clearTimeout(t);console.log(r.status)})
      .catch(()=>{clearTimeout(t);console.log('000')})" 2>/dev/null || echo 000
}

# All addresses a throwaway container on the edge network gets for NAME (what Caddy's dialer would get). One IP per line, sorted.
resolve_from_edge() {
  docker run --rm --network "$EDGE_NETWORK" --entrypoint node "$1" -e "
    require('dns').promises.lookup('$2',{all:true,family:4}).then(r=>console.log(r.map(a=>a.address).sort().join('\n'))).catch(()=>{})" 2>/dev/null
}

# Fallback for the first rollback: the old image predates /api/health/ready.
# Query the SAME accounts REST endpoint with the service-role credentials
# already present inside that container. Neither tokens nor data are printed.
# A login redirect/home-page HTTP 200 is deliberately NOT accepted as DB health.
legacy_db_ready_status() {
  docker exec "$1" node -e '
    const base=process.env.NEXT_PUBLIC_SUPABASE_URL;
    const token=process.env.SUPABASE_SERVICE_ROLE_KEY;
    if(!base||!token){console.log("503");process.exit(0)}
    const ctrl=new AbortController();const timer=setTimeout(()=>ctrl.abort(),3000);
    const url=base.replace(/\/$/,"")+"/rest/v1/accounts?select=id&limit=1";
    fetch(url,{headers:{apikey:token,Authorization:"Bearer "+token},signal:ctrl.signal})
      .then(res=>{clearTimeout(timer);console.log(res.status===200?"200":"503")})
      .catch(()=>{clearTimeout(timer);console.log("000")});
  ' 2>/dev/null || echo 000
}
rollback_ready_status() {
  local status
  status="$(ready_status "$1")"
  if [ "$status" = "200" ]; then echo 200; else legacy_db_ready_status "$1"; fi
}
wait_ready() {  # $1 container, optional $2 probe function
  local passes=0 waited=0 probe="${2:-ready_status}"
  while [ "$waited" -lt "$READY_TIMEOUT" ]; do
    if container_running "$1" && [ "$("$probe" "$1")" = "200" ]; then passes=$((passes+1)); else passes=0; fi
    [ "$passes" -ge "$READY_PASSES" ] && return 0
    sleep 2; waited=$((waited+2))
  done
  return 1
}
