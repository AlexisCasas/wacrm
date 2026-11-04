#!/usr/bin/env bash
# BSUID Flow watch + circuit breaker (read-only except for the breaker). One local log line per run; sends nothing anywhere.
#   bsuid_watch.sh [--no-kill]        env: WATCH_ACCOUNTS=<account_id>[,<account_id>...]  restrict the watch AND the breaker to those accounts (cron: Rossy only)
#                                          WATCH_VIA=cron|manual (recorded in the log)
# For every account whose BSUID Flow master switch is ON it looks at the last 15 minutes and raises:
#   A1  >= 3 failed flow runs of hidden-number contacts (send_*_failed)              -> ALERT and CIRCUIT BREAKER (master switch off + every authorization disabled)
#   A2  a REAL duplicate: one send_media node sent twice inside one run, or one inbound Meta message that started the flow twice for the same
#       hidden-number contact (flow_run_events)                                      -> ALERT and CIRCUIT BREAKER
#       The same image reaching a contact twice is NOT enough: two different inbound messages start two legitimate runs (counted as repeat_ok10m).
#   A2d same contact + same media_url within 10 min that the run data cannot explain (no run, a start without an inbound message id)
#                                                                                    -> ALERT (diagnostic), never the breaker
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
VIA=${WATCH_VIA:-manual}
ACCS=$(q "select account_id from bsuid_flow_settings where flows_enabled") || true
# only the accounts named in WATCH_ACCOUNTS are looked at, and only those can ever be switched off by the breaker (UUIDs only: anything else is ignored)
if [ -n "${WATCH_ACCOUNTS:-}" ]; then ACCS=$(for a in $ACCS; do case ",$WATCH_ACCOUNTS," in *",$a,"*) echo "$a";; esac; done); fi
[ -n "${ACCS:-}" ] || { echo "$(ts) OK via=$VIA no watched account has the BSUID Flow switch on" >> "$LOG"; exit 0; }
SUMMARY=""; ALERTS=""
for A in $ACCS; do
  P=${A:0:8}
  failed=$(q "select count(*) from flow_runs r join contacts c on c.id=r.contact_id where r.account_id='$A' and c.phone_optional and r.status='failed' and r.end_reason like 'send_%_failed' and r.ended_at > now() - interval '15 minutes'")
  # A2 evidence (run-aware). The same image reaching one contact twice is NOT proof of a duplicate: two inbound messages of the customer start two legitimate runs of the same flow.
  #  dup_send  = a send_media node that sent more times than it was REALLY entered inside ONE run (the engine sent one node twice). The auxiliary node_entered
  #              with reason=send_intent (written before the Meta call) is not an entry. Only runs with a send in the last 15 min are looked at, but their whole
  #              history counts, so a Flow started long ago and a duplicate sent now is caught while an old duplicate outside the window is not
  #  dup_runs  = one inbound Meta message that started more than one run for the same contact (the engine started the flow twice); at least one start in the last 15 min
  dup_send=$(q "select count(*) from (select e.flow_run_id, e.node_key from flow_run_events e join flow_runs r on r.id=e.flow_run_id join contacts ct on ct.id=r.contact_id where r.account_id='$A' and ct.phone_optional and e.payload->>'node_type'='send_media' and e.event_type in ('message_sent','node_entered') and coalesce(e.payload->>'reason','') <> 'send_intent' and e.flow_run_id in (select s.flow_run_id from flow_run_events s where s.event_type='message_sent' and s.payload->>'node_type'='send_media' and s.created_at > now() - interval '15 minutes') group by 1,2 having count(*) filter (where e.event_type='message_sent' and e.created_at > now() - interval '15 minutes') >= 1 and count(*) filter (where e.event_type='message_sent') > greatest(count(*) filter (where e.event_type='node_entered'), 1)) d")
  dup_runs=$(q "select count(*) from (select r.contact_id, e.payload->>'meta_message_id' from flow_run_events e join flow_runs r on r.id=e.flow_run_id join contacts ct on ct.id=r.contact_id where r.account_id='$A' and ct.phone_optional and e.event_type='started' and e.payload->>'meta_message_id' is not null and e.created_at > now() - interval '6 hours' group by 1,2 having count(distinct e.flow_run_id) > 1 and max(e.created_at) > now() - interval '15 minutes') d")
  # Diagnostic only (never trips the breaker): the old heuristic (same contact + same media_url within 10 min) split into hits that the run data explains
  # (every run in the last 20 min carries its own distinct inbound message id: legitimate repeat) and hits it cannot explain (no run, a manual start without an inbound id).
  diag=$(q "with h as (select distinct c.contact_id from messages m join conversations c on c.id=m.conversation_id join contacts ct on ct.id=c.contact_id where ct.account_id='$A' and ct.phone_optional and m.sender_type='bot' and m.media_url is not null and m.created_at > now() - interval '10 minutes' group by c.contact_id, m.media_url having count(*) > 1), s as (select r.contact_id, count(distinct e.flow_run_id) runs, count(distinct e.payload->>'meta_message_id') ids, count(*) filter (where e.payload->>'meta_message_id' is null) nulls from flow_run_events e join flow_runs r on r.id=e.flow_run_id where r.account_id='$A' and e.event_type='started' and e.created_at > now() - interval '1 hour' group by r.contact_id) select count(*) filter (where s.contact_id is null or s.nulls>0 or s.ids<s.runs) || ' ' || count(*) filter (where s.contact_id is not null and s.nulls=0 and s.ids=s.runs) from h left join s on s.contact_id=h.contact_id")
  read -r unexplained repeat_ok <<< "${diag:-x x}"
  dup=$(( ${dup_send:-0} + ${dup_runs:-0} ))
  rl=$(q "select count(*) from contact_identity_audit where account_id='$A' and event='send_blocked' and detail::text like '%rate_limited%' and created_at > now() - interval '15 minutes'")
  hr=$(q "select count(*) from messages m join conversations cv on cv.id=m.conversation_id join contacts c on c.id=cv.contact_id where c.account_id='$A' and c.phone_optional and m.sender_type='bot' and m.created_at > now() - interval '1 hour'")
  cap=$(q "select max_account_sends_per_hour from bsuid_flow_settings where account_id='$A'")
  runs=$(q "select count(*) from flow_runs r join contacts c on c.id=r.contact_id where r.account_id='$A' and c.phone_optional and r.started_at > now() - interval '15 minutes'")
  [[ "$failed$dup_send$dup_runs$unexplained$repeat_ok$rl$hr$cap$runs" =~ ^[0-9]+$ ]] || { ALERTS="$ALERTS account=$P:A0(query failed; no action)"; continue; }
  SUMMARY="$SUMMARY account=$P runs15m=$runs failed15m=$failed dup_send15m=$dup_send dup_runs15m=$dup_runs repeat_ok10m=$repeat_ok ratelimited15m=$rl sends1h=$hr/$cap"
  kill_reason=""
  [ "$failed" -ge 3 ] && { ALERTS="$ALERTS account=$P:A1(failed_runs=$failed)"; kill_reason="A1"; }
  [ "$dup" -ge 1 ] && { ALERTS="$ALERTS account=$P:A2(duplicate_send=$dup_send,duplicate_runs=$dup_runs)"; kill_reason="${kill_reason:+$kill_reason+}A2"; }
  [ "$unexplained" -ge 1 ] && [ "$dup" -eq 0 ] && ALERTS="$ALERTS account=$P:A2d(unexplained_repeat=$unexplained; diagnostic only, no breaker)"
  [ "$rl" -ge 1 ] && ALERTS="$ALERTS account=$P:A3(rate_limited=$rl)"
  [ $(( hr * 100 )) -gt $(( cap * 80 )) ] && ALERTS="$ALERTS account=$P:A4(sends_1h=$hr/$cap)"
  if [ -n "$kill_reason" ]; then
    if [ $AUTOKILL = 1 ]; then $KILL "$A" >/dev/null 2>&1 && ALERTS="$ALERTS account=$P:BREAKER_TRIPPED($kill_reason): BSUID flows switched off, reception untouched" || ALERTS="$ALERTS account=$P:BREAKER_FAILED($kill_reason): run flow_pilot.sh kill $A NOW"
    else ALERTS="$ALERTS account=$P:BREAKER_WOULD_TRIP($kill_reason)"; fi
  fi
done
if [ -n "$ALERTS" ]; then echo "$(ts) ALERT via=$VIA$ALERTS |$SUMMARY" >> "$LOG"; exit 1; fi
echo "$(ts) OK via=$VIA$SUMMARY" >> "$LOG"
