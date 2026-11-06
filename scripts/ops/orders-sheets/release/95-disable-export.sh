#!/usr/bin/env bash
# Stops the Sheets exporter immediately, without recreating any container: destination enabled=false for every account + removes the cron file (if installed).
# Orders and their delivery to InkaClick are untouched. CONFIRM=yes. The sheet keeps what was written (it is a projection: it can be emptied and rebuilt).
. "$(dirname "$0")/lib.sh"; need_confirm
docker exec -i $DBC psql -U postgres -d postgres -X -v ON_ERROR_STOP=1 -c "update order_sheet_destinations set enabled=false, updated_at=now() where enabled"
rm -f /etc/cron.d/wacrm-orders-sheets /etc/cron.d/wacrm-orders-sheets-health
log "Sheets exporter disabled (destinations off, cron files removed)"
chk "no destination enabled" "$(RO "select count(*) from order_sheet_destinations where enabled")" 0
chk "no cron file" "$(ls /etc/cron.d/wacrm-orders-sheets* 2>/dev/null | wc -l)" 0
[ $fail -eq 0 ] && echo "EXPORT DISABLED" || exit 1
