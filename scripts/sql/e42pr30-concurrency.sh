#!/usr/bin/env bash
# PR #30 audit fixes, real concurrent sessions. Needs committed fixtures + helpers.
# Q05 (P1 Inbox repair): two repairs of the same ended run; Q12, Q13 (P2): races around a deferred effect. Usage: e42pr30-concurrency.sh <container-name>
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

# ---- P2 (migration 062): races around a temporary rejection
M2=58000000-0000-4000-8000-0000000000c0
pq -c "select public.qa_synth_flow('$M2','[{\"node_key\":\"m\",\"node_type\":\"send_message\",\"config\":{\"text\":\"hi\",\"next_node_key\":\"x\"}},{\"node_key\":\"x\",\"node_type\":\"end\"}]','m')" >/dev/null
# a leased run with a claimed effect: prints "<run> <token> <effect> <attempt>"
claimed_effect() {
  local rid tok eid att
  rid=$(pq -c "select public.qa_flow_run_conv('$M2', $1)"); tok=$(pq -c "select public.qa_lease('$rid','w1')")
  eid=$(pq -c "select effect_id from public.register_versioned_effect('$ACC','$rid','w1',$tok,0,'send_message','{\"kind\":\"text\",\"text\":\"rl\"}')")
  att=$(pq -c "select claimed_attempt_id from public.claim_versioned_effect('$ACC','$rid','w1',$tok,'$eid')")
  echo "$rid $tok $eid $att"
}
defer_sql() { echo "select '$1','defer',deferred,effect_state,coalesce(wait_seconds::text,''),coalesce(reason,'') from public.defer_versioned_effect('$ACC','$2','w1',$3,'$4','$5',$6,'rate_limited');"; }
claim_sql() { echo "select '$1','claim',claimed,effect_state,coalesce(attempt_no::text,''),coalesce(reason,'') from public.claim_versioned_effect('$ACC','$2','w1',$3,'$4');"; }
effrow() { pq -F '|' -c "select state, attempt, (retry_not_before is not null) from public.flow_run_effects where id='$1'"; }
runrow() { pq -c "select to_jsonb(r) from public.flow_runs r where id='$1'"; }

# Q12: two workers deferring the same attempt
CUR=Q12
read -r RID TOK EID ATT < <(claimed_effect 6101)
RUN_BEFORE=$(runrow "$RID")
hold "$(defer_sql A "$RID" "$TOK" "$EID" "$ATT" 120)" "$(defer_sql B "$RID" "$TOK" "$EID" "$ATT" 7)"
RA=$(res A a); RB=$(res B b); echo "-- $CUR results: $RA // $RB"
[ "$(field "$RA" 3)" = t ] && [ "$(field "$RA" 5)" = 120 ] && [ "$(field "$RB" 3)" = f ] && [ "$(field "$RB" 6)" = effect_not_claimed ] || fail "$RA // $RB"
[ "$(effrow "$EID")" = "pending|1|t" ] || fail "effect $(effrow "$EID")"
[ "$(pq -c "select count(*) from public.flow_run_events where flow_run_id='$RID' and event_type='effect_deferred'")" = 1 ] || fail "duplicated deferral event"
[ "$(runrow "$RID")" = "$RUN_BEFORE" ] || fail "the run changed"
ok Q12 "two workers deferring one attempt: B blocked on the run row, then effect_not_claimed; the effect is pending with ONE persisted time (the winner's 120 s), one event, attempt 1, run row byte-identical"

# Q13: two workers claiming the moment the retry becomes due
CUR=Q13
read -r RID TOK EID ATT < <(claimed_effect 6102)
pq -c "select deferred from public.defer_versioned_effect('$ACC','$RID','w1',$TOK,'$EID','$ATT',60,'rate_limited')" >/dev/null
# not due yet: both are refused and nothing changes
hold "$(claim_sql A "$RID" "$TOK" "$EID")" "$(claim_sql B "$RID" "$TOK" "$EID")"
RA=$(res A a); RB=$(res B b)
[ "$(field "$RA" 6)" = retry_not_due ] && [ "$(field "$RB" 6)" = retry_not_due ] && [ "$(effrow "$EID")" = "pending|1|t" ] || fail "before the time: $RA // $RB // $(effrow "$EID")"
pq -c "update public.flow_run_effects set retry_not_before = clock_timestamp() - interval '1 second' where id='$EID'" >/dev/null
hold "$(claim_sql A "$RID" "$TOK" "$EID")" "$(claim_sql B "$RID" "$TOK" "$EID")"
RA=$(res A a); RB=$(res B b); echo "-- $CUR due: $RA // $RB"
[ "$(field "$RA" 3)" = t ] && [ "$(field "$RA" 5)" = 2 ] && [ "$(field "$RB" 3)" = f ] && [ "$(field "$RB" 6)" = effect_not_pending ] || fail "$RA // $RB"
[ "$(effrow "$EID")" = "claimed|2|f" ] || fail "effect $(effrow "$EID")"
read -r RID TOK EID ATT < <(claimed_effect 6103)
pq -c "select deferred from public.defer_versioned_effect('$ACC','$RID','w1',$TOK,'$EID','$ATT',60,'rate_limited')" >/dev/null
pq -c "update public.flow_run_effects set retry_not_before = clock_timestamp() - interval '1 second' where id='$EID'" >/dev/null
race "$(claim_sql A "$RID" "$TOK" "$EID")" "$(claim_sql B "$RID" "$TOK" "$EID")"
RA=$(res A a); RB=$(res B b); echo "-- $CUR race: $RA // $RB"
won=0; [ "$(field "$RA" 3)" = t ] && won=$((won+1)); [ "$(field "$RB" 3)" = t ] && won=$((won+1))
[ "$won" = 1 ] && [ "$(effrow "$EID")" = "claimed|2|f" ] || fail "race: $won winners, effect $(effrow "$EID")"
ok Q13 "claims before the persisted time are refused (retry_not_due) for both workers; at the due time exactly ONE worker claims (attempt 2) and the other gets effect_not_pending - in a held transaction and in a simultaneous race"
