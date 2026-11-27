#!/usr/bin/env bash
# Stops the app, the tests and every service, and checks that nothing is left running. Every problem is reported and fails the step.
set -uo pipefail
failed=0
problem() { echo "TEARDOWN problem: $1"; failed=1; }
if id qarun >/dev/null 2>&1; then
  sudo pkill -KILL -u qarun; rc=$? # 1 = there was nothing to kill
  [ "$rc" -le 1 ] || problem "pkill exit $rc"
  sleep 2
  if pgrep -u qarun >/dev/null; then problem "processes of the QA user survived"; fi
fi
if command -v supabase >/dev/null 2>&1; then
  supabase stop --no-backup || problem "supabase stop failed"
fi
if names="$(docker ps --format '{{.Names}}')"; then
  left="$(grep -c '^supabase_' <<<"$names")"
  [ "$left" = 0 ] || problem "$left Supabase containers still running"
else
  problem "could not list the containers"
fi
if curl -s -o /dev/null --max-time 3 http://127.0.0.1:3000/; then problem "something still answers on the app port"; fi
if [ "$failed" = 0 ]; then echo "TEARDOWN=PASS"; fi
exit "$failed"
