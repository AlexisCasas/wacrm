#!/usr/bin/env bash
# E4.2B1.1 QA T12-T14: two real, concurrent psql sessions create a run for the
# same contact. Requires committed fixtures (helpers + e42b11-fixtures.sql).
# Usage: e42b11-t12-t14.sh <container-name>
# Synchronisation is deterministic and sleep-free: a gate session holds an
# advisory lock, sessions queue on it, and the script polls pg_stat_activity
# until the expected wait states are observed before releasing the gate.
set -euo pipefail
NAME="$1"
FLOW=50000000-0000-4000-8000-000000000001
GATE=4242
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
pq() { docker exec -i "$NAME" psql -U supabase_admin -h /var/run/postgresql -d postgres -X -A -t -q -v ON_ERROR_STOP=1 "$@"; }
fail() { echo "QA-RESULT $1 FAIL $2"; exit 1; }
ok() { echo "QA-RESULT $1 PASS $2"; }

# Polls a SQL predicate (must print t) for up to ~60s.
wait_for() { # <description> <sql>
  for _ in $(seq 1 300); do [ "$(pq -c "$2" | tr -d '[:space:]')" = t ] && return 0; sleep 0.2; done
  fail "$CUR" "timeout waiting for: $1"
}
CALL() { echo "select '$1', pg_backend_pid(), created, coalesce(flow_run_id::text,''), coalesce(reason,'') from public.create_versioned_flow_run((select account_id from public.flows where id='$FLOW'),'$FLOW','$2',null,'{\"sess\":\"$1\"}'::jsonb);"; }

# round <test-prefix> <contact-uuid> <mode: hold|race>
#  hold: A creates the run inside an open transaction and waits on the gate;
#        B must block on A's uncommitted row lock; then A commits, B resumes.
#  race: A and B both queue on the gate and start the RPC together on release.
round() {
  local CUR="$1" C="$2" mode="$3" gate_pid
  pq -c "set application_name='qa_gate'; select pg_advisory_lock($GATE); select pg_sleep(600);" >/dev/null 2>&1 &
  gate_pid=$!
  wait_for "gate lock held" "select exists(select 1 from pg_locks where locktype='advisory' and granted and objid=$GATE)"
  if [ "$mode" = hold ]; then
    { echo "set application_name='qa_sess_a'; begin;"; CALL A "$C"; echo "select pg_advisory_lock($GATE); commit;"; } > "$WORK/a.sql"
    { echo "set application_name='qa_sess_b';"; CALL B "$C"; } > "$WORK/b.sql"
    pq < "$WORK/a.sql" > "$WORK/a.out" 2>"$WORK/a.err" & local pa=$!
    wait_for "A blocked on gate after creating its run" "select exists(select 1 from pg_stat_activity where application_name='qa_sess_a' and wait_event_type='Lock' and wait_event='advisory')"
    pq < "$WORK/b.sql" > "$WORK/b.out" 2>"$WORK/b.err" & local pb=$!
    wait_for "B blocked on A's row lock" "select exists(select 1 from pg_stat_activity where application_name='qa_sess_b' and wait_event_type='Lock' and wait_event in ('transactionid','tuple'))"
    echo "-- $CUR evidence while both sessions are open:"
    pq -F ' | ' -c "select application_name, pid, state, wait_event_type||':'||wait_event as waiting, left(query,60) from pg_stat_activity where application_name in ('qa_sess_a','qa_sess_b') order by 1"
  else
    { echo "set application_name='qa_sess_a'; select pg_advisory_lock_shared($GATE);"; CALL A "$C"; } > "$WORK/a.sql"
    { echo "set application_name='qa_sess_b'; select pg_advisory_lock_shared($GATE);"; CALL B "$C"; } > "$WORK/b.sql"
    pq < "$WORK/a.sql" > "$WORK/a.out" 2>"$WORK/a.err" & local pa=$!
    pq < "$WORK/b.sql" > "$WORK/b.out" 2>"$WORK/b.err" & local pb=$!
    wait_for "A and B both queued on gate" "select count(*)=2 from pg_stat_activity where application_name in ('qa_sess_a','qa_sess_b') and wait_event_type='Lock' and wait_event='advisory'"
  fi
  # Release: ending the gate session drops its advisory lock.
  pq -c "select pg_terminate_backend(pid) from pg_stat_activity where application_name='qa_gate'" >/dev/null
  wait "$pa" || fail "$CUR" "session A failed: $(cat "$WORK/a.err")"
  wait "$pb" || fail "$CUR" "session B failed: $(cat "$WORK/b.err")"
  wait "$gate_pid" 2>/dev/null || true
  # Result lines look like: A|<pid>|t|<run id>|<reason>
  RA=$(grep '^A|' "$WORK/a.out"); RB=$(grep '^B|' "$WORK/b.out")
  echo "-- $CUR session results: $RA  //  $RB"
}

check_round() { # <contact> <label>
  local C="$1" created_n lost_reason
  IFS='|' read -r _ pa ca ra rsa <<<"$RA"; IFS='|' read -r _ pb cb rb rsb <<<"$RB"
  [ "$pa" != "$pb" ] || fail T12 "both sessions used the same backend pid $pa"
  created_n=0; [ "$ca" = t ] && created_n=$((created_n+1)); [ "$cb" = t ] && created_n=$((created_n+1))
  [ "$created_n" = 1 ] || fail T12 "expected exactly one session to create a run, got $created_n ($RA // $RB)"
  if [ "$ca" = t ]; then lost_reason="$rsb"; else lost_reason="$rsa"; fi
  [ "$lost_reason" = active_run_exists ] || fail T14 "loser reason is '$lost_reason', expected active_run_exists"
  local active total
  active=$(pq -c "select count(*) from public.flow_runs where contact_id='$C' and status='active'")
  total=$(pq -c "select count(*) from public.flow_runs where contact_id='$C'")
  [ "$active" = 1 ] && [ "$total" = 1 ] || fail T13 "contact $C has $active active / $total total runs"
  WINNER_RUN=$([ "$ca" = t ] && echo "$ra" || echo "$rb")
  [ "$(pq -c "select count(*) from public.flow_runs where id='$WINNER_RUN' and execution_mode='versioned'")" = 1 ] || fail T13 "winner run $WINNER_RUN missing"
}

# Deterministic blocking scenario (T12-T14).
round T12 30000000-0000-4000-8000-000000000001 hold
check_round 30000000-0000-4000-8000-000000000001
ok T12 "two distinct backends (pids $(cut -d'|' -f2 <<<"$RA") and $(cut -d'|' -f2 <<<"$RB")) ran concurrently; B was observed blocked on A's uncommitted lock before A committed"
ok T13 "exactly one active run for the contact (run $WINNER_RUN), one row in total"
ok T14 "losing session returned created=false reason=active_run_exists"

# Symmetric simultaneous races on three more contacts.
for n in 2 3 4; do
  C=30000000-0000-4000-8000-00000000000$n
  round "T12-race-$n" "$C" race
  check_round "$C"
done
ok T12-race "3 simultaneous races: exactly one winner, one active run, loser active_run_exists each time"
