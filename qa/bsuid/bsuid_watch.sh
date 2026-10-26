#!/usr/bin/env bash
# BSUID Flow watch + circuit breaker (read-only except for the breaker). One local log line per run; sends nothing anywhere.
#   bsuid_watch.sh [--no-kill]
# For every account whose BSUID Flow master switch is ON it looks at the last 15 minutes and raises:
#   A1  >= 3 failed flow runs of hidden-number contacts (send_*_failed)              -> ALERT and CIRCUIT BREAKER (master switch off + every authorization disabled)
#   A2  any duplicate media send to the same hidden-number contact within 10 min     -> ALERT and CIRCUIT BREAKER
#   A3  any send refused by a volume ceiling (rate_limited_*)                        -> ALERT
#   A4  bot messages to hidden-number contacts in the last hour above 80% of the account ceiling -> ALERT
# The breaker only turns the BSUID Flow feature OFF (contacts and received messages are untouched; reception stays on). Turn it back on with flow_pilot.sh.
# Phone contacts, automations and campaigns are never read or changed. Stop the schedule with: rm /etc/cron.d/wacrm-bsuid-watch
set -uo pipefail
CT=${WATCH_CONTAINER:-supabase-db}; DB=${WATCH_DB:-postgres}; LOG=${WATCH_LOG:-/var/log/wacrm-bsuid-watch.log}
KILL=${WATCH_KILL_CMD:-/opt/backups/wacrm/bsuid-identity/14_flow_pilot_v3.sh kill}; AUTOKILL=1; [ "${1:-}" = "--no-kill" ] && AUTOKILL=0
LOCK=${WATCH_LOCK:-/tmp/wacrm-bsuid-watch.lock}; exec 9>"$LOCK"; flock -n 9 || exit 0
q(){ docker exec -i $CT psql -U postgres -d $DB -X -At -c "$1" </dev/null 2>/dev/null; }
ts(){ date -u +%FT%TZ; }
ACCS=$(q "select account_id from bsuid_flow_settings where flows_enabled") || true
[ -n "${ACCS:-}" ] || { echo "$(ts) OK no account has the BSUID Flow switch on" >> "$LOG"; exit 0; }
SUMMARY=""; ALERTS=""
for A in $ACCS; do
  P=${A:0:8}
  failed=$(q "select count(*) from flow_runs r join contacts c on c.id=r.contact_id where r.account_id='$A' and c.phone_optional and r.status='failed' and r.end_reason like 'send_%_failed' and r.ended_at > now() - interval '15 minutes'")
  dup=$(q "select count(*) from (select c.contact_id, m.media_url from messages m join conversations c on c.id=m.conversation_id join contacts ct on ct.id=c.contact_id where ct.account_id='$A' and ct.phone_optional and m.sender_type='bot' and m.media_url is not null and m.created_at > now() - interval '10 minutes' group by 1,2 having count(*) > 1) d")
  rl=$(q "select count(*) from contact_identity_audit where account_id='$A' and event='send_blocked' and detail::text like '%rate_limited%' and created_at > now() - interval '15 minutes'")
  hr=$(q "select count(*) from messages m join conversations cv on cv.id=m.conversation_id join contacts c on c.id=cv.contact_id where c.account_id='$A' and c.phone_optional and m.sender_type='bot' and m.created_at > now() - interval '1 hour'")
  cap=$(q "select max_account_sends_per_hour from bsuid_flow_settings where account_id='$A'")
  runs=$(q "select count(*) from flow_runs r join contacts c on c.id=r.contact_id where r.account_id='$A' and c.phone_optional and r.started_at > now() - interval '15 minutes'")
  [[ "$failed$dup$rl$hr$cap$runs" =~ ^[0-9]+$ ]] || { ALERTS="$ALERTS account=$P:A0(query failed; no action)"; continue; }
  SUMMARY="$SUMMARY account=$P runs15m=$runs failed15m=$failed dup10m=$dup ratelimited15m=$rl sends1h=$hr/$cap"
  kill_reason=""
  [ "$failed" -ge 3 ] && { ALERTS="$ALERTS account=$P:A1(failed_runs=$failed)"; kill_reason="A1"; }
  [ "$dup" -ge 1 ] && { ALERTS="$ALERTS account=$P:A2(duplicate_media=$dup)"; kill_reason="${kill_reason:+$kill_reason+}A2"; }
  [ "$rl" -ge 1 ] && ALERTS="$ALERTS account=$P:A3(rate_limited=$rl)"
  [ $(( hr * 100 )) -gt $(( cap * 80 )) ] && ALERTS="$ALERTS account=$P:A4(sends_1h=$hr/$cap)"
  if [ -n "$kill_reason" ]; then
    if [ $AUTOKILL = 1 ]; then $KILL "$A" >/dev/null 2>&1 && ALERTS="$ALERTS account=$P:BREAKER_TRIPPED($kill_reason): BSUID flows switched off, reception untouched" || ALERTS="$ALERTS account=$P:BREAKER_FAILED($kill_reason): run flow_pilot.sh kill $A NOW"
    else ALERTS="$ALERTS account=$P:BREAKER_WOULD_TRIP($kill_reason)"; fi
  fi
done
if [ -n "$ALERTS" ]; then echo "$(ts) ALERT$ALERTS |$SUMMARY" >> "$LOG"; exit 1; fi
echo "$(ts) OK$SUMMARY" >> "$LOG"
