#!/usr/bin/env bash
# PR #30 audit fixes, real concurrent sessions. Needs committed fixtures + helpers.
# Q05 (P1 Inbox repair): two repairs of the same ended run. Usage: e42pr30-concurrency.sh <container-name>
set -euo pipefail
NAME="$1"; GATE=4848
source "$(dirname "$0")/qa-conc-lib.sh"
M=57000000-0000-4000-8000-0000000000c0
ACC=$(pq -c "select account_id from public.flows where id='50000000-0000-4000-8000-000000000001'")
pq -c "select public.qa_synth_flow('$M','[{\"node_key\":\"m\",\"node_type\":\"send_message\",\"config\":{\"text\":\"hi\",\"next_node_key\":\"x\"}},{\"node_key\":\"x\",\"node_type\":\"end\"}]','m')" >/dev/null

# a COMPLETED run whose confirmed effect has no Inbox message: prints "<run> <conversation>"
orphan_run() {
  local rid eid conv
  rid=$(pq -c "select public.qa_flow_run_conv('$M', $1)"); pq -c "select public.qa_lease('$rid','w1')" >/dev/null
  eid=$(pq -c "select public.qa_eff_registered_accept('$rid','w1','{\"kind\":\"text\",\"text\":\"orphan\"}','wamid.$2')")
  pq -c "select public.qa_finish_run('$rid','w1','$eid','completed')" >/dev/null
  conv=$(pq -c "select conversation_id from public.flow_runs where id='$rid'")
  # the Inbox write is "lost": remove the link and the message the confirmation created
  pq -c "delete from public.flow_run_effect_messages where flow_run_id='$rid'; delete from public.messages where conversation_id='$conv'" >/dev/null
  echo "$rid $conv"
}
repair_sql() { echo "select '$1','repair',outcome,coalesce(reason,'') from public.repair_versioned_run_inbox('$ACC','$2');"; }
msgs() { pq -c "select count(*) from public.messages where conversation_id='$1'"; }
links() { pq -c "select count(*) from public.flow_run_effect_messages where flow_run_id='$1'"; }

CUR=Q05
read -r RID CONV < <(orphan_run 6001 Q05A)
[ "$(msgs "$CONV")" = 0 ] || fail "setup: message still there"
RUN_BEFORE=$(pq -c "select to_jsonb(r) from public.flow_runs r where id='$RID'")
hold "$(repair_sql A "$RID")" "$(repair_sql B "$RID")"
RA=$(res A a); RB=$(res B b); echo "-- $CUR results: $RA // $RB"
[ "$(field "$RA" 3)" = created ] && [ "$(field "$RB" 3)" = already_persisted ] || fail "expected created / already_persisted: $RA // $RB"
[ "$(msgs "$CONV")" = 1 ] && [ "$(links "$RID")" = 1 ] || fail "rows: messages $(msgs "$CONV"), links $(links "$RID")"
[ "$(pq -c "select to_jsonb(r) from public.flow_runs r where id='$RID'")" = "$RUN_BEFORE" ] || fail "the run changed"
for n in 6002 6003; do
  read -r RID CONV < <(orphan_run $n Q05$n)
  race "$(repair_sql A "$RID")" "$(repair_sql B "$RID")"
  RA=$(res A a); RB=$(res B b); echo "-- $CUR race $n: $RA // $RB"
  created=0; [ "$(field "$RA" 3)" = created ] && created=$((created+1)); [ "$(field "$RB" 3)" = created ] && created=$((created+1))
  [ "$created" = 1 ] && [ "$(msgs "$CONV")" = 1 ] && [ "$(links "$RID")" = 1 ] || fail "race $n: $created creators, messages $(msgs "$CONV"), links $(links "$RID")"
done
ok Q05 "two repairs of the same completed run: the second is blocked behind the first on the run row and then reports already_persisted; exactly 1 message and 1 link, run row untouched; two simultaneous races also create exactly one"
