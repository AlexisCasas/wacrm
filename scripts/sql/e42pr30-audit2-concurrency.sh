#!/usr/bin/env bash
# PR #30 audit round 2, real concurrent sessions. Needs committed fixtures + helpers.
# Q17: two ended runs of ONE conversation, both with a confirmed effect and no Inbox message, repaired at the same time
# in both arrival orders. Usage: e42pr30-audit2-concurrency.sh <container-name>
set -euo pipefail
NAME="$1"; GATE=4849
source "$(dirname "$0")/qa-conc-lib.sh"
M=57000000-0000-4000-8000-0000000000d0
ACC=$(pq -c "select account_id from public.flows where id='50000000-0000-4000-8000-000000000001'")
pq -c "select public.qa_synth_flow('$M','[{\"node_key\":\"m\",\"node_type\":\"send_message\",\"config\":{\"text\":\"hi\",\"next_node_key\":\"x\"}},{\"node_key\":\"x\",\"node_type\":\"end\"}]','m')" >/dev/null

# one conversation, two completed runs (OLD then NEW), both without Inbox messages: prints "<runOld> <runNew> <conversation>"
shared_conv() {
  local r1 r2 e1 e2 conv
  r1=$(pq -c "select public.qa_flow_run_conv('$M', $1)"); pq -c "select public.qa_lease('$r1','w1')" >/dev/null
  e1=$(pq -c "select public.qa_eff_registered_accept('$r1','w1','{\"kind\":\"text\",\"text\":\"OLD\"}','wamid.Q17O$1')")
  pq -c "select public.qa_finish_run('$r1','w1','$e1','completed')" >/dev/null
  conv=$(pq -c "select conversation_id from public.flow_runs where id='$r1'")
  sleep 0.05
  r2=$(pq -c "select public.qa_flow_run_on('$M', '$conv')"); pq -c "select public.qa_lease('$r2','w1')" >/dev/null
  e2=$(pq -c "select public.qa_eff_registered_accept('$r2','w1','{\"kind\":\"text\",\"text\":\"NEW\"}','wamid.Q17N$1')")
  pq -c "select public.qa_finish_run('$r2','w1','$e2','completed')" >/dev/null
  # the Inbox writes are "lost"
  pq -c "delete from public.flow_run_effect_messages where conversation_id='$conv'; delete from public.messages where conversation_id='$conv'; update public.conversations set last_message_text=null, last_message_at=null where id='$conv'" >/dev/null
  echo "$r1 $r2 $conv"
}
repair_sql() { echo "select '$1','repair',outcome,coalesce(reason,'') from public.repair_versioned_run_inbox('$ACC','$2');"; }
state() { pq -F '|' -c "select last_message_text, (select string_agg(content_text, ',' order by created_at) from public.messages where conversation_id=c.id), (select count(*) from public.flow_run_effect_messages where conversation_id=c.id) from public.conversations c where c.id='$1'"; }
want() { [ "$(state "$2")" = "NEW|OLD,NEW|2" ] || fail "$1: expected NEW|OLD,NEW|2, got $(state "$2")"; }

CUR=Q17
read -r OLD NEW CONV < <(shared_conv 6201)
hold "$(repair_sql A "$OLD")" "$(repair_sql B "$NEW")"      # the OLD run's repair commits first, the NEW one waits for it
echo "-- $CUR old-first: $(res A a) // $(res B b)"; want old-first "$CONV"
read -r OLD NEW CONV < <(shared_conv 6202)
hold "$(repair_sql A "$NEW")" "$(repair_sql B "$OLD")"      # the NEW run's repair commits first, the OLD one waits and must NOT replace the preview
echo "-- $CUR new-first: $(res A a) // $(res B b)"; want new-first "$CONV"
for n in 6203 6204 6205; do
  read -r OLD NEW CONV < <(shared_conv $n)
  race "$(repair_sql A "$OLD")" "$(repair_sql B "$NEW")"
  echo "-- $CUR race $n: $(res A a) // $(res B b)"; want "race $n" "$CONV"
done
ok Q17 "two ended runs of one conversation repaired concurrently, OLD-first and NEW-first (the second session waits on the conversation row and re-evaluates the guard) plus 3 free races: always 2 messages ordered OLD,NEW, 2 links and the preview of the NEWEST message"
