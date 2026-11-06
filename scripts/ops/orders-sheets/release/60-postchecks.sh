#!/usr/bin/env bash
# READ-ONLY post-swap checks for the Keyler Sheets release (PR #82 + dashboard + PR #81 status code). Counters of orders / messages / flows may grow with legitimate traffic: the checks look for anomalies
# (changed history, regressions, stuck or failed deliveries, the OLD error signature, cross-account symptoms), not for frozen numbers.
# Run right after the swap and again after ~10 minutes of real traffic. Needs T0 files from 50-swap-image.sh.
. "$(dirname "$0")/lib.sh"
SW=$(docker inspect wacrm-app-1 --format '{{.State.StartedAt}}'); SWS=${SW%%.*}Z
echo "== app (started $SW)"
chk "image" "$(docker inspect wacrm-app-1 --format '{{.Config.Image}}')" $NEW_IMAGE
chk "image id" "$(docker inspect wacrm-app-1 --format '{{.Image}}')" "$(cat $D/NEW_IMAGE_ID)"
chk "revision label" "$(docker image inspect $NEW_IMAGE --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" $CAND_SHA
chk "health" "$(docker inspect wacrm-app-1 --format '{{.State.Health.Status}}')" healthy
chk "restarts" "$(docker inspect wacrm-app-1 --format '{{.RestartCount}}')" 0
chk "other containers: same names" "$(docker ps -a --format '{{.Names}}' | sort | diff -q - $D/containers-before.txt >/dev/null && echo same)" same
echo "== database objects and switches (must be exactly as after the migration / before the swap)"
chk "3 status functions exist" "$(sfn_count)" 3
chk "status function bodies unchanged since T0" "$(RO "select 'T0 fnmd5='||string_agg(proname||'='||md5(prosrc), ',' order by proname) from pg_proc where proname in ('$STATUS_FNS')")" "$(grep '^T0 fnmd5=' $D/T0.txt | tail -1)"
chk "only service_role may execute the RPC" "$(RO "select has_function_privilege('service_role','$APPLY_SIG','execute')::text||'/'||has_function_privilege('authenticated','$APPLY_SIG','execute')::text||'/'||has_function_privilege('anon','$APPLY_SIG','execute')::text")" "true/false/false"
T0SW=$(sed -nE 's/^T0 switches=//p' $D/T0.txt); chk "order switches (all accounts) unchanged since T0" "$(RO "select string_agg(account_id||':'||enabled||'/'||confirm_enabled||'/'||multiproduct_enabled||'@'||updated_at, ';') from order_integration_settings")" "$T0SW"
echo "== order history untouched (legitimate new sales are fine)"
CUT=$(sed -nE 's/^T0 cutoff=(.*)$/\1/p' $D/T0.txt); FP=$(sed -nE 's/^T0 orders=.*fp=(.*)$/\1/p' $D/T0.txt)
chk "fingerprint of orders up to the T0 cutoff" "$(RO "select md5(string_agg(id::text||customer_name||product||quantity||price||delivery_status||coalesce(inkaclick_order_id::text,''), ',' order by id)) from order_confirmations where confirmed_at <= '$CUT'")" "$FP"
RO "select 'orders now='||count(*)||' new since swap='||count(*) filter (where confirmed_at>'$SWS')||' pending='||count(*) filter (where delivery_status='pending') from order_confirmations"
chk "no stuck pending order >3 min" "$(RO "select count(*) from order_confirmations where delivery_status='pending' and confirmed_at<now()-interval '3 minutes'")" 0
chk "no failed/rejected delivery since swap" "$(RO "select count(*) from order_confirmation_deliveries where outcome<>'sent' and started_at>'$SWS'")" 0
chk "orders cron since swap: all 200" "$(awk -v t="${SWS%Z}" '$1>t' /var/log/wacrm-orders-cron.log | grep -vc 'rc=0 200')" 0
echo "== Google Sheets exporter: present and INERT"
chk "global switch visible in the container (value compared, not printed)" "$(docker exec wacrm-app-1 printenv ORDERS_SHEETS_EXPORT_ENABLED 2>/dev/null | tr -d '\r\n')" "${EXPECT_SHEETS_SWITCH:-true}"
chk "service-account variables present (names/length only)" "$(docker exec wacrm-app-1 sh -c 'test -n "$GOOGLE_SHEETS_SA_EMAIL" && test ${#GOOGLE_SHEETS_SA_KEY_B64} -gt 1000 && echo ok')" ok
CR=$(cron_call sync); echo "     sync endpoint -> ${CR:0:160}"
if [ "${EXPECT_ENABLED:-0}" = 0 ]; then chk "sync endpoint: HTTP 200, enabled, status ok, no account touched" "$(echo "$CR" | grep -c '^HTTP 200 {"enabled":true,"mode":"sync","status":"ok","attention":\[\],"accounts":{}}')" 1
else chk "sync endpoint: HTTP 200 and status ok/retrying" "$(echo "$CR" | grep -cE '^HTTP 200 .*"status":"(ok|retrying)"')" 1; fi
chk "no export job exists before activation" "$(RO "select count(*) from order_sheet_exports")" "${EXPECT_JOBS:-0}"
chk "no destination is enabled" "$(RO "select count(*) from order_sheet_destinations where enabled")" "${EXPECT_ENABLED:-0}"
chk "orders cron still 200 (InkaClick path untouched)" "$(tail -3 /var/log/wacrm-orders-cron.log | grep -vc 'rc=0 200')" 0
chk "dashboard: pricing analytics requires a session (401/403)" "$(case $(probe /api/whatsapp/pricing-analytics) in 401|403) echo ok;; *) echo bad;; esac)" ok
echo "== STATUS WEBHOOKS: PR #81 code now live"
LOGS=$(docker logs --since "$SW" wacrm-app-1 2>&1)
chk "the OLD error signature is gone ('Error updating message status')" "$(echo "$LOGS" | grep -c 'Error updating message status')" 0
chk "no 'Error applying message status' (RPC failure / PGRST202)" "$(echo "$LOGS" | grep -c 'Error applying message status')" 0
chk "no 'status event not applied' (unattributable number)" "$(echo "$LOGS" | grep -c 'status event not applied')" 0
echo "     unsupported-status warnings (Meta values the app does not store): $(echo "$LOGS" | grep -c 'unsupported status')"
# monotonicity in production: every outbound message recorded at T0 must now be at the same level or higher.
# (The id list can be thousands of UUIDs: the query goes through stdin; if the current statuses cannot be read the check FAILS, it never passes silently.)
IDS=$(cut -d'|' -f1 $D/T0-statuses.txt | head -20000 | sed "s/.*/'&'/" | paste -sd,)
if [ -n "$IDS" ]; then
  echo "select id||'|'||status from messages where id::text in ($IDS)" | ROF | sort > $D/NOW-statuses.txt; RC=${PIPESTATUS[1]}
  python3 -I - "$D/T0-statuses.txt" "$D/NOW-statuses.txt" "$RC" <<'PY'
import sys
rank={"sending":0,"sent":1,"delivered":2,"read":3,"failed":9}
t0=dict(l.strip().split("|",1) for l in open(sys.argv[1]) if "|" in l)
now=dict(l.strip().split("|",1) for l in open(sys.argv[2]) if "|" in l)
if sys.argv[3]!="0" or len(now) < 0.98*len(t0):
    print(f"FAIL could not read the current statuses (read {len(now)} of {len(t0)}, rc={sys.argv[3]}): the regression check did NOT run"); sys.exit(2)
reg=[i for i,s in t0.items() if i in now and now[i]!=s and not (s!="failed" and now[i]=="failed") and rank.get(now[i],0)<rank.get(s,0)]
adv=sum(1 for i,s in t0.items() if i in now and now[i]!=s)
print(f"     T0 outbound messages tracked={len(t0)} (read now: {len(now)}) | changed since T0={adv} | REGRESSIONS (lower rank than at T0)={len(reg)}")
sys.exit(1 if reg else 0)
PY
  case $? in 0) echo "ok   no outbound message regressed since T0";; 1) echo "FAIL a message status went backwards"; fail=1;; *) fail=1;; esac
fi
RO "select 'outbound since swap: total='||count(*)||' sent='||count(*) filter (where status='sent')||' delivered='||count(*) filter (where status='delivered')||' read='||count(*) filter (where status='read')||' failed='||count(*) filter (where status='failed') from messages where sender_type<>'customer' and created_at>'$SWS'"
chk "statuses are flowing: not more than 25% of outbound older than 5 min still 'sent' (needs >=20 samples)" "$(RO "select case when count(*)<20 then 'skip-small-sample' when 100.0*count(*) filter (where status='sent')/count(*)<=25 then 'ok' else 'HIGH' end from messages where sender_type<>'customer' and created_at>'$SWS' and created_at<now()-interval '5 minutes'")" "$( [ "$(RO "select count(*) from messages where sender_type<>'customer' and created_at>'$SWS' and created_at<now()-interval '5 minutes'")" -lt 20 ] && echo skip-small-sample || echo ok )"
RO "select 'voice notes (bot audio) since swap with status read: '||count(*) filter (where status='read')||' of '||count(*) from messages where sender_type='bot' and content_type='audio' and created_at>'$SWS'"
echo "== endpoints (inside the container: the app publishes no host port)"
for p in /api/orders/sellers "/api/orders/products?q=gu" /api/orders/confirm /api/contacts/bulk-delete /api/whatsapp/pricing-analytics; do c=$(probe "$p"); case $c in 401|403|405) echo "ok   $p -> $c";; *) echo "FAIL $p -> $c"; fail=1;; esac; done
chk "/login" "$(probe /login)" 200; chk "webhook GET without params -> 400" "$(probe /api/whatsapp/webhook)" 400
chk "webhook POST unsigned -> 401" "$(docker exec wacrm-app-1 node -e "fetch('http://127.0.0.1:3000/api/whatsapp/webhook',{method:'POST',body:'{}'}).then(r=>console.log(r.status)).catch(()=>console.log(0))")" 401
chk "public https login" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://crm.globaltechup.com/login)" 200
chk "public https webhook GET reaches the app (400)" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://crm.globaltechup.com/api/whatsapp/webhook)" 400
V=$("$(dirname "$0")/31-verify-migration.sh" after 2>&1 | tail -1); chk "Sheets objects, privileges and PostgREST visibility (31-verify)" "$V" "VERIFY-MIGRATION PASS"
echo "== flows / automations / keyword pause / contacts / media / messages"
RO "select 'flow_runs failed since swap='||count(*) filter (where status='failed' and coalesce(ended_at,last_advanced_at)>'$SWS')||' advanced since swap='||count(*) filter (where last_advanced_at>'$SWS')||' started since swap='||count(*) filter (where started_at>'$SWS') from flow_runs"
chk "no overdue active waits >5 min" "$(RO "select count(*) from flow_runs where status='active' and wait_until<now()-interval '5 minutes'")" 0
RO "select 'automation pending='||count(*)||' | automation_logs since swap: '||coalesce((select string_agg(status||'='||n, ', ') from (select status, count(*) n from automation_logs where created_at>'$SWS' group by 1) x),'none') from automation_pending_executions"
RO "select 'kw pause rows='||count(*)||' paused='||count(*) filter (where keyword_automations_paused)||' | media cleanup queue='||(select count(*) from contact_media_cleanup_items)||' | contacts='||(select count(*) from contacts) from contact_automation_settings"
chk "keyword pause respected: no keyword flow started within 2 min of a message from a contact whose pause was ALREADY in force" "$(RO "select count(distinct r.id) from messages m join conversations v on v.id=m.conversation_id join contact_automation_settings s on s.contact_id=v.contact_id and s.keyword_automations_paused and s.updated_at<m.created_at join flow_runs r on r.contact_id=v.contact_id and r.started_at between m.created_at and m.created_at+interval '2 minutes' join flows f on f.id=r.flow_id and f.trigger_type='keyword' where m.created_at>'$SWS' and m.sender_type='customer'")" 0
RO "select 'messages since swap: in='||count(*) filter (where sender_type='customer')||' out='||count(*) filter (where sender_type<>'customer') from messages where created_at>'$SWS'"
echo "== other errors since swap (classified; known baseline noise excluded from the check)"
echo "$LOGS" | grep -iE "error|exception|fatal|unhandled" | sed -E 's/[0-9a-f]{8}-[0-9a-f-]{27}/<uuid>/g; s/[0-9]{6,}/<num>/g' | cut -c1-90 | sort | uniq -c | sort -rn | head -6
chk "errors other than known noise (Error inserting message / upstream resets / UnauthorizedError / expired refresh tokens)" "$(echo "$LOGS" | grep -iE "error|exception|fatal|unhandled" | grep -vcE "Error inserting message|upstream connect error|UnauthorizedError|AuthApiError|Invalid Refresh Token|^\s+(message|__isAuthError|code|details|hint|status|name)")" 0
[ $fail -eq 0 ] && echo "POSTCHECK PASS" || { echo "POSTCHECK FAIL - evaluate 90-rollback-image.sh against the criteria in README.md"; exit 1; }
