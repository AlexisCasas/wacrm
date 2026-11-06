#!/usr/bin/env bash
# READ-ONLY GATE for the MIGRATION 20261109000000 (independent from the image gate). Prints GATE-MIGRATION GO / NO-GO.
# DRYRUN_MERGE_COMMIT=<sha> pretends that commit is main's merge of PR #82 to test the rest of the logic; it can NEVER yield GO (exit 3).
. "$(dirname "$0")/lib.sh"
DRY=0; [ -n "${DRYRUN_MERGE_COMMIT:-}" ] && DRY=1
git -C $REPO fetch -q origin main 2>/dev/null
echo "== A. what will be applied is what was reviewed and merged"
if [ $DRY -eq 1 ]; then M=$DRYRUN_MERGE_COMMIT; echo "     (DRY RUN: pretending $M is main's tip)"
else M=$(gh api repos/AlexisCasas/wacrm/pulls/82 --jq 'select(.merged==true).merge_commit_sha' 2>/dev/null); fi
chk "PR #82 is merged into main" "$([ -n "$M" ] && echo yes || echo no)" yes
if [ -n "$M" ]; then
  chk "merge commit is contained in origin/main" "$(git -C $REPO merge-base --is-ancestor $M origin/main 2>/dev/null && echo yes || echo no)" yes
  chk "migration file AT main == the reviewed file" "$(git -C $REPO show origin/main:supabase/migrations/$MIG_NAME 2>/dev/null | sha256sum | cut -c1-64)" "$MIG_SHA256"
  NEWER=$(git -C $REPO ls-tree --name-only origin/main supabase/migrations/ | sed 's#.*/##' | awk -v m="$MIG_NAME" '$0 > m' | tr '\n' ' ')
  chk "no migration NEWER than this one in main (ordering)" "${NEWER:-none}" none
fi
chk "staged copy of the migration == reviewed sha256" "$(sha256sum $MIG_FILE | cut -c1-64)" "$MIG_SHA256"
echo "== B. production is in the expected state"
chk "export tables NOT present yet (migration pending)" "$(tbl_count)" 0
chk "export functions NOT present yet" "$(fn_count)" 0
chk "PR #81 migration already applied (3 status functions)" "$(RO "select count(*) from pg_proc where proname in ('apply_whatsapp_message_status','whatsapp_status_can_advance','whatsapp_status_rank')")" 3
chk "running image = the one archived for rollback" "$(docker inspect wacrm-app-1 --format '{{.Image}}')" $OLD_IMAGE_ID
chk "app healthy, 0 restarts" "$(docker inspect wacrm-app-1 --format '{{.State.Health.Status}} {{.RestartCount}}')" "healthy 0"
chk "postgres can CREATE in public (database owner)" "$(RO "select has_schema_privilege('postgres','public','create')")" t
chk "accounts has a primary key" "$(RO "select count(*) from pg_constraint where conrelid='public.accounts'::regclass and contype='p'")" 1
chk "order_confirmations has UNIQUE (id, account_id) (composite FK target)" "$(RO "select count(*) from pg_constraint where conrelid='public.order_confirmations'::regclass and contype='u' and (select string_agg(attname,',' order by attnum) from pg_attribute where attrelid=conrelid and attnum=any(conkey))='id,account_id'")" 1
chk "service_role exists" "$(RO "select count(*) from pg_roles where rolname='service_role'")" 1
chk "PostgREST schema reload trigger exists (pgrst_ddl_watch)" "$(RO "select count(*) from pg_event_trigger where evtname='pgrst_ddl_watch'")" 1
chk "no transaction older than 60 s (lock-queue risk)" "$(RO "select count(*) from pg_stat_activity where state<>'idle' and pid<>pg_backend_pid() and now()-xact_start>interval '60 seconds' and datname='postgres' and usename not in ('supabase_admin','supabase_replication_admin')")" 0
chk "nobody holds an exclusive lock on accounts / order tables" "$(RO "select count(*) from pg_locks l join pg_class c on c.oid=l.relation where c.relname in ('accounts','order_confirmations','order_confirmation_items') and l.mode in ('AccessExclusiveLock','ExclusiveLock','ShareRowExclusiveLock')")" 0
chk "Keyler account exists" "$(RO "select count(*) from accounts where id='$KEYLER'")" 1
echo "== C. backups and rehearsal"
AGE=$(( ($(date +%s) - $(stat -c %Y $(ls $D/db/postgres_full_*.dump | tail -1))) / 60 ))
chk "database dump younger than ${MAX_BACKUP_AGE_MIN} min (age ${AGE} min)" "$(( AGE < MAX_BACKUP_AGE_MIN ))" 1
chk "database dump checksums" "$(cd $D/db && sha256sum -c SHA256SUMS --quiet >/dev/null 2>&1 && echo ok)" ok
chk "image archive checksum" "$(cd $D/image && sha256sum -c SHA256SUMS --quiet >/dev/null 2>&1 && echo ok)" ok
chk "rollback archive = running image" "$(tar -xzOf $OLD_IMAGE_TAR index.json | python3 -I -c "import json,sys; print(json.load(sys.stdin)['manifests'][0]['digest'])")" $OLD_IMAGE_ID
chk "rehearsal on the production copy passed" "$(grep -c '^REHEARSAL PASS' $D/evidence/rehearsal-run.txt 2>/dev/null)" 1
chk "rehearsal used this exact migration (sha256 recorded)" "$(grep -c "migration sha256: $MIG_SHA256" $D/evidence/rehearsal-run.txt 2>/dev/null)" 1
chk "rehearsal is newer than the current dump" "$([ $D/evidence/rehearsal-run.txt -nt $(ls $D/db/postgres_full_*.dump | tail -1) ] && echo ok)" ok
echo "== D. switches that must not move (recorded)"
RO "select 'order_integration_settings: '||account_id||' enabled='||enabled||' confirm_enabled='||confirm_enabled||' multiproduct_enabled='||multiproduct_enabled||' updated_at='||updated_at from order_integration_settings" | sed 's/^/     /'
if [ $DRY -eq 1 ]; then echo "GATE-MIGRATION DRY-RUN ONLY (result would be $([ $fail -eq 0 ] && echo GO || echo NO-GO)); never a release gate"; exit 3; fi
[ $fail -eq 0 ] && echo "GATE-MIGRATION GO" || { echo "GATE-MIGRATION NO-GO"; exit 1; }
