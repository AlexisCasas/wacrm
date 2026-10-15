# Manual alert review (while e-mail notifications, P12.2, stay deferred)

The monitor writes one line every 10 minutes to its local log (see `alerts-p8-monitor.sh`). Nothing is sent anywhere, so someone has to look.

**When:** at the start and end of each working day, and after every deployment or database incident.

```bash
tail -n 6 /var/log/wacrm-alerts-p8.log          # last runs: "OK A1=0 ... A6=0" is healthy
grep -E "ALERT|MONITOR_ERROR|JOURNAL_ERROR" /var/log/wacrm-alerts-p8.log | tail   # anything fired since the last rotation
/usr/local/lib/wacrm-alerts/alerts-p8.sh        # run the six checks right now (read-only); exit 0 = clean
```
Also confirm the log is **fresh** (last line within ~15 minutes): a stopped monitor is silent.

| Alert | Meaning | First action |
|---|---|---|
| A1 / A2 | A send ended with unknown outcome / recovery was not safe | Check with the provider whether the message left; never resend blindly. |
| A3 | A wait is overdue and nobody resumed it | Check the one-minute cron log and the app logs. |
| A4 | An ended run left a call frame | Investigate; migration 072 should prevent it. |
| A5 | An active run has not advanced for 30 minutes on an automatic node | Check the recovery cron and the run's events. |
| A6 | A run stands inside a flow that is no longer active | Ask whether a called flow was deactivated; reactivate or close the run. |

If anything is wrong and cannot be explained quickly, use the rollback in `qa/subflow-exec/p14/P14-RUNBOOK.md`.
