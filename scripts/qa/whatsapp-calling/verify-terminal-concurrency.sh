#!/usr/bin/env bash
set -euo pipefail

# CALL-03B2.5: two independent database sessions race reject reservation vs
# claim on ONE offered inbound call. Only the winner may proceed.
# Local Supabase ONLY; never point this at QA VPS or Supabase Cloud.
if ! command -v psql >/dev/null 2>&1; then
  echo "CALL035_CONCURRENCY=FAIL (psql missing)" >&2
  exit 1
fi
status_env="$(supabase status -o env)"
db_url="$(printf '%s\n' "$status_env" | awk -F= '$1 == "DB_URL" { gsub(/^"/, "", $2); gsub(/"$/, "", $2); print $2 }')"
if [[ -z "$db_url" || "$db_url" != postgresql://postgres:*@127.0.0.1:*/* ]]; then
  echo "CALL035_CONCURRENCY=FAIL (local DB only)" >&2
  exit 1
fi

user_a="e5000000-0000-4000-8000-000000000001"
user_b="e5000000-0000-4000-8000-000000000002"
phone="740434745820831"
call="wacid.qa-terminal-concurrent"
request_id="e5000000-0000-4000-8000-000000000099"
tmp="$(mktemp -d)"

cleanup() {
  psql "$db_url" -X -v ON_ERROR_STOP=1 -q <<SQL >/dev/null 2>&1 || true
DELETE FROM public.whatsapp_call_events WHERE call_id = '$call';
DELETE FROM public.whatsapp_call_sessions WHERE call_id = '$call';
DELETE FROM public.accounts WHERE owner_user_id IN ('$user_a','$user_b');
DELETE FROM auth.users WHERE id IN ('$user_a','$user_b');
SQL
  rm -rf "$tmp"
}
trap cleanup EXIT

psql "$db_url" -X -v ON_ERROR_STOP=1 -q <<SQL
INSERT INTO auth.users (
  id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) VALUES
('$user_a','authenticated','authenticated','call035-race-a@example.invalid','',now(),'{}'::jsonb,'{}'::jsonb,now(),now()),
('$user_b','authenticated','authenticated','call035-race-b@example.invalid','',now(),'{}'::jsonb,'{}'::jsonb,now(),now());
DO \$do\$
DECLARE v_account uuid;
BEGIN
  SELECT account_id INTO v_account FROM public.profiles WHERE user_id='$user_a';
  UPDATE public.profiles SET account_id=v_account,account_role='agent' WHERE user_id='$user_b';
  DELETE FROM public.accounts WHERE owner_user_id='$user_b';
  INSERT INTO public.whatsapp_call_sessions(
    account_id,phone_number_id,call_id,direction,state,
    session_sdp_encrypted,session_sdp_type,session_sdp_expires_at
  ) VALUES (v_account,'$phone','$call','USER_INITIATED','offered',
    'qa-offer','offer',now()+interval '5 minutes');
END
\$do\$;
SQL

account="$(psql "$db_url" -X -v ON_ERROR_STOP=1 -qAtc \
  "SELECT account_id FROM public.profiles WHERE user_id='$user_a'")"
if [[ -z "$account" ]]; then echo "CALL035_CONCURRENCY=FAIL (no fixture)" >&2; exit 1; fi

# Both commands operate atomically on the same session row. Either reservation
# commits first and claim fails, or claim commits first and reject is denied.
psql "$db_url" -X -v ON_ERROR_STOP=1 -qAtc \
  "SELECT pg_sleep(0.25); SELECT public.whatsapp_call_terminal_reserve('$account','$phone','$call','$user_a','$request_id','reject','reject',NULL)" \
  >"$tmp/reserve.out" &
pid_a=$!
psql "$db_url" -X -v ON_ERROR_STOP=1 -qAtc \
  "SELECT pg_sleep(0.25); SELECT public.whatsapp_call_claim('$account','$phone','$call','$user_b')" \
  >"$tmp/claim.out" &
pid_b=$!
wait "$pid_a"
wait "$pid_b"

reserved="$(tail -n 1 "$tmp/reserve.out" | tr -d '[:space:]')"
claimed="$(tail -n 1 "$tmp/claim.out" | tr -d '[:space:]')"
if [[ "$reserved" == "reserved" && "$claimed" == "f" ]]; then
  :
elif [[ "$reserved" == "denied" && "$claimed" == "t" ]]; then
  # Transfer from the winner to the terminal reserver to check the inverse.
  release="$(psql "$db_url" -X -v ON_ERROR_STOP=1 -qAtc \
    "SELECT public.whatsapp_call_release('$account','$phone','$call','$user_b')")"
  if [[ "$release" != "t" ]]; then
    echo "CALL035_CONCURRENCY=FAIL (winner could not release)" >&2; exit 1
  fi
  reserved="$(psql "$db_url" -X -v ON_ERROR_STOP=1 -qAtc \
    "SELECT public.whatsapp_call_terminal_reserve('$account','$phone','$call','$user_a','$request_id','reject','reject',NULL)")"
  if [[ "$reserved" != "reserved" ]]; then
    echo "CALL035_CONCURRENCY=FAIL (reservation after release refused)" >&2; exit 1
  fi
else
  echo "CALL035_CONCURRENCY=FAIL (reserve=$reserved claim=$claimed)" >&2
  exit 1
fi

# An uncertain Graph outcome must not release the reservation even when
# the original offer is still valid and the agent attempts a new claim.
finish="$(psql "$db_url" -X -v ON_ERROR_STOP=1 -qAtc \
  "SELECT public.whatsapp_call_terminal_finish('$account','$phone','$call','$user_a','$request_id','unknown')")"
new_claim="$(psql "$db_url" -X -v ON_ERROR_STOP=1 -qAtc \
  "SELECT public.whatsapp_call_claim('$account','$phone','$call','$user_b')")"
if [[ "$finish" != "t" || "$new_claim" != "f" ]]; then
  echo "CALL035_CONCURRENCY=FAIL (unknown outcome allowed reclaim)" >&2
  exit 1
fi
echo "CALL035_CONCURRENCY=PASS (two sessions, one winner, unknown outcome remains fenced)"
