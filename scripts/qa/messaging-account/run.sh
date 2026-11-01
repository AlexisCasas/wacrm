#!/usr/bin/env bash
# QA of migration 20261103000000 + the guarded connect/disconnect/rollback scripts, against a DISPOSABLE Postgres (no network, no published ports,
# synthetic data). Schema comes from a SCHEMA-ONLY dump of the WACRM database (no rows): WACRM_SCHEMA_DUMP=/path/schema.dump
#   (docker exec supabase-db pg_dump -U postgres -d postgres -Fc --schema-only -n public > schema.dump)
# Prints PASS lines; any failed assertion aborts with a non-zero exit.
set -uo pipefail
: "${WACRM_SCHEMA_DUMP:?}"
HERE="$(cd "$(dirname "$0")" && pwd)"; REPO="$(cd "$HERE/../../.." && pwd)"; NAME=qa-ma-pg
MIG="$REPO/supabase/migrations/20261103000000_whatsapp_config_messaging_account_id.sql"; OPS="$REPO/scripts/ops/messaging-account"
docker rm -f $NAME >/dev/null 2>&1 || true
trap 'docker rm -f $NAME >/dev/null 2>&1 || true' EXIT
docker run -d --name $NAME --network none --memory 1g -e POSTGRES_PASSWORD=qa_synthetic_pw supabase/postgres:17.6.1.136 >/dev/null
until docker exec $NAME pg_isready -U postgres -q 2>/dev/null; do sleep 2; done; sleep 6
docker exec -i $NAME pg_restore -s -U supabase_admin -d postgres --no-owner < "$WACRM_SCHEMA_DUMP" >/dev/null 2>&1 || true

PSQL=(docker exec -i $NAME psql -U supabase_admin -d postgres -X -At -q)
sql() { "${PSQL[@]}" -v ON_ERROR_STOP=1 -c "$1"; }
runf() { "${PSQL[@]}" -v ON_ERROR_STOP=1 "$@" 2>&1; }     # stdin = script
pass=0; fail=0
ok()   { pass=$((pass+1)); echo "PASS  $1"; }
bad()  { fail=$((fail+1)); echo "FAIL  $1  ($2)"; }
eq()   { [ "$2" = "$3" ] && ok "$1" || bad "$1" "got [$2] want [$3]"; }
fails_with() { # name pattern output
  if echo "$3" | grep -qE "$2"; then ok "$1"; else bad "$1" "output: $(echo "$3" | head -3 | tr '\n' ' ')"; fi; }

L=11111111-1111-4111-8111-111111111111; A=22222222-2222-4222-8222-222222222222; K=33333333-3333-4333-8333-333333333333
UL=a1111111-0000-4000-8000-000000000001; UA=a2222222-0000-4000-8000-000000000001; UKO=a3333333-0000-4000-8000-000000000001; UKG=a3333333-0000-4000-8000-000000000002; UKX=a3333333-0000-4000-8000-000000000003
CT="aaaaaaaaaaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:cccccccccccccccccccccccccccccccc"
CT2="dddddddddddddddddddddddd:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee:ffffffffffffffffffffffffffffffff"
MA=1111111111111111; OLDW=7777777777777777; PN=2222222222222222

# ---- synthetic world (accounts L, A already connected like accounts L and A; K is the empty destination)
"${PSQL[@]}" -v ON_ERROR_STOP=1 <<SQL >/dev/null
INSERT INTO auth.users (id, aud, role, email) VALUES ('$UL','authenticated','authenticated','l@qa.test'),('$UA','authenticated','authenticated','a@qa.test'),
 ('$UKO','authenticated','authenticated','ko@qa.test'),('$UKG','authenticated','authenticated','kg@qa.test'),('$UKX','authenticated','authenticated','kx@qa.test');
ALTER TABLE public.profiles DISABLE TRIGGER USER; ALTER TABLE public.accounts DISABLE TRIGGER USER;
INSERT INTO public.accounts (id, name, owner_user_id) VALUES ('$L','account L','$UL'),('$A','account A','$UA'),('$K','account K','$UKO');
INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role) VALUES ('$UL','L','l@qa.test','$L','owner'),('$UA','A','a@qa.test','$A','owner'),
 ('$UKO','K owner','ko@qa.test','$K','owner'),('$UKG','K agent','kg@qa.test','$K','agent'),('$UKX','K viewer','kx@qa.test','$K','viewer');
ALTER TABLE public.profiles ENABLE TRIGGER USER; ALTER TABLE public.accounts ENABLE TRIGGER USER;
INSERT INTO public.whatsapp_config (account_id, user_id, phone_number_id, waba_id, access_token, verify_token, app_secret, status, connected_at, registered_at, subscribed_apps_at)
 VALUES ('$L','$UL','3333333333333333','5555555555555555','$CT','$CT','$CT','connected',now(),now(),now()),
        ('$A','$UA','4444444444444444','6666666666666666','$CT2','$CT2','$CT2','connected',now(),now(),now());
GRANT SELECT ON public.whatsapp_config TO authenticated;
SQL

# Fingerprint of a row WITHOUT the new column and without updated_at (the set_updated_at trigger legitimately moves it on any UPDATE, which the
# constraint probes below perform and revert). Everything else - ids, owner, ciphertexts, timestamps - must be byte-identical.
rowhash() { sql "select md5((to_jsonb(w) - 'messaging_account_id' - 'updated_at')::text) from public.whatsapp_config w where account_id='$1'"; }
rowhash_nocol() { rowhash "$1"; }
HL0=$(rowhash $L); HA0=$(rowhash $A)

eq "before: the column does not exist yet" "$(sql "select count(*) from information_schema.columns where table_name='whatsapp_config' and column_name='messaging_account_id'")" "0"

# ---- migration
out=$(runf < "$MIG"); eq "migration applies cleanly" "$(echo "$out" | grep -ci error)" "0"
out=$(runf < "$MIG"); eq "migration is idempotent (second run, no error)" "$(echo "$out" | grep -ci error)" "0"
eq "column is text and nullable" "$(sql "select data_type||'/'||is_nullable from information_schema.columns where table_name='whatsapp_config' and column_name='messaging_account_id'")" "text/YES"
eq "exactly one format constraint" "$(sql "select count(*) from pg_constraint where conname='whatsapp_config_messaging_account_id_format'")" "1"
eq "account L row byte-identical except the new NULL column" "$(rowhash_nocol $L)" "$HL0"
eq "account A row byte-identical except the new NULL column" "$(rowhash_nocol $A)" "$HA0"
eq "existing rows keep messaging_account_id NULL" "$(sql "select count(*) from public.whatsapp_config where messaging_account_id is not null")" "0"

# ---- constraint
for v in 12345 1111111111111111 1234567890123456789012345; do
  r=$(sql "with u as (update public.whatsapp_config set messaging_account_id='$v' where account_id='$A' returning 1) select count(*) from u" 2>&1); sql "update public.whatsapp_config set messaging_account_id=NULL where account_id='$A'" >/dev/null
  eq "CHECK accepts [$v]" "$r" "1"; done
for v in 1234 12345678901234567890123456 abc "11 007" "1111111111111111x" "" "-1234567"; do
  r=$(sql "update public.whatsapp_config set messaging_account_id='$v' where account_id='$A'" 2>&1)
  echo "$r" | grep -q "violates check constraint" && ok "CHECK rejects [$v]" || bad "CHECK rejects [$v]" "$r"; done
eq "account A row still untouched after the constraint probes" "$(rowhash_nocol $A)" "$HA0"

# ---- connect
conn() { # extra psql -v args...
  runf -v account_id=$K -v actor_user_id=$UKO -v phone_number_id=$PN -v waba_id=$MA -v messaging_account_id=$MA -v cipher_token="$CT" -v cipher_verify="$CT" -v cipher_app_secret="$CT2" "$@" < "$OPS/connect-account.sql"; }
bad_runs=(
 "actor is an agent|-v actor_user_id=$UKG|not an owner/admin"
 "actor is a viewer|-v actor_user_id=$UKX|not an owner/admin"
 "actor belongs to another account|-v actor_user_id=$UL|not an owner/admin"
 "destination account does not exist|-v account_id=99999999-9999-4999-8999-999999999999|does not exist"
 "token is not ciphertext|-v cipher_token=plaintext-token-value|not GCM ciphertext"
 "phone id with letters|-v phone_number_id=74043x|5-25 digits"
 "messaging account too short|-v messaging_account_id=1234|5-25 digits"
 "phone already configured elsewhere|-v phone_number_id=3333333333333333|already belongs"
)
for entry in "${bad_runs[@]}"; do IFS='|' read -r name args pat <<<"$entry"; out=$(conn $args); fails_with "connect refuses: $name" "$pat" "$out"; done
eq "after the refusals nothing was written" "$(sql "select count(*) from public.whatsapp_config")" "2"
out=$(conn); fails_with "connect inserts exactly one row" "INSERTED_1_ROW" "$out"
eq "now three configurations" "$(sql "select count(*) from public.whatsapp_config")" "3"
eq "account L row untouched by the connect" "$(rowhash $L)" "$HL0"
eq "account A row untouched by the connect" "$(rowhash $A)" "$HA0"
eq "new row: account K, the right ids" "$(sql "select account_id||' '||phone_number_id||' '||waba_id||' '||messaging_account_id||' '||status from public.whatsapp_config where account_id='$K'")" "$K $PN $MA $MA connected"
eq "new row: nothing registered or subscribed (NULL timestamps)" "$(sql "select (registered_at is null)::text||(subscribed_apps_at is null)::text from public.whatsapp_config where account_id='$K'")" "truetrue"
eq "new row: secrets stored exactly as the ciphertext given" "$(sql "select (access_token='$CT')::text||(verify_token='$CT')::text||(app_secret='$CT2')::text from public.whatsapp_config where account_id='$K'")" "truetruetrue"
out=$(conn); fails_with "a second connect is refused (account already has one)" "already has a whatsapp_config" "$out"
out=$(conn -v phone_number_id=2222222222222223); fails_with "another number for the same account is refused" "already has a whatsapp_config" "$out"
eq "still exactly three configurations" "$(sql "select count(*) from public.whatsapp_config")" "3"
out=$(conn -v cipher_verify= -v cipher_app_secret= -v account_id=$A -v actor_user_id=$UA); fails_with "connect never takes over an account that has a configuration" "already has a whatsapp_config" "$out"

# ---- row-level security on the new column (policies are the existing ones)
as() { # user, sql  (one transaction: role + synthetic JWT, then the statement; always rolled back)
  "${PSQL[@]}" -v ON_ERROR_STOP=1 2>&1 <<SQL | tail -1
begin; set local role authenticated;
\o /dev/null
select set_config('request.jwt.claims','{"sub":"$1","role":"authenticated"}',true), set_config('request.jwt.claim.sub','$1',true);
\o
$2;
rollback;
SQL
}
eq "account K owner reads account K's messaging_account_id" "$(as $UKO "select messaging_account_id from public.whatsapp_config")" "$MA"
eq "account K agent reads account K's row only" "$(as $UKG "select count(*) from public.whatsapp_config")" "1"
eq "account L owner sees only account L's row" "$(as $UL "select account_id from public.whatsapp_config")" "$L"
eq "a account K agent cannot change it (policy needs admin): 0 rows" "$(as $UKG "with u as (update public.whatsapp_config set messaging_account_id='55555' returning 1) select count(*) from u")" "0"
eq "account L owner cannot touch account K's row: 0 rows" "$(as $UL "with u as (update public.whatsapp_config set messaging_account_id='55555' where account_id='$K' returning 1) select count(*) from u")" "0"
eq "account K's owner (admin) can change its own messaging_account_id: 1 row" "$(as $UKO "with u as (update public.whatsapp_config set messaging_account_id='55555' returning 1) select count(*) from u")" "1"
eq "account K's value is still the one connected" "$(sql "select messaging_account_id from public.whatsapp_config where account_id='$K'")" "$MA"

# ---- disconnect (rollback of the row)
dis() { runf -v account_id=$K -v phone_number_id=$PN -v messaging_account_id=$MA -v confirm_unsubscribed=yes "$@" < "$OPS/disconnect-account.sql"; }
out=$(dis -v confirm_unsubscribed=no); fails_with "disconnect refuses without the Meta-unsubscribed confirmation" "confirm_unsubscribed=yes is required" "$out"
out=$(dis -v messaging_account_id=99999); fails_with "disconnect refuses a configuration it did not create (other messaging account)" "not the one this procedure created" "$out"
out=$(dis -v phone_number_id=3333333333333333); fails_with "disconnect refuses a different number" "not the one this procedure created" "$out"
out=$(dis -v account_id=$A); fails_with "disconnect cannot delete account A's configuration" "not the one this procedure created" "$out"
out=$(dis -v account_id=$L); fails_with "disconnect cannot delete account L's configuration" "not the one this procedure created" "$out"
eq "after the refusals account K's row is still there" "$(sql "select count(*) from public.whatsapp_config where account_id='$K'")" "1"
# column rollback refuses while a configuration uses it
out=$(runf < "$OPS/rollback-column.sql"); fails_with "column rollback refuses while account K uses the column" "still use messaging_account_id" "$out"
eq "the column is still there" "$(sql "select count(*) from information_schema.columns where table_name='whatsapp_config' and column_name='messaging_account_id'")" "1"
out=$(dis); fails_with "disconnect deletes exactly the one row" "DELETED_1_ROW" "$out"
eq "back to two configurations" "$(sql "select count(*) from public.whatsapp_config")" "2"
eq "account L row untouched after connect + disconnect" "$(rowhash $L)" "$HL0"
eq "account A row untouched after connect + disconnect" "$(rowhash $A)" "$HA0"
out=$(dis); fails_with "a second disconnect is refused (nothing left to remove)" "has no configuration" "$out"

# ---- column rollback, then re-apply
out=$(runf < "$OPS/rollback-column.sql"); eq "column rollback succeeds once nothing uses it" "$(echo "$out" | grep -ci error)" "0"
eq "column and constraint are gone" "$(sql "select (select count(*) from information_schema.columns where table_name='whatsapp_config' and column_name='messaging_account_id')+(select count(*) from pg_constraint where conname='whatsapp_config_messaging_account_id_format')")" "0"
eq "after the schema rollback account L's row is byte-identical to the original" "$(rowhash $L)" "$HL0"
eq "after the schema rollback account A's row is byte-identical to the original" "$(rowhash $A)" "$HA0"
out=$(runf < "$MIG"); eq "the migration can be re-applied after a rollback" "$(echo "$out" | grep -ci error)" "0"

echo "----"; echo "PASS=$pass FAIL=$fail"
[ "$fail" -eq 0 ]
