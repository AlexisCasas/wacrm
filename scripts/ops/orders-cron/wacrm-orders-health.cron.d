# PREPARED, NOT INSTALLED. READ-ONLY delivery monitor every 5 minutes (SELECTs only; one local log line per run; sends nothing anywhere).
# Stop it with:  rm /etc/cron.d/wacrm-orders-health
*/5 * * * * root /usr/bin/timeout 120 /usr/local/lib/wacrm-orders/orders-health-monitor.sh
