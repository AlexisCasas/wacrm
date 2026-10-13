#!/usr/bin/env bash
# Isolated PostgreSQL 17 (no network, no ports, destroyed on exit) for migration 069 (durable waits).
# Usage: qa/durable-wait/run-db-qa.sh [--e4-migrations <dir with 052..066 *.sql>]
# Proves: W01-W09 (transactional SQL), races between real sessions (W10 claim, W11 consume), persistence across a database
# restart (W12), and that 069 coexists with E4.1/F06 migrations in both orders (with --e4-migrations).
set -euo pipefail
cd "$(dirname "$0")/../.."
FS=qa/flows-safe-save; HERE=qa/durable-wait; IMAGE="${QA_PG_IMAGE:-supabase/postgres:17.6.1.136}"; E4=""
[ "${1:-}" = "--e4-migrations" ] && E4="$2"
LOG="$(mktemp)"; NAME=""; FAILED=0
cleanup() { rm -f "$LOG"; [ -n "$NAME" ] && docker rm -f "$NAME" >/dev/null 2>&1 || true; }; trap cleanup EXIT
psql_() { docker exec -i -e PGOPTIONS="-c client_min_messages=${QA_MIN_MSG:-notice}" "$NAME" psql -U supabase_admin -h /var/run/postgresql -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
pq() { docker exec -i "$NAME" psql -U supabase_admin -h /var/run/postgresql -d postgres -X -A -t -q -v ON_ERROR_STOP=1 "$@"; }
wait_ready() { local _ log; for _ in $(seq 1 120); do sleep 1; log="$(docker logs "$NAME" 2>&1 || true)"
  if grep -q 'PostgreSQL init process complete' <<<"$log" && [ "$(grep -c 'ready to accept connections' <<<"$log")" -ge "${1:-2}" ] && psql_ -Atc 'select 1' >/dev/null 2>&1; then return 0; fi; done; echo "database did not start" >&2; return 1; }
start() { NAME="dw-qa-$$-$RANDOM"; docker run -d --name "$NAME" --network none -e POSTGRES_PASSWORD=qa "$IMAGE" >/dev/null; wait_ready 2; QA_MIN_MSG=warning psql_ < "$FS/bootstrap.sql" >/dev/null; }
apply() { local f; for f in "$@"; do QA_MIN_MSG=warning psql_ < "$f" >/dev/null || { echo "migration failed: $f" >&2; return 1; }; done; }
stop() { docker rm -f "$NAME" >/dev/null 2>&1 || true; NAME=""; }
mig_le() { ls supabase/migrations/*.sql | awk -F/ -v max="$1" '{ n=substr($NF,1,3); if (n+0 <= max+0) print $0 }'; }
M069=supabase/migrations/069_flow_durable_waits.sql
A=a1000000-0000-4000-8000-0000000000f1

suite() { # <label>
  QA_MIN_MSG=warning psql_ < "$FS/fixtures.sql" >/dev/null 2>&1 || true            # committed fixtures (also used by the races)
  { echo 'BEGIN;'; cat "$HERE/helpers.sql" "$HERE/db-waits.sql"; echo 'ROLLBACK;'; } | psql_ -o /dev/null 2>&1 | sed "s/^NOTICE:  QA-RESULT \([A-Z0-9]*\)/QA-RESULT [$1] \1/" | tee -a "$LOG" | grep -E 'QA-RESULT|ERROR' || true
}
races() { # <label> real concurrent sessions
  local acct; acct=$(pq -c "select account_id from public.flows where id='$A'")
  psql_ < "$HERE/helpers.sql" >/dev/null
  local round bad=0 i ids
  for round in 1 2 3; do
    ids=(); for i in $(seq 1 40); do ids+=("$(pq -c "select public.qa_wait_run(1000 + $round * 100 + $i)")"); done
    pq -c "update public.flow_runs set wait_until = clock_timestamp() - interval '1 minute', wait_node_key='pause', current_node_key='pause' where id in ($(printf "'%s'," "${ids[@]}" | sed 's/,$//'))" >/dev/null
    local at; at=$(pq -c "select clock_timestamp() + interval '2 seconds'")
    for w in 1 2 3 4; do ( pq -c "select pg_sleep(greatest(0, extract(epoch from ('$at'::timestamptz - clock_timestamp())))); select string_agg(run_id::text, ',') from public.claim_due_flow_waits(ARRAY['$acct'::uuid], 100, 300)" > /tmp/dw-claim-$$-$w.out 2>&1 ) & done; wait
    local all; all=$(cat /tmp/dw-claim-$$-?.out | tr ',' '\n' | grep -E '^[0-9a-f-]{36}$' | sort); local total uniq
    total=$(echo "$all" | grep -c . || true); uniq=$(echo "$all" | sort -u | grep -c . || true)
    [ "$total" = 40 ] && [ "$uniq" = 40 ] || { echo "QA-RESULT [$1] W10 FAIL round $round: $total claims, $uniq distinct (expected 40/40)"; bad=1; }
    rm -f /tmp/dw-claim-$$-?.out
  done
  [ "$bad" = 0 ] && echo "QA-RESULT [$1] W10 PASS 3 rounds x 40 due runs claimed by 4 simultaneous workers: every run claimed exactly once (no duplicates, none lost)"
  # consume race: one claimed run, two sessions consume with the same token at the same instant
  local r tok; r=$(pq -c "select public.qa_wait_run(5000)"); pq -c "select public.schedule_flow_wait('$acct', '$r', 'pause', clock_timestamp() + interval '1 hour')" >/dev/null
  pq -c "update public.flow_runs set wait_until = clock_timestamp() - interval '1 second' where id='$r'" >/dev/null
  tok=$(pq -c "select claim_token from public.claim_due_flow_waits(ARRAY['$acct'::uuid], 1, 300)")
  local at2; at2=$(pq -c "select clock_timestamp() + interval '2 seconds'"); local res1 res2
  ( pq -c "select pg_sleep(greatest(0, extract(epoch from ('$at2'::timestamptz - clock_timestamp())))); select public.consume_flow_wait('$acct', '$r', '$tok', 'after')" > /tmp/dw-c1-$$.out 2>&1 ) &
  ( pq -c "select pg_sleep(greatest(0, extract(epoch from ('$at2'::timestamptz - clock_timestamp())))); select public.consume_flow_wait('$acct', '$r', '$tok', 'after')" > /tmp/dw-c2-$$.out 2>&1 ) & wait
  res1=$(tail -1 /tmp/dw-c1-$$.out); res2=$(tail -1 /tmp/dw-c2-$$.out); rm -f /tmp/dw-c?-$$.out
  if { [ "$res1" = t ] && [ "$res2" = f ]; } || { [ "$res1" = f ] && [ "$res2" = t ]; }; then echo "QA-RESULT [$1] W11 PASS two simultaneous resumes of the same claimed run: exactly one wins ($res1/$res2), the run sits at the next node once"; else echo "QA-RESULT [$1] W11 FAIL consume race: $res1/$res2"; fi
}
persistence() { # <label> the database restarts while a wait is pending
  local acct r; acct=$(pq -c "select account_id from public.flows where id='$A'"); r=$(pq -c "select public.qa_wait_run(6000)")
  pq -c "select public.schedule_flow_wait('$acct', '$r', 'pause', clock_timestamp() + interval '13 minutes')" >/dev/null
  local before; before=$(pq -c "select wait_node_key || '|' || (wait_until > clock_timestamp() + interval '12 minutes') from public.flow_runs where id='$r'")
  docker restart "$NAME" >/dev/null; wait_ready 3
  local after; after=$(pq -c "select wait_node_key || '|' || (wait_until > clock_timestamp() + interval '12 minutes') || '|' || status from public.flow_runs where id='$r'")
  pq -c "update public.flow_runs set wait_until = clock_timestamp() - interval '1 second' where id='$r'" >/dev/null
  local claimed; claimed=$(pq -c "select count(*) from public.claim_due_flow_waits(ARRAY['$acct'::uuid], 50, 300) where run_id='$r'")
  [ "$before" = "pause|true" ] && [ "$after" = "pause|true|active" ] && [ "$claimed" = 1 ] && echo "QA-RESULT [$1] W12 PASS a 13-minute wait survives a restart of the database server (still pending, still ~13 min away, active) and is claimed normally once due" || echo "QA-RESULT [$1] W12 FAIL persistence: before=$before after=$after claimed=$claimed"
}
run_scenario() { local label="$1"; shift; [ -n "${QA_ONLY:-}" ] && [[ "$label" != *"$QA_ONLY"* ]] && return 0; start; apply "$@"; echo "== $label: $# migrations applied"; suite "$label"; races "$label" | tee -a "$LOG"; persistence "$label" | tee -a "$LOG"; stop; }

run_scenario "main:001-069" $(mig_le 69)
if [ -n "$E4" ]; then
  run_scenario "e4-first:001-051,052-066,067-069" $(mig_le 51) $(ls "$E4"/05[2-9]_*.sql "$E4"/06[0-6]_*.sql) supabase/migrations/067_replace_flow_draft_atomic.sql supabase/migrations/068_execute_flow_authoring_guards.sql $M069
  run_scenario "069-first:001-051,067-069,052-066" $(mig_le 51) supabase/migrations/067_replace_flow_draft_atomic.sql supabase/migrations/068_execute_flow_authoring_guards.sql $M069 $(ls "$E4"/05[2-9]_*.sql "$E4"/06[0-6]_*.sql)
fi
echo "---- matrix"
for t in W01 W02 W03 W04 W05 W06 W07 W08 W09 W10 W11 W12; do
  n=$(grep -c "QA-RESULT .*] $t PASS" "$LOG" || true); want=1; [ -n "$E4" ] && want=3; [ -n "${QA_ONLY:-}" ] && want=1
  [ "$n" -ge "$want" ] && echo "$t PASS ($n scenario(s))" || { echo "$t MISSING/FAIL ($n of $want)"; FAILED=1; }
done
grep -q 'QA-RESULT .* FAIL\|ERROR:' "$LOG" && FAILED=1
[ "$FAILED" = 0 ] && echo "DURABLE WAIT DB QA PASS" || { echo "DURABLE WAIT DB QA FAILED" >&2; exit 1; }
