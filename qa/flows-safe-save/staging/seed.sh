#!/usr/bin/env bash
# Two synthetic accounts (A = the "Pilot-like" tester, B = another company) and one draft flow in B, used to prove isolation.
set -euo pipefail
source "$(dirname "$0")/lib.sh"; load_env
signup() { curl -s -o /dev/null -w '%{http_code}' -X POST "$URL/auth/v1/signup" -H "apikey: $ANON_KEY" -H 'content-type: application/json' \
  -d "{\"email\":\"$1\",\"password\":\"$USER_PASSWORD\",\"data\":{\"full_name\":\"$2\"}}"; }
echo "signup A: $(signup "$USER_A_EMAIL" 'QA Owner A')  signup B: $(signup "$USER_B_EMAIL" 'QA Owner B')"
psql_db <<SQL
UPDATE public.profiles SET locale = 'en' WHERE user_id IN (SELECT id FROM auth.users WHERE email IN ('$USER_A_EMAIL', '$USER_B_EMAIL'));
DO \$\$
DECLARE ub uuid; ab uuid; f uuid;
BEGIN
  SELECT id INTO ub FROM auth.users WHERE email = '$USER_B_EMAIL';
  SELECT account_id INTO ab FROM public.profiles WHERE user_id = ub;
  IF ab IS NULL THEN RAISE EXCEPTION 'account B was not provisioned'; END IF;
  INSERT INTO public.flows (user_id, account_id, name, trigger_type, entry_node_id)
    VALUES (ub, ab, 'OTHER COMPANY FLOW - must never change', 'manual', 'start') RETURNING id INTO f;
  INSERT INTO public.flow_nodes (flow_id, node_key, node_type, config) VALUES
    (f, 'start', 'send_message', '{"text":"belongs to company B","next_node_key":"end"}'), (f, 'end', 'end', '{}');
END \$\$;
SQL
echo "accounts: $(psql_db -Atc "select count(*) from public.accounts") | profiles: $(psql_db -Atc "select email||'='||(select account_role::text from public.profiles p where p.user_id=u.id) from auth.users u order by email" | tr '\n' ' ')"
