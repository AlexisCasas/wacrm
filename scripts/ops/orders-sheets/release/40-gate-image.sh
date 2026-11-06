#!/usr/bin/env bash
# READ-ONLY GATE for the IMAGE SWAP (independent from the migration gate). Prints GATE-IMAGE GO / NO-GO.
# DRYRUN_MERGE_COMMIT=<sha> pretends that commit is main's tip to test the rest of the logic; it never yields GO (exit 3).
# Activity thresholds come from the 14-day traffic analysis of the quietest band (Lima 04:30-05:00): override with MAX_IN_10M / MAX_OUT_10M.
. "$(dirname "$0")/lib.sh"
DRY=0; [ -n "${DRYRUN_MERGE_COMMIT:-}" ] && DRY=1
MAX_IN_10M=${MAX_IN_10M:-15}; MAX_OUT_10M=${MAX_OUT_10M:-150}; MAX_IN_2M=${MAX_IN_2M:-3}
git -C $REPO fetch -q origin main 2>/dev/null
echo "== A. the image corresponds to the code integrated in main"
if [ $DRY -eq 1 ]; then M=$DRYRUN_MERGE_COMMIT; echo "     (DRY RUN: pretending $M is main's tip)"; else M=$(git -C $REPO rev-parse origin/main); fi
P82=$(gh api repos/AlexisCasas/wacrm/pulls/82 --jq 'select(.merged==true).merge_commit_sha' 2>/dev/null)
chk "PR #82 (Sheets export) is merged into main" "$([ -n "$P82" ] && echo yes || echo no)" yes
chk "the dashboard commit running in production (13d12e06) is contained in main" "$(git -C $REPO merge-base --is-ancestor 13d12e06 $M 2>/dev/null && echo yes || echo no)" yes
chk "PR #81 code (71261e9f) is contained in main" "$(git -C $REPO merge-base --is-ancestor 71261e9f $M 2>/dev/null && echo yes || echo no)" yes
IMG_REV=$(docker image inspect $NEW_IMAGE --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null)
IMG_TREE=$(docker image inspect $NEW_IMAGE --format '{{index .Config.Labels "io.wacrm.source-tree"}}' 2>/dev/null)
chk "candidate image exists with the recorded id" "$(docker image inspect $NEW_IMAGE --format '{{.Id}}' 2>/dev/null)" "$(cat $D/NEW_IMAGE_ID 2>/dev/null)"
chk "image revision label = the QA'd candidate commit" "$IMG_REV" "$CAND_SHA"
chk "image tree label = tree of the candidate commit" "$IMG_TREE" "$(tree_of $CAND_SHA)"
chk "TREE of main's tip == tree the image was built from (so prod will equal main)" "$(tree_of $M)" "$IMG_TREE"
AGEH=$(( ( $(date +%s) - $(date -d "$(docker image inspect $NEW_IMAGE --format '{{.Created}}' 2>/dev/null | cut -c1-19)Z" +%s 2>/dev/null || echo 0) ) / 3600 ))
chk "image younger than 22 h (the 04:13 UTC prune removes unused images older than 24 h) - age ${AGEH} h" "$(( AGEH < 22 ))" 1
chk "candidate image archive checksum (safety copy)" "$(cd $D/image && sha256sum -c SHA256SUMS --quiet >/dev/null 2>&1 && echo ok)" ok
echo "== B. the migration is applied and verified (independent gate passed first); the secrets are in place"
chk "export tables/functions exist (4/8)" "$(tbl_count)/$(fn_count)" "4/8"
V=$("$(dirname "$0")/31-verify-migration.sh" after 2>&1 | tail -1); chk "31-verify-migration.sh" "$V" "VERIFY-MIGRATION PASS"
chk "2 test orders excluded" "$(RO "select count(*) from order_sheet_exclusions where reason='test'")" 2
chk "service-account JSON exists, mode 600" "$(stat -c %a $SA_JSON 2>/dev/null)" 600
chk "service-account JSON has the expected structure (no values printed)" "$(python3 -I -c "import json;d=json.load(open('$SA_JSON'));print('ok' if d.get('type')=='service_account' and d.get('client_email','').endswith('.iam.gserviceaccount.com') and d.get('private_key','').startswith('-----BEGIN PRIVATE KEY-----') else 'bad')")" ok
chk "env file is mode 600" "$(stat -c %a $ENV_FILE)" 600
chk "definitive sheet is registered with enabled=false (or not yet registered)" "$(RO "select count(*) from order_sheet_destinations where enabled")" 0
echo "== C. rollback is ready"
chk "running image = the one archived for rollback" "$(docker inspect wacrm-app-1 --format '{{.Image}}')" $OLD_IMAGE_ID
chk "rollback archive checksum" "$(cd $D/image && sha256sum -c SHA256SUMS --quiet >/dev/null 2>&1 && echo ok)" ok
chk "rollback archive digest = running image" "$(tar -xzOf $OLD_IMAGE_TAR index.json | python3 -I -c "import json,sys; print(json.load(sys.stdin)['manifests'][0]['digest'])")" $OLD_IMAGE_ID
chk "previous override still on disk (the container's label references it)" "$([ -s $PREV_OVERRIDE ] && echo ok)" ok
chk "app healthy, 0 restarts" "$(docker inspect wacrm-app-1 --format '{{.State.Health.Status}} {{.RestartCount}}')" "healthy 0"
chk "disk free >= 10 GB" "$(( $(df --output=avail -BG / | tail -1 | tr -dc 0-9) >= 10 ))" 1
echo "== D. quiet window: LIVE activity (the swap leaves ~10 s without an upstream; Meta retries, but fewer events = fewer risks)"
IN10=$(RO "select count(*) from messages where sender_type='customer' and created_at>now()-interval '10 minutes'"); OUT10=$(RO "select count(*) from messages where sender_type<>'customer' and created_at>now()-interval '10 minutes'"); IN2=$(RO "select count(*) from messages where sender_type='customer' and created_at>now()-interval '2 minutes'")
echo "     inbound last 10 min=$IN10 (max $MAX_IN_10M) | outbound last 10 min=$OUT10 (max $MAX_OUT_10M) | inbound last 2 min=$IN2 (max $MAX_IN_2M) | Lima time $(TZ=America/Lima date +%H:%M)"
if [ -n "${FORCE_BUSY:-}" ]; then echo "     !!! FORCE_BUSY set: activity thresholds are NOT enforced (emergency use only)"; else
  chk "inbound (10 min) within threshold" "$(( IN10 <= MAX_IN_10M ))" 1; chk "outbound (10 min) within threshold" "$(( OUT10 <= MAX_OUT_10M ))" 1; chk "inbound (2 min) within threshold" "$(( IN2 <= MAX_IN_2M ))" 1; fi
chk "no order awaiting delivery (pending)" "$(RO "select count(*) from order_confirmations where delivery_status='pending'")" 0
chk "no order confirmed in the last 5 min" "$(RO "select count(*) from order_confirmations where confirmed_at>now()-interval '5 minutes'")" 0
chk "no delivery to InkaClick in flight" "$(RO "select count(*) from order_confirmation_deliveries where finished_at is null")" 0
chk "no flow wait claimed right now" "$(RO "select count(*) from flow_runs where wait_claim_token is not null")" 0
chk "no automation step running" "$(RO "select count(*) from automation_pending_executions where status='running'")" 0
chk "no contact media cleanup in progress" "$(RO "select count(*) from contact_media_cleanup_items where status not in ('completed','done')")" 0
chk "no broadcast sending" "$(RO "select count(*) from broadcasts where status in ('sending','scheduled')")" 0
chk "orders cron: last 10 runs 200" "$(tail -10 /var/log/wacrm-orders-cron.log | grep -vc 'rc=0 200')" 0
chk "outbox: nothing failed in 24 h" "$(RO "select count(*) from order_confirmation_deliveries where outcome<>'sent' and started_at>now()-interval '24 hours'")" 0
if [ $DRY -eq 1 ]; then echo "GATE-IMAGE DRY-RUN ONLY (result would be $([ $fail -eq 0 ] && echo GO || echo NO-GO)); never a release gate"; exit 3; fi
[ $fail -eq 0 ] && echo "GATE-IMAGE GO" || { echo "GATE-IMAGE NO-GO"; exit 1; }
