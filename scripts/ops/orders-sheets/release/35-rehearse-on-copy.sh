#!/usr/bin/env bash
# REHEARSAL of migration 20261109000000 + the test-order exclusion on a RESTORED COPY of production, in a throw-away container WITHOUT network. It reads only the
# backup files: it never touches the production database or containers. The copy holds real data, so nothing it reads is printed (counts and hashes only);
# the lifecycle tests use SYNTHETIC rows inserted in the copy. Safe to re-run; removes its container on exit.
. "$(dirname "$0")/lib.sh"
MIG=${1:-$MIG_FILE}
C=qa-sheets-rehearsal; DB=restore_target; OUT=$D/evidence/rehearsal; mkdir -p $OUT; umask 077
SU()  { docker exec -i $C psql -U supabase_admin -d $DB -X -At -v ON_ERROR_STOP=1 "$@"; }
OWN() { docker exec -i $C psql -U postgres -d $DB -X -At -v ON_ERROR_STOP=1 "$@"; }
ok() { echo "PASS $1"; }; bad() { echo "FAIL $1"; fail=1; }
cleanup() { docker rm -f -v $C >/dev/null 2>&1; }; trap cleanup EXIT
docker ps -a --format '{{.Names}}' | grep -x $C && { echo "container $C already exists: refusing"; exit 2; }
DUMP=$(ls $D/db/postgres_full_*.dump | tail -1); GLOB=$(ls $D/db/globals_*.sql | tail -1)
echo "migration sha256: $(sha256sum $MIG | cut -c1-64)"; echo "dump: $(basename $DUMP)"
echo "== 1. restore the production dump into an isolated, network-less container"
(cd $D/db && sha256sum -c SHA256SUMS --quiet) || { echo "backup checksum FAILED"; exit 1; }
docker run -d --name $C --network none --memory 3g -e POSTGRES_PASSWORD=qa_rehearsal_only supabase/postgres:17.6.1.136 >/dev/null
until docker exec $C pg_isready -U postgres -q 2>/dev/null; do sleep 2; done; sleep 8
chk "container has NO network" "$(docker inspect $C --format '{{.HostConfig.NetworkMode}}')" none
docker exec -i $C psql -U supabase_admin -d postgres -X -q < $GLOB > $OUT/globals.log 2>&1
docker exec $C psql -U supabase_admin -d postgres -X -qc "CREATE DATABASE $DB OWNER postgres" >/dev/null
docker exec -i $C pg_restore -U supabase_admin -d $DB < $DUMP > $OUT/restore.log 2>&1; chk "pg_restore errors" "$(grep -c '^pg_restore: error' $OUT/restore.log)" 0
chk "production ownership replicated (postgres can CREATE in public)" "$(SU -c "select has_schema_privilege('postgres','public','create')")" t
chk "export tables not present in the copy" "$(SU -c "select count(*) from pg_tables where schemaname='public' and tablename like 'order_sheet%'")" 0
echo "== 2. snapshots BEFORE (counts and hashes only)"
toc() { docker exec $C pg_dump -U supabase_admin -d $DB -s -Fc | docker exec -i $C pg_restore -l | grep -v '^;' | sed -E 's/^[0-9]+; [0-9]+ [0-9]+ //' | sort; }
toc > $OUT/objects-before.txt; echo "   schema objects before: $(wc -l < $OUT/objects-before.txt)"
FP="select 'order_confirmations',count(*),sum(hashtext(t::text)) from public.order_confirmations t union all select 'order_confirmation_items',count(*),sum(hashtext(t::text)) from public.order_confirmation_items t union all select 'order_integration_settings',count(*),sum(hashtext(t::text)) from public.order_integration_settings t union all select 'accounts',count(*),sum(hashtext(t::text)) from public.accounts t union all select 'messages',count(*),sum(hashtext(t::text)) from public.messages t union all select 'contacts',count(*),sum(hashtext(t::text)) from public.contacts t"
SU -F '|' -c "$FP" > $OUT/data-before.txt; awk -F'|' '{printf "   %s rows=%s\n",$1,$2}' $OUT/data-before.txt
SU -c "select string_agg(policyname, ',' order by policyname) from pg_policies where schemaname='public'" | md5sum | cut -c1-12 > $OUT/policies-before.md5
echo "== 3. ATOMICITY: a migration whose LAST statement fails must leave nothing behind"
sed '$ s#.*#GRANT EXECUTE ON FUNCTION public.this_function_does_not_exist() TO service_role;#' $MIG > $OUT/mutant-broken.sql
cmp -s $MIG $OUT/mutant-broken.sql && bad "mutant was not created"
OWN -1 -f - < $OUT/mutant-broken.sql > $OUT/mutant-apply.log 2>&1; rc=$?; [ $rc -ne 0 ] && ok "broken migration exits non-zero (rc=$rc)" || bad "broken migration returned 0"
chk "objects left after the failed run (tables + functions)" "$(SU -c "select (select count(*) from pg_tables where schemaname='public' and tablename like 'order_sheet%')+(select count(*) from pg_proc where proname like 'order_sheet%')")" 0
echo "== 4. apply the REAL migration exactly as documented (postgres, ON_ERROR_STOP, -1)"
T0=$(date +%s%N); OWN -1 -f - < $MIG > $OUT/apply1.log 2>&1; rc=$?; T1=$(date +%s%N); chk "apply rc" "$rc" 0; echo "   duration $(( (T1-T0)/1000000 )) ms"
chk "tables created" "$(SU -c "select count(*) from pg_tables where schemaname='public' and tablename like 'order_sheet%'")" 4
chk "functions created" "$(SU -c "select count(*) from pg_proc where pronamespace='public'::regnamespace and proname like 'order_sheet%'")" 8
OWN -1 -f - < $MIG > $OUT/apply2.log 2>&1; rc2=$?; [ $rc2 -ne 0 ] && ok "a second run fails (not idempotent by design)" || bad "second run succeeded?"
chk "objects unchanged by the failed second run" "$(SU -c "select (select count(*) from pg_tables where schemaname='public' and tablename like 'order_sheet%')||'/'||(select count(*) from pg_proc where proname like 'order_sheet%')")" "4/8"
echo "== 5. schema diff: ONLY the new tables, functions, their indexes/constraints and ACLs may appear"
toc > $OUT/objects-after.txt; diff $OUT/objects-before.txt $OUT/objects-after.txt | grep -E '^[<>]' > $OUT/objects.diff
echo "   removed: $(grep -c '^<' $OUT/objects.diff) | added: $(grep -c '^>' $OUT/objects.diff)"
chk "no object was removed or changed" "$(grep -c '^<' $OUT/objects.diff)" 0
chk "every added object belongs to order_sheet_*" "$(grep '^>' $OUT/objects.diff | grep -vc 'order_sheet')" 0
echo "   added by kind: $(grep '^>' $OUT/objects.diff | sed -E 's/^> //' | awk '{print $1}' | sort | uniq -c | awk '{printf "%s=%s ",$2,$1}')"
chk "policies unchanged" "$(SU -c "select string_agg(policyname, ',' order by policyname) from pg_policies where schemaname='public'" | md5sum | cut -c1-12)" "$(cat $OUT/policies-before.md5)"
SU -F '|' -c "$FP" > $OUT/data-after.txt; chk "data fingerprints identical (6 tables)" "$(cmp -s $OUT/data-before.txt $OUT/data-after.txt && echo same || echo DIFFERENT)" same
echo "== 6. privileges and RLS (as in production roles)"
chk "RLS on all 4 tables" "$(SU -c "select count(*) from pg_class where relname like 'order_sheet%' and relkind='r' and relrowsecurity")" 4
chk "anon/authenticated/PUBLIC have no table grants" "$(SU -c "select count(*) from information_schema.role_table_grants where table_name like 'order_sheet%' and grantee in ('anon','authenticated','PUBLIC')")" 0
chk "only service_role may execute the 8 functions" "$(SU -c "select count(*) from pg_proc p where proname like 'order_sheet%' and pronamespace='public'::regnamespace and (has_function_privilege('anon',p.oid,'execute') or has_function_privilege('authenticated',p.oid,'execute') or exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee=0))")" 0
chk "service_role executes all 8" "$(SU -c "select bool_and(has_function_privilege('service_role',p.oid,'execute')) from pg_proc p where proname like 'order_sheet%' and pronamespace='public'::regnamespace")" t
chk "functions are SECURITY INVOKER with pinned search_path" "$(SU -c "select count(*) from pg_proc where proname like 'order_sheet%' and pronamespace='public'::regnamespace and (prosecdef or proconfig::text not like '%search_path=public%')")" 0
echo "== 7. the prepared exclusion script on the real copy (guards, idempotency, orders untouched)"
SU -c "select md5(string_agg(o::text, ',' order by id)) from order_confirmations o" > $OUT/orders-pre-excl.md5
OWN -1 -f - < $D/sql/exclude-test-orders.sql > $OUT/excl1.log 2>&1; chk "exclusion script rc" "$?" 0
OWN -1 -f - < $D/sql/exclude-test-orders.sql > $OUT/excl2.log 2>&1; chk "exclusion script is idempotent (rc)" "$?" 0
chk "2 exclusions, both 'test'" "$(SU -c "select count(*)||':'||min(reason)||':'||max(reason) from order_sheet_exclusions")" "2:test:test"
chk "order rows byte-identical after the exclusion" "$(SU -c "select md5(string_agg(o::text, ',' order by id)) from order_confirmations o")" "$(cat $OUT/orders-pre-excl.md5)"
echo "== 8. historical totals on this cut (aggregates only): acknowledged orders, lines, units, amount, minus the 2 excluded"
SU -F '|' -c "
with k as (select o.id, o.price, o.quantity, o.delivery_status, o.account_id,
  (select count(*) from order_confirmation_items i where i.order_id=o.id) n, (select coalesce(sum(i.quantity),0) from order_confirmation_items i where i.order_id=o.id) iq
  from order_confirmations o where o.account_id='$KEYLER'),
 e as (select * from k where delivery_status='acknowledged' and id not in (select order_id from order_sheet_exclusions))
select 'orders_total='||(select count(*) from k)||' acknowledged='||(select count(*) from k where delivery_status='acknowledged')||' not_ack='||(select count(*) from k where delivery_status<>'acknowledged')||' excluded_test='||(select count(*) from order_sheet_exclusions where reason='test')
 ||' | ELIGIBLE orders='||count(*)||' lines='||sum(greatest(n,1))||' units='||sum(case when n>0 then iq else quantity end)||' amount='||sum(price)||' multiproduct_orders='||count(*) filter (where n>0)
from e" | tee $OUT/historical-totals.txt
echo "== 9. lifecycle with SYNTHETIC rows (as service_role, like PostgREST)"
SU > $OUT/fixture.log <<EOT
insert into order_sheet_destinations (account_id, spreadsheet_id, enabled) values ('$KEYLER', '${SHEET_ID}', true);
insert into order_confirmations (id, account_id, confirmed_by_name, customer_name, destination, phone, price, product, quantity, request_key, seller_name, order_status, confirmed_at, delivery_status, acknowledged_at)
 values ('00000000-0000-4000-8000-0000000000a1','$KEYLER','Rehearsal','Sintetico','Lima','51900000000',10,'Producto sintetico',1,'rehearsal-a1','Vendedor','Pedido confirmado',now(),'acknowledged',now()),
        ('00000000-0000-4000-8000-0000000000a2','$KEYLER','Rehearsal','Sintetico','Lima','51900000000',20,'Producto sintetico',1,'rehearsal-a2','Vendedor','Pedido confirmado',now(),'held',null);
EOT
chk "synthetic fixtures inserted" "$?" 0
SQ() { docker exec -i $C psql -U supabase_admin -d $DB -X -At -v ON_ERROR_STOP=1 -c "set role service_role; $1" | tail -1; }
ENQ=$(SQ "select order_sheet_enqueue('$KEYLER')"); echo "   enqueue found $ENQ eligible job(s) (all real acknowledged orders minus the 2 excluded, plus 1 synthetic)"
chk "held synthetic order is NOT enqueued" "$(SU -c "select count(*) from order_sheet_exports where order_id='00000000-0000-4000-8000-0000000000a2'")" 0
chk "excluded orders get an 'excluded' job, never a pending one" "$(SU -c "select count(*) from order_sheet_exports where status='excluded' and exclusion_reason='test'")" 2
chk "second enqueue finds nothing new (idempotent)" "$(SQ "select order_sheet_enqueue('$KEYLER')")" 0
TOK=$(SQ "select order_sheet_acquire('$KEYLER', 240)"); [ ${#TOK} -eq 36 ] && ok "lease acquired" || bad "lease not acquired ($TOK)"
chk "a second worker cannot acquire the lease" "$(SQ "select coalesce(order_sheet_acquire('$KEYLER', 240)::text,'NULL')")" NULL
CL=$(SQ "select count(*) from order_sheet_claim('$KEYLER','$TOK', 5, 240, 8)"); chk "claim returns the requested batch" "$CL" 5
chk "a wrong token claims nothing" "$(SQ "select count(*) from order_sheet_claim('$KEYLER','00000000-0000-4000-8000-000000000000', 5, 240, 8)")" 0
chk "claimed jobs are 'processing' with attempts=1" "$(SU -c "select count(*)||':'||min(attempts) from order_sheet_exports where status='processing'")" "5:1"
chk "complete with the right token" "$(SQ "select order_sheet_complete('00000000-0000-4000-8000-0000000000a1','$TOK',1,1,10)")" t
chk "4 jobs still processing after the first completion" "$(SU -c "select count(*) from order_sheet_exports where status='processing'" | head -1)" 4
chk "wrong-token completion changes nothing" "$(SQ "select order_sheet_complete((select order_id from order_sheet_exports where status='processing' limit 1),'00000000-0000-4000-8000-000000000000',1,1,10)")" f
chk "fail -> pending with backoff" "$(SQ "select order_sheet_fail((select order_id from order_sheet_exports where status='processing' limit 1),'$TOK','google_5xx',60,false,8)")" pending
chk "permanent failure -> dead" "$(SQ "select order_sheet_fail((select order_id from order_sheet_exports where status='processing' limit 1),'$TOK','row_content_mismatch',60,true,8)")" dead
chk "requeue returns dead jobs to pending" "$(SQ "select order_sheet_requeue('$KEYLER')")" 1
SQ "select order_sheet_release('$KEYLER','$TOK')" >/dev/null
chk "lease released" "$(SU -c "select count(*) from order_sheet_destinations where lease_token is not null")" 0
chk "one spreadsheet per account: a second account cannot reuse the file" "$(SU -c "insert into order_sheet_destinations (account_id, spreadsheet_id) select id, '${SHEET_ID}' from accounts where id<>'$KEYLER' limit 1" 2>&1 | grep -c 'duplicate key')" 1
chk "no order row was changed by the lifecycle (excluding the 2 synthetic inserts)" "$(SU -c "select md5(string_agg(o::text, ',' order by id)) from order_confirmations o where request_key not like 'rehearsal-%'")" "$(cat $OUT/orders-pre-excl.md5)"
echo "== 10. manual rollback script"
OWN -1 -f - < $D/sql/91-drop-sheet-objects.sql > $OUT/rollback.log 2>&1; chk "rollback SQL rc" "$?" 0
chk "objects after rollback" "$(SU -c "select (select count(*) from pg_tables where schemaname='public' and tablename like 'order_sheet%')+(select count(*) from pg_proc where proname like 'order_sheet%')")" 0
toc > $OUT/objects-rollback.txt; chk "schema after rollback == schema before the migration" "$(diff <(grep -v 'order_sheet' $OUT/objects-after.txt) $OUT/objects-before.txt >/dev/null && echo same || echo DIFF)" same
[ $fail -eq 0 ] && echo "REHEARSAL PASS" || echo "REHEARSAL FAIL"
