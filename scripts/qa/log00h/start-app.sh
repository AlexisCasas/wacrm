#!/usr/bin/env bash
# Starts the built app (standalone server, as the Dockerfile does) as the isolated QA user and waits for readiness.
set -euo pipefail
: "${QA_DIR:?}"
sudo -u qarun -H env QA_DIR="$QA_DIR" bash -c '
  set -a; . "$QA_DIR/env.sh"; set +a
  cd "$QA_DIR/repo/.next/standalone"
  NODE_ENV=production PORT=3000 HOSTNAME=127.0.0.1 setsid nohup node server.js >"$QA_DIR/results/app.log" 2>&1 </dev/null &
'
for attempt in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3000/api/health/ready || true)
  if [ "$code" = 200 ]; then echo "app ready after $attempt attempts"; exit 0; fi
  sleep 2
done
echo "app not ready (last status $code)"; tail -n 50 "$QA_DIR/results/app.log" || true; exit 1
