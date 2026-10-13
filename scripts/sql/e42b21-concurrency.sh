#!/usr/bin/env bash
# E4.2B2.1 QA S18-S23: real concurrent / interrupted PostgreSQL sessions against push/pop.
# Needs committed fixtures + helpers. Usage: e42b21-concurrency.sh <container-name>
set -euo pipefail
NAME="$1"; GATE=4545
source "$(dirname "$0")/qa-conc-lib.sh"

A=52000000-0000-4000-8000-0000000000a1
B=52000000-0000-4000-8000-0000000000b1
ACC=$(pq -c "select account_id from public.flows where id='50000000-0000-4000-8000-000000000001'")
# Committed synthetic flows: A (call -> x -> end, entry call), B (x -> bcall -> bend, entry x)
pq -c "select public.qa_synth_flow('$A','[{\"node_key\":\"call\",\"node_type\":\"execute_flow\",\"config\":{\"target_flow_id\":\"$B\",\"next_node_key\":\"x\"}},{\"node_key\":\"x\",\"node_type\":\"send_message\"},{\"node_key\":\"end\",\"node_type\":\"end\"}]','call')" >/dev/null
pq -c "select public.qa_synth_flow('$B','[{\"node_key\":\"x\",\"node_type\":\"start\"},{\"node_key\":\"bcall\",\"node_type\":\"execute_flow\"},{\"node_key\":\"bend\",\"node_type\":\"end\"}]','x')" >/dev/null
VB1=$(pq -c "select active_version_id from public.flows where id='$B'")

# A leased run sitting on A's call node; prints "<run id> <token>"
new_leased_run() { local rid; rid=$(pq -c "select public.qa_flow_run('$A', $1)"); echo "$rid $(pq -c "select public.qa_lease('$rid','w1')")"; }
push_sql() { echo "select '$1','push',committed,revision,coalesce(reason,''),new_depth from public.push_versioned_run_subflow('$ACC','$2','w1',$3,$4,'call','x','$B');"; }
pop_sql()  { echo "select '$1','pop',committed,revision,coalesce(reason,''),new_depth from public.pop_versioned_run_subflow('$ACC','$2','w1',$3,$4);"; }
state() { pq -F '|' -c "select versioned_depth, versioned_revision, versioned_node_key, (select count(*) from public.flow_run_call_frames f where f.flow_run_id=r.id), public.qa_stack_ok(r.id) from public.flow_runs r where r.id='$1'"; }

# ---- S18: two concurrent pushes with the same token and expected revision
CUR=S18
read -r RID TOK < <(new_leased_run 601)
hold "$(push_sql A "$RID" "$TOK" 0)" "$(push_sql B "$RID" "$TOK" 0)"
RA=$(res A a); RB=$(res B b); echo "-- $CUR results: $RA // $RB"
[ "$(field "$RA" 3)" = t ] && [ "$(field "$RA" 4)" = 1 ] && [ "$(field "$RA" 6)" = 1 ] || fail "A should push (revision 1, depth 1): $RA"
[ "$(field "$RB" 3)" = f ] && [ "$(field "$RB" 5)" = revision_conflict ] || fail "B should get revision_conflict: $RB"
[ "$(state "$RID")" = "1|1|x|1|t" ] || fail "state $(state "$RID")"
for n in 602 603; do   # plus simultaneous races
  read -r RID TOK < <(new_leased_run $n)
  race "$(push_sql A "$RID" "$TOK" 0)" "$(push_sql B "$RID" "$TOK" 0)"
  RA=$(res A a); RB=$(res B b); echo "-- $CUR race $n: $RA // $RB"
  won=0; [ "$(field "$RA" 3)" = t ] && won=$((won+1)); [ "$(field "$RB" 3)" = t ] && won=$((won+1))
  [ "$won" = 1 ] || fail "race $n: $won winners"
  [ "$(state "$RID")" = "1|1|x|1|t" ] || fail "race $n state $(state "$RID")"
done
ok S18 "two concurrent pushes: one committed (depth 1, 1 frame), the other blocked on the run row then revision_conflict; also 2 simultaneous races with a single winner and a consistent stack"

# ---- S19: two concurrent pops
CUR=S19
read -r RID TOK < <(new_leased_run 604)
pq -c "select public.qa_push('$RID','w1','call','x','$B'); select public.qa_goto('$RID','w1','bend')" >/dev/null
REV=$(pq -c "select versioned_revision from public.flow_runs where id='$RID'")
hold "$(pop_sql A "$RID" "$TOK" "$REV")" "$(pop_sql B "$RID" "$TOK" "$REV")"
RA=$(res A a); RB=$(res B b); echo "-- $CUR results: $RA // $RB"
[ "$(field "$RA" 3)" = t ] && [ "$(field "$RA" 6)" = 0 ] || fail "A should pop: $RA"
[ "$(field "$RB" 3)" = f ] && [ "$(field "$RB" 5)" = revision_conflict ] || fail "B should get revision_conflict: $RB"
[ "$(state "$RID")" = "0|$((REV+1))|x|0|t" ] || fail "state $(state "$RID")"
read -r RID TOK < <(new_leased_run 605)
pq -c "select public.qa_push('$RID','w1','call','x','$B'); select public.qa_goto('$RID','w1','bend')" >/dev/null
REV=$(pq -c "select versioned_revision from public.flow_runs where id='$RID'")
race "$(pop_sql A "$RID" "$TOK" "$REV")" "$(pop_sql B "$RID" "$TOK" "$REV")"
RA=$(res A a); RB=$(res B b); echo "-- $CUR race: $RA // $RB"
won=0; [ "$(field "$RA" 3)" = t ] && won=$((won+1)); [ "$(field "$RB" 3)" = t ] && won=$((won+1))
[ "$won" = 1 ] && [ "$(state "$RID")" = "0|$((REV+1))|x|0|t" ] || fail "pop race: $won winners, state $(state "$RID")"
ok S19 "two concurrent pops: the frame is consumed once (depth 0, 0 frames), the loser gets revision_conflict; simultaneous race also single-winner"

# ---- S20: interruption BEFORE commit. The pushing session dies inside its open transaction.
CUR=S20
read -r RID TOK < <(new_leased_run 606)
BEFORE=$(state "$RID")
start_gate
{ echo "set application_name='qa_sess_a'; begin;"; push_sql A "$RID" "$TOK" 0; echo "select pg_advisory_lock($GATE); commit;"; } > "$WORK/a.sql"
pq < "$WORK/a.sql" > "$WORK/a.out" 2>"$WORK/a.err" & PA=$!
wait_for "A pushed inside its open transaction" "select exists(select 1 from pg_stat_activity where application_name='qa_sess_a' and wait_event_type='Lock' and wait_event='advisory')"
[ "$(pq -c "select count(*) from public.flow_run_call_frames where flow_run_id='$RID'")" = 0 ] || fail "frame visible to other sessions before commit"
pq -c "select pg_terminate_backend(pid) from pg_stat_activity where application_name='qa_sess_a'" >/dev/null
wait "$PA" 2>/dev/null || true
release_gate; wait "$GATE_PID" 2>/dev/null || true
[ "$(state "$RID")" = "$BEFORE" ] || fail "state changed by a dead uncommitted session: $(state "$RID") vs $BEFORE"
[ "$(pq -c "select versioned_lease_owner||'/'||versioned_lease from public.flow_runs where id='$RID'")" = "w1/$TOK" ] || fail "lease changed"
# the worker retries with the same token and revision: exactly one frame results
pq -F '|' -c "$(push_sql R "$RID" "$TOK" 0 | sed 's/^select /select /')" > "$WORK/r.out"
[ "$(field "$(cat "$WORK/r.out")" 3)" = t ] || fail "retry after the dead session should push: $(cat "$WORK/r.out")"
[ "$(state "$RID")" = "1|1|x|1|t" ] || fail "state after retry $(state "$RID")"
ok S20 "session killed inside its open push transaction: frame invisible to others, nothing persisted (state identical, lease untouched); the retry with the same token/revision pushed exactly once"

# ---- S21: interruption AFTER commit. The client dies before reading the response.
CUR=S21
read -r RID TOK < <(new_leased_run 607)
pq -c "$(push_sql X "$RID" "$TOK" 0)" >/dev/null          # commits; the result is thrown away
[ "$(state "$RID")" = "1|1|x|1|t" ] || fail "committed push not visible: $(state "$RID")"
# recovering process: replays the same call (it cannot know it succeeded)
pq -F '|' -c "$(push_sql R "$RID" "$TOK" 0)" > "$WORK/r.out"
[ "$(field "$(cat "$WORK/r.out")" 3)" = f ] && [ "$(field "$(cat "$WORK/r.out")" 5)" = revision_conflict ] || fail "replay must be refused: $(cat "$WORK/r.out")"
[ "$(state "$RID")" = "1|1|x|1|t" ] || fail "replay changed state: $(state "$RID")"
# it then reads the persisted state and continues from the callee entry node (pop path works)
pq -c "select public.qa_goto('$RID','w1','bend')" >/dev/null
POP=$(pq -F '|' -c "$(pop_sql R "$RID" "$TOK" "$(pq -c "select versioned_revision from public.flow_runs where id='$RID'")")")
[ "$(field "$POP" 3)" = t ] && [ "$(state "$RID")" = "0|3|x|0|t" ] || fail "continuation failed: $POP / $(state "$RID")"
ok S21 "client lost the response after COMMIT: replay -> revision_conflict (still 1 frame); the recovered worker read the persisted state and completed the return"

# ---- S22: republication of the target while a push is in flight
CUR=S22
read -r RID TOK < <(new_leased_run 608)
PUB="select public.qa_synth_flow('$B','[{\"node_key\":\"x\",\"node_type\":\"start\"},{\"node_key\":\"newend\",\"node_type\":\"end\"}]','x');"
hold "$(push_sql A "$RID" "$TOK" 0)" "$PUB"
RA=$(res A a); echo "-- $CUR push result: $RA"
VB2=$(pq -c "select active_version_id from public.flows where id='$B'")
[ "$VB2" != "$VB1" ] || fail "republication did not happen"
[ "$(field "$RA" 3)" = t ] || fail "push should have committed: $RA"
[ "$(pq -c "select callee_flow_version_id from public.flow_run_call_frames where flow_run_id='$RID'")" = "$VB1" ] || fail "frame did not pin the version published at entry"
[ "$(pq -c "select current_flow_version_id from public.flow_runs where id='$RID'")" = "$VB1" ] || fail "cursor not in pinned version"
ok S22 "the publisher was blocked by the in-flight push (FOR SHARE on the target); the frame pinned B v1 ($VB1) although B v2 became active right after"

# ---- S23: an agent pause that is not yet committed vs a push
CUR=S23
read -r RID TOK < <(new_leased_run 609)
hold "update public.flow_runs set status='paused_by_agent' where id='$RID';" "$(push_sql B "$RID" "$TOK" 0)"
RB=$(res B b); echo "-- $CUR result: $RB"
[ "$(field "$RB" 3)" = f ] && [ "$(field "$RB" 5)" = run_not_active ] || fail "push must see the pause: $RB"
[ "$(pq -c "select status||'/'||versioned_depth from public.flow_runs where id='$RID'")" = "paused_by_agent/0" ] || fail "state changed"
ok S23 "push blocked behind an uncommitted agent pause, then refused with run_not_active; run paused, no frame"
