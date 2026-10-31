#!/usr/bin/env bash
# Operator control of the BSUID Flow pilot (migration 078). Works directly on the database; takes effect within seconds, NO restart.
#   status                                   read-only: pilot scopes, master switches, authorizations (flow names), BSUID Flow runs of the last 24 h
#   kill <account_id>                        IMMEDIATE: master switch off + every authorization of the account disabled (no confirmation asked)
#   flows <account_id> on|off                the account master switch (off = nothing reaches a Flow for a phone-less contact)
#   authorize <account_id> <flow_id> [--contact <contact_id>] [--media] [--buttons] [--list] [--audio] [--hours N]
#                                            enable ONE flow (text always; other modalities only if named); asks you to type the confirmation
#   disable <account_id> <flow_id> [--contact <contact_id>]   switch one authorization off (no confirmation asked)
#   agents-reply <account_id> on|off [--cap N]  human agents may answer hidden-number customers of the account WITHOUT a per-contact credit (migration 080; only manual replies by a verified
#                                            agent, only with an active BSUID, only inside WhatsApp's 24 h window, at most N agent messages per contact per hour, default 60). `off` asks nothing.
#   list <account_id> [hours]                read-only: hidden-number contacts created in the last N hours (default 24): full contact id, username, first message time, flow runs; no technical ids of the user
#   safe-flows <account_id>                  read-only: which ACTIVE flows are eligible for the BSUID rollout (only start/end, send_message, delay <= 10 min in total, send_media image|document,
#                                            set_contact_field; at least one send) and why each other flow is not (set_tag, subflow, buttons/list/audio, conditions, long waits...)
#   batch <account_id> <count> [--media]     authorize the next <count> ELIGIBLE flows (not yet authorized) for the whole account, text (+ media with --media); typed confirmation;
#                                            the account master switch is NOT touched (turn it on with `flows`)
#   endruns <account_id> <contact_id>        end the ACTIVE flow runs of ONE contact (e.g. when a canary test is over), so no deferred step is left to fail later;
#                                            asks you to type the confirmation; the run is closed as completed with end_reason canary_closed_by_operator
#   scope <account_id> <phone_number_id> <waba_id> on|off     number-level BSUID support (union with WHATSAPP_BSUID_PILOT); must match whatsapp_config
# Everything is logged to auto/pause/flow_pilot.log. Prints no phone numbers.
set -euo pipefail
LOG=${FLOW_PILOT_LOG:-/opt/backups/wacrm/bsuid-identity/auto/pause/flow_pilot.log}; mkdir -p "$(dirname "$LOG")"
UUID='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'; DIG='^[0-9]{6,25}$'
# (tests point it at a disposable database with FLOW_PILOT_CONTAINER / FLOW_PILOT_DB; stdin is closed so the typed confirmation is never eaten)
psqlq(){ docker exec -i ${FLOW_PILOT_CONTAINER:-supabase-db} psql -U postgres -d ${FLOW_PILOT_DB:-postgres} -X -P pager=off "$@" </dev/null; }
say(){ printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$LOG"; }
need_uuid(){ [[ "${1:-}" =~ $UUID ]] || { echo "not a UUID: ${1:-}"; exit 1; }; }

# eligibility of a flow for the BSUID rollout (shared by safe-flows and batch)
ELIG_SQL="with f as (select id, name from flows where account_id='%ACC%' and status='active'),
 n as (select f.id fid, n.node_type, n.config from f join flow_nodes n on n.flow_id=f.id),
 x as (select f.id, f.name,
   (select count(*) from n where fid=f.id and node_type in ('send_message','send_media')) sends,
   (select count(*) from n where fid=f.id and node_type not in ('start','end','send_message','delay','send_media','set_contact_field')) bad_nodes,
   (select string_agg(distinct node_type, ',') from n where fid=f.id and node_type not in ('start','end','send_message','delay','send_media','set_contact_field')) bad_types,
   (select count(*) from n where fid=f.id and node_type='send_media' and coalesce(config->>'media_type','') not in ('image','document')) bad_media,
   (select coalesce(sum(case when config->>'unit'='hours' then (config->>'amount')::numeric*3600 when config->>'unit'='minutes' then (config->>'amount')::numeric*60 when config->>'unit'='days' then (config->>'amount')::numeric*86400 else coalesce((config->>'seconds')::numeric,0) end),0) from n where fid=f.id and node_type='delay') delay_s,
   (select count(*) from n where fid=f.id and node_type='send_media') media,
   exists (select 1 from bsuid_flow_authorizations a where a.flow_id=f.id and a.account_id='%ACC%') authorized
  from f)
select id, name, sends, media, delay_s, authorized,
 case when sends=0 then 'no sends' when bad_nodes>0 then 'node types: '||bad_types when bad_media>0 then 'media type not image/document' when delay_s>600 then 'waits longer than 10 minutes' else 'eligible' end as verdict from x"
cmd=${1:-}; shift || true
case "$cmd" in
  status)
    psqlq -c "select left(account_id::text,8)||'…' as account, phone_number_id, waba_id, enabled, agents_reply_without_credit as agents_no_credit, max_agent_replies_per_contact_hour as agent_cap, note from bsuid_pilot_scopes order by 1"
    psqlq -c "select left(account_id::text,8)||'…' as account, flows_enabled, updated_at from bsuid_flow_settings order by 1"
    psqlq -c "select left(a.account_id::text,8)||'…' as account, left(a.flow_id::text,8)||'…' as flow, f.name, a.enabled, case when a.contact_id is null then 'whole account' else 'contact '||left(a.contact_id::text,8)||'…' end as scope, concat_ws(',', case when a.allow_text then 'text' end, case when a.allow_media then 'media' end, case when a.allow_buttons then 'buttons' end, case when a.allow_list then 'list' end, case when a.allow_audio then 'audio' end) as modalities, a.expires_at from bsuid_flow_authorizations a join flows f on f.id=a.flow_id order by 1,3"
    psqlq -c "select left(r.account_id::text,8)||'…' as account, r.status, count(*) from flow_runs r join contacts c on c.id=r.contact_id where c.phone_optional and r.started_at > now() - interval '24 hours' group by 1,2 order by 1,2" ;;
  kill) A=${1:-}; need_uuid "$A"
    psqlq -At -c "update bsuid_flow_settings set flows_enabled=false, updated_at=now() where account_id='$A'; update bsuid_flow_authorizations set enabled=false where account_id='$A'" >/dev/null
    say "KILL account ${A:0:8}: master switch off, all authorizations disabled"
    psqlq -At -c "select 'master on: '||count(*) filter (where flows_enabled)||' ; enabled authorizations: '||(select count(*) from bsuid_flow_authorizations where account_id='$A' and enabled) from bsuid_flow_settings where account_id='$A'" ;;
  flows) A=${1:-}; S=${2:-}; need_uuid "$A"; [[ "$S" == on || "$S" == off ]] || { echo "on|off"; exit 1; }
    V=$([ "$S" = on ] && echo true || echo false)
    psqlq -At -c "insert into bsuid_flow_settings(account_id,flows_enabled,note) values ('$A',$V,'flow_pilot.sh') on conflict (account_id) do update set flows_enabled=$V, updated_at=now()" >/dev/null
    say "FLOWS master switch account ${A:0:8} -> $S" ;;
  authorize) A=${1:-}; F=${2:-}; shift 2 || true; need_uuid "$A"; need_uuid "$F"
    C=""; M=false; B=false; L=false; AU=false; H=""
    while [ $# -gt 0 ]; do case "$1" in --contact) C=${2:-}; need_uuid "$C"; shift 2;; --media) M=true; shift;; --buttons) B=true; shift;; --list) L=true; shift;; --audio) AU=true; shift;; --hours) H=${2:-}; [[ "$H" =~ ^[0-9]{1,3}$ ]] || exit 1; shift 2;; *) echo "unknown $1"; exit 1;; esac; done
    OK=$(psqlq -At -c "select count(*) from flows where id='$F' and account_id='$A' and status='active'"); [ "$OK" = 1 ] || { echo "that flow is not an ACTIVE flow of that account; nothing changed"; exit 1; }
    if [ -n "$C" ]; then OKC=$(psqlq -At -c "select count(*) from contacts where id='$C' and account_id='$A'"); [ "$OKC" = 1 ] || { echo "that contact is not in that account; nothing changed"; exit 1; }; fi
    NAME=$(psqlq -At -c "select name from flows where id='$F'")
    echo "flow: $NAME | scope: ${C:+contact ${C:0:8}…}${C:-whole account} | modalities: text$([ $M = true ] && echo ,media)$([ $B = true ] && echo ,buttons)$([ $L = true ] && echo ,list)$([ $AU = true ] && echo ,audio) | expires: ${H:+in $H h}${H:-never}"
    read -r -p "Type AUTHORIZE ${F:0:8} to enable it: " ANS; [ "$ANS" = "AUTHORIZE ${F:0:8}" ] || { echo "not confirmed; nothing changed"; exit 1; }
    if [ -n "$C" ]; then CID="'$C'"; else CID=null; fi
    if [ -n "$H" ]; then EXP="now() + interval '$H hours'"; else EXP=null; fi
    psqlq -At -c "delete from bsuid_flow_authorizations where account_id='$A' and flow_id='$F' and coalesce(contact_id,'00000000-0000-0000-0000-000000000000'::uuid)=coalesce(${CID}::uuid,'00000000-0000-0000-0000-000000000000'::uuid); insert into bsuid_flow_authorizations(account_id,flow_id,contact_id,enabled,allow_text,allow_media,allow_buttons,allow_list,allow_audio,expires_at,note) values ('$A','$F',${CID}::uuid,true,true,$M,$B,$L,$AU,$EXP,'flow_pilot.sh')" >/dev/null
    say "AUTHORIZED flow ${F:0:8} account ${A:0:8} scope ${C:-all} media=$M buttons=$B list=$L audio=$AU hours=${H:-never}"
    echo "Remember: the account master switch must also be on (flows $A on)." ;;
  disable) A=${1:-}; F=${2:-}; shift 2 || true; need_uuid "$A"; need_uuid "$F"; C=""
    while [ $# -gt 0 ]; do case "$1" in --contact) C=${2:-}; need_uuid "$C"; shift 2;; *) exit 1;; esac; done
    COND=$([ -n "$C" ] && echo "contact_id='$C'" || echo "true")
    N=$(psqlq -At -c "with u as (update bsuid_flow_authorizations set enabled=false where account_id='$A' and flow_id='$F' and $COND returning 1) select count(*) from u")
    say "DISABLED flow ${F:0:8} account ${A:0:8} rows=$N" ;;
  agents-reply) A=${1:-}; S=${2:-}; CAP=""; shift 2 || true; need_uuid "$A"; [[ "$S" == on || "$S" == off ]] || { echo "on|off"; exit 1; }
    while [ $# -gt 0 ]; do case "$1" in --cap) CAP=${2:-}; [[ "$CAP" =~ ^[0-9]{1,4}$ ]] && [ "$CAP" -ge 1 ] || exit 1; shift 2;; *) echo "unknown $1"; exit 1;; esac; done
    OK=$(psqlq -At -c "select count(*) from bsuid_pilot_scopes s join whatsapp_config w on w.account_id=s.account_id and w.phone_number_id=s.phone_number_id and w.waba_id=s.waba_id where s.account_id='$A' and s.enabled"); [ "$OK" = 1 ] || { echo "that account has no ENABLED BSUID scope matching its own WhatsApp number; nothing changed"; exit 1; }
    if [ "$S" = on ]; then read -r -p "Type AGENTS ${A:0:8} to let human agents reply to hidden-number customers without a credit: " ANS; [ "$ANS" = "AGENTS ${A:0:8}" ] || { echo "not confirmed; nothing changed"; exit 1; }; fi
    V=$([ "$S" = on ] && echo true || echo false)
    psqlq -At -c "update bsuid_pilot_scopes set agents_reply_without_credit=$V${CAP:+, max_agent_replies_per_contact_hour=$CAP}, updated_at=now() where account_id='$A' and enabled" >/dev/null
    say "AGENT REPLIES WITHOUT CREDIT account ${A:0:8} -> $S${CAP:+ (cap $CAP per contact per hour)}" ;;
  list) A=${1:-}; H=${2:-24}; need_uuid "$A"; [[ "$H" =~ ^[0-9]{1,3}$ ]] || exit 1
    psqlq -c "select c.id as contact_id, to_char(c.created_at at time zone 'utc','MM-DD HH24:MI') as created_utc, coalesce('@'||c.wa_username,'-') as username, left(c.name,1)||'***' as name_masked, (select count(*) from messages m join conversations cv on cv.id=m.conversation_id where cv.contact_id=c.id and m.sender_type='customer') as customer_msgs, (select count(*) from flow_runs r where r.contact_id=c.id) as flow_runs from contacts c where c.account_id='$A' and c.phone_optional and c.created_at > now() - interval '$H hours' order by c.created_at desc limit 50" ;;
  safe-flows) A=${1:-}; need_uuid "$A"
    psqlq -c "select left(id::text,8) as flow, name, sends, media, delay_s::int as delay_s, case when authorized then 'yes' else 'no' end as authorized, verdict from (${ELIG_SQL//%ACC%/$A}) v order by (verdict='eligible') desc, name" ;;
  batch) A=${1:-}; K=${2:-}; M=false; shift 2 || true; need_uuid "$A"; [[ "$K" =~ ^[0-9]{1,3}$ ]] && [ "$K" -ge 1 ] || { echo "count 1-999"; exit 1; }
    while [ $# -gt 0 ]; do case "$1" in --media) M=true; shift;; *) echo "unknown $1"; exit 1;; esac; done
    LIST=$(psqlq -At -c "select id from (${ELIG_SQL//%ACC%/$A}) v where verdict='eligible' and not authorized order by name limit $K")
    N=$(printf '%s\n' "$LIST" | grep -c . || true); [ "$N" -ge 1 ] || { echo "no eligible flow left to authorize"; exit 0; }
    echo "$N flow(s) would be authorized for the WHOLE account (text$([ $M = true ] && echo ' + media')):"; psqlq -At -c "select '  '||left(id::text,8)||'  '||name from flows where id in ($(printf '%s\n' "$LIST" | sed "s/.*/'&'/" | paste -sd, -)) order by name"
    read -r -p "Type BATCH $N to enable them: " ANS; [ "$ANS" = "BATCH $N" ] || { echo "not confirmed; nothing changed"; exit 1; }
    psqlq -At -c "insert into bsuid_flow_authorizations(account_id,flow_id,contact_id,enabled,allow_text,allow_media,note) select '$A', id, null, true, true, $M, 'flow_pilot.sh batch' from flows where id in ($(printf '%s\n' "$LIST" | sed "s/.*/'&'/" | paste -sd, -)) on conflict do nothing" >/dev/null
    say "BATCH account ${A:0:8} authorized=$N media=$M"; echo "Remember: the account master switch must be on (flows $A on)." ;;
  endruns) A=${1:-}; C=${2:-}; need_uuid "$A"; need_uuid "$C"
    N=$(psqlq -At -c "select count(*) from flow_runs where account_id='$A' and contact_id='$C' and status='active'")
    [ "$N" != 0 ] || { echo "no active run for that contact; nothing to do"; exit 0; }
    echo "active run(s) of contact ${C:0:8}…: $N (flow: $(psqlq -At -c "select string_agg(distinct f.name, ', ') from flow_runs r join flows f on f.id=r.flow_id where r.account_id='$A' and r.contact_id='$C' and r.status='active'"))"
    read -r -p "Type END ${C:0:8} to close them: " ANS; [ "$ANS" = "END ${C:0:8}" ] || { echo "not confirmed; nothing changed"; exit 1; }
    R=$(psqlq -At -c "with u as (update flow_runs set status='completed', end_reason='canary_closed_by_operator', ended_at=now(), wait_until=null, wait_node_key=null, wait_claim_token=null, wait_claimed_at=null where account_id='$A' and contact_id='$C' and status='active' returning 1) select count(*) from u")
    say "ENDRUNS account ${A:0:8} contact ${C:0:8}… closed=$R" ;;
  scope) A=${1:-}; P=${2:-}; W=${3:-}; S=${4:-}; need_uuid "$A"; [[ "$P" =~ $DIG && "$W" =~ $DIG ]] || { echo "numeric ids"; exit 1; }; [[ "$S" == on || "$S" == off ]] || exit 1
    OK=$(psqlq -At -c "select count(*) from whatsapp_config where account_id='$A' and phone_number_id='$P' and waba_id='$W'"); [ "$OK" = 1 ] || { echo "that account/number/WABA triple is not in whatsapp_config; nothing changed"; exit 1; }
    if [ "$S" = on ]; then read -r -p "Type SCOPE ${A:0:8} to switch BSUID support ON for that number: " ANS; [ "$ANS" = "SCOPE ${A:0:8}" ] || { echo "not confirmed; nothing changed"; exit 1; }; fi
    V=$([ "$S" = on ] && echo true || echo false)
    psqlq -At -c "insert into bsuid_pilot_scopes(account_id,phone_number_id,waba_id,enabled,note) values ('$A','$P','$W',$V,'flow_pilot.sh') on conflict (account_id,phone_number_id,waba_id) do update set enabled=$V, updated_at=now()" >/dev/null
    say "SCOPE account ${A:0:8} number ${P} -> $S" ;;
  *) sed -n '2,24p' "$0"; exit 1 ;;
esac
