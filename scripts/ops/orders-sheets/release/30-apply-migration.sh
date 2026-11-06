#!/usr/bin/env bash
# Applies ONLY 20261109000000_order_sheet_exports.sql. Requires CONFIRM=yes and GATE-MIGRATION GO. Additive (4 tables, 8 functions, 1 index): no existing table,
# policy, switch or row is touched; everything is inert until a destination is enabled. The file is run with psql -1 + ON_ERROR_STOP (one transaction) as
# postgres, exactly as the previous migrations. NOT idempotent by design (CREATE TABLE): a second run fails and changes nothing.
. "$(dirname "$0")/lib.sh"; need_confirm
unset DRYRUN_MERGE_COMMIT
"$(dirname "$0")/20-gate-migration.sh" || { echo "gate is NO-GO: nothing was changed"; exit 1; }
RO "select 'PRE order_integration_settings md5='||md5(string_agg(t::text,',' order by account_id)) from order_integration_settings t" | tee $D/migration-pre.txt
RO "select 'PRE orders fp='||count(*)||':'||md5(string_agg(o::text, ',' order by id)) from order_confirmations o" | tee -a $D/migration-pre.txt
RO "select 'PRE objects: tables='||(select count(*) from pg_tables where schemaname='public')||' functions='||(select count(*) from pg_proc where pronamespace='public'::regnamespace)||' policies='||(select count(*) from pg_policies where schemaname='public')" | tee -a $D/migration-pre.txt
log "migration start ($MIG_NAME sha256 $MIG_SHA256)"
docker exec -i $DBC psql -U postgres -d postgres -X -v ON_ERROR_STOP=1 -1 -f - < $MIG_FILE > $D/migration.log 2>&1; rc=$?
log "migration rc=$rc"; sed 's/^/   /' $D/migration.log | tail -12
if [ $rc -ne 0 ]; then echo "MIGRATION FAILED. One transaction: nothing was kept. Tables now: $(tbl_count), functions: $(fn_count) (expected 0 and 0). Do NOT deploy the image. Report $D/migration.log."; exit $rc; fi
RO "select 'POST order_integration_settings md5='||md5(string_agg(t::text,',' order by account_id)) from order_integration_settings t" | tee $D/migration-post.txt
RO "select 'POST orders fp='||count(*)||':'||md5(string_agg(o::text, ',' order by id)) from order_confirmations o" | tee -a $D/migration-post.txt
RO "select 'POST objects: tables='||(select count(*) from pg_tables where schemaname='public')||' functions='||(select count(*) from pg_proc where pronamespace='public'::regnamespace)||' policies='||(select count(*) from pg_policies where schemaname='public')" | tee -a $D/migration-post.txt
echo "Now run 31-verify-migration.sh, then (if authorized) 32-apply-exclusions.sh"
