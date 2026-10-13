#!/usr/bin/env bash
# Isolated PostgreSQL 17 (supabase/postgres image, no network, no published ports, destroyed on exit) for the atomic-save migration.
# Usage: qa/subflow-pilot/run-db-qa.sh [--e4-migrations <dir with 052..066 *.sql>]
#   without the option: migrations 001..067 of this branch.
#   with it: also proves 067 coexists with E4.1/F06 both ways (067 before 052-066, and 052-066 before 067).
set -euo pipefail
cd "$(dirname "$0")/../.."
HERE=qa/flows-safe-save; PILOT=qa/subflow-pilot; IMAGE="${QA_PG_IMAGE:-supabase/postgres:17.6.1.136}"; E4=""
[ "${1:-}" = "--e4-migrations" ] && E4="$2"
LOG="$(mktemp)"; NAME=""
cleanup() { rm -f "$LOG"; [ -n "$NAME" ] && docker rm -f "$NAME" >/dev/null 2>&1 || true; }; trap cleanup EXIT
FAILED=0

start() { # <label>
  NAME="f3-qa-$$-$RANDOM"
  docker run -d --rm --name "$NAME" --network none -e POSTGRES_PASSWORD=qa "$IMAGE" >/dev/null
  local _ log; for _ in $(seq 1 120); do sleep 1; log="$(docker logs "$NAME" 2>&1 || true)"
    if grep -q 'PostgreSQL init process complete' <<<"$log" && [ "$(grep -c 'ready to accept connections' <<<"$log")" -ge 2 ] && psql_ -Atc 'select 1' >/dev/null 2>&1; then break; fi; done
  QA_MIN_MSG=warning psql_ < "$HERE/bootstrap.sql" >/dev/null
}
psql_() { docker exec -i -e PGOPTIONS="-c client_min_messages=${QA_MIN_MSG:-notice}" "$NAME" psql -U supabase_admin -h /var/run/postgresql -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
apply() { local f; for f in "$@"; do QA_MIN_MSG=warning psql_ < "$f" >/dev/null || { echo "migration failed: $f" >&2; return 1; }; done; }
stop() { docker rm -f "$NAME" >/dev/null 2>&1 || true; NAME=""; }
mig_le() { ls supabase/migrations/*.sql | awk -F/ -v max="$1" '{ n=substr($NF,1,3); if (n+0 <= max+0) print $0 }'; }
M067="supabase/migrations/067_replace_flow_draft_atomic.sql supabase/migrations/068_execute_flow_authoring_guards.sql"

suite() { # <label> -> runs the transactional DB tests
  { echo 'BEGIN;'; cat "$HERE/fixtures.sql" "$HERE/db-atomic-save.sql" "$PILOT/db-guards.sql"; echo 'ROLLBACK;'; } | psql_ -o /dev/null 2>&1 | sed "s/^NOTICE:  QA-RESULT \([A-Z0-9]*\)/QA-RESULT [$1] \1/" | tee -a "$LOG" | grep -E 'QA-RESULT|ERROR' || true
}
concurrency() { # <label> two real sessions saving the same flow with different 40-node payloads
  psql_ -q < "$HERE/fixtures.sql" >/dev/null
  local acct; acct=$(psql_ -At -c "select account_id from public.flows where id='a1000000-0000-4000-8000-0000000000f1'")
  payload() { echo "select count(*) from public.replace_flow_draft_atomic('$acct','a1000000-0000-4000-8000-0000000000f1','{\"name\":\"$1\"}'::jsonb, (select jsonb_agg(jsonb_build_object('node_key','n'||g,'node_type','send_message','config',jsonb_build_object('writer','$1'))) from generate_series(1,40) g));"; }
  local i bad=0
  for i in 1 2 3 4 5 6; do
    psql_ -At -c "$(payload W1)" >/dev/null & p1=$!; psql_ -At -c "$(payload W2)" >/dev/null & p2=$!; wait $p1 $p2
    local w; w=$(psql_ -At -c "select string_agg(distinct config->>'writer', ',') || '|' || count(*) || '|' || (select name from public.flows where id='a1000000-0000-4000-8000-0000000000f1') from public.flow_nodes where flow_id='a1000000-0000-4000-8000-0000000000f1'")
    case "$w" in 'W1|40|W1'|'W2|40|W2') ;; *) echo "QA-RESULT [$1] D08 FAIL interleaved or lost write: $w"; bad=1;; esac
  done
  [ "$bad" = 0 ] && echo "QA-RESULT [$1] D08 PASS 6 pairs of simultaneous saves of one flow: always exactly one complete 40-node graph with the matching header (no interleaving, no lost or mixed rows)"
}
atomic_session() { # <label> a failing call in its own session leaves nothing behind, seen from another session
  local acct before after; acct=$(psql_ -At -c "select account_id from public.flows where id='a1000000-0000-4000-8000-0000000000f1'")
  before=$(psql_ -At -c "select md5(public.qa_flow_state('a1000000-0000-4000-8000-0000000000f1')::text)")
  psql_ -At -c "select public.replace_flow_draft_atomic('$acct','a1000000-0000-4000-8000-0000000000f1','{\"name\":\"X\"}','[{\"node_key\":\"a\",\"node_type\":\"start\"},{\"node_key\":\"a\",\"node_type\":\"end\"}]')" >/dev/null 2>&1 && { echo "QA-RESULT [$1] D09 FAIL duplicate keys were accepted"; return; }
  after=$(psql_ -At -c "select md5(public.qa_flow_state('a1000000-0000-4000-8000-0000000000f1')::text)")
  [ "$before" = "$after" ] && echo "QA-RESULT [$1] D09 PASS a failed autocommit call (a real separate transaction, not a savepoint) leaves the committed flow byte-identical when read from another session" || echo "QA-RESULT [$1] D09 FAIL state changed after a failed call"
}
revision_advances() { # <label> each committed save moves updated_at forward (the value the editor and E4.1 use as a revision)
  local f='a1000000-0000-4000-8000-0000000000f1' acct t1 t2
  acct=$(psql_ -At -c "select account_id from public.flows where id='$f'")
  t1=$(psql_ -At -c "select updated_at from public.replace_flow_draft_atomic('$acct','$f','{\"name\":\"R1\"}')")
  t2=$(psql_ -At -c "select updated_at from public.replace_flow_draft_atomic('$acct','$f','{\"name\":\"R2\"}')")
  [ "$(psql_ -At -c "select '$t2'::timestamptz > '$t1'::timestamptz")" = t ] && echo "QA-RESULT [$1] D11 PASS two committed saves return strictly increasing updated_at ($t1 < $t2)" || echo "QA-RESULT [$1] D11 FAIL updated_at did not advance: $t1 / $t2"
}
legacy_sequence() { # <label> the OLD route: three separate statements (three PostgREST calls) -> a failure in the last leaves a half-saved flow
  local f='a1000000-0000-4000-8000-0000000000f1' before after
  before=$(psql_ -At -c "select md5(public.qa_flow_state('$f')::text)")
  psql_ -q -c "update public.flows set name='LEGACY HEADER', updated_at=clock_timestamp() where id='$f'" >/dev/null
  psql_ -q -c "delete from public.flow_nodes where flow_id='$f'" >/dev/null
  psql_ -q -c "insert into public.flow_nodes (flow_id,node_key,node_type) values ('$f','k','not_a_type')" >/dev/null 2>&1 || true
  after=$(psql_ -At -c "select md5(public.qa_flow_state('$f')::text)||'|'||(select count(*) from public.flow_nodes where flow_id='$f')||'|'||(select name from public.flows where id='$f')")
  case "$after" in *'|0|LEGACY HEADER') echo "QA-RESULT [$1] D10 PASS defect reproduced with the previous three-statement sequence: the failed insert left the header changed and ALL nodes deleted (this is what 067 prevents)";;
    *) echo "QA-RESULT [$1] D10 FAIL could not reproduce the partial save: $after";; esac
}
run_scenario() { # <label> <migrations...>
  local label="$1"; shift; [ -n "${QA_ONLY:-}" ] && [[ "$label" != *"$QA_ONLY"* ]] && return 0; start "$label"; apply "$@"; echo "== $label: $(ls "$@" 2>/dev/null | wc -l) migrations applied"
  suite "$label"; concurrency "$label" | tee -a "$LOG"; atomic_session "$label" | tee -a "$LOG"; legacy_sequence "$label" | tee -a "$LOG"; revision_advances "$label" | tee -a "$LOG"; stop
}

run_scenario "main:001-068" $(mig_le 68)
if [ -n "$E4" ]; then
  # E4.1/F06 already applied, then 067 (the order after those PRs merge)
  run_scenario "e4-first:001-051,052-066,067-068" $(mig_le 51) $(ls "$E4"/05[2-9]_*.sql "$E4"/06[0-6]_*.sql) $M067
  # 067 applied first, then E4.1/F06 (the order in a database that already runs main)
  run_scenario "pilot-first:001-051,067-068,052-066" $(mig_le 51) $M067 $(ls "$E4"/05[2-9]_*.sql "$E4"/06[0-6]_*.sql)
fi
echo "---- matrix"
for t in D01 D02 D03 D04 D05 D06 D07 D08 D09 D10 D11 G01 G02 G03 G04 G06 G07 G08; do
  n=$(grep -c "QA-RESULT .*] $t PASS" "$LOG" || true); want=1; [ -n "$E4" ] && want=3
  [ "$n" -ge "$want" ] && echo "$t PASS ($n scenario(s))" || { echo "$t MISSING/FAIL ($n of $want)"; FAILED=1; }
done
grep -q 'QA-RESULT .* FAIL\|ERROR:' "$LOG" && FAILED=1
[ "$FAILED" = 0 ] && echo "SUBFLOW PILOT DB QA PASS" || { echo "SUBFLOW PILOT DB QA FAILED" >&2; exit 1; }
