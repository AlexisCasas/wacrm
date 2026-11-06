#!/usr/bin/env bash
# Recreates ONLY the `app` service on the candidate image (same compose files + image override) AFTER adding the Sheets variables to the env file
# (45-prepare-env.sh; both are read when the container is created, so ONE recreate carries both). Requires CONFIRM=yes and GATE-IMAGE GO. Waits for a slot inside the minute that avoids the minute-boundary crons (orders/flows at :00) and the 5/10-minute monitors,
# records T0 (order fingerprint + status snapshot of recent outbound messages), swaps, and waits for `healthy`. Expect ~10 s without upstream.
. "$(dirname "$0")/lib.sh"; need_confirm
unset DRYRUN_MERGE_COMMIT          # a dry-run pretend-merge must never reach a real swap
"$(dirname "$0")/40-gate-image.sh" || { echo "image gate is NO-GO: nothing was changed"; exit 1; }
printf 'services:\n  app:\n    image: %s\n' "$NEW_IMAGE" > $D/new-image-override.yml
printf 'services:\n  app:\n    image: %s\n' "$OLD_IMAGE" > $D/rollback-image-override.yml
"$(dirname "$0")/45-prepare-env.sh" || { echo "env preparation failed: nothing was swapped"; exit 1; }
RO "select 'T0 fnmd5='||string_agg(proname||'='||md5(prosrc), ',' order by proname) from pg_proc where proname in ('$STATUS_FNS')" | tee -a $D/T0.txt
RO "select 'T0 export tables='||count(*) from pg_tables where schemaname='public' and tablename like 'order_sheet%'" | tee -a $D/T0.txt
docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Status}}' > $D/containers-before-swap.txt
# T0 evidence ---------------------------------------------------------------------------------------------------------
RO "select 'T0 orders='||count(*)||' items='||(select count(*) from order_confirmation_items)||' fp='||md5(string_agg(id::text||customer_name||product||quantity||price||delivery_status||coalesce(inkaclick_order_id::text,''), ',' order by id)) from order_confirmations" | tee $D/T0.txt
RO "select 'T0 cutoff='||max(confirmed_at) from order_confirmations" | tee -a $D/T0.txt
RO "select 'T0 switches='||string_agg(account_id||':'||enabled||'/'||confirm_enabled||'/'||multiproduct_enabled||'@'||updated_at, ';') from order_integration_settings" | tee -a $D/T0.txt
RO "select id||'|'||status from messages where sender_type<>'customer' and created_at>now()-interval '3 hours' order by id" > $D/T0-statuses.txt; echo "T0 statuses recorded: $(wc -l < $D/T0-statuses.txt) outbound messages" | tee -a $D/T0.txt
# slot: second 10-20 of a minute whose number mod 5 is 1, 2 or 3
for i in $(seq 1 400); do s=$((10#$(date -u +%S))); m=$((10#$(date -u +%M))); r=$((m % 5)); if [ $s -ge 10 ] && [ $s -le 20 ] && [ $r -ge 1 ] && [ $r -le 3 ]; then break; fi; sleep 0.5; done
log "swap -> $NEW_IMAGE (slot $(date -u +%T), Lima $(TZ=America/Lima date +%H:%M:%S))"
cd /opt/apps/wacrm && docker compose $COMPOSE_BASE -f $D/new-image-override.yml up -d --no-deps --no-build app 2>&1 | grep -v 'variable is not set' | tee -a $D/deploy.log
for i in $(seq 1 30); do s=$(docker inspect wacrm-app-1 --format '{{.State.Health.Status}}'); [ "$s" = healthy ] && break; sleep 5; done
log "app health after swap: $s | image: $(docker inspect wacrm-app-1 --format '{{.Config.Image}}') | started $(docker inspect wacrm-app-1 --format '{{.State.StartedAt}}')"
[ "$s" = healthy ] || { echo "NOT healthy after 150 s: run 90-rollback-image.sh (CONFIRM=yes)"; exit 1; }
echo "Now run 60-postchecks.sh (and again after ~10 minutes of real traffic)."
