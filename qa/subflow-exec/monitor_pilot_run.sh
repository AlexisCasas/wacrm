#!/bin/sh
# READ-ONLY snapshot of the pilot company's run(s): state, call stack, events, messages, cron log tail. Writes nothing.
ACC=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb
Q() { docker exec supabase-db psql -U postgres -d postgres -At -F ' | ' -c "$1"; }
date -u +"== %FT%TZ"
Q "select 'run', left(r.id::text,8), r.status, coalesce(r.end_reason,'-'), 'flujo_raiz='||(select name from flows where id=r.flow_id), 'en='||coalesce((select name from flows where id=r.current_flow_id),'(raíz)'), 'nodo='||coalesce(r.current_node_key,'-'), 'espera hasta='||coalesce(to_char(r.wait_until at time zone 'UTC','HH24:MI:SS'),'-') from flow_runs r where r.account_id='$ACC' and r.started_at > now() - interval '3 hours' order by r.started_at desc limit 3"
Q "select 'marcos', f.depth, (select name from flows where id=f.caller_flow_id), '->', (select name from flows where id=f.callee_flow_id), 'retorno='||f.return_node_key, 'política='||f.on_customer_reply from flow_run_subflow_frames f join flow_runs r on r.id=f.flow_run_id where r.account_id='$ACC' and r.status='active'"
Q "select to_char(e.created_at at time zone 'UTC','HH24:MI:SS'), e.event_type, coalesce(e.node_key,'-'), coalesce(e.payload->>'reason', e.payload->>'condition_result', e.payload->>'node_type', '') from flow_run_events e where e.flow_run_id = (select id from flow_runs where account_id='$ACC' order by started_at desc limit 1) and e.created_at > now() - interval '3 hours' and e.event_type <> 'started' order by e.created_at, e.id | tail -25" 2>/dev/null
Q "select to_char(m.created_at at time zone 'UTC','HH24:MI:SS'), m.sender_type, left(coalesce(m.content_text,''),48) from messages m join conversations v on v.id=m.conversation_id where v.account_id='$ACC' and m.created_at > now() - interval '3 hours' order by m.created_at"
echo "-- ejecuciones activas en TODA la base: $(Q "select count(*) from flow_runs where status='active'") (de ellas fuera del piloto: $(Q "select count(*) from flow_runs where status='active' and account_id<>'$ACC'"))"
echo "-- cron por minuto (últimas líneas):"; tail -4 /var/log/wacrm-flows-cron.log | cut -c1-150
