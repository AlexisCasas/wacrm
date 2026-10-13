#!/usr/bin/env bash
# E4.2C1 QA E18-E22: real concurrent / interrupted PostgreSQL sessions against the effect ledger.
# Needs committed fixtures + helpers. Usage: e42c1-concurrency.sh <container-name>
set -euo pipefail
NAME="$1"; GATE=4646
source "$(dirname "$0")/qa-conc-lib.sh"

M=55000000-0000-4000-8000-0000000000c0
ACC=$(pq -c "select account_id from public.flows where id='50000000-0000-4000-8000-000000000001'")
pq -c "select public.qa_synth_flow('$M','[{\"node_key\":\"m\",\"node_type\":\"send_message\",\"config\":{\"text\":\"hi\",\"next_node_key\":\"x\"}},{\"node_key\":\"x\",\"node_type\":\"end\"}]','m')" >/dev/null

new_leased_run() { local rid; rid=$(pq -c "select public.qa_flow_run('$M', $1)"); echo "$rid $(pq -c "select public.qa_lease('$rid','w1')")"; }
reg_sql()    { echo "select '$1','reg',registered,effect_id,effect_state,coalesce(reason,'') from public.register_versioned_effect('$ACC','$2','w1',$3,$4,'send_message','{\"text\":\"hi\"}'::jsonb);"; }
claim_sql()  { echo "select '$1','claim',claimed,effect_state,attempt_no,coalesce(reason,'') from public.claim_versioned_effect('$ACC','$2','${5:-w1}',$3,'$4');"; }
settle_sql() { echo "select '$1','settle',settled,effect_state,coalesce(reason,'') from public.settle_versioned_effect('$ACC','$2','${6:-w1}',$3,'$4','$5','confirmed','wamid.$1$RANDOM');"; }
step_sql()   { echo "select '$1','step',committed,revision,coalesce(reason,''),messages_executed from public.commit_versioned_effect_step('$ACC','$2','w1',$3,$4,'$5',(select jsonb_build_object('cursor',jsonb_build_object('flow_version_id',current_flow_version_id,'node_key','x'),'step',(versioned_checkpoint->>'step')::int+1) from public.flow_runs where id='$2'));"; }
revision() { pq -c "select versioned_revision from public.flow_runs where id='$1'"; }
eff() { pq -F '|' -c "select state, attempt, coalesce(provider_message_id,'') from public.flow_run_effects where id='$1'"; }
count_effects() { pq -c "select count(*) from public.flow_run_effects where flow_run_id='$1'"; }
claim_now() { pq -c "select claimed_attempt_id from public.claim_versioned_effect('$ACC','$1','w1',$2,'$3')"; }

# ---- E18: two workers registering the same step
CUR=E18
read -r RID TOK < <(new_leased_run 2001)
hold "$(reg_sql A "$RID" "$TOK" 0)" "$(reg_sql B "$RID" "$TOK" 0)"
RA=$(res A a); RB=$(res B b); echo "-- $CUR results: $RA // $RB"
[ "$(field "$RA" 3)" = t ] && [ "$(field "$RB" 3)" = f ] && [ "$(field "$RB" 6)" = already_registered ] && [ "$(field "$RA" 4)" = "$(field "$RB" 4)" ] || fail "expected A registered, B already_registered with the same id: $RA // $RB"
[ "$(count_effects "$RID")" = 1 ] || fail "rows: $(count_effects "$RID")"
for n in 2002 2003; do
  read -r RID TOK < <(new_leased_run $n)
  race "$(reg_sql A "$RID" "$TOK" 0)" "$(reg_sql B "$RID" "$TOK" 0)"
  RA=$(res A a); RB=$(res B b); echo "-- $CUR race $n: $RA // $RB"
  won=0; [ "$(field "$RA" 3)" = t ] && won=$((won+1)); [ "$(field "$RB" 3)" = t ] && won=$((won+1))
  [ "$won" = 1 ] && [ "$(field "$RA" 4)" = "$(field "$RB" 4)" ] && [ "$(count_effects "$RID")" = 1 ] || fail "race $n: $won winners, rows $(count_effects "$RID")"
  [ "$(pq -c "select count(*) from public.flow_run_events where flow_run_id='$RID' and event_type='effect_registered'")" = 1 ] || fail "race $n: duplicated registration event"
done
ok E18 "two workers registering the same step: B blocked on the run row, then got already_registered with A's effect id; 2 simultaneous races -> 1 row and 1 event each"

# ---- E19: two workers claiming the same effect
CUR=E19
read -r RID TOK < <(new_leased_run 2004)
EID=$(pq -c "select effect_id from public.register_versioned_effect('$ACC','$RID','w1',$TOK,0,'send_message','{\"text\":\"hi\"}')")
hold "$(claim_sql A "$RID" "$TOK" "$EID")" "$(claim_sql B "$RID" "$TOK" "$EID")"
RA=$(res A a); RB=$(res B b); echo "-- $CUR results: $RA // $RB"
[ "$(field "$RA" 3)" = t ] && [ "$(field "$RB" 3)" = f ] && [ "$(field "$RB" 6)" = effect_not_pending ] || fail "$RA // $RB"
[ "$(eff "$EID")" = "claimed|1|" ] || fail "effect $(eff "$EID")"
read -r RID TOK < <(new_leased_run 2005)
EID=$(pq -c "select effect_id from public.register_versioned_effect('$ACC','$RID','w1',$TOK,0,'send_message','{\"text\":\"hi\"}')")
race "$(claim_sql A "$RID" "$TOK" "$EID")" "$(claim_sql B "$RID" "$TOK" "$EID")"
RA=$(res A a); RB=$(res B b); echo "-- $CUR race: $RA // $RB"
won=0; [ "$(field "$RA" 3)" = t ] && won=$((won+1)); [ "$(field "$RB" 3)" = t ] && won=$((won+1))
[ "$won" = 1 ] && [ "$(eff "$EID")" = "claimed|1|" ] || fail "race: $won winners, effect $(eff "$EID")"
ok E19 "two workers claiming one effect: exactly one claim (attempt 1), the other effect_not_pending; the attempt counter never exceeds 1 (hold + simultaneous race)"

# ---- E20: a stale worker tries to settle while the successor takes the lease and recovers
CUR=E20
read -r RID TOK < <(new_leased_run 2006)
EID=$(pq -c "select effect_id from public.register_versioned_effect('$ACC','$RID','w1',$TOK,0,'send_message','{\"text\":\"hi\"}')")
ATT=$(claim_now "$RID" "$TOK" "$EID")
pq -c "update public.flow_runs set versioned_lease_expires_at = clock_timestamp() - interval '1 second' where id='$RID'" >/dev/null
TAKE="select 'A','take',acquired,fencing_token,coalesce(reason,'') from public.reclaim_versioned_run_lease('$ACC','$RID','w2',600); select 'A','recover',count(*) from public.recover_versioned_run_effects('$ACC','$RID','w2',2) where new_state='ambiguous';"
hold "$TAKE" "$(settle_sql B "$RID" "$TOK" "$EID" "$ATT" w1)"
RB=$(res B b); echo "-- $CUR old worker: $RB"
[ "$(field "$RB" 3)" = f ] && [ "$(field "$RB" 5)" = stale_lease ] || fail "the old worker must be refused after the takeover: $RB"
[ "$(eff "$EID")" = "ambiguous|1|" ] || fail "effect $(eff "$EID")"
[ "$(pq -c "select versioned_lease_owner||'/'||versioned_lease from public.flow_runs where id='$RID'")" = "w2/2" ] || fail "lease not taken over"
ok E20 "old worker's settle was blocked behind the successor's open takeover, then refused (stale_lease); the abandoned claim became ambiguous (attempt 1, no provider id) and nothing was confirmed or resent"

# ---- E21: interruptions around claim and settle
CUR=E21
# (a) the claiming session dies before its transaction commits: the effect is still pending, never attempted
read -r RID TOK < <(new_leased_run 2007)
EID=$(pq -c "select effect_id from public.register_versioned_effect('$ACC','$RID','w1',$TOK,0,'send_message','{\"text\":\"hi\"}')")
start_gate
{ echo "set application_name='qa_sess_a'; begin;"; claim_sql A "$RID" "$TOK" "$EID"; echo "select pg_advisory_lock($GATE); commit;"; } > "$WORK/a.sql"
pq < "$WORK/a.sql" > "$WORK/a.out" 2>"$WORK/a.err" & PA=$!
wait_for "A claimed inside its open transaction" "select exists(select 1 from pg_stat_activity where application_name='qa_sess_a' and wait_event_type='Lock' and wait_event='advisory')"
pq -c "select pg_terminate_backend(pid) from pg_stat_activity where application_name='qa_sess_a'" >/dev/null
wait "$PA" 2>/dev/null || true; release_gate; wait "$GATE_PID" 2>/dev/null || true
[ "$(eff "$EID")" = "pending|0|" ] || fail "(a) effect $(eff "$EID")"
[ "$(pq -c "select claimed_attempt_id is not null from public.claim_versioned_effect('$ACC','$RID','w1',$TOK,'$EID')")" = t ] || fail "(a) retry claim"
[ "$(eff "$EID")" = "claimed|1|" ] || fail "(a) after retry $(eff "$EID")"
# (b) the claim committed and the worker died (provider outcome unknown): successor recovers to ambiguous, no second attempt
pq -c "update public.flow_runs set versioned_lease_expires_at = clock_timestamp() - interval '1 second' where id='$RID'" >/dev/null
pq -c "select 1 from public.reclaim_versioned_run_lease('$ACC','$RID','w2',600)" >/dev/null
[ "$(pq -c "select count(*) from public.recover_versioned_run_effects('$ACC','$RID','w2',2) where new_state='ambiguous'")" = 1 ] || fail "(b) recover"
[ "$(pq -c "select reason from public.claim_versioned_effect('$ACC','$RID','w2',2,'$EID')")" = effect_not_pending ] || fail "(b) successor must not claim an ambiguous effect"
[ "$(eff "$EID")" = "ambiguous|1|" ] || fail "(b) effect $(eff "$EID")"
# (c) the outcome was confirmed and the worker died before advancing: the successor advances without resending, budget once
read -r RID TOK < <(new_leased_run 2008)
EID=$(pq -c "select effect_id from public.register_versioned_effect('$ACC','$RID','w1',$TOK,0,'send_message','{\"text\":\"hi\"}')")
ATT=$(claim_now "$RID" "$TOK" "$EID")
pq -c "select settled from public.settle_versioned_effect('$ACC','$RID','w1',$TOK,'$EID','$ATT','confirmed','wamid.DONE')" >/dev/null
pq -c "update public.flow_runs set versioned_lease_expires_at = clock_timestamp() - interval '1 second' where id='$RID'" >/dev/null
pq -c "select 1 from public.reclaim_versioned_run_lease('$ACC','$RID','w2',600)" >/dev/null
[ "$(pq -c "select count(*) from public.recover_versioned_run_effects('$ACC','$RID','w2',2)")" = 0 ] || fail "(c) recover touched a confirmed effect"
[ "$(eff "$EID")" = "confirmed|1|wamid.DONE" ] || fail "(c) effect $(eff "$EID")"
REV=$(revision "$RID")
STEP=$(pq -F '|' -c "select committed,messages_executed from public.commit_versioned_effect_step('$ACC','$RID','w2',2,$REV,'$EID',(select jsonb_build_object('cursor',jsonb_build_object('flow_version_id',current_flow_version_id,'node_key','x'),'step',2) from public.flow_runs where id='$RID'))")
[ "$STEP" = "t|1" ] || fail "(c) step $STEP"
[ "$(pq -c "select count(*) from public.flow_run_effects where flow_run_id='$RID'")" = 1 ] || fail "(c) rows"
[ "$(pq -c "select attempt from public.flow_run_effects where id='$EID'")" = 1 ] || fail "(c) a resend happened"
ok E21 "(a) claim session killed before COMMIT -> still pending/attempt 0, retry claims attempt 1; (b) claim committed + worker dead -> ambiguous after recovery, successor cannot claim or resend; (c) confirmed + worker dead before advancing -> successor advanced once (budget 1, attempt stays 1)"

# ---- E22: two workers racing the final step
CUR=E22
read -r RID TOK < <(new_leased_run 2009)
EID=$(pq -c "select effect_id from public.register_versioned_effect('$ACC','$RID','w1',$TOK,0,'send_message','{\"text\":\"hi\"}')")
ATT=$(claim_now "$RID" "$TOK" "$EID")
pq -c "select settled from public.settle_versioned_effect('$ACC','$RID','w1',$TOK,'$EID','$ATT','confirmed','wamid.RACE')" >/dev/null
REV=$(revision "$RID")
hold "$(step_sql A "$RID" "$TOK" "$REV" "$EID")" "$(step_sql B "$RID" "$TOK" "$REV" "$EID")"
RA=$(res A a); RB=$(res B b); echo "-- $CUR results: $RA // $RB"
[ "$(field "$RA" 3)" = t ] && [ "$(field "$RB" 3)" = f ] && [ "$(field "$RB" 5)" = revision_conflict ] || fail "$RA // $RB"
[ "$(pq -c "select versioned_messages_executed||'/'||versioned_nodes_executed||'/'||versioned_revision from public.flow_runs where id='$RID'")" = "1/1/$((REV+1))" ] || fail "budget/revision $(pq -c "select versioned_messages_executed||'/'||versioned_nodes_executed||'/'||versioned_revision from public.flow_runs where id='$RID'")"
ok E22 "two workers advancing past the same confirmed effect: one commit (messages 1, nodes 1), the other blocked then revision_conflict - the message budget is consumed once"
