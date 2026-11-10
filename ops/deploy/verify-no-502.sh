#!/usr/bin/env bash
# Read-only. Confirms the 502s on the WhatsApp webhook are gone around a deploy.
#
#   verify-no-502.sh [--since 2026-11-10T18:00:00Z] [--until ...]    (default: the last 30 minutes)
#
# Caddy logs only ERRORS (a failed upstream dial/read), not successful requests, so the proof is "zero error lines for the webhook path in the
# window" plus a live readiness probe. It prints counts only; no IPs, headers or payloads.
set -euo pipefail
SINCE="30m"; UNTIL=""
while [ $# -gt 0 ]; do case "$1" in --since) SINCE="$2"; shift 2 ;; --until) UNTIL="$2"; shift 2 ;; *) echo "unknown arg $1" >&2; exit 2 ;; esac; done
PROXY="${PROXY_CONTAINER:-dentalpin-caddy-1}"      # the shared Caddy: only its LOG is read
LIVE="${LIVE_NAME:-wacrm-app-1}"
ARGS=(--since "$SINCE"); [ -n "$UNTIL" ] && ARGS+=(--until "$UNTIL")
# Missing Caddy logs must never be interpreted as zero webhook failures.
docker inspect "$PROXY" >/dev/null 2>&1 || { echo "FAIL: Caddy container unavailable" >&2; exit 2; }
if ! FULL_LOG="$(docker logs "${ARGS[@]}" "$PROXY" 2>&1)"; then
  echo "FAIL: could not read Caddy log (unknown 502 count)" >&2
  exit 2
fi
LOG="$(printf '%s' "$FULL_LOG" | grep 'whatsapp/webhook' || true)"
unset FULL_LOG
TOTAL="$(printf '%s' "$LOG" | grep -c . || true)"
echo "window: since=$SINCE until=${UNTIL:-now}   webhook error lines in proxy log: $TOTAL"
if [ "$TOTAL" -gt 0 ]; then
  printf '%s' "$LOG" | python3 -I -c '
import sys, json, re, collections
c = collections.Counter()
for line in sys.stdin:
    try: d = json.loads(line)
    except Exception: continue
    m = re.sub(r"\d+\.\d+\.\d+\.\d+(:\d+)?", "<ip>", d.get("msg", ""))
    c[(d.get("status"), m[:80])] += 1
for (status, msg), n in c.most_common(): print(f"  {n:4d}  status={status}  {msg}")'
fi
READY="$(docker exec "$LIVE" node -e 'const c=new AbortController();const t=setTimeout(()=>c.abort(),4000);fetch("http://127.0.0.1:3000/api/health/ready",{signal:c.signal}).then(r=>{clearTimeout(t);console.log(r.status)}).catch(()=>{clearTimeout(t);console.log("000")})' 2>/dev/null || echo 000)"
echo "live DB-backed readiness: $READY"
echo -n "restart count / started: "; docker inspect -f '{{.RestartCount}} {{.State.StartedAt}}' "$LIVE"
if [ "$TOTAL" -gt 0 ]; then echo "FAIL: webhook errors present"; exit 1; fi
if [ "$READY" != 200 ]; then echo "FAIL: live database-backed readiness not 200"; exit 1; fi
echo "PASS: no webhook error lines and live DB-backed readiness 200 in inspected window"
