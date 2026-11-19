# PREPARED, NOT INSTALLED (PR-05C). Would live in its OWN file (/etc/cron.d/wacrm-routing-return, owner root, mode 0644) so no other cron file is edited.
# Every minute: the 10-minute rule needs a fine tick. flock -n: a pass still running when the next tick starts skips it (the database row lock makes overlap safe anyway).
# Stop it at once:   rm /etc/cron.d/wacrm-routing-return   (pending returns simply wait in the database)
* * * * * root flock -n /var/lock/wacrm-routing-return.lock /usr/local/bin/wacrm-routing-return-cron.sh >> /var/log/wacrm-routing-return-cron.log 2>&1
