#!/usr/bin/env bash
# E4.2C3.1 QA P10-P12: real concurrent / interrupted sessions around the Inbox persistence of a confirmed effect.
# Needs committed fixtures + helpers. Usage: e42c31-concurrency.sh <container-name>
set -euo pipefail
NAME="$1"; GATE=4747
source "$(dirname "$0")/qa-conc-lib.sh"
M=56000000-0000-4000-8000-0000000000c0
ACC=$(pq -c "select account_id from public.flows where id='50000000-0000-4000-8000-000000000001'")
pq -c "select public.qa_synth_flow('$M','[{\"node_key\":\"m\",\"node_type\":\"send_message\",\"config\":{\"text\":\"hi\",\"next_node_key\":\"x\"}},{\"node_key\":\"x\",\"node_type\":\"end\"}]','m')" >/dev/null

# a leased run WITH a conversation and a claimed effect: prints "<run> <token> <effect> <attempt> <conversation>"
claimed_effect() {
  local rid tok eid att conv
  rid=$(pq -c "select public.qa_flow_run_conv('$M', $1)"); tok=$(pq -c "select public.qa_lease('$rid','w1')")
  eid=$(pq -c "select effect_id from public.register_versioned_effect('$ACC','$rid','w1',$tok,0,'send_message','{\"kind\":\"text\",\"text\":\"hello\"}')")
  att=$(pq -c "select claimed_attempt_id from public.claim_versioned_effect('$ACC','$rid','w1',$tok,'$eid')")
  conv=$(pq -c "select conversation_id from public.flow_runs where id='$rid'")
  echo "$rid $tok $eid $att $conv"
}
settle_sql() { echo "select '$1','settle',settled,effect_state,coalesce(reason,'') from public.settle_versioned_effect('$ACC','$2','w1',$3,'$4','$5','confirmed','$6');"; }
reconcile_sql() { echo "select '$1','reconcile',coalesce(outcome,''),coalesce(reason,'') from public.reconcile_versioned_effect_messages('$ACC','$2','w1',$3);"; }
msgs() { pq -c "select count(*) from public.messages where conversation_id='$1'"; }
links() { pq -c "select count(*) from public.flow_run_effect_messages where flow_run_id='$1'"; }

# ---- P10: two workers confirming the same attempt
CUR=P10
read -r RID TOK EID ATT CONV < <(claimed_effect 4001)
hold "$(settle_sql A "$RID" "$TOK" "$EID" "$ATT" wamid.P10A)" "$(settle_sql B "$RID" "$TOK" "$EID" "$ATT" wamid.P10B)"
RA=$(res A a); RB=$(res B b); echo "-- $CUR results: $RA // $RB"
[ "$(field "$RA" 3)" = t ] && [ "$(field "$RB" 3)" = f ] && [ "$(field "$RB" 5)" = effect_not_claimed ] || fail "$RA // $RB"
[ "$(msgs "$CONV")" = 1 ] && [ "$(links "$RID")" = 1 ] || fail "rows: messages $(msgs "$CONV"), links $(links "$RID")"
[ "$(pq -c "select message_id from public.messages where conversation_id='$CONV'")" = wamid.P10A ] || fail "the stored wamid is not the winner's"
read -r RID TOK EID ATT CONV < <(claimed_effect 4002)
race "$(settle_sql A "$RID" "$TOK" "$EID" "$ATT" wamid.P10C)" "$(settle_sql B "$RID" "$TOK" "$EID" "$ATT" wamid.P10D)"
RA=$(res A a); RB=$(res B b); echo "-- $CUR race: $RA // $RB"
won=0; [ "$(field "$RA" 3)" = t ] && won=$((won+1)); [ "$(field "$RB" 3)" = t ] && won=$((won+1))
[ "$won" = 1 ] && [ "$(msgs "$CONV")" = 1 ] && [ "$(links "$RID")" = 1 ] || fail "race: $won winners, messages $(msgs "$CONV")"
ok P10 "two workers confirming one attempt: B blocked on the run row, then effect_not_claimed; exactly 1 message and 1 link, carrying the winner's wamid; a simultaneous race gives the same result"

# ---- P11: the confirming session dies before COMMIT: neither the confirmation nor the message exists
CUR=P11
read -r RID TOK EID ATT CONV < <(claimed_effect 4003)
start_gate
{ echo "set application_name='qa_sess_a'; begin;"; settle_sql A "$RID" "$TOK" "$EID" "$ATT" wamid.P11KILLED; echo "select pg_advisory_lock($GATE); commit;"; } > "$WORK/a.sql"
pq < "$WORK/a.sql" > "$WORK/a.out" 2>"$WORK/a.err" & PA=$!
wait_for "A confirmed inside its open transaction" "select exists(select 1 from pg_stat_activity where application_name='qa_sess_a' and wait_event_type='Lock' and wait_event='advisory')"
[ "$(msgs "$CONV")" = 0 ] || fail "message visible to other sessions before COMMIT"
pq -c "select pg_terminate_backend(pid) from pg_stat_activity where application_name='qa_sess_a'" >/dev/null
wait "$PA" 2>/dev/null || true; release_gate; wait "$GATE_PID" 2>/dev/null || true
[ "$(msgs "$CONV")" = 0 ] && [ "$(pq -c "select state from public.flow_run_effects where id='$EID'")" = claimed ] || fail "state after the kill: messages $(msgs "$CONV"), effect $(pq -c "select state from public.flow_run_effects where id='$EID'")"
# the worker cannot know whether the provider accepted: the claim is still ours, so it settles again with the outcome it holds
RES=$(pq -F '|' -c "select settled,effect_state from public.settle_versioned_effect('$ACC','$RID','w1',$TOK,'$EID','$ATT','confirmed','wamid.P11RETRY')")
[ "$RES" = "t|confirmed" ] && [ "$(msgs "$CONV")" = 1 ] && [ "$(links "$RID")" = 1 ] || fail "retry: $RES, messages $(msgs "$CONV")"
ok P11 "confirming session killed before COMMIT: no confirmation and no message (rolled back together); the retry confirmed it and created exactly one message"

# ---- P12: reconcile racing the confirmation
CUR=P12
read -r RID TOK EID ATT CONV < <(claimed_effect 4004)
hold "$(settle_sql A "$RID" "$TOK" "$EID" "$ATT" wamid.P12)" "$(reconcile_sql B "$RID" "$TOK")"
RB=$(res B b); echo "-- $CUR reconcile: $RB"
[ "$(field "$RB" 3)" = already_persisted ] || fail "reconcile should find the message created by the confirmation: $RB"
[ "$(msgs "$CONV")" = 1 ] && [ "$(links "$RID")" = 1 ] || fail "rows: messages $(msgs "$CONV")"
ok P12 "reconcile blocked behind an uncommitted confirmation, then found the message already persisted (already_persisted); still exactly 1 message"
