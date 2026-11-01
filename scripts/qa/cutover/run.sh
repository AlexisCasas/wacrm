#!/usr/bin/env bash
# QA of scripts/ops/cutover/{flows-set-status.sql,cutover-watch.sql} against a DISPOSABLE Postgres (no network, synthetic data, schema from a schema-only dump).
#   WACRM_SCHEMA_DUMP=/path/schema.dump bash scripts/qa/cutover/run.sh
set -uo pipefail
: "${WACRM_SCHEMA_DUMP:?}"
HERE="$(cd "$(dirname "$0")" && pwd)"; REPO="$(cd "$HERE/../../.." && pwd)"; OPS="$REPO/scripts/ops/cutover"; NAME=qa-cut-pg
docker rm -f $NAME >/dev/null 2>&1 || true
trap 'docker rm -f $NAME >/dev/null 2>&1 || true' EXIT
docker run -d --name $NAME --network none --memory 1g -e POSTGRES_PASSWORD=qa_synthetic_pw supabase/postgres:17.6.1.136 >/dev/null
until docker exec $NAME pg_isready -U postgres -q 2>/dev/null; do sleep 2; done; sleep 6
docker exec -i $NAME pg_restore -s -U supabase_admin -d postgres --no-owner < "$WACRM_SCHEMA_DUMP" >/dev/null 2>&1 || true
PSQL=(docker exec -i $NAME psql -U supabase_admin -d postgres -X -At -q)
sql() { "${PSQL[@]}" -v ON_ERROR_STOP=1 -c "$1" 2>&1; }
runf() { "${PSQL[@]}" -v ON_ERROR_STOP=1 "$@" 2>&1; }
pass=0; fail=0
ok()  { pass=$((pass+1)); echo "PASS  $1"; }
bad() { fail=$((fail+1)); echo "FAIL  $1  ($2)"; }
eq()  { [ "$2" = "$3" ] && ok "$1" || bad "$1" "got [$2] want [$3]"; }
has() { echo "$3" | grep -qE "$2" && ok "$1" || bad "$1" "output: $(echo "$3" | head -3 | tr '\n' ' ')"; }

A=11111111-1111-4111-8111-111111111111; B=22222222-2222-4222-8222-222222222222; U1=a1111111-0000-4000-8000-000000000001; U2=a2222222-0000-4000-8000-000000000001
F1=f1111111-0000-4000-8000-000000000001 # caller (execute_flow -> F2)
F2=f2222222-0000-4000-8000-000000000002 # callee
F3=f3333333-0000-4000-8000-000000000003 # standalone
F4=f4444444-0000-4000-8000-000000000004 # other, must never change
FB=fbbbbbbb-0000-4000-8000-00000000000b # other ACCOUNT
"${PSQL[@]}" -v ON_ERROR_STOP=1 <<SQL >/dev/null
INSERT INTO auth.users (id, aud, role, email) VALUES ('$U1','authenticated','authenticated','a@qa.test'),('$U2','authenticated','authenticated','b@qa.test');
ALTER TABLE public.profiles DISABLE TRIGGER USER; ALTER TABLE public.accounts DISABLE TRIGGER USER;
INSERT INTO public.accounts (id, name, owner_user_id) VALUES ('$A','A','$U1'),('$B','B','$U2');
INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role) VALUES ('$U1','A','a@qa.test','$A','owner'),('$U2','B','b@qa.test','$B','owner');
ALTER TABLE public.profiles ENABLE TRIGGER USER; ALTER TABLE public.accounts ENABLE TRIGGER USER;
INSERT INTO public.flow_execution_defaults (singleton, subflow_execution, durable_wait_execution) VALUES (true, true, true) ON CONFLICT (singleton) DO UPDATE SET subflow_execution=true, durable_wait_execution=true;
INSERT INTO public.flows (id, user_id, account_id, name, status, trigger_type, trigger_config) VALUES
 ('$F1','$U1','$A','caller','draft','keyword','{"keywords":["uno"]}'),('$F2','$U1','$A','callee','draft','keyword','{"keywords":["dos"]}'),
 ('$F3','$U1','$A','standalone','draft','keyword','{"keywords":["tres"]}'),('$F4','$U1','$A','other','draft','keyword','{"keywords":["cuatro"]}'),
 ('$FB','$U2','$B','other account','draft','keyword','{"keywords":["cinco"]}');
INSERT INTO public.flow_nodes (flow_id, node_key, node_type, config) VALUES
 ('$F1','start','start','{"next_node_key":"call"}'),('$F1','call','execute_flow','{"target_flow_id":"$F2","next_node_key":"end"}'),('$F1','end','end','{}'),
 ('$F2','start','start','{"next_node_key":"end"}'),('$F2','end','end','{}'),
 ('$F3','start','start','{"next_node_key":"end"}'),('$F3','end','end','{}');
SQL
st() { sql "select status from public.flows where id='$1'"; }
set_st() { # from to ids expected [account]
  runf -v account_id=${5:-$A} -v from_status=$1 -v to_status=$2 -v flow_ids="$3" -v expected=$4 -f - < "$OPS/flows-set-status.sql"; }
fp() { sql "select md5(string_agg(md5(to_jsonb(f)::text), '|' order by id)) from public.flows f where id not in ($1)"; }

eq "fixture: all five flows start as draft" "$(sql "select count(*) from public.flows where status='draft'")" "5"
# ---- guards that must refuse and write nothing
BASE=$(sql "select md5(string_agg(md5(to_jsonb(f)::text), '|' order by id)) from public.flows f")
START=$(sql "select md5(string_agg(md5((to_jsonb(f)-'updated_at')::text), '|' order by id)) from public.flows f")
out=$(set_st draft active "$F1" 1);                  has "refuses to activate a caller whose sub-flow is still draft (callee_unavailable at run time)" "sub-flow" "$out"
out=$(set_st draft active "$F3,$F3" 2);              has "refuses duplicated ids" "duplicate ids" "$out"
out=$(set_st draft active "$F3,$F2" 3);             has "refuses when the count differs from the expected one" "expected 3 ids, got 2" "$out"
out=$(set_st draft active "$F3,$FB" 2);             has "refuses an id that belongs to another account" "of 2 flows are in this account" "$out"
out=$(set_st active draft "$F3" 1);                  has "refuses when a flow is not in the expected current status" "0 of 1 flows" "$out"
out=$(set_st draft draft "$F3" 1);                   has "refuses from=to" "must be draft<->active" "$out"
out=$(set_st draft archived "$F3" 1);                has "refuses a status other than draft/active" "must be draft<->active" "$out"
out=$(set_st draft active "not-a-uuid" 1);          has "refuses a malformed id" "invalid input syntax for type uuid" "$out"
out=$(set_st draft active "$F3" 1 99999999-9999-4999-8999-999999999999); has "refuses a non-existent account" "account does not exist" "$out"
eq "after every refusal not one flow changed" "$(sql "select md5(string_agg(md5(to_jsonb(f)::text), '|' order by id)) from public.flows f")" "$BASE"
# ---- activate the wave
OTHER_BEFORE=$(fp "'$F1','$F2','$F3'")
out=$(set_st draft active "$F1,$F2,$F3" 3);         has "activates exactly the wave (caller + its callee + a standalone)" "FLOWS_SET_ACTIVE rows=3" "$out"
eq "the three are active" "$(sql "select count(*) from public.flows where id in ('$F1','$F2','$F3') and status='active'")" "3"
eq "the flow outside the list is still draft" "$(st $F4)" "draft"
eq "the flow of the other account is still draft" "$(st $FB)" "draft"
eq "no other flow changed at all (fingerprint of the rest)" "$(fp "'$F1','$F2','$F3'")" "$OTHER_BEFORE"
out=$(set_st draft active "$F3" 1);                  has "a second activation of the same flow is refused (already active)" "0 of 1 flows" "$out"
# ---- rollback with the SAME list
out=$(set_st active draft "$F1,$F2,$F3" 3);         has "rollback pauses exactly the same list" "FLOWS_SET_DRAFT rows=3" "$out"
eq "back to five drafts" "$(sql "select count(*) from public.flows where status='draft'")" "5"
eq "the whole table is byte-identical to the start except updated_at" "$(sql "select md5(string_agg(md5((to_jsonb(f)-'updated_at')::text), '|' order by id)) from public.flows f")" "$START"
# the activation order that matters: the callee on its own first is fine, then the caller
out=$(set_st draft active "$F2" 1);                  has "a callee can be activated first" "FLOWS_SET_ACTIVE rows=1" "$out"
out=$(set_st draft active "$F1" 1);                  has "...and then its caller passes the sub-flow guard (callee already active)" "FLOWS_SET_ACTIVE rows=1" "$out"
out=$(set_st active draft "$F2,$F1" 2) 
sql "update public.flows set status='draft' where status='active'" >/dev/null

# ---- watch (read-only): fixtures for conversations/messages
C1=c1111111-0000-4000-8000-000000000001; C2=c2222222-0000-4000-8000-000000000002; C3=c3333333-0000-4000-8000-000000000003
"${PSQL[@]}" -v ON_ERROR_STOP=1 <<SQL >/dev/null
INSERT INTO public.contacts (id, user_id, account_id, phone, name) VALUES ('d1111111-0000-4000-8000-000000000001','$U1','$A','900000001','x'),('d2222222-0000-4000-8000-000000000002','$U1','$A','900000002','y'),('d3333333-0000-4000-8000-000000000003','$U1','$A','900000003','z');
INSERT INTO public.conversations (id, user_id, account_id, contact_id) VALUES ('$C1','$U1','$A','d1111111-0000-4000-8000-000000000001'),('$C2','$U1','$A','d2222222-0000-4000-8000-000000000002'),('$C3','$U1','$A','d3333333-0000-4000-8000-000000000003');
SQL
W=(-v account_id=$A -v since='2026-01-01 00:00:00+00' -v silence_minutes=3)
watch() { runf "${W[@]}" -f - < "$OPS/cutover-watch.sql"; }
out=$(watch); has "watch: empty window reports OK for failures, duplicates and silence" "OK    failed outbound since window: 0" "$out"
has "watch: ...duplicates OK" "OK    duplicate replies" "$out"
echo "$out" | grep -q "^ALERT" && bad "watch: nothing alerts on an empty window" "$(echo "$out" | grep ^ALERT | head -2)" || ok "watch: nothing alerts on an empty window"
# a healthy conversation: customer asks, bot answers once
sql "insert into public.messages (conversation_id, sender_type, content_type, content_text, status, created_at) values ('$C1','customer','text','hola','delivered', now()-interval '10 minutes'),('$C1','bot','text','respuesta','delivered', now()-interval '9 minutes')" >/dev/null
out=$(watch); echo "$out" | grep -q "^ALERT" && bad "watch: a normal answered conversation raises no alert" "$(echo "$out" | grep ^ALERT | head -2)" || ok "watch: a normal answered conversation raises no alert"
# duplicate replies (two engines answering the same inbound)
sql "insert into public.messages (conversation_id, sender_type, content_type, content_text, status, created_at) values ('$C2','customer','text','hola','delivered', now()-interval '8 minutes'),('$C2','bot','text','misma respuesta','delivered', now()-interval '7 minutes'),('$C2','bot','text','misma respuesta','delivered', now()-interval '7 minutes' + interval '20 seconds')" >/dev/null
out=$(watch); has "watch: the same reply twice within 60 s raises an ALERT" "ALERT duplicate replies .*: 1" "$out"
# a failed outbound
sql "insert into public.messages (conversation_id, sender_type, content_type, content_text, status, created_at) values ('$C1','bot','text','otra','failed', now()-interval '5 minutes')" >/dev/null
out=$(watch); has "watch: a failed outbound raises an ALERT" "ALERT failed outbound since window: 1" "$out"
# silence: customer wrote 6 minutes ago and nobody answered
sql "insert into public.messages (conversation_id, sender_type, content_type, content_text, status, created_at) values ('$C3','customer','text','¿hay alguien?','delivered', now()-interval '6 minutes')" >/dev/null
out=$(watch); has "watch: an unanswered inbound older than 3 min raises an ALERT" "ALERT unanswered inbound older than 3 min: 1" "$out"
out=$(runf -v account_id=$A -v since='2026-01-01 00:00:00+00' -v silence_minutes=10 -f - < "$OPS/cutover-watch.sql"); has "watch: ...but not before the silence threshold" "OK    unanswered inbound older than 10 min: 0" "$out"
eq "watch is read-only: the message count only changed by my fixtures (7)" "$(sql "select count(*) from public.messages")" "7"
eq "watch is read-only: no flow changed" "$(sql "select count(*) from public.flows where status<>'draft'")" "0"
grep -qiE "^\s*(insert|update|delete|truncate|alter|drop|create)\b" "$OPS/cutover-watch.sql" && bad "watch: script contains no write statements" "found" || ok "watch: script contains no write statements"
echo "----"; echo "PASS=$pass FAIL=$fail"; [ "$fail" -eq 0 ]
