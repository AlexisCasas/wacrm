#!/usr/bin/env bash
# Local, Docker-free regression suite for the public-proxy (Caddy upstream) contract.
# Run: bash ops/deploy/test-guard-public-proxy.sh
#
# It never talks to a Docker daemon, to Caddy or to the network: `docker` and `curl` are stubs earlier on PATH that
# answer from environment knobs and log every call. Every scenario also proves the guard is READ-ONLY (only
# `docker inspect` and `docker exec` are ever issued) and that deploy.sh stops BEFORE any mutation when the proxy
# contract is broken.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD="$HERE/guard-public-proxy.sh"
ROOT="$(mktemp -d)"
trap 'rm -rf -- "$ROOT"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
pass() { printf 'PASS: %s\n' "$*"; }

BIN="$ROOT/bin"; CALLS="$ROOT/calls.log"; mkdir -p "$BIN"
cat >"$BIN/docker" <<'STUB'
#!/usr/bin/env bash
echo "docker $*" >>"$CALLS"
case "$1" in
  inspect)
    if [ "$2" = "-f" ]; then
      case "$3 $4" in
        "{{.State.Running}} $PROXY_NAME") echo "${PROXY_RUNNING:-true}" ;;
        "{{.State.Running}} "*) echo "${APP_RUNNING:-true}" ;;
        *) exit 1 ;;
      esac
    else
      if [ "$2" = "$PROXY_NAME" ]; then
        if [ "${PROXY_ON_EDGE:-1}" = 1 ]; then echo '{"edge_proxy":{"Aliases":["dentalpin-caddy-1"]}}'; else echo '{"other":{}}'; fi
      else
        echo "{\"edge_proxy\":{\"Aliases\":${APP_ALIASES:-[\"wacrm-app\"]}}}"
      fi
    fi ;;
  exec)
    [ "$2" = "$PROXY_NAME" ] || { echo "unexpected exec target $2" >&2; exit 99; }
    case "$3" in
      cat) cat "$CADDYFILE" ;;
      wget) echo "wget ${*: -1}" >>"$CALLS"; exit "${WGET_RC:-0}" ;;
      *) echo "unexpected exec $3" >&2; exit 99 ;;
    esac ;;
  image) exit 1 ;;   # "image is not loaded": lets deploy.sh stop right after the guard, without mutating anything
  *) echo "MUTATING_OR_UNEXPECTED docker $*" >>"$CALLS"; exit 99 ;;
esac
STUB
cat >"$BIN/curl" <<'STUB'
#!/usr/bin/env bash
echo "curl $*" >>"$CALLS"
printf '%s' "${CURL_CODE:-200}"
STUB
chmod +x "$BIN/docker" "$BIN/curl"

CADDY_OK="$ROOT/Caddyfile.ok"
cat >"$CADDY_OK" <<'CADDY'
# Other site
dentalpin.example.com {
        reverse_proxy dentalpin-frontend-1:3000
}

# WA CRM
crm.globaltechup.com {
        reverse_proxy wacrm-app-1:3000
        encode gzip
}

erp.globaltechup.com {
        reverse_proxy erpnext-frontend:8080
}
CADDY
CADDY_LEGACY="$ROOT/Caddyfile.legacy"; sed 's/wacrm-app-1:3000/wacrm-app:3000/' "$CADDY_OK" >"$CADDY_LEGACY"
CADDY_NESTED="$ROOT/Caddyfile.nested"
cat >"$CADDY_NESTED" <<'CADDY'
crm.globaltechup.com, www.crm.globaltechup.com {
        reverse_proxy wacrm-app:3000 {
                lb_try_duration 10s
        }
}
CADDY
CADDY_NONE="$ROOT/Caddyfile.none"; printf 'other.example.com {\n        reverse_proxy x:1\n}\n' >"$CADDY_NONE"

# run_guard <expected-exit-substring|-> <caddyfile> [guard args...] ; env knobs are exported by the caller.
OUT=""
run_guard() {
  local caddyfile="$1"; shift
  : >"$CALLS"
  set +e
  OUT="$(PATH="$BIN:$PATH" CALLS="$CALLS" PROXY_NAME=dentalpin-caddy-1 CADDYFILE="$caddyfile" bash "$GUARD" "$@" 2>&1)"
  RC=$?
  set -e
}
assert_read_only() {
  ! grep -q 'MUTATING_OR_UNEXPECTED' "$CALLS" || fail "$1: guard issued a non-read-only Docker command: $(grep MUTATING "$CALLS")"
  local sub
  while read -r _ sub _; do
    case "$sub" in inspect|exec|image) ;; *) fail "$1: unexpected docker subcommand '$sub'" ;; esac
  done < <(grep '^docker ' "$CALLS")
}
expect_ok()   { [ "$RC" = 0 ] || fail "$1 (rc=$RC): $OUT"; assert_read_only "$1"; pass "$1"; }
expect_fail() { [ "$RC" != 0 ] || fail "$1: expected failure but it passed: $OUT"; grep -q "$2" <<<"$OUT" || fail "$1: expected '$2' in: $OUT"; assert_read_only "$1"; pass "$1"; }

# 1. Healthy: Caddy dials wacrm-app-1, the live container is wacrm-app-1, nothing else needed.
export APP_ALIASES='["wacrm-app-cand-20261116T091729Z","wacrm-app-1"]'
PUBLIC_ALIAS=wacrm-app-1 run_guard "$CADDY_OK" wacrm-app-1
expect_ok "healthy route: alias = container name = Caddy upstream"
grep -q 'wget http://wacrm-app-1:3000/login' "$CALLS" || fail "Caddy must fetch the public upstream name"

# 2. Stable alias contract (wacrm-app on the container, Caddy dials wacrm-app).
export APP_ALIASES='["wacrm-app"]'
PUBLIC_ALIAS=wacrm-app run_guard "$CADDY_LEGACY" wacrm-app-1
expect_ok "healthy route: stable alias wacrm-app"
PUBLIC_ALIAS=wacrm-app run_guard "$CADDY_NESTED" wacrm-app-1
expect_ok "Caddy site block with several addresses and a nested reverse_proxy body"

# 3. THE INCIDENT: the live container lost the alias Caddy dials (candidate overlay replaced the aliases).
export APP_ALIASES='["wacrm-app-cand-20261114T150000Z"]'
PUBLIC_ALIAS=wacrm-app run_guard "$CADDY_LEGACY" wacrm-app-1
expect_fail "lost public alias is detected" "LIVE_PUBLIC_ALIAS_MISSING"
if grep -q 'wget' "$CALLS"; then fail "lost alias: nothing should be probed after the alias check"; fi

# 4. Tooling default (wacrm-app) vs a Caddy that dials wacrm-app-1 (today's production): refuse, never guess.
export APP_ALIASES='["wacrm-app","wacrm-app-1"]'
PUBLIC_ALIAS=wacrm-app run_guard "$CADDY_OK" wacrm-app-1
expect_fail "published alias differs from what Caddy dials" "CADDY_UPSTREAM_MISMATCH configured=wacrm-app-1 published=wacrm-app"

# 5. Unknown / unparsable upstream fails closed.
PUBLIC_ALIAS=wacrm-app-1 run_guard "$CADDY_NONE" wacrm-app-1
expect_fail "unknown Caddy upstream fails closed" "CADDY_UPSTREAM_UNKNOWN"

# 6. Caddy cannot reach the app by the public name even though the aliases look right.
export WGET_RC=1
PUBLIC_ALIAS=wacrm-app-1 run_guard "$CADDY_OK" wacrm-app-1
expect_fail "Caddy cannot fetch the upstream" "CADDY_PUBLIC_UPSTREAM=FAIL"
unset WGET_RC

# 7. HTTPS through Caddy answers 502.
export CURL_CODE=502
PUBLIC_ALIAS=wacrm-app-1 run_guard "$CADDY_OK" wacrm-app-1
expect_fail "public HTTPS route 502" "CADDY_HTTPS_ROUTE=FAIL_HTTP_502"
unset CURL_CODE

# 8. Caddy is not on the shared network / app not running.
export PROXY_ON_EDGE=0
PUBLIC_ALIAS=wacrm-app-1 run_guard "$CADDY_OK" wacrm-app-1
[ "$RC" != 0 ] || fail "proxy off the edge network must fail"; pass "proxy not on edge_proxy is detected"
unset PROXY_ON_EDGE
export APP_RUNNING=false
PUBLIC_ALIAS=wacrm-app-1 run_guard "$CADDY_OK" wacrm-app-1
expect_fail "stopped app is detected" "APP_NOT_RUNNING"
unset APP_RUNNING

# 9. --print-upstream returns the exact host:port Caddy dials; works for nested blocks; unknown fails closed.
run_guard "$CADDY_OK" --print-upstream;     [ "$RC" = 0 ] && [ "$OUT" = "wacrm-app-1:3000" ] || fail "--print-upstream (rc=$RC out=$OUT)"
run_guard "$CADDY_NESTED" --print-upstream; [ "$RC" = 0 ] && [ "$OUT" = "wacrm-app:3000" ] || fail "--print-upstream nested (rc=$RC out=$OUT)"
run_guard "$CADDY_NONE" --print-upstream;   [ "$RC" != 0 ] || fail "--print-upstream must fail when unknown"
pass "--print-upstream"

# 9b. The probe goes to EXACTLY the destination Caddy dials (its port, or 80 when none is written).
CADDY_PORT="$ROOT/Caddyfile.port"; sed 's/wacrm-app-1:3000/wacrm-app-1:8080/' "$CADDY_OK" >"$CADDY_PORT"
export APP_ALIASES='["wacrm-app-1"]'
PUBLIC_ALIAS=wacrm-app-1 run_guard "$CADDY_PORT" wacrm-app-1
expect_ok "non-default Caddy port"; grep -q 'wget http://wacrm-app-1:8080/login' "$CALLS" || fail "probe must use the port Caddy dials"
CADDY_NOPORT="$ROOT/Caddyfile.noport"; sed 's/wacrm-app-1:3000/wacrm-app-1/' "$CADDY_OK" >"$CADDY_NOPORT"
PUBLIC_ALIAS=wacrm-app-1 run_guard "$CADDY_NOPORT" wacrm-app-1
expect_ok "Caddy upstream without a port defaults to 80"; grep -q 'wget http://wacrm-app-1:80/login' "$CALLS" || fail "probe must default to port 80 like Caddy"

# 10. deploy.sh preflight stops BEFORE any mutation when the contract is broken, in DRY-RUN as well.
run_deploy() {  # extra env passed as VAR=val args
  : >"$CALLS"
  set +e
  OUT="$(env "$@" PATH="$BIN:$PATH" CALLS="$CALLS" PROXY_NAME=dentalpin-caddy-1 CADDYFILE="$CADDY_OK" \
      LOCK_FILE="$ROOT/deploy.lock" STATE_DIR="$ROOT/state" bash "$HERE/deploy.sh" wacrm-app:candidate-test 2>&1)"
  RC=$?
  set -e
}
export APP_ALIASES='["wacrm-app-1"]'
run_deploy PUBLIC_ALIAS=wacrm-app            # tooling default vs Caddy on wacrm-app-1: the pre-fix situation
[ "$RC" != 0 ] && grep -q 'NO-GO' <<<"$OUT" || fail "deploy must stop on alias/upstream mismatch (rc=$RC): $OUT"
assert_read_only "deploy preflight mismatch"
! grep -qE 'docker (compose|network|run|stop|start|rm|rename|create)' "$CALLS" || fail "deploy mutated before the contract passed"
pass "deploy.sh stops before any mutation on alias/upstream mismatch"

export APP_ALIASES='["wacrm-app-cand-20261114T150000Z"]'
run_deploy "PUBLIC_ALIAS=wacrm-app-1"; PUBLIC_ALIAS_OK=1
# alias equals container name => accepted as published; this run must reach the image check (which the stub fails).
grep -q 'is not loaded on this host' <<<"$OUT" || fail "contract should pass for alias==container name, then stop at the image check: $OUT"
assert_read_only "deploy preflight pass"
pass "deploy.sh derives the pass from the same contract and only then continues (stub stops it at the image check)"

run_deploy                                   # unpinned: alias is taken from Caddy (wacrm-app-1)
grep -q 'public alias (Caddy upstream contract): wacrm-app-1' <<<"$OUT" || fail "unpinned deploy must adopt Caddy's upstream name: $OUT"
grep -q 'is not loaded on this host' <<<"$OUT" || fail "unpinned deploy should reach the image check: $OUT"
assert_read_only "deploy unpinned"
pass "deploy.sh adopts the upstream name Caddy dials when PUBLIC_ALIAS is not pinned"

# 11. Static ordering and presence checks on the real scripts (cannot run a real cutover here).
line() { grep -n -F -- "$1" "$2" | head -1 | cut -d: -f1; }
D="$HERE/deploy.sh"; R="$HERE/rollback.sh"
g1="$(line 'guard-public-proxy.sh" "$OLD"' "$D")"; up="$(line 'up -d --no-build --no-deps app' "$D")"
[ -n "$g1" ] && [ -n "$up" ] && [ "$g1" -lt "$up" ] || fail "deploy: preflight guard must come before the candidate is started"
c2="$(line 'CADDY_TO_CANDIDATE=PASS' "$D")"; stop="$(line 'docker stop -t "$STOP_GRACE" "$PREV_NAME"' "$D")"
[ -n "$c2" ] && [ -n "$stop" ] && [ "$c2" -lt "$stop" ] || fail "deploy: Caddy->candidate proof must come before the old container is stopped"
lastenv="$(line 'mv -f "$STATE_DIR/.last.env.tmp-$TS"' "$D")"; g3="$(line 'guard-public-proxy.sh" "$LIVE_NAME"' "$D")"
[ -n "$lastenv" ] && [ -n "$g3" ] && [ "$lastenv" -lt "$g3" ] || fail "deploy: post-cutover guard must run after the rollback manifest is published"
grep -qF '${CADDY_UPSTREAM##*:}' "$D" || fail "deploy: Caddy->candidate proof must use the port Caddy dials"
grep -q 'guard-public-proxy.sh" "$LIVE_NAME"' "$R" || fail "rollback must verify the Caddy route before reporting success"
grep -q -- '--print-upstream' "$R" || fail "rollback must publish the alias Caddy dials (same contract as deploy)"
pass "ordering: guard before start; Caddy->candidate before stopping old; post-cutover guard after manifest; rollback uses the same contract"

# 12. #127 is preserved: legacy overlay handling is the byte-compare filter, not a blanket wildcard.
grep -q 'select_live_compose_files' "$D" || fail "deploy.sh lost the #127 overlay filter"
! grep -q '\*/candidate.override.yml) continue' "$D" || fail "deploy.sh must not blanket-skip every candidate.override.yml"
pass "#127 overlay filter preserved (fail-closed on divergent legacy overlays)"

# 13. The guard and the new code never mutate Docker state.
! grep -nE 'docker (network (connect|disconnect|rm|create)|rm|stop|start|restart|run|compose|rename|create|kill)' "$GUARD" || fail "guard must be read-only"
pass "guard-public-proxy.sh contains no mutating Docker command"
echo "ALL PASS"
