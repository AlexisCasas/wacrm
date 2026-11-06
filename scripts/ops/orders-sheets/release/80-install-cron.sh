#!/usr/bin/env bash
# Installs the Sheets crons (CONFIRM=yes; separate authorization AFTER the historical load reconciled to zero and the second pass was idempotent):
#   sync every 2 min, reconcile every 30 min (writes the control tab), read-only health monitor every 5 min. Own files; nothing else in /etc/cron.d is touched.
. "$(dirname "$0")/lib.sh"; need_confirm
chk "a destination is enabled" "$(RO "select count(*) from order_sheet_destinations where enabled")" 1
chk "the historical load is complete (no pending/processing job)" "$(RO "select count(*) from order_sheet_exports where status in ('pending','processing')")" 0
chk "no dead job" "$(RO "select count(*) from order_sheet_exports where status='dead'")" 0; [ $fail -eq 0 ] || { echo "NOT installing"; exit 1; }
install -m 0755 $(dirname "$0")/orders-sheets-cron.sh /usr/local/bin/wacrm-orders-sheets-cron.sh
mkdir -p /usr/local/lib/wacrm-orders; install -m 0755 $(dirname "$0")/orders-sheets-health.sh $(dirname "$0")/orders-sheets-health-monitor.sh /usr/local/lib/wacrm-orders/
cat > /etc/cron.d/wacrm-orders-sheets <<'EOT'
# Google Sheets export (PR #82). Stop: rm /etc/cron.d/wacrm-orders-sheets  (and 95-disable-export.sh). Independent of /etc/cron.d/wacrm-orders (InkaClick).
*/2 * * * * root flock -n /var/lock/wacrm-orders-sheets.lock /usr/local/bin/wacrm-orders-sheets-cron.sh sync >> /var/log/wacrm-orders-sheets-cron.log 2>&1
7,37 * * * * root flock -n /var/lock/wacrm-orders-sheets-recon.lock /usr/local/bin/wacrm-orders-sheets-cron.sh reconcile >> /var/log/wacrm-orders-sheets-cron.log 2>&1
EOT
cat > /etc/cron.d/wacrm-orders-sheets-health <<'EOT'
# READ-ONLY monitor of the Sheets export (log lines only). Stop: rm /etc/cron.d/wacrm-orders-sheets-health
*/5 * * * * root /usr/bin/timeout 120 /usr/local/lib/wacrm-orders/orders-sheets-health-monitor.sh
EOT
chmod 644 /etc/cron.d/wacrm-orders-sheets /etc/cron.d/wacrm-orders-sheets-health; log "Sheets crons installed"; echo "INSTALLED"
