#!/usr/bin/env bash
set -euo pipefail

# Run after `supabase db start` and `supabase db reset --local`.
# Two independent PostgreSQL sessions race for one synthetic call. Exactly
# one agent must win the atomic UPDATE lease; the loser must receive false.
# All fixtures are deleted by the EXIT trap. No hosted/production database
# URL is accepted: this script only reads the local Supabase DB_URL.

if ! command -v psql >/dev/null 2>&1; then
  echo "CALL02_CONCURRENCY=FAIL (psql client missing)" >&2
  exit 1
fi

status_env="$(supabase status -o env)"
db_url="$(printf '%s\n' "$status_env" | awk -F= '$1 == "DB_URL" { gsub(/^"/, "", $2); gsub(/"$/, "", $2); print $2 }')"
if [[ -z "$db_url" || "$db_url" != postgresql://postgres:*@127.0.0.1:*/* ]]; then
  echo "CALL02_CONCURRENCY=FAIL (local Supabase DB_URL not found)" >&2
  exit 1
fi

user_a="a2000000-0000-4000-8000-000000000001"
user_b="a2000000-0000-4000-8000-000000000002"
phone_number_id="740434745820831"
call_id="wacid.qa-concurrency"
tmp_dir="$(mktemp -d)"

cleanup() {
  psql "$db_url" -X -v ON_ERROR_STOP=1 -q <<'SQL'
DO $qa$
DECLARE
  v_account uuid;
BEGIN
  INSERT INTO auth.users (
    id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at
  ) VALUES
    ('a2000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'call-qa-agent-a@example.invalid', '', now(),
     '{}'::jsonb, '{"full_name":"CALL QA Agent A"}'::jsonb, now(), now()),
    ('a2000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'call-qa-agent-b@example.invalid', '', now(),
     '{}'::jsonb, '{"full_name":"CALL QA Agent B"}'::jsonb, now(), now());

  SELECT account_id INTO v_account
  FROM public.profiles
  WHERE user_id = 'a2000000-0000-4000-8000-000000000001';
  IF v_account IS NULL THEN RAISE EXCEPTION 'CALL02_QA_AGENT_A_PROFILE_MISSING'; END IF;

  UPDATE public.profiles
  SET account_id = v_account, account_role = 'agent'
  WHERE user_id = 'a2000000-0000-4000-8000-000000000002';

  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE user_id = 'a2000000-0000-4000-8000-000000000002'
      AND account_id = v_account AND account_role = 'agent'
  ) THEN RAISE EXCEPTION 'CALL02_QA_AGENT_B_MEMBERSHIP_SETUP_FAILED'; END IF;

  DELETE FROM public.accounts
  WHERE owner_user_id = 'a2000000-0000-4000-8000-000000000002';

  PERFORM public.whatsapp_call_event_apply(
    v_account, '740434745820831', 'wacid.qa-concurrency', repeat('c', 64),
    'connect', 1795120000, 'USER_INITIATED',
    'PE.qa-concurrency', '51911111111', 'PE.qa-concurrency', NULL,
    'CALL QA synthetic contact', 'offered', NULL, NULL, NULL, NULL, NULL, NULL
  );
END
$qa$;
SQL

account_id="$(psql "$db_url" -X -v ON_ERROR_STOP=1 -qAtc "SELECT account_id FROM public.profiles WHERE user_id = '$user_a'")"
if [[ -z "$account_id" ]]; then
  echo "CALL02_CONCURRENCY=FAIL (synthetic account missing)" >&2
  exit 1
fi

# A small common delay makes both independent sessions contend for the same
# row rather than relying on shell process scheduling to overlap by chance.
psql "$db_url" -X -v ON_ERROR_STOP=1 -qAtc \
  "SELECT pg_sleep(0.25); SELECT public.whatsapp_call_claim('$account_id', '$phone_number_id', '$call_id', '$user_a')" \
  >"$tmp_dir/agent-a.out" &
pid_a=$!
psql "$db_url" -X -v ON_ERROR_STOP=1 -qAtc \
  "SELECT pg_sleep(0.25); SELECT public.whatsapp_call_claim('$account_id', '$phone_number_id', '$call_id', '$user_b')" \
  >"$tmp_dir/agent-b.out" &
pid_b=$!
wait "$pid_a"
wait "$pid_b"

result_a="$(tail -n 1 "$tmp_dir/agent-a.out" | tr -d '\r[:space:]')"
result_b="$(tail -n 1 "$tmp_dir/agent-b.out" | tr -d '\r[:space:]')"
if ! { [[ "$result_a" == "t" && "$result_b" == "f" ]] || [[ "$result_a" == "f" && "$result_b" == "t" ]]; }; then
  echo "CALL02_CONCURRENCY=FAIL (race results agent-a=$result_a agent-b=$result_b)" >&2
  exit 1
fi

winner="$(psql "$db_url" -X -v ON_ERROR_STOP=1 -qAtc "SELECT claimed_by_user_id FROM public.whatsapp_call_sessions WHERE phone_number_id = '$phone_number_id' AND call_id = '$call_id'")"
if [[ "$winner" != "$user_a" && "$winner" != "$user_b" ]]; then
  echo "CALL02_CONCURRENCY=FAIL (winning agent not persisted)" >&2
  exit 1
fi

# Verify lease expiry transfers ownership and the new owner can release it.
other="$user_a"
[[ "$winner" == "$user_a" ]] && other="$user_b"
psql "$db_url" -X -v ON_ERROR_STOP=1 -q <<SQL
UPDATE public.whatsapp_call_sessions
SET claim_expires_at = now() - interval '1 second'
WHERE phone_number_id = '$phone_number_id' AND call_id = '$call_id';
SQL
release_claim="$(psql "$db_url" -X -v ON_ERROR_STOP=1 -qAtc "SELECT public.whatsapp_call_claim('$account_id', '$phone_number_id', '$call_id', '$other')")"
if [[ "$release_claim" != "t" ]]; then
  echo "CALL02_CONCURRENCY=FAIL (expired lease was not claimable)" >&2
  exit 1
fi
release_result="$(psql "$db_url" -X -v ON_ERROR_STOP=1 -qAtc "SELECT public.whatsapp_call_release('$account_id', '$phone_number_id', '$call_id', '$other')")"
if [[ "$release_result" != "t" ]]; then
  echo "CALL02_CONCURRENCY=FAIL (claim owner could not release lease)" >&2
  exit 1
fi

still_claimed="$(psql "$db_url" -X -v ON_ERROR_STOP=1 -qAtc "SELECT claimed_by_user_id IS NOT NULL FROM public.whatsapp_call_sessions WHERE phone_number_id = '$phone_number_id' AND call_id = '$call_id'")"
if [[ "$still_claimed" != "f" ]]; then
  echo "CALL02_CONCURRENCY=FAIL (release left a claim behind)" >&2
  exit 1
fi

echo "CALL02_CONCURRENCY=PASS (exactly one simultaneous claimant; lease expiry and release verified)"
