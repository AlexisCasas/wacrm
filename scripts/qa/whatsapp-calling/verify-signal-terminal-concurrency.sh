#!/usr/bin/env bash
set -euo pipefail

# CALL-03B2.6: independent DB sessions race signaling against a terminal
# reservation, twice (pre_accept and accept). LOCAL Supabase only.
command -v psql >/dev/null 2>&1 || { echo "CALL036_RACE=FAIL (no psql)" >&2; exit 1; }
status_env="$(supabase status -o env)"
db_url="$(printf '%s\n' "$status_env" | awk -F= '$1 == "DB_URL" { gsub(/^"/, "", $2); gsub(/"$/, "", $2); print $2 }')"
[[ "$db_url" == postgresql://postgres:*@127.0.0.1:*/* ]] || { echo "CALL036_RACE=FAIL (not local)" >&2; exit 1; }

user="e6000000-0000-4000-8000-000000000001"
phone="740434745820831"
call_a="wacid.qa-signal-termin-race-a"
call_b="wacid.qa-signal-termin-race-b"
tmp="$(mktemp -d)"
cleanup() {
  psql "$db_url" -X -v ON_ERROR_STOP=1 -q <<SQL >/dev/null 2>&1 || true
DELETE FROM public.whatsapp_call_events WHERE call_id IN ('$call_a','$call_b');
DELETE FROM public.whatsapp_call_sessions WHERE call_id IN ('$call_a','$call_b');
DELETE FROM public.accounts WHERE owner_user_id='$user';
DELETE FROM auth.users WHERE id='$user';
SQL
  rm -rf "$tmp"
}
trap cleanup EXIT

psql "$db_url" -X -v ON_ERROR_STOP=1 -q <<SQL
INSERT INTO auth.users (
  id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) VALUES ('$user','authenticated','authenticated','call036-race@example.invalid','',now(),'{}'::jsonb,'{}'::jsonb,now(),now());
DO \$do\$
DECLARE a uuid;
BEGIN
  SELECT account_id INTO a FROM public.profiles WHERE user_id='$user';
  INSERT INTO public.whatsapp_call_sessions (
    account_id,phone_number_id,call_id,direction,state,
    session_sdp_encrypted,session_sdp_type,session_sdp_expires_at
  ) VALUES
  (a,'$phone','$call_a','USER_INITIATED','ringing','qa-offer','offer',now()+interval '4 minutes'),
  (a,'$phone','$call_b','USER_INITIATED','ringing','qa-offer','offer',now()+interval '4 minutes');
END
\$do\$;
SQL

account="$(psql "$db_url" -X -qAt -v ON_ERROR_STOP=1 -c "SELECT account_id FROM public.profiles WHERE user_id='$user'")"
[[ -n "$account" ]] || { echo "CALL036_RACE=FAIL (no account)" >&2; exit 1; }
for call in "$call_a" "$call_b"; do
  psql "$db_url" -X -qAt -v ON_ERROR_STOP=1 -c "SELECT public.whatsapp_call_claim('$account','$phone','$call','$user')" | grep -qx t
  psql "$db_url" -X -qAt -v ON_ERROR_STOP=1 -c "SELECT public.whatsapp_call_session_agent_sdp_store('$account','$phone','$call','$user','qa-answer',now()+interval '3 minutes')" | grep -qx t
done
epoch_a="$(psql "$db_url" -X -qAt -v ON_ERROR_STOP=1 -c "SELECT claimed_at::text FROM public.whatsapp_call_sessions WHERE call_id='$call_a'")"
epoch_b="$(psql "$db_url" -X -qAt -v ON_ERROR_STOP=1 -c "SELECT claimed_at::text FROM public.whatsapp_call_sessions WHERE call_id='$call_b'")"

# Prepare the second call to race accept (not pre_accept) against terminate.
p_request="e6000000-0000-4000-8000-000000000010"
psql "$db_url" -X -qAt -v ON_ERROR_STOP=1 -c \
  "SELECT public.whatsapp_call_signal_begin('$account','$phone','$call_b','$user','$p_request','pre_accept','$epoch_b')" | grep -qx reserved
psql "$db_url" -X -qAt -v ON_ERROR_STOP=1 -c \
  "SELECT public.whatsapp_call_signal_finish('$account','$phone','$call_b','$user','$p_request','acknowledged',NULL)" | grep -qx acknowledged

race() {
  local call="$1" action="$2" epoch="$3" name="$4"
  local sig_req term_req
  sig_req="$(cat /proc/sys/kernel/random/uuid)"
  term_req="$(cat /proc/sys/kernel/random/uuid)"
  psql "$db_url" -X -qAt -v ON_ERROR_STOP=1 -c \
    "SELECT pg_sleep(0.2); SELECT public.whatsapp_call_signal_begin('$account','$phone','$call','$user','$sig_req','$action','$epoch')" \
    > "$tmp/$name.signal" &
  local spid=$!
  psql "$db_url" -X -qAt -v ON_ERROR_STOP=1 -c \
    "SELECT pg_sleep(0.2); SELECT public.whatsapp_call_terminal_reserve('$account','$phone','$call','$user','$term_req','terminate','claim_cleanup','$epoch')" \
    > "$tmp/$name.terminal" &
  local tpid=$!
  wait "$spid"
  wait "$tpid"
  local signal terminal
  signal="$(tail -n 1 "$tmp/$name.signal" | tr -d '[:space:]')"
  terminal="$(tail -n 1 "$tmp/$name.terminal" | tr -d '[:space:]')"
  if [[ "$signal" == "reserved" && "$terminal" == "in_progress" ]]; then
    :
  elif [[ "$terminal" == "reserved" && "$signal" == "terminal_in_progress" ]]; then
    :
  else
    echo "CALL036_RACE=FAIL ($name signal=$signal terminal=$terminal)" >&2
    exit 1
  fi
  local db_signal db_terminal
  # An acknowledged pre_accept is a legitimate historical signal for the
  # accept race. Count only the *current reserved action*, not any old UUID.
  db_signal="$(psql "$db_url" -X -qAt -v ON_ERROR_STOP=1 -c "SELECT (signal_action='$action' AND signal_status='reserved')::text FROM public.whatsapp_call_sessions WHERE call_id='$call'")"
  db_terminal="$(psql "$db_url" -X -qAt -v ON_ERROR_STOP=1 -c "SELECT (terminal_request_id IS NOT NULL)::text FROM public.whatsapp_call_sessions WHERE call_id='$call'")"
  if [[ "$db_signal" == "$db_terminal" ]]; then
    echo "CALL036_RACE=FAIL ($name both/none reserved)" >&2
    exit 1
  fi
}
race "$call_a" pre_accept "$epoch_a" pre_accept
race "$call_b" accept "$epoch_b" accept
echo "CALL036_RACE=PASS (real PG sessions; mutually exclusive pre_accept, accept and terminate)"
