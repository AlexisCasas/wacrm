#!/usr/bin/env bash
# Manual technical QA for E4.2C3.1: an ISOLATED PostgreSQL 17 (no network, no published ports) with all migrations and
# the QA fixtures, plus the simulated Meta transport. Nothing here can reach Meta, a real credential or production.
#   ./scripts/sql/manual-qa-c31.sh up                 start (or reuse) the container
#   ./scripts/sql/manual-qa-c31.sh run <scenario>     run one scenario against it (see below), prints PASS/FAIL
#   ./scripts/sql/manual-qa-c31.sh inspect            show runs, effects, Inbox messages, conversations and events
#   ./scripts/sql/manual-qa-c31.sh psql               interactive psql inside the container
#   ./scripts/sql/manual-qa-c31.sh down               remove the container and its data
# Scenarios: send (text + media from a subflow, return to the main flow) | duplicate | ambiguous | recovery | all
set -euo pipefail
cd "$(dirname "$0")/../.."
SQL=scripts/sql
source "$SQL/qa-lib.sh"
trap - EXIT                                   # qa-lib removes its container on exit; this one is kept on purpose
NAME="${MANUAL_QA_CONTAINER:-wacrm-manual-qa}"
TEST=src/lib/flows/versioned-meta-sender.pg.test.ts

exists() { [ -n "$(docker ps -a --filter "name=^${NAME}$" --format '{{.Names}}')" ]; }
dbq() { docker exec -i "$NAME" psql -U supabase_admin -h /var/run/postgresql -d postgres -X -q "$@"; }

case "${1:-}" in
  up)
    if exists; then echo "container $NAME already exists (use 'down' to start from scratch)"; exit 0; fi
    qa_start
    qa_commit_fixtures
    echo "ready: container $NAME (network: $(docker inspect -f '{{.HostConfig.NetworkMode}}' "$NAME"), published ports: $(docker port "$NAME" | wc -l))"
    ;;
  run)
    exists || { echo "start it first: $0 up" >&2; exit 2; }
    scenario="${2:-all}"
    case "$scenario" in
      send)      filter='N01/N02' ;;
      duplicate) filter='N19' ;;
      ambiguous) filter='N06/N07/N08' ;;
      recovery)  filter='N13/N14' ;;
      all)       filter='' ;;
      *) echo "unknown scenario '$scenario' (send|duplicate|ambiguous|recovery|all)" >&2; exit 2 ;;
    esac
    out="$(mktemp)"
    set +e
    QA_PG_CONTAINER="$NAME" npx vitest run "$TEST" ${filter:+-t "$filter"} --reporter=verbose >"$out" 2>&1
    code=$?
    set -e
    grep -E 'QA-RESULT' "$out" | sed 's/^/  /' | cut -c1-260
    grep -E '^\s+Tests ' "$out" | sed 's/^/  /'
    rm -f "$out"
    if [ "$code" = 0 ]; then echo "SCENARIO $scenario: PASS"; else echo "SCENARIO $scenario: FAIL (vitest exit $code)"; exit 1; fi
    ;;
  inspect)
    exists || { echo "start it first: $0 up" >&2; exit 2; }
    echo "== runs (latest first)";            dbq -c "select left(id::text,8) run, status, versioned_node_key node, versioned_depth depth, versioned_nodes_executed nodes, versioned_messages_executed messages, versioned_revision rev, end_reason from flow_runs where execution_mode='versioned' order by started_at desc limit 8"
    echo "== effects (ledger)";               dbq -c "select left(flow_run_id::text,8) run, node_key, effect_type, state, attempt, provider_message_id wamid, error_code from flow_run_effects order by created_at desc limit 12"
    echo "== Inbox messages written by the engine"; dbq -c "select left(m.conversation_id::text,8) conv, m.sender_type, m.content_type, left(coalesce(m.content_text,''),28) text, m.media_url, m.message_id wamid, m.status from messages m join flow_run_effect_messages l on l.message_id=m.id order by l.created_at desc limit 12"
    echo "== conversations touched";          dbq -c "select left(c.id::text,8) conv, c.last_message_text preview, to_char(c.last_message_at,'HH24:MI:SS') at from conversations c where c.id in (select conversation_id from flow_run_effect_messages) order by c.last_message_at desc limit 8"
    echo "== trace (ids only)";               dbq -c "select left(flow_run_id::text,8) run, event_type, node_key from flow_run_events where event_type like 'effect_%' or event_type like 'subflow_%' order by created_at desc limit 20"
    ;;
  psql)  exists || { echo "start it first: $0 up" >&2; exit 2; }; docker exec -it "$NAME" psql -U supabase_admin -h /var/run/postgresql -d postgres ;;
  down)  docker rm -f "$NAME" >/dev/null 2>&1 && echo "removed $NAME" || echo "$NAME did not exist" ;;
  *)     sed -n '2,12p' "$0"; exit 2 ;;
esac
