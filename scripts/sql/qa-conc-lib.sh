#!/usr/bin/env bash
# Shared plumbing for the real-session concurrency harnesses (source it, do not execute).
# Needs: NAME (container), optional GATE (advisory-lock id), committed fixtures + helpers.
# Ordering is enforced with an advisory-lock gate and by polling pg_stat_activity for the
# expected wait states; there are no sleeps for ordering.
GATE="${GATE:-4343}"; WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
pq() { docker exec -i "$NAME" psql -U supabase_admin -h /var/run/postgresql -d postgres -X -A -t -q -v ON_ERROR_STOP=1 "$@"; }
CUR=setup
fail() { echo "QA-RESULT $CUR FAIL $1"; exit 1; }
ok() { echo "QA-RESULT $1 PASS $2"; }
wait_for() { for _ in $(seq 1 300); do [ "$(pq -c "$2" | tr -d '[:space:]')" = t ] && return 0; sleep 0.2; done; fail "timeout waiting for: $1"; }
res() { grep "^$1|" "$WORK/$2.out" | head -1; }   # res A a -> first line of session A's output tagged A
field() { echo "$1" | cut -d'|' -f"$2"; }
start_gate() {
  pq -c "set application_name='qa_gate'; select pg_advisory_lock($GATE); select pg_sleep(600);" >/dev/null 2>&1 & GATE_PID=$!
  wait_for "gate held" "select exists(select 1 from pg_locks where locktype='advisory' and granted and objid=$GATE)"
}
release_gate() { pq -c "select pg_terminate_backend(pid) from pg_stat_activity where application_name='qa_gate'" >/dev/null; }
finish() { wait "$PA" || fail "session A failed: $(cat "$WORK/a.err")"; wait "$PB" || fail "session B failed: $(cat "$WORK/b.err")"; wait "$GATE_PID" 2>/dev/null || true; }

# hold <A statements run inside an open transaction> <B statement>
hold() {
  start_gate
  { echo "set application_name='qa_sess_a'; begin;"; echo "$1"; echo "select pg_advisory_lock($GATE); commit;"; } > "$WORK/a.sql"
  { echo "set application_name='qa_sess_b';"; echo "$2"; } > "$WORK/b.sql"
  pq < "$WORK/a.sql" > "$WORK/a.out" 2>"$WORK/a.err" & PA=$!
  wait_for "A holds its open transaction (blocked on gate)" "select exists(select 1 from pg_stat_activity where application_name='qa_sess_a' and wait_event_type='Lock' and wait_event='advisory')"
  pq < "$WORK/b.sql" > "$WORK/b.out" 2>"$WORK/b.err" & PB=$!
  wait_for "B blocked on A's uncommitted row lock" "select exists(select 1 from pg_stat_activity where application_name='qa_sess_b' and wait_event_type='Lock' and wait_event in ('transactionid','tuple'))"
  echo "-- $CUR sessions while A's transaction is open:"
  pq -F ' | ' -c "select application_name, pid, wait_event_type||':'||wait_event, left(query,50) from pg_stat_activity where application_name in ('qa_sess_a','qa_sess_b') order by 1"
  release_gate; finish
}
# race <A statement> <B statement>: both sessions queue on the gate and start together
race() {
  start_gate
  { echo "set application_name='qa_sess_a'; select pg_advisory_lock_shared($GATE);"; echo "$1"; } > "$WORK/a.sql"
  { echo "set application_name='qa_sess_b'; select pg_advisory_lock_shared($GATE);"; echo "$2"; } > "$WORK/b.sql"
  pq < "$WORK/a.sql" > "$WORK/a.out" 2>"$WORK/a.err" & PA=$!
  pq < "$WORK/b.sql" > "$WORK/b.out" 2>"$WORK/b.err" & PB=$!
  wait_for "A and B queued on gate" "select count(*)=2 from pg_stat_activity where application_name in ('qa_sess_a','qa_sess_b') and wait_event_type='Lock' and wait_event='advisory'"
  release_gate; finish
}
