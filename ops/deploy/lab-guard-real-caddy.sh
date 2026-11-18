#!/usr/bin/env bash
# CI-only integration test: the REAL guard-public-proxy.sh (and the real deploy.sh preflight) against a REAL Caddy and
# Docker's REAL DNS, inside a disposable network, with a dummy app and a throw-away Caddyfile. It reproduces the class of
# outage where Caddy keeps dialing an upstream name that Docker no longer publishes.
#
#   bash ops/deploy/lab-guard-real-caddy.sh [app-image] [caddy-image]      (default node:20-alpine caddy:2-alpine)
#
# It creates ONLY objects named qa-guard-<run>-* (one network, two containers) and removes them on exit. It refuses to
# run outside GitHub Actions so nobody points it at a production host by accident (override: WACRM_LAB_ALLOW_LOCAL=1,
# only on a disposable Docker daemon).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_IMAGE="${1:-node:20-alpine}"
CADDY_IMAGE="${2:-caddy:2-alpine}"
[ "${GITHUB_ACTIONS:-}" = "true" ] || [ "${WACRM_LAB_ALLOW_LOCAL:-}" = "1" ] ||
  { echo "REFUSED: this lab only runs inside GitHub Actions (ephemeral runner)" >&2; exit 2; }

RUN="qa-guard-$RANDOM-$(date +%s)"
NET="$RUN-net"; APP="$RUN-app"; PROXY="$RUN-caddy"; ALIAS="$RUN-public"; OTHER="$RUN-unpublished"
SITE="wacrm-guard.test"
TMP="$(mktemp -d)"
cleanup() {
  docker rm -f "$APP" "$PROXY" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf -- "$TMP"
}
trap cleanup EXIT
fail() { printf 'OPS LAB FAIL: %s\n' "$*" >&2; exit 1; }
pass() { printf 'PASS: %s\n' "$*"; }
wait_for() { local n=0; until "$@" >/dev/null 2>&1; do n=$((n + 1)); [ "$n" -lt 40 ] || return 1; sleep 1; done; }

# Caddy's HTTPS listener is published on the runner loopback because the guard checks https://<host>/login on 127.0.0.1:443.
if ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq '(^|:)443$'; then fail "port 443 is already in use on this runner"; fi

# (Re)create the dummy app. "without" reproduces the incident: the container is recreated and the alias Caddy dials is absent.
start_app() {  # $1 = with | without the public network alias
  local -a alias_args=()
  [ "$1" != "with" ] || alias_args=(--network-alias "$ALIAS")
  docker rm -f "$APP" >/dev/null 2>&1 || true
  docker run -d --name "$APP" --network "$NET" ${alias_args[@]+"${alias_args[@]}"} --entrypoint node "$APP_IMAGE" \
    -e 'require("http").createServer((q,r)=>{r.writeHead(200);r.end("ok")}).listen(3000,"0.0.0.0")' >/dev/null
}
write_caddyfile() {  # $1 = upstream name Caddy will dial
  cat >"$TMP/Caddyfile" <<EOF
{
	skip_install_trust
}

$SITE {
	tls internal
	reverse_proxy $1:3000
}
EOF
}
apply_caddyfile() {
  docker cp "$TMP/Caddyfile" "$PROXY:/etc/caddy/Caddyfile"
  docker exec "$PROXY" caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1
}
https_code() {  # status of https://$SITE/login through the REAL Caddy, trusting only this lab's local CA
  CURL_CA_BUNDLE="$TMP/root.crt" curl --noproxy '*' -s -o /dev/null -w '%{http_code}' --max-time 8 \
    --resolve "$SITE:443:127.0.0.1" "https://$SITE/login" || true
}
wait_https() { local want="$1" n=0; until [ "$(https_code)" = "$want" ]; do n=$((n + 1)); [ "$n" -lt 20 ] || return 1; sleep 1; done; }
diag() {   # lab containers only: state, aliases on the lab network, HTTP code through Caddy, tail of Caddy's log
  {
    echo "--- diagnostics (lab containers only) ---"
    docker inspect -f 'app state={{.State.Status}} running={{.State.Running}} restarts={{.RestartCount}}' "$APP" 2>&1 || true
    docker inspect -f 'app aliases on lab network: {{json (index .NetworkSettings.Networks "'"$NET"'").Aliases}}' "$APP" 2>&1 || true
    echo "https code through Caddy: $(https_code)"
    docker logs --tail 5 "$PROXY" 2>&1 | cut -c1-220 || true
    echo "--- end diagnostics ---"
  } >&2
}
lab_env() {
  EDGE_NETWORK="$NET" PROXY_CONTAINER="$PROXY" PUBLIC_ALIAS="$ALIAS" WACRM_PUBLIC_HOST="$SITE" CURL_CA_BUNDLE="$TMP/root.crt" "$@"
}
run_guard() {   # the REAL guard, unmodified
  set +e; G_OUT="$(lab_env env bash "$HERE/guard-public-proxy.sh" "$APP" 2>&1)"; G_RC=$?; set -e
}
run_deploy_preflight() {   # the REAL deploy.sh (dry-run, no --execute): it must stop at the proxy gate, before any mutation
  CONTAINERS_BEFORE="$(docker ps -a --format '{{.Names}}' | sort)"
  set +e
  D_OUT="$(lab_env env LIVE_NAME="$APP" LOCK_FILE="$TMP/deploy.lock" STATE_DIR="$TMP/state" bash "$HERE/deploy.sh" "$APP_IMAGE" 2>&1)"; D_RC=$?
  set -e
  [ "$(docker ps -a --format '{{.Names}}' | sort)" = "$CONTAINERS_BEFORE" ] || fail "deploy.sh preflight changed the set of containers"
}

docker network create "$NET" >/dev/null
start_app with
write_caddyfile "$ALIAS"
docker create --name "$PROXY" --network "$NET" -p 127.0.0.1:443:443 "$CADDY_IMAGE" >/dev/null
docker cp "$TMP/Caddyfile" "$PROXY:/etc/caddy/Caddyfile"
docker start "$PROXY" >/dev/null
echo "real Caddy: $(docker exec "$PROXY" caddy version | cut -c1-60)"
wait_for docker exec "$PROXY" wget -q -T 2 -O /dev/null "http://$ALIAS:3000/login" || { diag; fail "Caddy never reached the dummy app by its alias"; }
wait_for docker cp "$PROXY:/data/caddy/pki/authorities/local/root.crt" "$TMP/root.crt" || fail "Caddy never produced its local CA"
wait_https 200 || { diag; fail "healthy route: HTTPS through Caddy never returned 200 (got $(https_code))"; }

# 1. Healthy route: Caddy dials the alias the app publishes.
run_guard
[ "$G_RC" = 0 ] || fail "1 healthy: guard rc=$G_RC: $G_OUT"
grep -q 'CADDY_UPSTREAM_CONTRACT=PASS' <<<"$G_OUT" && grep -q 'WACRM_PUBLIC_ROUTE=PASS' <<<"$G_OUT" || fail "1 healthy: missing PASS lines: $G_OUT"
pass "1 healthy route: guard PASS against real Caddy ($ALIAS:3000)"

# 2. Lost alias (the incident): the app container is RECREATED without the alias Caddy dials. It is up and healthy by its
#    container name, but Docker no longer publishes the upstream name.
start_app without
wait_for docker exec "$PROXY" wget -q -T 2 -O /dev/null "http://$APP:3000/login" || { diag; fail "2 lost alias: the recreated app should be healthy by container name"; }
wait_https 502 || { diag; fail "2 lost alias: real Caddy should answer 502 (got $(https_code)); the scenario is not reproducing the incident"; }
run_guard
[ "$G_RC" != 0 ] || fail "2 lost alias: guard passed although Caddy answers 502: $G_OUT"
grep -q 'LIVE_PUBLIC_ALIAS_MISSING' <<<"$G_OUT" || fail "2 lost alias: expected LIVE_PUBLIC_ALIAS_MISSING, got: $G_OUT"
! grep -q 'WACRM_PUBLIC_ROUTE=PASS' <<<"$G_OUT" || fail "2 lost alias: false PASS"
run_deploy_preflight
[ "$D_RC" != 0 ] && grep -q 'NO-GO' <<<"$D_OUT" || fail "2 lost alias: deploy.sh must stop with NO-GO (rc=$D_RC): $D_OUT"
pass "2 lost alias: real Caddy answers 502 while the app is healthy; guard FAIL (LIVE_PUBLIC_ALIAS_MISSING); deploy.sh NO-GO before any mutation"

# 2b. Recovery from the lost alias alone (what a correct rollback restores).
start_app with
wait_for docker exec "$PROXY" wget -q -T 2 -O /dev/null "http://$ALIAS:3000/login" || { diag; fail "2b recovery: Caddy cannot reach the recreated app by its alias"; }
wait_https 200 || { diag; fail "2b recovery: Caddy did not reach the app again (got $(https_code))"; }
run_guard
[ "$G_RC" = 0 ] || fail "2b recovery: guard should PASS after the alias is restored: $G_OUT"
pass "2b alias restored: Caddy reaches the app again and the guard is back to PASS"

# 3. Mismatch: Caddy dials a name that the deployment does not publish.
write_caddyfile "$OTHER"; apply_caddyfile
wait_https 502 || { diag; fail "3 mismatch: real Caddy should answer 502 for an unpublished upstream (got $(https_code))"; }
run_guard
[ "$G_RC" != 0 ] || fail "3 mismatch: guard passed on a mismatched upstream: $G_OUT"
grep -q 'CADDY_UPSTREAM_MISMATCH' <<<"$G_OUT" || fail "3 mismatch: expected CADDY_UPSTREAM_MISMATCH, got: $G_OUT"
! grep -q 'WACRM_PUBLIC_ROUTE=PASS' <<<"$G_OUT" || fail "3 mismatch: false PASS"
run_deploy_preflight
[ "$D_RC" != 0 ] && grep -q 'NO-GO' <<<"$D_OUT" || fail "3 mismatch: deploy.sh must stop with NO-GO (rc=$D_RC): $D_OUT"
pass "3 mismatch: guard FAIL CLOSED (CADDY_UPSTREAM_MISMATCH); deploy.sh NO-GO before any mutation"

# 4. Recovery: the correct upstream is restored.
write_caddyfile "$ALIAS"; apply_caddyfile
wait_https 200 || { diag; fail "4 recovery: Caddy did not reach the app again (got $(https_code))"; }
run_guard
[ "$G_RC" = 0 ] || fail "4 recovery: guard should PASS after restoring the upstream: $G_OUT"
grep -q 'WACRM_PUBLIC_ROUTE=PASS' <<<"$G_OUT" || fail "4 recovery: missing PASS: $G_OUT"
pass "4 recovery: upstream restored, real Caddy serves the app and the guard is back to PASS"

echo "OPS_GUARD_REAL_CADDY=PASS"
