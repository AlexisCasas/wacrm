#!/usr/bin/env bash
# Runs a command as the isolated QA user, inside its copy of the code, with the per-run environment.
# QA_SUBDIR=base runs it in the base-commit copy instead.
set -euo pipefail
: "${QA_DIR:?}"
exec sudo -u qarun -H env QA_DIR="$QA_DIR" QA_SUBDIR="${QA_SUBDIR:-repo}" bash -c '
  set -a; . "$QA_DIR/env.sh"; set +a
  # Node 20 has no global WebSocket without this flag and supabase-js refuses to start without one.
  export NODE_OPTIONS="--experimental-websocket"
  cd "$QA_DIR/$QA_SUBDIR"
  exec "$@"
' _ "$@"
