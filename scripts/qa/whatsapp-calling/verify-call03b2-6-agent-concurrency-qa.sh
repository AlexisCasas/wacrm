#!/usr/bin/env bash
set -euo pipefail

# CALL-03B2.6 — Post-browser A/C concurrency evidence (READ ONLY).
# Must be run on the isolated QA VPS and with a new synthetic call_id from Peer QA.
# This SQL proves ONE durable winning/terminated call, NOT the losing browser's
# HTTP 409, microphone behavior, or absence of duplicate Graph requests.
call_id="${1:-}"
if [[ ! "$call_id" =~ ^wacid\.[A-Za-z0-9._~-]{1,240}$ ]]; then
  echo "CALL03B26_CONCURRENCY=BLOCKED_INVALID_QA_CALL_ID" >&2
  echo "Usage: $0 wacid.<new-peer-qa-call-id>" >&2
  exit 2
fi
command -v docker >/dev/null 2>&1 || { echo "CALL03B26_CONCURRENCY=BLOCKED_NO_DOCKER" >&2; exit 2; }
project="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' call03b2-qa-db 2>/dev/null || true)"
if [[ "$project" != "call03b2-qa" ]]; then
  echo "CALL03B26_CONCURRENCY=BLOCKED_NOT_QA_COMPOSE_PROJECT" >&2
  exit 2
fi

result="$(
  docker exec -i -e PGOPTIONS='-c default_transaction_read_only=on' \
    call03b2-qa-db psql -X -qAt -U postgres -d postgres \
    -v ON_ERROR_STOP=1 -v "qa_call_id=$call_id" <<'SQL'
BEGIN READ ONLY;
WITH matching AS (
  SELECT *
  FROM public.whatsapp_call_sessions
  WHERE call_id = :'qa_call_id'
), gate AS (
  SELECT
    count(*)::integer AS matched,
    count(*) FILTER (WHERE
      direction = 'USER_INITIATED'
      AND state = 'terminated'
      AND accepted_by_user_id IS NOT NULL
      AND ended_by_user_id = accepted_by_user_id
      AND rejected_by_user_id IS NULL
      AND signal_action = 'accept' AND signal_status = 'acknowledged'
      AND terminal_action = 'terminate' AND terminal_status = 'acknowledged'
      AND (claimed_by_user_id IS NULL OR claim_expires_at <= now())
      AND session_sdp_encrypted IS NULL AND agent_sdp_encrypted IS NULL
      AND created_at > timestamptz '2026-11-21 18:18:48.714064+00'
    )::integer AS valid_winner,
    count(*) FILTER (WHERE claimed_by_user_id IS NOT NULL AND claim_expires_at > now())::integer AS claims,
    count(*) FILTER (WHERE session_sdp_encrypted IS NOT NULL OR agent_sdp_encrypted IS NOT NULL)::integer AS sdp,
    count(*) FILTER (WHERE signal_status IN ('reserved','unknown') OR terminal_status IN ('reserved','unknown'))::integer AS unsettled
  FROM matching
)
SELECT CASE
  WHEN matched <> 1 THEN 'BLOCKED_CALL_NOT_UNIQUE_OR_NOT_FOUND'
  WHEN valid_winner=1 AND claims=0 AND sdp=0 AND unsettled=0 THEN 'PASS_SQL_ONLY'
  ELSE 'FAIL_INVARIANTS'
END || '|matched=' || matched || '|valid_winner=' || valid_winner
    || '|claims=' || claims || '|sdp=' || sdp || '|unsettled=' || unsettled
FROM gate;
ROLLBACK;
SQL
)"
printf 'CALL03B26_CONCURRENCY=%s\n' "$result"
[[ "${result%%|*}" == "PASS_SQL_ONLY" ]] || exit 1
