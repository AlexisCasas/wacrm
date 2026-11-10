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
LOG="$(docker logs "${ARGS[@]}" "$PROXY" 2>&1 | grep 'whatsapp/webhook' || true)"
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
echo -n "live readiness: "; docker exec "$LIVE" node -e "fetch('http://127.0.0.1:3000/api/health/ready').then(r=>console.log(r.status)).catch(()=>console.log('unreachable'))"
echo -n "restart count / started: "; docker inspect -f '{{.RestartCount}} {{.State.StartedAt}}' "$LIVE"
[ "$TOTAL" -eq 0 ] && echo "PASS: no webhook 502 in the window" || { echo "FAIL: webhook errors present (expected only if the window includes an old-procedure deploy)"; exit 1; }
