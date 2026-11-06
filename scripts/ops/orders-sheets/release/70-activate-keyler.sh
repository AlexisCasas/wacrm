#!/usr/bin/env bash
# Controlled activation of the Keyler export, in explicit stages. Each stage that changes anything needs CONFIRM=yes AND its own authorization.
#   status                         read-only summary (DB + last cron lines)
#   register                       insert the destination for Keyler with enabled=false (no export yet)
#   precheck                       read-only: the definitive sheet answers (auth + read), has the 27 headers and NO data rows
#   enable                         enabled=true (needs: exclusions applied, precheck PASS)                       -> exporter becomes active ONLY when the cron / this script calls it
#   sync                           runs the sync pass repeatedly until nothing is claimed, then prints the totals
#   reconcile                      reconcile pass (writes the figures to the control tab): must show 0 differences and the expected totals
#   second-pass                    one more sync (must append 0 lines) + one more reconcile
#   disable                        enabled=false (stops the exporter at once)
. "$(dirname "$0")/lib.sh"
CMD=${1:-status}
TOTALS_SQL="with k as (select o.id, o.price, o.quantity, o.delivery_status,(select count(*) from order_confirmation_items i where i.order_id=o.id) n,(select coalesce(sum(i.quantity),0) from order_confirmation_items i where i.order_id=o.id) iq from order_confirmations o where o.account_id='$KEYLER'), e as (select * from k where delivery_status='acknowledged' and id not in (select order_id from order_sheet_exclusions)) select count(*)||' orders / '||sum(greatest(n,1))||' lines / '||sum(case when n>0 then iq else quantity end)||' units / S/ '||sum(price) from e"
cron_json() { docker exec -e MODE="$1" wacrm-app-1 node -e "fetch('http://127.0.0.1:3000/api/orders/sheets-export/cron?mode='+process.env.MODE,{headers:{'x-cron-secret':process.env.AUTOMATION_CRON_SECRET},signal:AbortSignal.timeout(140000)}).then(async r=>{console.log(r.status);console.log(await r.text())}).catch(e=>{console.log(0);console.log('{}')})"; }
field() { python3 -I -c "import json,sys;d=json.loads(sys.stdin.read() or '{}');a=(d.get('accounts') or {}).get('$KEYLER') or {};print(a.get('$1','?'))"; }
case $CMD in
status)
  RO "select 'destination: enabled='||enabled||' eligible_since='||coalesce(eligible_since::text,'null')||' lease='||(lease_token is not null)||' layout='||layout_version from order_sheet_destinations where account_id='$KEYLER'" | sed 's/^/   /'
  RO "select 'jobs: '||coalesce(string_agg(status||'='||n, ' '),'none') from (select status, count(*) n from order_sheet_exports group by 1 order by 1) x" | sed 's/^/   /'
  RO "select 'exclusions: '||count(*) from order_sheet_exclusions" | sed 's/^/   /'
  echo "   eligible per DB now: $(RO "$TOTALS_SQL")"; tail -3 /var/log/wacrm-orders-sheets-cron.log 2>/dev/null | cut -c1-200 | sed 's/^/   cron: /' ;;
register)
  need_confirm
  chk "migration applied" "$(tbl_count)" 4; [ $fail -eq 0 ] || exit 1
  docker exec -i $DBC psql -U postgres -d postgres -X -v ON_ERROR_STOP=1 -c "insert into order_sheet_destinations (account_id, spreadsheet_id, enabled) values ('$KEYLER','$SHEET_ID',false) on conflict (account_id) do nothing"
  chk "destination registered, disabled, definitive sheet" "$(RO "select enabled||':'||(spreadsheet_id='$SHEET_ID') from order_sheet_destinations where account_id='$KEYLER'")" "false:true"
  [ $fail -eq 0 ] && echo "REGISTER OK" || exit 1 ;;
precheck)
  R=$(docker exec -e SHEET="$SHEET_ID" wacrm-app-1 node -e "
const c=require('crypto'),b=x=>Buffer.from(x).toString('base64url'),n=Math.floor(Date.now()/1000),email=process.env.GOOGLE_SHEETS_SA_EMAIL,key=Buffer.from(process.env.GOOGLE_SHEETS_SA_KEY_B64,'base64').toString();
const h=b(JSON.stringify({alg:'RS256',typ:'JWT'})),p=b(JSON.stringify({iss:email,scope:'https://www.googleapis.com/auth/spreadsheets',aud:'https://oauth2.googleapis.com/token',iat:n,exp:n+3600}));
const jwt=h+'.'+p+'.'+b(c.createSign('RSA-SHA256').update(h+'.'+p).sign(key));
(async()=>{const t=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:jwt})});const tj=await t.json();
if(!t.ok){console.log('AUTH '+t.status);return}
const r=await fetch('https://sheets.googleapis.com/v4/spreadsheets/'+process.env.SHEET+'/values/'+encodeURIComponent(\"'Registro de pedidos'!A1:AA\")+'?valueRenderOption=UNFORMATTED_VALUE',{headers:{authorization:'Bearer '+tj.access_token}});
const j=await r.json();console.log('AUTH 200 READ '+r.status+' headers='+((j.values||[[]])[0]||[]).length+' first='+(((j.values||[[]])[0]||[])[0]||'')+' datarows='+Math.max((j.values||[]).length-1,0))})().catch(e=>console.log('ERR '+e.name))" 2>&1 | tail -1)
  echo "   $R"; chk "OAuth + read of the definitive sheet" "$(echo $R | grep -c 'AUTH 200 READ 200')" 1
  chk "27 headers, first is 'Fecha'" "$(echo $R | grep -c 'headers=27 first=Fecha')" 1
  chk "the definitive sheet has NO data rows (nothing mixed in)" "$(echo $R | grep -c 'datarows=0')" 1
  [ $fail -eq 0 ] && echo "PRECHECK PASS" || { echo "PRECHECK FAIL"; exit 1; } ;;
enable)
  need_confirm
  chk "destination registered" "$(RO "select count(*) from order_sheet_destinations where account_id='$KEYLER' and spreadsheet_id='$SHEET_ID'")" 1
  chk "2 test orders excluded" "$(RO "select count(*) from order_sheet_exclusions where reason='test'")" 2
  P=$("$0" precheck 2>&1 | tail -1); chk "precheck" "$P" "PRECHECK PASS"
  [ $fail -eq 0 ] || exit 1
  docker exec -i $DBC psql -U postgres -d postgres -X -v ON_ERROR_STOP=1 -c "update order_sheet_destinations set enabled=true, updated_at=now() where account_id='$KEYLER'"
  log "Keyler export ENABLED (sheet $SHEET_ID)"; echo "ENABLED. Next: sync" ;;
sync|second-pass)
  need_confirm
  for i in $(seq 1 30); do
    OUT=$(cron_json sync); CODE=$(echo "$OUT" | head -1); BODY=$(echo "$OUT" | tail -n +2)
    CL=$(echo "$BODY" | field claimed); AP=$(echo "$BODY" | field appendedLines); EX=$(echo "$BODY" | field exported); DE=$(echo "$BODY" | field deadOutstanding); ER=$(echo "$BODY" | field error)
    echo "   pass $i: HTTP $CODE claimed=$CL exported=$EX appendedLines=$AP deadOutstanding=$DE error=$ER skipped=$(echo "$BODY" | field skipped)"
    [ "$CODE" = 200 ] || { echo "STOP: HTTP $CODE (attention). Inspect with status; 95-disable-export.sh stops the exporter."; exit 1; }
    [ "$CL" = 0 ] && break; sleep 2
  done
  if [ "$CMD" = second-pass ]; then chk "second pass appended 0 lines and claimed 0 jobs" "$CL/$AP" "0/0"; fi
  echo "   jobs: $(RO "select string_agg(status||'='||n, ' ') from (select status, count(*) n from order_sheet_exports group by 1 order by 1) x")"
  [ $fail -eq 0 ] && echo "SYNC OK" || exit 1 ;;
reconcile)
  need_confirm
  OUT=$(cron_json reconcile); CODE=$(echo "$OUT" | head -1); BODY=$(echo "$OUT" | tail -n +2)
  echo "   HTTP $CODE | eligible: $(echo "$BODY" | field eligibleOrders) orders / $(echo "$BODY" | field eligibleLines) lines / $(echo "$BODY" | field eligibleUnits) units / cents $(echo "$BODY" | field eligibleCents)"
  echo "   sheet   : $(echo "$BODY" | field sheetOrders) orders / $(echo "$BODY" | field sheetLines) lines / $(echo "$BODY" | field sheetUnits) units / cents $(echo "$BODY" | field sheetCents) | differences=$(echo "$BODY" | field differences)"
  echo "   excluded: $(echo "$BODY" | field excludedByReason) | not acknowledged: $(echo "$BODY" | field notAcknowledgedOrders)"
  echo "   expected per DB: $(RO "$TOTALS_SQL")"
  chk "HTTP 200" "$CODE" 200; chk "0 differences" "$(echo "$BODY" | field differences)" 0
  [ $fail -eq 0 ] && echo "RECONCILE PASS (the control tab of the sheet now shows the figures and the time of this pass)" || { echo "RECONCILE FAIL"; exit 1; }
  [ "$CMD" = reconcile ] ;;
disable)
  need_confirm
  docker exec -i $DBC psql -U postgres -d postgres -X -v ON_ERROR_STOP=1 -c "update order_sheet_destinations set enabled=false, updated_at=now() where account_id='$KEYLER'"
  log "Keyler export DISABLED"; echo "DISABLED" ;;
*) echo "usage: $0 status|register|precheck|enable|sync|reconcile|second-pass|disable"; exit 2 ;;
esac
