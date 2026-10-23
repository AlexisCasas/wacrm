#!/usr/bin/env bash
# PRODUCTION PROCEDURE FOR MIGRATION 076 (audio selection schema) - REVISION 2. PREPARED, NOT EXECUTED: every mode that writes needs its own explicit authorisation.
#
# Revision 2 (the only functional change from aplicar-076.sh, SHA-256 67cf0151cd75...): the PostgreSQL backup is validated again - same file, still recent
# (<= BACKUP_MAX_MIN), same SHA-256, restore test still approved (8/8) - right after the quiet gap is found AND before EVERY attempt of the migration
# transaction, in apply mode. A backup that expired, vanished, changed or lost its restore evidence is a NO-GO (exit 3) and nothing is applied. The
# rollback mode is deliberately NOT gated by the age of the backup: an emergency rollback must stay possible hours after the migration.
#
#   aplicar-076.sh preflight   READ ONLY. All pre-conditions; prints PASS/FAIL per check; exit 0 only if every one passes.
#   aplicar-076.sh apply       needs CONFIRM_APPLY_076=yes. preflight -> snapshot -> wait for a quiet gap -> 076 in ONE transaction with lock_timeout 3 s and
#                              statement_timeout 30 s (up to 3 attempts, only for lock/deadlock/serialisation errors) -> verification -> observation.
#   aplicar-076.sh verify      READ ONLY. The post-conditions (also run at the end of apply).
#   aplicar-076.sh rollback    needs CONFIRM_ROLLBACK_076=yes. Refuses if ANY purpose, identifier, classified audio or selective request exists.
#
# Never touched: the application container, images, .env.local, Flows, contacts, products, audios, messages. The migration is additive (new columns NULL,
# new tables empty): the running image keeps working before, during and after; image rollback needs no database change.
# Output: evidence folder $EVID (digests, matrix, psql output, SHA-256 manifest) with mode 700.
set -uo pipefail
umask 077
HERE="$(cd "$(dirname "$0")" && pwd)"
DB_CONTAINER="${DB_CONTAINER:-supabase-db}"; APP="${APP_CONTAINER-wacrm-app-1}"; DB_NAME=postgres; DB_USER=supabase_admin
MIG="${MIG076:-/opt/apps/wacrm-audios-sel1/supabase/migrations/076_audio_guide_selection.sql}"
VERIFY="${VERIFY_SQL:-/opt/apps/wacrm-audios-sel1/supabase/ci/verify-schema.sql}"
ROLLBACK_SQL="${ROLLBACK_SQL:-$HERE/../rollback-076.sql}"
MATRIX_SQL="${MATRIX_SQL:-$HERE/../matriz-permisos.sql}"; MATRIX_PROD="${MATRIX_PROD:-/opt/wacrm-ensayo-076/matriz-permisos-prod.txt}"
BACKUP_DIR="${BACKUP_DIR:-/opt/backups/supabase}"; BACKUP_MAX_MIN="${BACKUP_MAX_MIN:-90}"
EXPECT_IMAGE="${EXPECT_IMAGE:-wacrm-app:audio-guard-7b9208d7}"; EXPECT_COUNTS="${EXPECT_COUNTS:-76/76/0/0}"
# ---- pins (what was reviewed and rehearsed) ----------------------------------------------------------------------------------------------------------
SHA_MIG="4588d86b7744b6d5cba0359f31b9f53c71d5e9c9c91577376fe22cedff94c461"
SHA_VERIFY="ee2e4ca1a7147f9b070f7a66052f1d5eb2d7d621c7f9fc517d6a655f83447f5c"
SHA_ROLLBACK="b23aa5cce4c1fc36d44a1e45fec442de2690e64c9bb0c1c96864eb98f389d229"
SHA_MATRIX_SQL="9723cf6daa5ce20ba14ae71fff19b6d493e2a21356cda16a6aab848fc2339b95"
SHA_MATRIX_PROD="43d20a85435f9f698e68397a94f9b33b2aa3dce4b771368fa04692a522bdcd28"
SHA_DIGEST_SQL="48e3de276a5a9129ca752c4c326c39295aa0a0149afdb2bd86e6ecdfad8f7f42"
SHA_DATA_SQL="3da8badd6aa0ec1ba0ee1450b4dca2972018cc813d04937d3224c6a2a2b72eef"
SHA_ALLOWED="b46730f1279f0f9a48e96ae5ee380609fd04ccf8bec614cfe58e07785cbb7028"
PRE_DIGEST="97af59843fd884d44432fec95a3e95ea"      # md5 of the sorted structure lines of public in production, 1320 lines, captured read-only on 2026-10-23
PRE_DIGEST_LINES=1320
SYNTH="${ENSAYO_SINTETICO:-0}"                       # 1 = rehearse THIS script on a throwaway database; refused against the production container
[ "$SYNTH" = 1 ] && { [ "$DB_CONTAINER" = supabase-db ] && { echo "REFUSED: ENSAYO_SINTETICO=1 with the production container"; exit 2; }
  SHA_MIG="${T_SHA_MIG:-$SHA_MIG}"; SHA_VERIFY="${T_SHA_VERIFY:-$SHA_VERIFY}"; PRE_DIGEST="${T_PRE_DIGEST:-$PRE_DIGEST}"; PRE_DIGEST_LINES="${T_PRE_DIGEST_LINES:-$PRE_DIGEST_LINES}"
  SHA_MATRIX_PROD="${T_SHA_MATRIX_PROD:-$SHA_MATRIX_PROD}"; echo "SYNTHETIC REHEARSAL on container $DB_CONTAINER (pins taken from T_* variables)"; }
MODE="${1:-}"; STAMP="$(date -u +%Y%m%dT%H%M%SZ)"; EVID="${EVID_DIR:-/opt/backups/supabase/evidence-076-$STAMP}"
PASS=0; FAIL=0; WAIT_MAX="${WAIT_MAX:-1800}"; QUIET_NEED="${QUIET_NEED:-60}"
mkdir -p "$EVID" && chmod 700 "$EVID" || { echo "cannot create $EVID"; exit 2; }
LOGF="$EVID/run.log"; say() { echo "$*" | tee -a "$LOGF"; }
res() { if [ "$2" = PASS ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi; say "PROD076-RESULT $1 $2 $3"; }
sha() { sha256sum "$1" 2>/dev/null | cut -d' ' -f1; }
# read-only psql (cannot write even by mistake) and write psql (only used by apply / rollback)
dbx() { docker exec -i "$@"; }
qro() { docker exec -i -e PGOPTIONS="-cdefault_transaction_read_only=on -cstatement_timeout=20000 -clock_timeout=2000" "$DB_CONTAINER" psql -U "$DB_USER" -h /var/run/postgresql -d "$DB_NAME" -X -A -t -v ON_ERROR_STOP=1 "$@"; }
qwr() { docker exec -i -e PGOPTIONS="-clock_timeout=3000 -cstatement_timeout=30000 -capplication_name=wacrm_mig076" "$DB_CONTAINER" psql -U "$DB_USER" -h /var/run/postgresql -d "$DB_NAME" -X -q -A -t -v ON_ERROR_STOP=1 "$@"; }
same() { [ -s "$1" ] && [ -s "$2" ] && cmp -s "$1" "$2"; }
need_ok() { [ -s "$1" ] || { res "$2" FAIL "no output"; return 1; }; }

digest_lines() { qro < "$HERE/digest-estructura.sql" | LC_ALL=C sort; }                       # the sorted structure lines of public
filter_new() { grep -v -E -f "$EVID/allowed.regex"; }                                      # drops the objects that belong to 076
matrix_now() { qro < "$MATRIX_SQL" | LC_ALL=C sort; }
data_fp() { qro < "$HERE/huella-datos.sql"; }                                              # 4 lines: hash of every ORIGINAL column of the 4 audio tables
counts_now() { qro -c "SELECT (SELECT count(*) FROM public.audio_guide_products)||'/'||(SELECT count(*) FROM public.audio_guide_items)||'/'||(SELECT count(*) FROM public.audio_guide_requests)||'/'||(SELECT count(*) FROM public.audio_guide_sends)"; }
state076() { qro -c "SELECT (to_regclass('public.audio_guide_purposes') IS NOT NULL)::int || '/' || (to_regclass('public.audio_guide_identifiers') IS NOT NULL)::int
  || '/' || (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('audio_guide_save_purpose','audio_guide_save_identifier','audio_guide_delete_purpose','audio_guide_delete_identifier','audio_guide_classify_item','audio_guide_open_selected_request','audio_guide_record_selected_skip'))
  || '/' || (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('audio_guide_items','audio_guide_requests') AND column_name IN ('purpose_id','identifier_id','selection_mode','purpose_name','identifier_name','node_key'))"; }
# state076 -> tables / tables / functions / columns:  absent = 0/0/0/0   applied = 1/1/7/8   anything else = partial
blockers_now() { qro -c "SELECT count(*) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND datname = current_database() AND (state = 'idle in transaction' OR (xact_start IS NOT NULL AND now() - xact_start > interval '30 seconds' AND state <> 'idle'))"; }
app_healthy() { [ -z "$APP" ] || [ "$(docker inspect -f '{{.State.Health.Status}}' "$APP" 2>/dev/null)" = healthy ]; }

# backup_check DUMP [first] : 0 only when DUMP exists, is recent, is intact (SHA-256 equals its .sha256 file, its restore-ok record and - after the first
# validation - the SHA-256 recorded then) and its restore test is approved (8 criteria). Sets BK_MSG (reason) and BK_SHA. Reads files only.
backup_check() {
  local dump="$1" first="${2:-}" okf age max shaf shac shaok okk kvname kvsha ref refname refsha
  okf="$dump.restore-ok"; shaf="$dump.sha256"; BK_SHA=""
  [ -f "$dump" ] || { BK_MSG="backup file is missing: $(basename "$dump")"; return 1; }
  [ -f "$shaf" ] && [ -f "$okf" ] || { BK_MSG="the .sha256 or .restore-ok evidence of $(basename "$dump") is missing"; return 1; }
  age=$(( $(date +%s) - $(stat -c %Y "$dump") )); max=$(( BACKUP_MAX_MIN * 60 )); [ "$SYNTH" = 1 ] && [ -n "${T_BACKUP_MAX_SEC:-}" ] && max="$T_BACKUP_MAX_SEC"
  [ "$age" -le "$max" ] || { BK_MSG="backup $(basename "$dump") EXPIRED: ${age}s old (max ${max}s)"; return 1; }
  shac="$(sha "$dump")"; BK_SHA="$shac"; shaok="$(cut -d' ' -f1 "$shaf")"
  [ "$shac" = "$shaok" ] || { BK_MSG="backup $(basename "$dump") SHA-256 does not match its .sha256 file (the file changed)"; return 1; }
  kvname="$(awk -F= '$1=="dump"{print $2}' "$okf")"; kvsha="$(awk -F= '$1=="sha256"{print $2}' "$okf")"
  { [ "$kvname" = "$(basename "$dump")" ] && [ "$kvsha" = "$shac" ]; } || { BK_MSG="the restore record does not describe this backup file"; return 1; }
  okk=$(awk -F= '$1=="ok"&&$2=="1"{a=1} $1=="restore_errors_unmatched"&&$2=="0"{b=1} $1=="catalog_mismatch"&&$2=="0"{c=1} $1=="extensions_match"&&$2=="1"{d=1} $1=="acl_rls_match"&&$2=="1"{e=1} $1=="counts_all_ok"&&$2=="1"{f=1} $1=="roles_missing"&&$2=="0"{g=1} $1=="restore_rc"&&($2=="0"||$2=="1"){h=1} END{print a+b+c+d+e+f+g+h}' "$okf" 2>/dev/null)
  [ "$okk" = 8 ] || { BK_MSG="the restore test of $(basename "$dump") is not approved ($okk/8 criteria)"; return 1; }
  if [ "$first" != first ]; then
    ref="$(cat "$EVID/backup.ref" 2>/dev/null)"; refname="${ref% *}"; refsha="${ref##* }"
    { [ "$dump" = "$refname" ] && [ "$shac" = "$refsha" ]; } || { BK_MSG="the backup is not the one validated at the start (path or SHA-256 differs)"; return 1; }
  fi
  BK_MSG="backup $(basename "$dump") is ${age}s old (max ${max}s), SHA-256 matches, restore test approved (8/8 criteria: catalog, extensions, ACL/RLS, counts, roles)"; return 0
}
gate_backup() {   # gate_backup LABEL : NO-GO (and nothing applied) unless the backup validated at the start is still valid
  [ "${REQUIRE_BACKUP:-0}" = 1 ] || return 0
  local dump; dump="$(awk '{print $1}' "$EVID/backup.ref" 2>/dev/null)"
  if backup_check "$dump"; then res "$1" PASS "$BK_MSG"; return 0; fi
  res "$1" FAIL "NO-GO: $BK_MSG - nothing was applied"; return 1
}

# ======================================================================================================================================================
preflight() {
  # PF01 the exact files that were reviewed and rehearsed
  local bad=""; for pair in "$MIG:$SHA_MIG" "$VERIFY:$SHA_VERIFY" "$ROLLBACK_SQL:$SHA_ROLLBACK" "$MATRIX_SQL:$SHA_MATRIX_SQL" "$MATRIX_PROD:$SHA_MATRIX_PROD" "$HERE/digest-estructura.sql:$SHA_DIGEST_SQL" "$HERE/huella-datos.sql:$SHA_DATA_SQL" "$HERE/permitidos-076.regex:$SHA_ALLOWED"; do
    [ "$(sha "${pair%%:*}")" = "${pair##*:}" ] || bad="$bad $(basename "${pair%%:*}")"; done
  [ -z "$bad" ] && res PF01 PASS "migration, verifier, rollback, matrix (query and production export), digest and data-hash queries and allow-list have the reviewed SHA-256" || { res PF01 FAIL "SHA-256 differs:$bad"; return 1; }
  cp "$HERE/permitidos-076.regex" "$EVID/allowed.regex"
  # PF02 the target is the real database server and can be written to
  local ident; ident="$(qro -c "SELECT current_database()||'|'||current_user||'|'||(pg_is_in_recovery())::text||'|'||current_setting('server_version_num')::int/10000||'|'||current_setting('transaction_read_only')" 2>"$EVID/pf02.err")"
  [ "$ident" = "postgres|supabase_admin|false|17|on" ] && res PF02 PASS "container $DB_CONTAINER: database postgres, user supabase_admin, PostgreSQL 17, primary (not a replica)" || { res PF02 FAIL "unexpected server identity: $ident"; return 1; }
  # PF03 076 absent, 075 present
  local st; st="$(state076)"; local p75; p75="$(qro -c "SELECT (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('audio_guide_open_request','audio_guide_claim_next_send','audio_guide_record_skip','audio_guide_halt_request','audio_guide_recoverable_requests','audio_guide_lock_product'))||'/'||(SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' AND relname IN ('audio_guide_products','audio_guide_items','audio_guide_requests','audio_guide_sends'))")"
  [ "$st" = "0/0/0/0" ] && [ "$p75" = "6/4" ] && res PF03 PASS "076 is completely absent (0 tables, 0 functions, 0 columns) and 073-075 are present (6 functions, 4 tables)" || { res PF03 FAIL "state of 076 is '$st' (expected 0/0/0/0) or 073-075 incomplete ($p75, expected 6/4)"; return 1; }
  # PF04 the structure is the one that was rehearsed
  digest_lines > "$EVID/pre.struct"; need_ok "$EVID/pre.struct" PF04 || return 1
  local d n; d="$(md5sum < "$EVID/pre.struct" | cut -c1-32)"; n="$(wc -l < "$EVID/pre.struct")"
  [ "$d" = "$PRE_DIGEST" ] && [ "$n" = "$PRE_DIGEST_LINES" ] && res PF04 PASS "structure of schema public equals the approved one ($n lines, digest $d)" || { res PF04 FAIL "structure changed since the approval ($n lines, digest $d, expected $PRE_DIGEST_LINES / $PRE_DIGEST)"; return 1; }
  # PF05 the privileges are the ones of the rehearsal's reference
  matrix_now > "$EVID/pre.matrix"; need_ok "$EVID/pre.matrix" PF05 || return 1
  same "$MATRIX_PROD" "$EVID/pre.matrix" && res PF05 PASS "client privileges (anon/authenticated/service_role) equal the exported reference: $(wc -l < "$EVID/pre.matrix") objects" || { res PF05 FAIL "privileges differ from the reference:"; diff "$MATRIX_PROD" "$EVID/pre.matrix" | cut -c1-200 | head -8 | tee -a "$LOGF"; return 1; }
  # PF06 the data is the one that was rehearsed
  local c; c="$(counts_now)"; data_fp > "$EVID/pre.data"; need_ok "$EVID/pre.data" PF06 || return 1
  [ "$c" = "$EXPECT_COUNTS" ] && [ "$(wc -l < "$EVID/pre.data")" = 4 ] && res PF06 PASS "audio catalogue counts (products/audios/requests/sends) = $c, as approved" || { res PF06 FAIL "counts are $c, approved $EXPECT_COUNTS: the rehearsal no longer describes production"; return 1; }
  # PF07 nobody holds the tables
  local b; b="$(blockers_now)"; [ "$b" = 0 ] && res PF07 PASS "no idle-in-transaction session and no transaction older than 30 s" || { res PF07 FAIL "$b blocking session(s)"; return 1; }
  # PF08 capacity and application
  local conn pct disk; conn="$(qro -c "SELECT round(100.0*count(*)/current_setting('max_connections')::int) FROM pg_stat_activity")"; disk="$(df -BG --output=avail /var/lib/docker | tail -1 | tr -dc 0-9)"
  { [ "${conn:-100}" -lt 80 ] && [ "${disk:-0}" -ge 10 ]; } && res PF08 PASS "connections ${conn}% of max, ${disk} GB free" || { res PF08 FAIL "connections ${conn}% (max 80) or disk ${disk} GB (min 10)"; return 1; }
  if [ -n "$APP" ]; then
    local img rc; img="$(docker inspect -f '{{.Config.Image}}' "$APP" 2>/dev/null)"; rc="$(docker inspect -f '{{.RestartCount}}' "$APP" 2>/dev/null)"
    [ "$img" = "$EXPECT_IMAGE" ] && app_healthy && [ "$rc" = 0 ] && res PF09 PASS "application $APP runs $img, healthy, 0 restarts" || { res PF09 FAIL "application is '$img', health '$(docker inspect -f '{{.State.Health.Status}}' "$APP" 2>/dev/null)', restarts '$rc'"; return 1; }
    echo "$rc" > "$EVID/app.restarts"
  else res PF09 PASS "(synthetic rehearsal: no application container)"; fi
  # PF10 a verified backup of the WHOLE database, recent. The file chosen here is the one revalidated later (BK1/BK2).
  if [ "$SYNTH" = 1 ] && [ "${T_REQUIRE_BACKUP:-0}" != 1 ]; then res PF10 PASS "(synthetic rehearsal: backup check skipped)"; else
    local newest; newest="$(ls -t "$BACKUP_DIR"/wacrm_pre_audios_*.dump 2>/dev/null | head -1)"
    [ -n "$newest" ] || { res PF10 FAIL "no wacrm_pre_audios_*.dump in $BACKUP_DIR"; return 1; }
    BK_DUMP="$newest"
    if backup_check "$BK_DUMP" first; then res PF10 PASS "$BK_MSG"; else res PF10 FAIL "$BK_MSG"; return 1; fi
    printf '%s %s\n' "$BK_DUMP" "$BK_SHA" > "$EVID/backup.ref"; cp "$BK_DUMP.sha256" "$BK_DUMP.restore-ok" "$EVID/" 2>/dev/null
  fi
  return 0
}

verify_post() {   # read-only post-conditions; needs $EVID/pre.struct, pre.matrix, pre.data (written by preflight)
  local st; st="$(state076)"
  [ "$st" = "1/1/7/8" ] && res V01 PASS "076 is present: 2 tables, 7 functions, 8 columns" || { res V01 FAIL "state of 076 is $st (expected 1/1/7/8)"; return 1; }
  qro < "$VERIFY" >/dev/null 2>"$EVID/verify-schema.err" && res V02 PASS "supabase/ci/verify-schema.sql accepts the production schema (includes the 076 checks: service-role-only functions, grants, unique index, RLS)" || { res V02 FAIL "verify-schema.sql rejected the schema"; cut -c1-220 "$EVID/verify-schema.err" | head -3 | tee -a "$LOGF"; return 1; }
  digest_lines > "$EVID/post.struct"; need_ok "$EVID/post.struct" V03 || return 1
  LC_ALL=C comm -23 "$EVID/pre.struct" "$EVID/post.struct" > "$EVID/removed"; LC_ALL=C comm -13 "$EVID/pre.struct" "$EVID/post.struct" > "$EVID/added"; filter_new < "$EVID/added" > "$EVID/unexpected"
  { [ ! -s "$EVID/removed" ] && [ -s "$EVID/added" ] && [ ! -s "$EVID/unexpected" ]; } && res V03 PASS "nothing that existed was removed or changed; only 076's objects were added ($(wc -l < "$EVID/added") structure lines)" || { res V03 FAIL "structure comparison: removed=$(wc -l < "$EVID/removed") unexpected=$(wc -l < "$EVID/unexpected")"; head -5 "$EVID/removed" "$EVID/unexpected" | cut -c1-200 | tee -a "$LOGF"; return 1; }
  data_fp > "$EVID/post.data"; same "$EVID/pre.data" "$EVID/post.data" && res V04 PASS "every original column of products, audios, requests and sends is byte-identical (4 hashes)" || { res V04 FAIL "original data changed"; return 1; }
  matrix_now > "$EVID/post.matrix"; need_ok "$EVID/post.matrix" V05 || return 1
  [ -z "$(LC_ALL=C comm -23 "$EVID/pre.matrix" "$EVID/post.matrix")" ] && res V05 PASS "every client privilege that existed is unchanged ($(LC_ALL=C comm -13 "$EVID/pre.matrix" "$EVID/post.matrix" | wc -l) new objects, all reviewed by verify-schema.sql)" || { res V05 FAIL "an existing privilege changed"; LC_ALL=C comm -23 "$EVID/pre.matrix" "$EVID/post.matrix" | head -5 | cut -c1-200 | tee -a "$LOGF"; return 1; }
  local fresh; fresh="$(qro -c "SELECT (SELECT count(*) FROM public.audio_guide_purposes)||'/'||(SELECT count(*) FROM public.audio_guide_identifiers)||'/'||(SELECT count(*) FROM public.audio_guide_items WHERE purpose_id IS NOT NULL OR identifier_id IS NOT NULL)||'/'||(SELECT count(*) FROM public.audio_guide_requests WHERE selection_mode IS NOT NULL OR purpose_id IS NOT NULL OR identifier_id IS NOT NULL OR purpose_name IS NOT NULL OR identifier_name IS NOT NULL OR node_key IS NOT NULL)")"
  [ "$fresh" = "0/0/0/0" ] && res V06 PASS "new tables empty and every new column NULL" || { res V06 FAIL "new objects are not empty ($fresh)"; return 1; }
  return 0
}

observe() {   # the running application must not notice: health, restarts, errors that mention the audio modules
  [ -n "$APP" ] || { res V07 PASS "(synthetic rehearsal: no application to observe)"; return 0; }
  local since rc0 bad=0 errs=0 n; since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; rc0="$(cat "$EVID/app.restarts" 2>/dev/null || echo 0)"
  for n in $(seq 1 20); do sleep 15
    app_healthy || bad=1; [ "$(docker inspect -f '{{.RestartCount}}' "$APP")" = "$rc0" ] || bad=1
    errs=$(docker logs --since "$since" "$APP" 2>&1 | grep -c -i -E 'audio[-_ ]?guide|product-audios|PGRST|42703|42883' || true)
    [ "$errs" = 0 ] || bad=1
    [ "$bad" = 0 ] || break
  done
  [ "$bad" = 0 ] && res V07 PASS "5 minutes of observation: application healthy, no restart, no log line about the audio modules or missing columns/functions" || res V07 FAIL "the application showed a problem during observation (health/restart/log: errors=$errs)"
  [ "$bad" = 0 ]
}

manifest() { ( cd "$EVID" && rm -f MANIFEST.sha256 && find . -maxdepth 1 -type f ! -name MANIFEST.sha256 -printf '%f\n' | LC_ALL=C sort | xargs -r sha256sum > MANIFEST.sha256; true ); }

wait_quiet() {
  local quiet=0 start now runs bots; start=$(date +%s)
  while :; do
    now=$(date +%s); [ $((now-start)) -gt "$WAIT_MAX" ] && { say "ABORT: no quiet gap in $WAIT_MAX s; nothing was changed"; return 1; }
    runs="$(qro -c "SELECT count(*) FROM public.flow_runs WHERE status='active' AND wait_until IS NULL AND last_advanced_at > now() - interval '180 seconds'")"
    bots="$(qro -c "SELECT count(*) FROM public.messages WHERE sender_type='bot' AND created_at > now() - interval '20 seconds'")"
    if [ "$runs" = 0 ] && [ "$bots" = 0 ] && app_healthy; then quiet=$((quiet+5)); else quiet=0; fi
    say "$(date -u +%T) runs=$runs bots=$bots quiet=${quiet}s"
    [ "$quiet" -ge "$QUIET_NEED" ] && { say "QUIET GAP OK at $(date -u +%T)"; return 0; }
    sleep 5
  done
}

run_sql_file() {  # run_sql_file FILE LABEL [single-transaction]  -> up to 3 attempts, only for lock/deadlock/serialisation errors
  local f="$1" label="$2" tx="${3:-1}" attempt rc code b; local -a waits=(0 20 60)
  for attempt in 1 2 3; do
    [ "${waits[$((attempt-1))]}" -gt 0 ] && { say "retry in ${waits[$((attempt-1))]} s"; sleep "${waits[$((attempt-1))]}"; }
    gate_backup "BK-attempt$attempt" || return 4        # revalidate the backup before EVERY attempt (apply mode only)
    b="$(blockers_now)"; if [ "$b" != 0 ]; then say "attempt $attempt: $b blocking session(s); not trying"; code=blockers; continue; fi
    if [ "$tx" = 1 ]; then qwr -1 < "$f" > "$EVID/$label-attempt$attempt.out" 2> "$EVID/$label-attempt$attempt.err"; else qwr < "$f" > "$EVID/$label-attempt$attempt.out" 2> "$EVID/$label-attempt$attempt.err"; fi
    rc=$?; say "attempt $attempt: psql rc=$rc"
    [ "$rc" = 0 ] && return 0
    code="$(grep -o -E 'ERROR:  [0-9A-Z]{5}|ERROR:  .*' "$EVID/$label-attempt$attempt.err" | head -1)"
    if grep -q -E '55P03|40P01|40001|lock timeout|deadlock|could not obtain lock|could not serialize' "$EVID/$label-attempt$attempt.err"; then say "retryable: ${code:-lock}"; else say "NON-RETRYABLE error: $(head -c 300 "$EVID/$label-attempt$attempt.err" | tr '\n' ' ')"; return 2; fi
  done
  say "lock/blockers persisted for 3 attempts; nothing was applied"; return 3
}

# ======================================================================================================================================================
case "$MODE" in
  preflight)
    say "== preflight 076 - $STAMP - container $DB_CONTAINER"
    preflight; rc=$?; say "---- $PASS PASS, $FAIL FAIL"; [ $rc -eq 0 ] && [ "$FAIL" -eq 0 ] && say "PREFLIGHT 076 PASS (evidence: $EVID)" || say "PREFLIGHT 076 FAIL (evidence: $EVID)"; manifest; exit $((rc || FAIL > 0));;
  verify)
    say "== verify 076 - $STAMP"
    [ -s "$EVID/pre.struct" ] || { # standalone verify: build the "before" reference from the approved pins is impossible, so only the absolute checks run
      st="$(state076)"; [ "$st" = "1/1/7/8" ] && res V01 PASS "076 present" || res V01 FAIL "state $st"
      qro < "$VERIFY" >/dev/null 2>&1 && res V02 PASS "verify-schema.sql accepts the schema" || res V02 FAIL "verify-schema.sql rejected the schema"
      f="$(qro -c "SELECT count(*) FROM public.audio_guide_purposes")"; say "purposes: $f"; say "---- $PASS PASS, $FAIL FAIL"; exit $((FAIL > 0)); }
    verify_post; rc=$?; say "---- $PASS PASS, $FAIL FAIL"; manifest; exit $((rc || FAIL > 0));;
  apply)
    [ "${CONFIRM_APPLY_076:-}" = yes ] || { echo "REFUSED: set CONFIRM_APPLY_076=yes (explicit authorisation required)"; exit 2; }
    say "== APPLY 076 - $STAMP - container $DB_CONTAINER"
    preflight || { manifest; say "PREFLIGHT FAILED: nothing was changed"; exit 1; }
    [ "$FAIL" -eq 0 ] || { manifest; say "PREFLIGHT FAILED: nothing was changed"; exit 1; }
    wait_quiet || { manifest; exit 1; }
    preflight_again_pre="$(md5sum < "$EVID/pre.struct" | cut -c1-32)"; cur="$(digest_lines | md5sum | cut -c1-32)"
    [ "$cur" = "$preflight_again_pre" ] && [ "$(state076)" = "0/0/0/0" ] || { say "ABORT: the schema changed while waiting; nothing was changed"; manifest; exit 1; }
    REQUIRE_BACKUP=1; [ "$SYNTH" = 1 ] && [ "${T_REQUIRE_BACKUP:-0}" != 1 ] && REQUIRE_BACKUP=0
    gate_backup BK1 || { st="$(state076)"; say "NO-GO: the backup is no longer valid after the wait; state of 076: $st (nothing was changed)"; manifest; exit 3; }
    say "APPLYING at $(date -u +%T)"
    t0=$(date +%s.%N); run_sql_file "$MIG" mig076 1; arc=$?; dur=$(awk -v a="$(date +%s.%N)" -v b="$t0" 'BEGIN{printf "%.2f", a-b}')
    if [ $arc -eq 4 ]; then
      st="$(state076)"; say "NO-GO: the backup stopped being valid between attempts; state of 076: $st"
      [ "$st" = "0/0/0/0" ] && res A01 PASS "aborted before any change: the database is exactly as it was" || res A01 FAIL "PARTIAL STATE $st - STOP and ask a human"; say "---- $PASS PASS, $FAIL FAIL"; manifest; exit 3
    fi
    if [ $arc -ne 0 ]; then
      st="$(state076)"; say "migration did NOT complete (code $arc); state of 076 now: $st (a failed single transaction leaves 0/0/0/0)"
      [ "$st" = "0/0/0/0" ] && res A01 PASS "the failed attempt left the database exactly as it was" || res A01 FAIL "PARTIAL STATE $st - STOP and ask a human"; manifest; exit 1
    fi
    res A01 PASS "076 applied in one transaction in ${dur} s"
    verify_post; vrc=$?
    observe; orc=$?
    say "---- $PASS PASS, $FAIL FAIL"
    if [ $vrc -eq 0 ] && [ $orc -eq 0 ] && [ "$FAIL" -eq 0 ]; then say "APPLY 076 PASS (evidence: $EVID)"; manifest; exit 0; fi
    say "APPLY 076 FAIL after the migration committed. The schema is additive: DO NOT roll back by reflex. Read $EVID/run.log, then decide (see the plan)."; manifest; exit 1;;
  rollback)
    [ "${CONFIRM_ROLLBACK_076:-}" = yes ] || { echo "REFUSED: set CONFIRM_ROLLBACK_076=yes (explicit authorisation required)"; exit 2; }
    say "== ROLLBACK 076 - $STAMP - container $DB_CONTAINER"
    cp "$HERE/permitidos-076.regex" "$EVID/allowed.regex"
    [ "$(sha "$ROLLBACK_SQL")" = "$SHA_ROLLBACK" ] && res R01 PASS "rollback-076.sql has the reviewed SHA-256" || { res R01 FAIL "rollback-076.sql SHA-256 differs"; exit 1; }
    [ "$(state076)" = "1/1/7/8" ] && res R02 PASS "076 is fully applied" || { res R02 FAIL "076 is not in the expected applied state: $(state076)"; exit 1; }
    held="$(qro -c "SELECT (SELECT count(*) FROM public.audio_guide_purposes)||'/'||(SELECT count(*) FROM public.audio_guide_identifiers)||'/'||(SELECT count(*) FROM public.audio_guide_items WHERE purpose_id IS NOT NULL OR identifier_id IS NOT NULL)||'/'||(SELECT count(*) FROM public.audio_guide_requests WHERE selection_mode IS NOT NULL OR purpose_id IS NOT NULL OR identifier_id IS NOT NULL OR node_key IS NOT NULL)")"
    [ "$held" = "0/0/0/0" ] && res R03 PASS "nothing would be lost: 0 purposes, 0 identifiers, 0 classified audios, 0 selective requests" || { res R03 FAIL "ROLLBACK FORBIDDEN: data exists (purposes/identifiers/classified audios/selective requests = $held). Leave the schema in place (it is additive) and roll back the application image instead."; manifest; exit 1; }
    digest_lines > "$EVID/pre-rollback.struct"; data_fp > "$EVID/pre-rollback.data"; wait_quiet || { manifest; exit 1; }
    run_sql_file "$ROLLBACK_SQL" rollback076 0; rrc=$?
    [ $rrc -eq 0 ] || { say "rollback did not complete (code $rrc); state of 076: $(state076)"; manifest; exit 1; }
    digest_lines > "$EVID/post-rollback.struct"; data_fp > "$EVID/post-rollback.data"; matrix_now > "$EVID/post-rollback.matrix"
    d="$(md5sum < "$EVID/post-rollback.struct" | cut -c1-32)"; n="$(wc -l < "$EVID/post-rollback.struct")"
    { [ "$d" = "$PRE_DIGEST" ] && [ "$n" = "$PRE_DIGEST_LINES" ]; } && res R04 PASS "structure equals the approved pre-076 structure again ($n lines, digest $d)" || res R04 FAIL "structure after rollback differs from the pre-076 one ($n lines, $d)"
    same "$EVID/pre-rollback.data" "$EVID/post-rollback.data" && res R05 PASS "original data unchanged by the rollback" || res R05 FAIL "original data changed"
    same "$MATRIX_PROD" "$EVID/post-rollback.matrix" && res R06 PASS "client privileges equal the production reference again" || res R06 FAIL "privileges differ from the reference"
    [ "$(state076)" = "0/0/0/0" ] && res R07 PASS "076 is absent again" || res R07 FAIL "076 not fully removed: $(state076)"
    say "---- $PASS PASS, $FAIL FAIL"; [ "$FAIL" -eq 0 ] && say "ROLLBACK 076 PASS" || say "ROLLBACK 076 FAIL"; manifest; exit $((FAIL > 0));;
  *) echo "usage: $0 preflight | apply | verify | rollback"; exit 2;;
esac
