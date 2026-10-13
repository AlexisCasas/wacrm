#!/usr/bin/env bash
# E4.2B1.2 QA L03, L22-L24: real concurrent PostgreSQL sessions against the
# lease/fencing/CAS RPCs. Needs committed fixtures + helpers.
# Usage: e42b12-concurrency.sh <container-name>
# Ordering is enforced with an advisory-lock gate and by polling
# pg_stat_activity for the expected wait states (no sleeps for ordering).
set -euo pipefail
NAME="$1"
source "$(dirname "$0")/qa-conc-lib.sh"
ACC=$(pq -c "select account_id from public.flows where id='50000000-0000-4000-8000-000000000001'")
VER=$(pq -c "select active_version_id from public.flows where id='50000000-0000-4000-8000-000000000001'")
cp_json() { echo "{\"cursor\":{\"flow_version_id\":\"$VER\",\"node_key\":\"$1\"},\"step\":$2}"; }
new_run() { pq -c "select public.qa_new_run($1)"; }
acquire() { echo "select '$1','acquire',acquired,fencing_token,coalesce(reason,'') from public.acquire_versioned_run_lease('$ACC','$2','$3',60);"; }
reclaim() { echo "select '$1','reclaim',acquired,fencing_token,coalesce(reason,'') from public.reclaim_versioned_run_lease('$ACC','$2','$3',60);"; }
cas() { echo "select '$1','cas',committed,revision,coalesce(reason,'') from public.commit_versioned_run_transition('$ACC','$2','$3',$4,$5,'$6'::jsonb);"; }

row() { pq -F '|' -c "select versioned_lease_owner, versioned_lease, versioned_revision, status, versioned_node_key from public.flow_runs where id='$1'"; }

# ---- L03: two owners, same free run, held transaction then three gated races
CUR=L03; RID=$(new_run 201)
hold "$(acquire A "$RID" owner-a)" "$(acquire B "$RID" owner-b)"
RA=$(res A a); RB=$(res B b); echo "-- $CUR results: $RA // $RB"
[ "$(field "$RA" 3)" = t ] && [ "$(field "$RB" 3)" = f ] && [ "$(field "$RB" 5)" = lease_held ] || fail "expected A acquired, B lease_held; got $RA // $RB"
[ "$(row "$RID")" = "owner-a|1|0|active|start" ] || fail "final row $(row "$RID")"
for n in 202 203 204; do
  RID=$(new_run $n); race "$(acquire A "$RID" owner-a)" "$(acquire B "$RID" owner-b)"
  RA=$(res A a); RB=$(res B b); echo "-- $CUR race $n: $RA // $RB"
  won=0; [ "$(field "$RA" 3)" = t ] && won=$((won+1)); [ "$(field "$RB" 3)" = t ] && won=$((won+1))
  [ "$won" = 1 ] || fail "race $n: $won winners"
  loser=$([ "$(field "$RA" 3)" = t ] && field "$RB" 5 || field "$RA" 5); [ "$loser" = lease_held ] || fail "race $n: loser reason $loser"
  [ "$(pq -c "select versioned_lease from public.flow_runs where id='$RID'")" = 1 ] || fail "race $n: token != 1"
  winner=$([ "$(field "$RA" 3)" = t ] && echo owner-a || echo owner-b)
  [ "$(pq -c "select versioned_lease_owner from public.flow_runs where id='$RID'")" = "$winner" ] || fail "race $n: stored owner is not the winner"
done
ok L03 "two concurrent owners: exactly one lease (token 1) per run in 1 held-transaction scenario (B blocked on A's uncommitted lease) + 3 simultaneous races; loser got lease_held"

# ---- L22: old writer vs reclaimer. R reclaims the expired lease inside an open
# transaction; W (old owner, token 1) tries to commit and blocks; after R commits W is stale.
CUR=L22; RID=$(new_run 205)
pq -c "$(acquire X "$RID" old-owner | sed 's/^select .X.,.acquire.,/select /')" >/dev/null
pq -c "update public.flow_runs set versioned_lease_expires_at = clock_timestamp() - interval '1 second' where id='$RID'" >/dev/null
hold "$(reclaim A "$RID" new-owner)" "$(cas B "$RID" old-owner 1 0 "$(cp_json end 1)")"
RA=$(res A a); RB=$(res B b); echo "-- $CUR results: $RA // $RB"
[ "$(field "$RA" 3)" = t ] && [ "$(field "$RA" 4)" = 2 ] || fail "reclaim should win with token 2: $RA"
[ "$(field "$RB" 3)" = f ] && [ "$(field "$RB" 5)" = stale_lease ] || fail "old writer must be stale_lease: $RB"
[ "$(row "$RID")" = "new-owner|2|0|active|start" ] || fail "old writer changed the run: $(row "$RID")"
ok L22 "expired lease reclaimed (token 1->2) while the old owner's CAS was blocked on it; old writer got stale_lease; revision 0, cursor still 'start'"

# ---- L23: two writers with the same expected revision (same owner + token).
CUR=L23; RID=$(new_run 206); pq -c "$(acquire X "$RID" owner-a | sed 's/^select .X.,.acquire.,/select /')" >/dev/null
hold "$(cas A "$RID" owner-a 1 0 "$(cp_json end 1)")" "$(cas B "$RID" owner-a 1 0 "$(cp_json start 2)")"
RA=$(res A a); RB=$(res B b); echo "-- $CUR results: $RA // $RB"
[ "$(field "$RA" 3)" = t ] && [ "$(field "$RA" 4)" = 1 ] || fail "A should commit revision 1: $RA"
[ "$(field "$RB" 3)" = f ] && [ "$(field "$RB" 5)" = revision_conflict ] && [ "$(field "$RB" 4)" = 1 ] || fail "B should get revision_conflict at revision 1: $RB"
[ "$(row "$RID")" = "owner-a|1|1|active|end" ] || fail "final row $(row "$RID")"
[ "$(pq -c "select versioned_checkpoint->>'step' from public.flow_runs where id='$RID'")" = 1 ] || fail "checkpoint is not the winner's"
ok L23 "two CAS with expected revision 0: one committed (rev 1, cursor 'end', step 1), the other blocked then revision_conflict; no contradictory transition persisted"

# ---- L24: an agent pauses the run (open transaction) while a worker commits CAS.
CUR=L24; RID=$(new_run 207); pq -c "$(acquire X "$RID" owner-a | sed 's/^select .X.,.acquire.,/select /')" >/dev/null
hold "update public.flow_runs set status='paused_by_agent' where id='$RID';" "$(cas B "$RID" owner-a 1 0 "$(cp_json end 1)")"
RB=$(res B b); echo "-- $CUR result: $RB"
[ "$(field "$RB" 3)" = f ] && [ "$(field "$RB" 5)" = run_not_active ] || fail "CAS must see the pause: $RB"
[ "$(row "$RID")" = "owner-a|1|0|paused_by_agent|start" ] || fail "final row $(row "$RID")"
ok L24 "CAS blocked behind an uncommitted agent pause, then refused with run_not_active; run stays paused, revision 0, cursor 'start'"
