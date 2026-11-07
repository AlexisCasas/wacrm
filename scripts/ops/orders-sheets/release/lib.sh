# Shared settings for the Keyler Google-Sheets release (PR #82 + dashboard branch + PR #81 code). Sourced by the numbered scripts. No secrets here.
# Installed by install.sh into $D (outside any repo). Candidate commit/tree are read from $D/CANDIDATE.{sha,tree} (written when the image is built).
set -uo pipefail
D=${RELEASE_DIR:-/opt/backups/wacrm/sheets-keyler-release-deploy}
REPO=/opt/apps/wacrm-sheets                                   # any clone with the commits fetched (NOT the production checkout)
CAND_SHA=$(cat $D/CANDIDATE.sha 2>/dev/null); CAND_TREE=$(cat $D/CANDIDATE.tree 2>/dev/null); S8=${CAND_SHA:0:8}
WT=/opt/apps/wacrm-deploy-$S8                                 # throw-away worktree used ONLY for the image build
NEW_IMAGE=wacrm-app:sheets-keyler-$S8
OLD_IMAGE=wacrm-app:meta-pricing-13d12e06
OLD_IMAGE_ID=sha256:535cf7a88e9cd2e1c03d857e413cde69c1bcbba3a250be0e2668ce8973e354ac
OLD_IMAGE_TAR=$D/image/wacrm-app_meta-pricing-13d12e06.tar.gz
PREV_OVERRIDE=/opt/backups/wacrm/meta-pricing-13d12e06-deploy/new-image-override.yml   # referenced by the running container's compose label: keep it
MIG_NAME=20261109000000_order_sheet_exports.sql
MIG_FILE=$D/sql/$MIG_NAME
MIG_SHA256=$(cat $D/MIG.sha256 2>/dev/null)                   # recorded when the package is installed from the reviewed file
EXCL_FILE=$D/sql/exclude-test-orders.sql
KEYLER=4d04a2e0-62b8-4508-a046-4b125aa2e8db
SHEET_ID=1iW-CiImc6CdMx9g-eGx5eImVWz57cH4g3Cmf8SqWlSk        # definitive Keyler sheet (not a secret; shared only with the service account)
SA_JSON=/root/.config/wacrm-secrets/google-sa.json
ENV_FILE=/opt/apps/wacrm/.env.local
TABLES="order_sheet_destinations order_sheet_exports order_sheet_exclusions order_sheet_events"
FUNCS="order_sheet_enqueue order_sheet_acquire order_sheet_renew order_sheet_release order_sheet_claim order_sheet_complete order_sheet_fail order_sheet_requeue"
APPLY_SIG='public.apply_whatsapp_message_status(uuid,text,text,timestamptz)'
STATUS_FNS="apply_whatsapp_message_status','whatsapp_status_can_advance','whatsapp_status_rank"
MAX_BACKUP_AGE_MIN=720
# Per-release profile: a release that is not the first Sheets release (image-only, other rollback target, other required history) puts its values in $D/release.conf.
# It is sourced here, so every numbered script sees them. Recognised: NEW_IMAGE OLD_IMAGE OLD_IMAGE_ID OLD_IMAGE_TAR PREV_OVERRIDE REPO RELEASE_LABEL
# REQUIRE_PRS (space separated PR numbers that must be merged) REQUIRE_COMMITS (commits that must be ancestors of main) EXPECT_DESTINATIONS_ENABLED (default 0).
REQUIRE_PRS=82; REQUIRE_COMMITS="13d12e06 71261e9f"; EXPECT_DESTINATIONS_ENABLED=0; RELEASE_LABEL="keyler-sheets (PR #82 + meta-pricing dashboard + PR #81 code)"
[ -f "$D/release.conf" ] && . "$D/release.conf"
COMPOSE_BASE="-p wacrm -f /opt/apps/wacrm/docker-compose.yml -f /opt/apps/wacrm/docker-compose.prod.yml -f /opt/apps/wacrm/docker-compose.bsuid-vars.yml"
DBC=supabase-db
RO()  { docker exec -e PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=20000' $DBC psql -U postgres -d postgres -At -F ' | ' -v ON_ERROR_STOP=1 -c "$1"; }
ROF() { docker exec -i -e PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=60000' $DBC psql -U postgres -d postgres -At -F ' | ' -v ON_ERROR_STOP=1 -f -; }
need_confirm() { [ "${CONFIRM:-}" = yes ] || { echo "REFUSING: this step changes production. Re-run with CONFIRM=yes after approval."; exit 2; }; }
log()   { echo "[$(date -u +%FT%TZ)] $*" | tee -a $D/deploy.log; }
probe() { docker exec wacrm-app-1 node -e "fetch('http://127.0.0.1:3000'+process.argv[1],{redirect:'manual'}).then(r=>console.log(r.status)).catch(()=>console.log(0))" "$1"; }
fail=0; chk() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1 (got '$2', want '$3')"; fail=1; fi; }
tree_of() { git -C $REPO rev-parse "$1^{tree}" 2>/dev/null; }
tbl_count() { RO "select count(*) from pg_tables where schemaname='public' and tablename in ('order_sheet_destinations','order_sheet_exports','order_sheet_exclusions','order_sheet_events')"; }
fn_count()  { RO "select count(*) from pg_proc where pronamespace='public'::regnamespace and proname like 'order_sheet%'"; }
# Calls the cron endpoint of the running app from inside the container (credentials never leave the container's environment). Prints "HTTP <status> <first 600 chars>".
cron_call() { docker exec -e MODE="$1" wacrm-app-1 node -e "fetch('http://127.0.0.1:3000/api/orders/sheets-export/cron?mode='+process.env.MODE,{headers:{'x-cron-secret':process.env.AUTOMATION_CRON_SECRET},signal:AbortSignal.timeout(process.env.MODE==='reconcile'?280000:140000)}).then(async r=>{const t=await r.text();console.log('HTTP '+r.status+' '+t.slice(0,600))}).catch(e=>console.log('ERR '+e.name))"; }
sfn_count() { RO "select count(*) from pg_proc where proname in ('$STATUS_FNS')"; }

# --- evidence handling (used by 50-swap-image.sh and 60-postchecks.sh) -------------------------------------------------------------------------
# Evidence files are never overwritten or truncated by a later run: the previous copy moves to $D/evidence/previous/<name>.<UTC timestamp>.
keep_prev() { [ -s "$1" ] || return 0; mkdir -p "$D/evidence/previous"; mv "$1" "$D/evidence/previous/$(basename "$1").$(date -u +%Y%m%dT%H%M%SZ)"; }
# containers-before.txt = NAMES ONLY, sorted (what 60-postchecks.sh compares); containers-before-swap.txt = name, image, status (tab separated, for the record).
record_containers() {
  keep_prev "$D/containers-before.txt"; keep_prev "$D/containers-before-swap.txt"
  docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Status}}' > "$D/containers-before-swap.txt" || return 1
  cut -f1 "$D/containers-before-swap.txt" | sort > "$D/containers-before.txt"
}
# T0.txt is started EMPTY first and only ever appended to afterwards, so no later line can erase an earlier one.
T0_KEYS=("T0 fnmd5=" "T0 export tables=" "T0 orders=" "T0 cutoff=" "T0 switches=")
t0_start() { keep_prev "$D/T0.txt"; keep_prev "$D/T0-statuses.txt"; : > "$D/T0.txt"; }
t0_complete() { for k in "${T0_KEYS[@]}"; do grep -q "^$k" "$D/T0.txt" 2>/dev/null || { echo "T0 evidence incomplete: missing '$k'"; return 1; }; done; }
