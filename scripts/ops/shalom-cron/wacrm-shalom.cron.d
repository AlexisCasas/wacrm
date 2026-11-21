# PREPARED, NOT INSTALLED (PR-05). Would live in its OWN file (/etc/cron.d/wacrm-shalom, owner root, mode 0644) so no other cron file is ever edited.
# Every 15 minutes (DEFAULT QA / PROVISIONAL tick: Shalom's real limits are not known). flock -n: a pass still running when the next tick starts skips that tick
# (the database claim / lease makes overlap safe anyway).
# Stop it at once, without touching the Inbox, Pedidos Confirmados or PR-04:   rm /etc/cron.d/wacrm-shalom      (or unset SHALOM_TRACKING_ENABLED and recreate the app)
*/15 * * * * root flock -n /var/lock/wacrm-shalom-15min.lock /usr/local/bin/wacrm-shalom-cron.sh >> /var/log/wacrm-shalom-cron.log 2>&1
