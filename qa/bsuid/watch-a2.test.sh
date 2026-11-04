#!/usr/bin/env bash
# Regression QA of the A2 detector of bsuid_watch.sh (self-contained: a disposable PostgreSQL with only the tables the watch reads, NO schema dump needed).
# Usage: qa/bsuid/watch-a2.test.sh        Needs docker and the postgres:16-alpine image. Touches nothing but its own container. Exit 0 = every check passed.
# Reproduces the incident of 2026-11-03: one customer sent the same keyword text twice, 85 s apart; two legitimate runs of one flow sent the same 5 images and the
# old "same contact + same media_url within 10 min" rule switched the whole account off.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); C=wa-bsuid-watch-a2; W=$(mktemp -d); cp "$HERE/bsuid_watch.sh" "$HERE/flow_pilot.sh" "$W/"
trap 'docker rm -f $C >/dev/null 2>&1; rm -rf "$W"' EXIT
docker rm -f $C >/dev/null 2>&1
docker run -d --name $C --network none -e POSTGRES_PASSWORD=x postgres:16-alpine >/dev/null
for i in $(seq 1 40); do docker exec $C pg_isready -U postgres -q && break; sleep 1; done; sleep 2
P(){ docker exec -i $C psql -U postgres -d postgres -X -At -v ON_ERROR_STOP=1 "$@"; }
P -q <<'SQL'
create table contacts(id uuid primary key default gen_random_uuid(), account_id uuid, phone_optional boolean);
create table conversations(id uuid primary key default gen_random_uuid(), account_id uuid, contact_id uuid);
create table messages(id uuid primary key default gen_random_uuid(), conversation_id uuid, sender_type text, media_url text, content_text text, created_at timestamptz default now());
create table flow_runs(id uuid primary key default gen_random_uuid(), account_id uuid, contact_id uuid, status text default 'completed', end_reason text, started_at timestamptz default now(), ended_at timestamptz);
create table flow_run_events(id uuid primary key default gen_random_uuid(), flow_run_id uuid, event_type text, node_key text, payload jsonb default '{}', created_at timestamptz default now());
create table bsuid_flow_settings(account_id uuid primary key, flows_enabled boolean not null default false, note text, updated_at timestamptz default now(), max_contact_sends_per_hour int default 60, max_account_sends_per_hour int default 1200);
create table bsuid_flow_authorizations(account_id uuid, flow_id uuid, enabled boolean default true);
create table contact_identity_audit(id uuid primary key default gen_random_uuid(), account_id uuid, contact_id uuid, event text, detail jsonb default '{}', created_at timestamptz default now());
-- mkrun: one run of a flow for a contact. p_meta = inbound Meta message id (NULL = manual start); each node i enters once and sends p_sends[i] times (a value above 1 = the engine double-sent that node).
create function mkrun(p_acc uuid, p_c uuid, p_meta text, p_ago interval, p_nodes text[], p_urls text[], p_sends int[]) returns uuid language plpgsql as $f$
declare r uuid := gen_random_uuid(); cv uuid; i int; k int;
begin
  select id into cv from conversations where contact_id = p_c limit 1;
  insert into flow_runs(id, account_id, contact_id, started_at) values (r, p_acc, p_c, now() - p_ago);
  insert into flow_run_events(flow_run_id, event_type, node_key, payload, created_at) values (r, 'started', 'start', case when p_meta is null then '{"trigger_type":"manual"}'::jsonb else jsonb_build_object('trigger_type','keyword','meta_message_id',p_meta) end, now() - p_ago);
  for i in 1..array_length(p_nodes, 1) loop
    insert into flow_run_events(flow_run_id, event_type, node_key, payload, created_at) values (r, 'node_entered', p_nodes[i], '{"node_type":"send_media"}', now() - p_ago);
    for k in 1..p_sends[i] loop
      insert into flow_run_events(flow_run_id, event_type, node_key, payload, created_at) values (r, 'message_sent', p_nodes[i], '{"node_type":"send_media","recipient_kind":"bsuid"}', now() - p_ago);
      insert into messages(conversation_id, sender_type, media_url, created_at) values (cv, 'bot', p_urls[i], now() - p_ago);
    end loop;
  end loop;
  return r;
end $f$;
-- ev: one event of a run at a given age; mkrun0: a run with only its started event (the tests then add node_entered / send_intent / message_sent by hand)
create function ev(r uuid, t text, node text, pl jsonb, ago interval) returns void language sql as $f$
  insert into flow_run_events(flow_run_id, event_type, node_key, payload, created_at) values (r, t, node, pl, now() - ago) $f$;
create function mkrun0(p_acc uuid, p_c uuid, p_meta text, p_ago interval) returns uuid language plpgsql as $f$
declare r uuid := gen_random_uuid();
begin
  insert into flow_runs(id, account_id, contact_id, started_at) values (r, p_acc, p_c, now() - p_ago);
  perform ev(r, 'started', 'start', jsonb_build_object('trigger_type','keyword','meta_message_id',p_meta), p_ago);
  return r;
end $f$;
SQL
A=a1a1a1a1-0000-4000-8000-00000000000a; B=b2b2b2b2-0000-4000-8000-00000000000b
FAILS=0
chk(){ if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1 (expected '$3', got '$2')"; FAILS=$((FAILS+1)); fi; }
WATCH(){ WATCH_CONTAINER=$C WATCH_DB=postgres WATCH_LOG=$W/watch.log WATCH_LOCK=$W/watch.lock WATCH_KILL_CMD="bash $W/flow_pilot.sh kill" FLOW_PILOT_CONTAINER=$C FLOW_PILOT_DB=postgres FLOW_PILOT_LOG=$W/fp.log bash "$W/bsuid_watch.sh" "$@"; }
last(){ tail -1 "$W/watch.log"; }
has(){ last | grep -c -- "$1"; }
master(){ P -c "select flows_enabled from bsuid_flow_settings where account_id='$1'"; }
auths(){ P -c "select count(*) from bsuid_flow_authorizations where account_id='$1' and enabled"; }
# fresh state: contact (hidden number) + conversation per scenario, master switch on, one authorization
fresh(){ P -q -c "truncate flow_run_events, flow_runs, messages, conversations, contacts, contact_identity_audit, bsuid_flow_authorizations, bsuid_flow_settings; insert into bsuid_flow_settings(account_id,flows_enabled) values ('$A',true),('$B',true); insert into bsuid_flow_authorizations(account_id,flow_id) values ('$A',gen_random_uuid()),('$B',gen_random_uuid())"; }
newc(){ local id; id=$(P -q -c "insert into contacts(account_id,phone_optional) values ('$1',$2) returning id"); P -q -c "insert into conversations(account_id,contact_id) values ('$1','$id')"; echo "$id"; }
N5="{send_media,send_media_2,send_media_3,send_media_4,send_media_5}"; U5="{https://cdn.test/1,https://cdn.test/2,https://cdn.test/3,https://cdn.test/4,https://cdn.test/5}"; S5="{1,1,1,1,1}"

echo "== 1. the incident: two inbound messages 85 s apart, two legitimate runs, the same 5 images twice"
fresh; X=$(newc $A true)
P -q -c "select mkrun('$A','$X','wamid.INBOUND-1', interval '86 seconds', '$N5', '$U5', '$S5'), mkrun('$A','$X','wamid.INBOUND-2', interval '1 second', '$N5', '$U5', '$S5')" >/dev/null
WATCH; R=$?
chk "incident: exit 0 (no alert)" "$R" "0"
chk "incident: master switch still on" "$(master $A)" "t"
chk "incident: authorization still enabled" "$(auths $A)" "1"
chk "incident: no A2 / A2d / breaker in the log" "$(has 'A2\|BREAKER')" "0"
chk "incident: recorded as an explained repeat" "$(has 'repeat_ok10m=1')" "1"

echo "== 2. one inbound message starts the flow twice (accidental duplicate runs) -> breaker"
fresh; X=$(newc $A true)
P -q -c "select mkrun('$A','$X','wamid.SAME', interval '30 seconds', '$N5', '$U5', '$S5'), mkrun('$A','$X','wamid.SAME', interval '29 seconds', '$N5', '$U5', '$S5')" >/dev/null
WATCH; R=$?
chk "same inbound twice: exit 1" "$R" "1"
chk "same inbound twice: A2 duplicate_runs=1 raised" "$(has 'A2(duplicate_send=0,duplicate_runs=1)')" "1"
chk "same inbound twice: breaker tripped, master off" "$(master $A)" "f"
chk "same inbound twice: authorizations disabled" "$(auths $A)" "0"

echo "== 3. one run sends one media node twice (accidental double send) -> breaker"
fresh; X=$(newc $A true)
P -q -c "select mkrun('$A','$X','wamid.ONE', interval '20 seconds', '{send_media,send_media_2}', '{https://cdn.test/1,https://cdn.test/2}', '{2,1}')" >/dev/null
WATCH; R=$?
chk "double send in one run: exit 1" "$R" "1"
chk "double send in one run: A2 duplicate_send=1 raised" "$(has 'A2(duplicate_send=1,duplicate_runs=0)')" "1"
chk "double send in one run: master off" "$(master $A)" "f"

echo "== 4. intentional repeat: one run uses the same image at two different nodes -> silent"
fresh; X=$(newc $A true)
P -q -c "select mkrun('$A','$X','wamid.ONE', interval '20 seconds', '{send_media,send_media_2}', '{https://cdn.test/1,https://cdn.test/1}', '{1,1}')" >/dev/null
WATCH; R=$?
chk "intentional repeat: exit 0" "$R" "0"
chk "intentional repeat: no A2/A2d/breaker" "$(has 'A2\|BREAKER')" "0"
chk "intentional repeat: master on" "$(master $A)" "t"

echo "== 5. insufficient data: manual start (no inbound id) + the same image twice -> diagnostic only, NEVER the breaker"
fresh; X=$(newc $A true)
P -q -c "select mkrun('$A','$X',NULL, interval '60 seconds', '{send_media}', '{https://cdn.test/1}', '{1}'), mkrun('$A','$X',NULL, interval '10 seconds', '{send_media}', '{https://cdn.test/1}', '{1}')" >/dev/null
WATCH; R=$?
chk "unexplained repeat: exit 1 (alert)" "$R" "1"
chk "unexplained repeat: A2d diagnostic raised" "$(has 'A2d(unexplained_repeat=1')" "1"
chk "unexplained repeat: no breaker" "$(has BREAKER)" "0"
chk "unexplained repeat: master still on" "$(master $A)" "t"
fresh; X=$(newc $A true)
P -q -c "insert into messages(conversation_id,sender_type,media_url) select id,'bot','https://cdn.test/1' from conversations where contact_id='$X' union all select id,'bot','https://cdn.test/1' from conversations where contact_id='$X'"
WATCH; chk "same image twice with no run at all: diagnostic, no breaker" "$(has 'A2d(')$(has BREAKER)" "10"

echo "== 6. phone-visible contacts are never read"
fresh; X=$(newc $A false)
P -q -c "select mkrun('$A','$X','wamid.SAME', interval '30 seconds', '$N5', '$U5', '$S5'), mkrun('$A','$X','wamid.SAME', interval '29 seconds', '$N5', '$U5', '$S5')" >/dev/null
WATCH; R=$?; chk "phone contact duplicate: exit 0, master on" "$R$(master $A)" "0t"

echo "== 7. the other protections are unchanged"
fresh; X=$(newc $A true)
P -q -c "insert into flow_runs(account_id,contact_id,status,end_reason,ended_at) select '$A','$X','failed','send_media_failed',now() from generate_series(1,3)"
WATCH; R=$?; chk "A1: 3 failed runs trip the breaker" "$R$(has 'A1(failed_runs=3)')$(master $A)" "11f"
fresh; X=$(newc $A true)
P -q -c "insert into contact_identity_audit(account_id,contact_id,event,detail) values ('$A','$X','send_blocked','{\"code\":\"rate_limited_contact\"}')"
WATCH; R=$?; chk "A3: a refused send alerts but does not trip" "$R$(has 'A3(rate_limited=1)')$(has BREAKER)$(master $A)" "110t"
fresh; X=$(newc $A true)
P -q -c "update bsuid_flow_settings set max_account_sends_per_hour=10 where account_id='$A'; insert into messages(conversation_id,sender_type,content_text) select id,'bot','x' from conversations c, generate_series(1,9) where c.contact_id='$X'"
WATCH; R=$?; chk "A4: sends above 80% of the ceiling alert without tripping" "$R$(has 'A4(sends_1h=9/10)')$(has BREAKER)$(master $A)" "110t"

echo "== 8. account isolation: a REAL duplicate in account B is neither seen nor switched off when only A is watched"
fresh; Y=$(newc $B true)
P -q -c "select mkrun('$B','$Y','wamid.SAME', interval '30 seconds', '$N5', '$U5', '$S5'), mkrun('$B','$Y','wamid.SAME', interval '29 seconds', '$N5', '$U5', '$S5')" >/dev/null
WATCH_ACCOUNTS=$A WATCH; R=$?
chk "B duplicate, only A watched: exit 0, B master on, B auth enabled" "$R$(master $B)$(auths $B)" "0t1"
WATCH_ACCOUNTS=$B WATCH; R=$?
chk "B watched: breaker trips B only, A untouched" "$R$(master $B)$(master $A)$(auths $A)" "1ft1"

echo "== 9. send_intent is not an entry (tracked flows write node_entered(reason=send_intent) before each Meta call)"
E='{"node_type":"send_media"}'; I='{"node_type":"send_media","reason":"send_intent"}'; S='{"node_type":"send_media","recipient_kind":"bsuid"}'
fresh; X=$(newc $A true)
P -q -c "select ev(r,'node_entered','m',('$E')::jsonb,'30 seconds'), ev(r,'node_entered','m',('$I')::jsonb,'30 seconds'), ev(r,'message_sent','m',('$S')::jsonb,'29 seconds') from (select mkrun0('$A','$X','wamid.T1','31 seconds') r) q" >/dev/null
WATCH; R=$?; chk "entry + send_intent + ONE send: no alert, master on" "$R$(has 'A2')$(master $A)" "00t"
fresh; X=$(newc $A true)
P -q -c "select ev(r,'node_entered','m',('$E')::jsonb,'30 seconds'), ev(r,'node_entered','m',('$I')::jsonb,'30 seconds'), ev(r,'message_sent','m',('$S')::jsonb,'29 seconds'), ev(r,'message_sent','m',('$S')::jsonb,'28 seconds') from (select mkrun0('$A','$X','wamid.T2','31 seconds') r) q" >/dev/null
WATCH; R=$?; chk "one real entry + one send_intent + TWO sends: A2 trips" "$R$(has 'A2(duplicate_send=1')$(master $A)" "11f"
fresh; X=$(newc $A true)
P -q -c "select ev(r,'node_entered','m',('$E')::jsonb,'30 seconds'), ev(r,'node_entered','m',('$I')::jsonb,'30 seconds'), ev(r,'node_entered','m',('$I')::jsonb,'29 seconds'), ev(r,'message_sent','m',('$S')::jsonb,'29 seconds'), ev(r,'message_sent','m',('$S')::jsonb,'28 seconds') from (select mkrun0('$A','$X','wamid.T3','31 seconds') r) q" >/dev/null
WATCH; R=$?; chk "one real entry + TWO send_intents + two sends: A2 trips (intents hide nothing)" "$R$(has 'A2(duplicate_send=1')$(master $A)" "11f"
fresh; X=$(newc $A true)
P -q -c "select ev(r,'node_entered','m',('$E')::jsonb,'40 seconds'), ev(r,'node_entered','m',('$I')::jsonb,'40 seconds'), ev(r,'message_sent','m',('$S')::jsonb,'39 seconds'), ev(r,'node_entered','m',('$E')::jsonb,'20 seconds'), ev(r,'node_entered','m',('$I')::jsonb,'20 seconds'), ev(r,'message_sent','m',('$S')::jsonb,'19 seconds') from (select mkrun0('$A','$X','wamid.T4','41 seconds') r) q" >/dev/null
WATCH; R=$?; chk "TWO real entries (a loop) + two sends: no alert, master on" "$R$(has 'A2')$(master $A)" "00t"

echo "== 10. time window: the whole history of a recent run counts, an old duplicate outside the window does not"
fresh; X=$(newc $A true)
P -q -c "select ev(r,'node_entered','m',('$E')::jsonb,'40 minutes'), ev(r,'node_entered','m',('$I')::jsonb,'40 minutes'), ev(r,'message_sent','m',('$S')::jsonb,'40 minutes'), ev(r,'message_sent','m',('$S')::jsonb,'1 minute') from (select mkrun0('$A','$X','wamid.T5','40 minutes') r) q" >/dev/null
WATCH; R=$?; chk "flow started 40 min ago, duplicate send 1 min ago: A2 trips" "$R$(has 'A2(duplicate_send=1')$(master $A)" "11f"
fresh; X=$(newc $A true)
P -q -c "select ev(r,'node_entered','m',('$E')::jsonb,'40 minutes'), ev(r,'message_sent','m',('$S')::jsonb,'40 minutes'), ev(r,'message_sent','m',('$S')::jsonb,'39 minutes') from (select mkrun0('$A','$X','wamid.T6','40 minutes') r) q" >/dev/null
WATCH; R=$?; chk "duplicate that happened 40 min ago (outside the window): no alert, master on" "$R$(has 'A2')$(master $A)" "00t"
fresh; X=$(newc $A true)
P -q -c "select ev(r,'node_entered','m',('$E')::jsonb,'40 minutes'), ev(r,'message_sent','m',('$S')::jsonb,'40 minutes'), ev(r,'node_entered','m',('$E')::jsonb,'1 minute'), ev(r,'message_sent','m',('$S')::jsonb,'1 minute') from (select mkrun0('$A','$X','wamid.T7','40 minutes') r) q" >/dev/null
WATCH; R=$?; chk "old legit send + recent send of a second real entry: no alert" "$R$(has 'A2')$(master $A)" "00t"
fresh; X=$(newc $A true)
P -q -c "select mkrun0('$A','$X','wamid.SAME2','25 minutes'), mkrun0('$A','$X','wamid.SAME2','1 minute') " >/dev/null
WATCH; R=$?; chk "same inbound started a second run recently (twin 25 min old): A2 trips" "$R$(has 'A2(duplicate_send=0,duplicate_runs=1)')$(master $A)" "11f"
fresh; X=$(newc $A true)
P -q -c "select mkrun0('$A','$X','wamid.SAME3','50 minutes'), mkrun0('$A','$X','wamid.SAME3','49 minutes')" >/dev/null
WATCH; R=$?; chk "old duplicate runs, nothing recent: no alert" "$R$(has 'A2')$(master $A)" "00t"

echo; if [ "$FAILS" = 0 ]; then echo "ALL CHECKS PASSED"; else echo "$FAILS CHECK(S) FAILED"; exit 1; fi
