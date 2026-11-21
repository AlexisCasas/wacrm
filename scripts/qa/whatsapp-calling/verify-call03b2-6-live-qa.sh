#!/usr/bin/env bash
set -euo pipefail

# CALL-03B2.6 QA: read-only evidence for one synthetic call.
# Does NOT create calls, mutate tables, issue HTTP requests, or touch production.
# Usage: bash verify-call03b2-6-live-qa.sh reject|unknown-signal|unknown-terminal wacid.<qa-id>
mode="${1:-}"
call_id="${2:-}"
case "$mode" in reject|unknown-signal|unknown-terminal) ;; *)
  echo "Usage: $0 {reject|unknown-signal|unknown-terminal} wacid.<qa-id>" >&2
  exit 2
esac
if [[ ! "$call_id" =~ ^wacid\.[A-Za-z0-9._~-]{1,240}$ ]]; then
  echo "CALL03B26_QA_GATE=BLOCKED_INVALID_CALL_ID" >&2
  exit 2
fi
command -v docker >/dev/null || { echo "CALL03B26_QA_GATE=BLOCKED_NO_DOCKER" >&2; exit 2; }
project="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' call03b2-qa-db 2>/dev/null || true)"
if [[ "$project" != "call03b2-qa" ]]; then
  echo "CALL03B26_QA_GATE=BLOCKED_NOT_QA_COMPOSE_PROJECT" >&2
  exit 2
fi

# PGOPTIONS and BEGIN READ ONLY both prevent SQL writes. No user/phone/SDP
# columns are printed. psql variables are SQL-escaped with :'name'.
result="$(
  docker exec -i -e PGOPTIONS='-c default_transaction_read_only=on' \
    call03b2-qa-db psql -X -qAt -U postgres -d postgres \
    -v ON_ERROR_STOP=1 -v "qa_mode=$mode" -v "qa_call_id=$call_id" <<'SQL'
BEGIN READ ONLY;
WITH target AS (
  SELECT id, direction, state, created_at, accepted_by_user_id,
         rejected_by_user_id, claimed_by_user_id, claim_expires_at,
         session_sdp_encrypted, agent_sdp_encrypted,
         signal_request_id, signal_action, signal_status,
         terminal_request_id, terminal_action, terminal_status
  FROM public.whatsapp_call_sessions
  WHERE call_id = :'qa_call_id'
),
totals AS (
  SELECT
    count(*)::integer AS sessions,
    count(*) FILTER (WHERE direction='USER_INITIATED' AND state='rejected')::integer AS rejected,
    count(*) FILTER (WHERE state IN ('offered','ringing','connecting','connected'))::integer AS active,
    count(*) FILTER (WHERE claimed_by_user_id IS NOT NULL AND claim_expires_at > now())::integer AS claims,
    count(*) FILTER (WHERE session_sdp_encrypted IS NOT NULL OR agent_sdp_encrypted IS NOT NULL)::integer AS sdp,
    count(*) FILTER (WHERE signal_status='reserved' OR terminal_status='reserved')::integer AS reserved,
    count(*) FILTER (WHERE signal_status='unknown' OR terminal_status='unknown')::integer AS unknown
  FROM public.whatsapp_call_sessions
),
checks AS (
  SELECT
    (SELECT count(*) FROM target) AS target_rows,
    EXISTS (
      SELECT 1 FROM target WHERE direction='USER_INITIATED'
        AND state='rejected'
        AND rejected_by_user_id IS NOT NULL
        AND accepted_by_user_id IS NULL
        AND terminal_action='reject' AND terminal_status='acknowledged'
        AND signal_status IS NULL
        AND session_sdp_encrypted IS NULL AND agent_sdp_encrypted IS NULL
        AND (claimed_by_user_id IS NULL OR claim_expires_at <= now())
        AND created_at > timestamptz '2026-11-21 18:18:48.714064+00'
    ) AS reject_ok,
    EXISTS (
      SELECT 1 FROM target WHERE signal_status='unknown'
        AND signal_request_id IS NOT NULL
        AND signal_action IN ('pre_accept','accept')
        AND terminal_request_id IS NULL
    ) AS signal_unknown_ok,
    EXISTS (
      SELECT 1 FROM target WHERE terminal_status='unknown'
        AND terminal_request_id IS NOT NULL
        AND terminal_action IN ('reject','terminate')
        AND signal_status IS DISTINCT FROM 'reserved'
    ) AS terminal_unknown_ok
)
SELECT
  CASE
    WHEN c.target_rows <> 1 THEN 'BLOCKED_CALL_NOT_UNIQUE_OR_NOT_FOUND'
    WHEN :'qa_mode'='reject' AND c.reject_ok AND t.sessions > 24
      AND t.rejected > 3 AND t.active=0 AND t.claims=0
      AND t.sdp=0 AND t.reserved=0 THEN 'PASS'
    WHEN :'qa_mode'='unknown-signal' AND c.signal_unknown_ok THEN 'PASS'
    WHEN :'qa_mode'='unknown-terminal' AND c.terminal_unknown_ok THEN 'PASS'
    ELSE 'FAIL_INVARIANTS'
  END || '|sessions=' || t.sessions
      || '|rejected=' || t.rejected
      || '|active=' || t.active
      || '|claims=' || t.claims
      || '|sdp=' || t.sdp
      || '|reserved=' || t.reserved
      || '|unknown=' || t.unknown
FROM checks c CROSS JOIN totals t;
ROLLBACK;
SQL
)"
printf 'CALL03B26_QA_%s=%s\n' "${mode^^}" "$result"
[[ "${result%%|*}" == "PASS" ]] || exit 1
