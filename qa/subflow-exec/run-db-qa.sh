#!/usr/bin/env bash
# Isolated PostgreSQL 17 (no network, no ports, destroyed on exit) for migration 070 (subflow execution with return).
# Usage: qa/subflow-exec/run-db-qa.sh [--e4-migrations <dir with 052..066 *.sql>]
set -euo pipefail
cd "$(dirname "$0")/../.."
FS=qa/flows-safe-save; HERE=qa/subflow-exec; IMAGE="${QA_PG_IMAGE:-supabase/postgres:17.6.1.136}"; E4=""
[ "${1:-}" = "--e4-migrations" ] && E4="$2"
LOG="$(mktemp)"; NAME=""; FAILED=0
cleanup() { rm -f "$LOG"; [ -n "$NAME" ] && docker rm -f "$NAME" >/dev/null 2>&1 || true; }; trap cleanup EXIT
psql_() { docker exec -i -e PGOPTIONS="-c client_min_messages=${QA_MIN_MSG:-notice}" "$NAME" psql -U supabase_admin -h /var/run/postgresql -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
pq() { docker exec -i "$NAME" psql -U supabase_admin -h /var/run/postgresql -d postgres -X -A -t -q -v ON_ERROR_STOP=1 "$@"; }
wait_ready() { local _ log; for _ in $(seq 1 120); do sleep 1; log="$(docker logs "$NAME" 2>&1 || true)"
  if grep -q 'PostgreSQL init process complete' <<<"$log" && [ "$(grep -c 'ready to accept connections' <<<"$log")" -ge "${1:-2}" ] && psql_ -Atc 'select 1' >/dev/null 2>&1; then return 0; fi; done; echo "database did not start" >&2; return 1; }
start() { NAME="sf-qa-$$-$RANDOM"; docker run -d --name "$NAME" --network none -e POSTGRES_PASSWORD=qa "$IMAGE" >/dev/null; wait_ready 2; QA_MIN_MSG=warning psql_ < "$FS/bootstrap.sql" >/dev/null; }
apply() { local f; for f in "$@"; do QA_MIN_MSG=warning psql_ < "$f" >/dev/null || { echo "migration failed: $f" >&2; return 1; }; done; }
stop() { docker rm -f "$NAME" >/dev/null 2>&1 || true; NAME=""; }
mig_le() { ls supabase/migrations/*.sql | awk -F/ -v max="$1" '{ n=substr($NF,1,3); if (n+0 <= max+0) print $0 }'; }
M067=supabase/migrations/067_replace_flow_draft_atomic.sql; M068=supabase/migrations/068_execute_flow_authoring_guards.sql; M069=supabase/migrations/069_flow_durable_waits.sql; M070=supabase/migrations/070_flow_subflow_execution.sql; M071=supabase/migrations/071_flow_execution_defaults.sql


suite() { # <label>
  QA_MIN_MSG=warning psql_ < "$FS/fixtures.sql" >/dev/null 2>&1 || true
  { echo 'BEGIN;'; echo "SELECT set_config('app.flow_publication', 'on', false);"; cat "$HERE/helpers.sql" "$HERE/db-subflow.sql" "$HERE/db-global.sql"; echo 'ROLLBACK;'; } | psql_ -o /dev/null 2>&1 | sed "s/^NOTICE:  QA-RESULT \([A-Z0-9]*\)/QA-RESULT [$1] \1/" | tee -a "$LOG" | grep -E 'QA-RESULT|ERROR' || true
}
races() { # <label> real concurrent sessions
  local ua=a1000000-0000-4000-8000-000000000001 acct r fa fb fc res1 res2 at
  psql_ < "$HERE/helpers.sql" >/dev/null
  acct=$(pq -c "select public.qa_acct('$ua')"); pq -c "select public.qa_enable('$acct')" >/dev/null
  # T12: two sessions push THE SAME call at the same instant: exactly one wins
  local ok12=1 round
  for round in 1 2 3 4 5; do
    fb=$(pq -c "select public.qa_simple('$acct','$ua','RB$round')"); fc=$(pq -c "select public.qa_simple('$acct','$ua','RC$round')"); fa=$(pq -c "select public.qa_caller('$acct','$ua','RA$round','$fb','$fc')"); r=$(pq -c "select public.qa_run('$fa','call1')")
    at=$(pq -c "select clock_timestamp() + interval '2 seconds'")
    ( pq -c "select pg_sleep(greatest(0, extract(epoch from ('$at'::timestamptz - clock_timestamp())))); select (public.qa_push('$r','call1','$fb','mid')->>'ok')" > /tmp/sf-p1-$$.out 2>&1 ) &
    ( pq -c "select pg_sleep(greatest(0, extract(epoch from ('$at'::timestamptz - clock_timestamp())))); select (public.qa_push('$r','call1','$fb','mid')->>'ok')" > /tmp/sf-p2-$$.out 2>&1 ) & wait
    res1=$(tail -1 /tmp/sf-p1-$$.out); res2=$(tail -1 /tmp/sf-p2-$$.out); rm -f /tmp/sf-p?-$$.out
    local frames; frames=$(pq -c "select count(*) from public.flow_run_subflow_frames where flow_run_id='$r'")
    { { [ "$res1" = true ] && [ "$res2" = false ]; } || { [ "$res1" = false ] && [ "$res2" = true ]; }; } && [ "$frames" = 1 ] || { echo "QA-RESULT [$1] T12 FAIL round $round: $res1/$res2, $frames frame(s)"; ok12=0; }
  done
  [ "$ok12" = 1 ] && echo "QA-RESULT [$1] T12 PASS 5 rounds: two sessions entering the same subflow at the same instant: exactly one wins, exactly one frame"
  # T13: two sessions pop the same call at the same instant: exactly one returns, the cursor lands once
  local ok13=1
  for round in 1 2 3 4 5; do
    fb=$(pq -c "select public.qa_simple('$acct','$ua','PB$round')"); fc=$(pq -c "select public.qa_simple('$acct','$ua','PC$round')"); fa=$(pq -c "select public.qa_caller('$acct','$ua','PA$round','$fb','$fc')"); r=$(pq -c "select public.qa_run('$fa','call1')")
    pq -c "select public.qa_push('$r','call1','$fb','mid')" >/dev/null
    at=$(pq -c "select clock_timestamp() + interval '2 seconds'")
    ( pq -c "select pg_sleep(greatest(0, extract(epoch from ('$at'::timestamptz - clock_timestamp())))); select (public.qa_pop('$r','$fb')->>'ok')" > /tmp/sf-q1-$$.out 2>&1 ) &
    ( pq -c "select pg_sleep(greatest(0, extract(epoch from ('$at'::timestamptz - clock_timestamp())))); select (public.qa_pop('$r','$fb')->>'ok')" > /tmp/sf-q2-$$.out 2>&1 ) & wait
    res1=$(tail -1 /tmp/sf-q1-$$.out); res2=$(tail -1 /tmp/sf-q2-$$.out); rm -f /tmp/sf-q?-$$.out
    local cur; cur=$(pq -c "select coalesce(current_flow_id::text,'root') || '|' || current_node_key from public.flow_runs where id='$r'")
    { { [ "$res1" = true ] && [ "$res2" = false ]; } || { [ "$res1" = false ] && [ "$res2" = true ]; }; } && [ "$cur" = "root|mid" ] || { echo "QA-RESULT [$1] T13 FAIL round $round: $res1/$res2, cursor $cur"; ok13=0; }
  done
  [ "$ok13" = 1 ] && echo "QA-RESULT [$1] T13 PASS 5 rounds: two sessions returning from the same subflow at the same instant: exactly one wins, the caller resumes once at the return node"
  # T14: push racing with a change to the callee: either the call happens with a pinned hash, or it is refused; never a frame with a stale pin
  local ok14=1
  for round in 1 2 3; do
    fb=$(pq -c "select public.qa_simple('$acct','$ua','GB$round')"); fc=$(pq -c "select public.qa_simple('$acct','$ua','GC$round')"); fa=$(pq -c "select public.qa_caller('$acct','$ua','GA$round','$fb','$fc')"); r=$(pq -c "select public.qa_run('$fa','call1')")
    at=$(pq -c "select clock_timestamp() + interval '2 seconds'")
    ( pq -c "select pg_sleep(greatest(0, extract(epoch from ('$at'::timestamptz - clock_timestamp())))); select (public.qa_push('$r','call1','$fb','mid')->>'ok')" > /tmp/sf-g1-$$.out 2>&1 ) &
    ( pq -c "select pg_sleep(greatest(0, extract(epoch from ('$at'::timestamptz - clock_timestamp())))); update public.flow_nodes set config = jsonb_set(config,'{next_node_key}','\"start\"') where flow_id='$fb' and node_key='end'" > /tmp/sf-g2-$$.out 2>&1 ) & wait
    rm -f /tmp/sf-g?-$$.out
    local frames; frames=$(pq -c "select count(*) from public.flow_run_subflow_frames where flow_run_id='$r'")
    if [ "$frames" = 1 ]; then
      local pinned_now pop; pinned_now=$(pq -c "select (callee_graph_hash = public.flow_graph_hash('$fb'))::text from public.flow_run_subflow_frames where flow_run_id='$r'"); pop=$(pq -c "select coalesce(public.qa_pop('$r','$fb')->>'reason','ok')")
      { [ "$pinned_now" = true ] && [ "$pop" = ok ]; } || { [ "$pinned_now" = false ] && [ "$pop" = callee_graph_changed ]; } || { echo "QA-RESULT [$1] T14 FAIL round $round: pinned_now=$pinned_now pop=$pop"; ok14=0; }
    else echo "QA-RESULT [$1] T14 FAIL round $round: $frames frames"; ok14=0; fi
  done
  [ "$ok14" = 1 ] && echo "QA-RESULT [$1] T14 PASS 3 rounds: a call racing with an edit of the callee either pins the new graph or is caught at the return (callee_graph_changed): never a silent mismatch"
}
run_scenario() { local label="$1"; shift; [ -n "${QA_ONLY:-}" ] && [[ "$label" != *"$QA_ONLY"* ]] && return 0; start; apply "$@"; echo "== $label: $# migrations applied"; suite "$label"; races "$label" | tee -a "$LOG"; stop; }

run_scenario "main:001-071" $(mig_le 71)
if [ -n "$E4" ]; then
  run_scenario "e4-first:001-051,052-066,067-071" $(mig_le 51) $(ls "$E4"/05[2-9]_*.sql "$E4"/06[0-6]_*.sql) $M067 $M068 $M069 $M070 $M071
  run_scenario "071-first:001-051,067-071,052-066" $(mig_le 51) $M067 $M068 $M069 $M070 $M071 $(ls "$E4"/05[2-9]_*.sql "$E4"/06[0-6]_*.sql)
fi
echo "---- matrix"
for t in T01 T02 T03 T04 T05 T06 T07 T08 T09 T10 T11 T12 T13 T14 T15 T16 T17 T18 T19 T20; do
  n=$(grep -c "QA-RESULT .*] $t PASS" "$LOG" || true); want=1; [ -n "$E4" ] && want=3; [ -n "${QA_ONLY:-}" ] && want=1
  [ "$n" -ge "$want" ] && echo "$t PASS ($n scenario(s))" || { echo "$t MISSING/FAIL ($n of $want)"; FAILED=1; }
done
grep -q 'QA-RESULT .* FAIL\|ERROR:' "$LOG" && FAILED=1
[ "$FAILED" = 0 ] && echo "SUBFLOW EXECUTION DB QA PASS" || { echo "SUBFLOW EXECUTION DB QA FAILED" >&2; exit 1; }
