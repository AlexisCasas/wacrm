#!/usr/bin/env bash
# Runs the F3 functional QA (F3-01..F3-10) in a real Chromium against the running staging (staging/up.sh first).
# The browser script asks this driver for database facts / fault injection through request files; evidence goes to shots/.
set -euo pipefail
source "$(dirname "$0")/lib.sh"; load_env
HERE="$(cd "$(dirname "$0")" && pwd)"; D="$HERE/state"; STOP="$D/.stop"
rm -rf "$D" "$HERE/shots"; mkdir -p "$D" "$HERE/shots"; chmod 777 "$D" "$HERE/shots"
q() { psql_db -At -c "$1"; }
fstate() { echo "select md5(jsonb_build_object('f',(select to_jsonb(f) from public.flows f where f.id='$1'),'n',(select coalesce(jsonb_agg(to_jsonb(n) order by n.node_key),'[]'::jsonb) from public.flow_nodes n where n.flow_id='$1'))::text)"; }
acct() { echo "(select p.account_id from public.profiles p join auth.users u on u.id=p.user_id where u.email='$1')"; }
handle() { local cmd="$1"; shift || true; case "$cmd" in
  ids) q "select json_build_object('account_a',$(acct "$USER_A_EMAIL"),'account_b',$(acct "$USER_B_EMAIL"),'flow_b',(select id from public.flows where name like 'OTHER COMPANY%' limit 1))";;
  fault) "$HERE/fault.sh" "$1";;
  flowdb) q "select json_build_object('name',f.name,'status',f.status,'description',f.description,'entry_node_id',f.entry_node_id,'account_id',f.account_id,'nodes',(select coalesce(json_agg(json_build_object('node_key',n.node_key,'config',n.config) order by n.node_key),'[]'::json) from public.flow_nodes n where n.flow_id=f.id)) from public.flows f where f.id='$1'";;
  snap) q "$(fstate "$2")" > "$D/snap-$1"; echo saved;;
  same) [ "$(q "$(fstate "$2")")" = "$(cat "$D/snap-$1")" ] && echo same || echo different;;
  hash-other) q "$(fstate "$(q "select id from public.flows where name like 'OTHER COMPANY%' limit 1")")";;
  counts) q "select json_build_object('active_flows',(select count(*) from public.flows where account_id=$(acct "$USER_A_EMAIL") and status='active'),'flow_runs',(select count(*) from public.flow_runs r join public.flows f on f.id=r.flow_id where f.account_id=$(acct "$USER_A_EMAIL")))";;
  *) echo "unknown command $cmd";; esac; }
watch() { while [ ! -f "$STOP" ]; do for r in "$D"/*.req; do [ -e "$r" ] || continue; id=$(basename "$r" .req); read -r -a parts < "$r" || true; rm -f "$r"
    out=$(handle "${parts[@]}" 2>&1 || true); printf '%s' "$out" > "$D/$id.tmpack"; mv "$D/$id.tmpack" "$D/$id.ack"; done; sleep 0.15; done; }
"$HERE/fault.sh" off >/dev/null; watch & WATCH=$!
trap 'touch "$STOP"; wait $WATCH 2>/dev/null; "$HERE/fault.sh" off >/dev/null 2>&1 || true' EXIT
set +e
docker exec -e URL="$URL" -e EMAIL_A="$USER_A_EMAIL" -e EMAIL_B="$USER_B_EMAIL" -e PASSWORD="$USER_PASSWORD" "$APP" node /qa/staging/e2e/f3.mjs 2>&1 | tee "$D/run.log"
RC=${PIPESTATUS[0]}
echo "---- matrix"; for t in F3-01 F3-02 F3-03 F3-04 F3-05 F3-05b F3-06 F3-07 F3-08 F3-09 F3-10 F3-10b; do grep -q "QA-RESULT $t PASS" "$D/run.log" && echo "$t PASS" || echo "$t FAIL/MISSING"; done
[ "$RC" = 0 ] && echo "F3 FUNCTIONAL QA (automated browser) PASS" || echo "F3 FUNCTIONAL QA (automated browser) FAILED"
exit "$RC"
