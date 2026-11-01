# PREPARED, NOT INSTALLED. Would live in its OWN file (/etc/cron.d/wacrm-orders, owner root, mode 0644) so /etc/cron.d/wacrm, wacrm-flows and the alert crons are never edited.
# Once a minute. flock -n: if a pass is still running when the next minute starts, that minute is skipped (leases make overlap safe anyway; this avoids piling up).
# Stop it at once, without touching the Inbox or any other cron:   rm /etc/cron.d/wacrm-orders
* * * * * root flock -n /var/lock/wacrm-orders-1min.lock /usr/local/bin/wacrm-orders-cron.sh >> /var/log/wacrm-orders-cron.log 2>&1
