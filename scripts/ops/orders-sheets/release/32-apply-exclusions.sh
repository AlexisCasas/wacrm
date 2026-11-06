#!/usr/bin/env bash
# Registers the two verified test orders in order_sheet_exclusions (reason='test'). Requires CONFIRM=yes and the migration applied. Their rows in
# order_confirmations are NOT touched (checked with a fingerprint before and after). Idempotent. Runs exclude-test-orders.sql (guards inside).
. "$(dirname "$0")/lib.sh"; need_confirm
chk "migration applied" "$(tbl_count)" 4; [ $fail -eq 0 ] || exit 1
RO "select md5(string_agg(o::text, ',' order by id)) from order_confirmations o where left(md5(id::text),8) in ('c071235f','821d22b1')" > $D/excl-pre.txt
docker exec -i $DBC psql -U postgres -d postgres -X -v ON_ERROR_STOP=1 -1 -f - < $EXCL_FILE > $D/exclusions.log 2>&1; rc=$?
log "exclusions rc=$rc"; tail -5 $D/exclusions.log | sed 's/^/   /'; [ $rc -eq 0 ] || exit $rc
chk "the 2 original order rows are byte-identical" "$(RO "select md5(string_agg(o::text, ',' order by id)) from order_confirmations o where left(md5(id::text),8) in ('c071235f','821d22b1')")" "$(cat $D/excl-pre.txt)"
chk "2 exclusions with reason test" "$(RO "select count(*) from order_sheet_exclusions where reason='test'")" 2
[ $fail -eq 0 ] && echo "EXCLUSIONS OK" || { echo "EXCLUSIONS FAIL"; exit 1; }
