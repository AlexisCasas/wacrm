#!/usr/bin/env bash
# Throwaway-database test of the backup revalidation added in aplicar-076-v2.sh. Synthetic backups (random bytes + the same evidence files the real
# script writes) in a temp folder; schema built from migrations 001..075; --network none; destroyed on exit. Never touches supabase-db (the script under
# test refuses ENSAYO_SINTETICO=1 against it). Proves: valid backup continues; a backup that expires / changes / loses its evidence during the wait or
# between attempts is a NO-GO that changes nothing; rollback is NOT blocked by an old backup.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; QA="$HERE/.."; MIGDIR="${MIG076_DIR:-/opt/apps/wacrm-audios-sel1/supabase/migrations}"
IMAGE="${ENSAYO_PG_IMAGE:-supabase/postgres:17.6.1.136}"; NAME="bk076-test-$$-$RANDOM"; W="$(mktemp -d)"; PASS=0; FAIL=0; BGS=""
cleanup() { for pid in ${BGS:-}; do kill "$pid" 2>/dev/null; done; rm -rf "$W"; docker rm -f "$NAME" >/dev/null 2>&1 || true; }; trap cleanup EXIT
res() { if [ "$2" = PASS ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi; echo "BKTEST-RESULT $1 $2 $3"; }
p() { docker exec -i -e PGOPTIONS="-c client_min_messages=warning" "$NAME" psql -U supabase_admin -h /var/run/postgresql -d postgres -X -q -A -t -v ON_ERROR_STOP=1 "$@"; }
st() { p -c "SELECT (to_regclass('public.audio_guide_purposes') IS NOT NULL)::int || '/' || (SELECT count(*) FROM pg_proc WHERE proname IN ('audio_guide_save_purpose','audio_guide_open_selected_request'))"; }
docker run -d --name "$NAME" --network none --label wacrm.ensayo=076-selftest --pull never -e POSTGRES_PASSWORD=t "$IMAGE" >/dev/null || { echo "ABORT: container"; exit 2; }
ok=0; for _ in $(seq 1 120); do sleep 1; l="$(docker logs "$NAME" 2>&1)"; grep -q 'init process complete' <<<"$l" && [ "$(grep -c 'ready to accept' <<<"$l")" -ge 2 ] && p -c 'select 1' >/dev/null 2>&1 && { ok=1; break; }; done
[ "$ok" = 1 ] || { echo "ABORT: db not ready"; exit 2; }
p < "$QA/../flows-safe-save/bootstrap.sql" >/dev/null || exit 2
for f in "$MIGDIR"/*.sql; do [ "$(basename "$f" | cut -c1-3)" -le 75 ] && { p < "$f" >/dev/null 2>"$W/m.err" || { echo "ABORT migration $f"; head -2 "$W/m.err"; exit 2; }; }; done
p >/dev/null <<'SQL'
SET session_replication_role = replica;
INSERT INTO public.audio_guide_products (id, account_id, product_key, display_name) SELECT gen_random_uuid(), 'a0000000-0000-4000-8000-000000000001', 'producto ' || n, 'Producto ' || n FROM generate_series(1, 3) n;
INSERT INTO public.audio_guide_items (account_id, product_id, position, voice_sha256, voice_path, bytes, duration_ms, pre_delay_seconds)
SELECT account_id, id, 1, md5(product_key) || md5(product_key || 'x'), 'account-' || account_id || '/' || md5(product_key) || md5(product_key || 'x') || '.ogg', 1000, 5000, 5 FROM public.audio_guide_products;
SQL
p < "$HERE/digest-estructura.sql" | LC_ALL=C sort > "$W/d.txt"; p < "$QA/matriz-permisos.sql" | LC_ALL=C sort > "$W/matrix-ref.txt"
export ENSAYO_SINTETICO=1 T_REQUIRE_BACKUP=1 DB_CONTAINER="$NAME" APP_CONTAINER="" MATRIX_PROD="$W/matrix-ref.txt" T_SHA_MATRIX_PROD="$(sha256sum "$W/matrix-ref.txt" | cut -d' ' -f1)" \
  T_PRE_DIGEST="$(md5sum < "$W/d.txt" | cut -c1-32)" T_PRE_DIGEST_LINES="$(wc -l < "$W/d.txt")" EXPECT_COUNTS="3/3/0/0" MIG076="$MIGDIR/076_audio_guide_selection.sql" WAIT_MAX=120
S="${APLICAR:-$HERE/aplicar-076-v2.sh}"; BKD="$W/bk"
mkbk() { # mkbk AGE_SECONDS : a synthetic backup with the evidence files the real script produces
  rm -rf "$BKD"; mkdir -p "$BKD"; local f="$BKD/wacrm_pre_audios_T.dump"; head -c 300000 /dev/urandom > "$f"; local h; h="$(sha256sum "$f" | cut -d' ' -f1)"
  echo "$h  wacrm_pre_audios_T.dump" > "$f.sha256"
  printf 'ok=1\ncreated=x\ndump=wacrm_pre_audios_T.dump\nsha256=%s\nroles_dump=r.sql\nrestore_rc=1\nrestore_errors_total=20\nrestore_errors_unmatched=0\nrestore_stderr_foreign=0\ncatalog_mismatch=0\nextensions_match=1\nacl_rls_match=1\nroles_missing=0\ncounts_all_ok=1\n' "$h" > "$f.restore-ok"
  touch -d "-$1 seconds" "$f"; }
run() { local tag="$1"; shift; EVID_DIR="$W/ev-$tag" BACKUP_DIR="$BKD" bash "$S" "$@" > "$W/out-$tag.txt" 2>&1; echo $?; }
nogo() { # nogo TAG RC EXPECTED-TEXT
  [ "$2" = 3 ] && grep -q "NO-GO" "$W/out-$1.txt" && grep -q "$3" "$W/out-$1.txt" && [ "$(st)" = "0/0" ]; }

# B1: an expired backup stops the PRE-FLIGHT
mkbk 4000; export BACKUP_DIR="$BKD" T_BACKUP_MAX_SEC=600
r=$(run b1 preflight); [ "$r" != 0 ] && grep -q 'PF10 FAIL.*EXPIRED' "$W/out-b1.txt" && res B01 PASS "an expired backup fails PF10 (preflight)" || res B01 FAIL "expired backup not detected at preflight"
# B2: valid at the start, expires WHILE waiting for the quiet gap (QUIET_NEED=60 s > 40 s of validity)
mkbk 2; T_BACKUP_MAX_SEC=40 QUIET_NEED=60; export T_BACKUP_MAX_SEC QUIET_NEED
r=$(CONFIRM_APPLY_076=yes run b2 apply); nogo b2 "$r" 'EXPIRED' && grep -q 'BK1 FAIL' "$W/out-b2.txt" && ! grep -q 'APPLYING' "$W/out-b2.txt" && res B02 PASS "a backup that expired during the wait is a NO-GO before the SQL starts (exit 3, schema unchanged, 'APPLYING' never printed)" || { res B02 FAIL "expiry during the wait not blocked"; tail -4 "$W/out-b2.txt"; }
# B3: valid for attempt 1, a held lock forces a retry, the backup expires during the 20 s back-off -> attempt 2 must not start
mkbk 2; T_BACKUP_MAX_SEC=22 QUIET_NEED=5; export T_BACKUP_MAX_SEC QUIET_NEED
( docker exec -i "$NAME" psql -U supabase_admin -h /var/run/postgresql -d postgres -X -q -c "BEGIN; LOCK TABLE public.audio_guide_items IN SHARE MODE; SELECT pg_sleep(60); COMMIT;" >/dev/null 2>&1 ) & BGS="$BGS $!"; sleep 1
r=$(CONFIRM_APPLY_076=yes run b3 apply); wait 2>/dev/null
nogo b3 "$r" 'EXPIRED' && grep -q 'BK1 PASS' "$W/out-b3.txt" && grep -q 'BK-attempt1 PASS' "$W/out-b3.txt" && grep -q 'retryable' "$W/out-b3.txt" && grep -q 'BK-attempt2 FAIL' "$W/out-b3.txt" && ! grep -q 'attempt 2: psql' "$W/out-b3.txt" \
  && res B03 PASS "attempt 1 ran (lock timeout), the backup expired during the back-off, attempt 2 NEVER started (exit 3, schema unchanged)" || { res B03 FAIL "expiry between attempts not blocked"; grep -E 'BK|attempt|retry|NO-GO' "$W/out-b3.txt" | head -8; }
sleep 1
# B4-B7: the backup changes during the wait (generous age limit, short wait)
QUIET_NEED=20; T_BACKUP_MAX_SEC=3000; export QUIET_NEED T_BACKUP_MAX_SEC
mkbk 2; ( sleep 9; echo tampered >> "$BKD/wacrm_pre_audios_T.dump" ) & BGS="$BGS $!"; r=$(CONFIRM_APPLY_076=yes run b4 apply); wait 2>/dev/null
nogo b4 "$r" 'SHA-256 does not match' && res B04 PASS "a backup whose bytes changed during the wait is a NO-GO" || { res B04 FAIL "changed backup not blocked"; tail -3 "$W/out-b4.txt"; }
mkbk 2; ( sleep 9; rm -f "$BKD/wacrm_pre_audios_T.dump.restore-ok" ) & BGS="$BGS $!"; r=$(CONFIRM_APPLY_076=yes run b5 apply); wait 2>/dev/null
nogo b5 "$r" 'evidence of' && res B05 PASS "a backup that lost its restore evidence during the wait is a NO-GO" || { res B05 FAIL "missing evidence not blocked"; tail -3 "$W/out-b5.txt"; }
mkbk 2; ( sleep 9; mv "$BKD/wacrm_pre_audios_T.dump" "$BKD/moved" ) & BGS="$BGS $!"; r=$(CONFIRM_APPLY_076=yes run b6 apply); wait 2>/dev/null
nogo b6 "$r" 'missing' && res B06 PASS "a backup file that disappeared during the wait is a NO-GO" || { res B06 FAIL "missing backup not blocked"; tail -3 "$W/out-b6.txt"; }
mkbk 2; ( sleep 9; sed -i 's/^catalog_mismatch=0/catalog_mismatch=1/' "$BKD/wacrm_pre_audios_T.dump.restore-ok" ) & BGS="$BGS $!"; r=$(CONFIRM_APPLY_076=yes run b7 apply); wait 2>/dev/null
nogo b7 "$r" 'not approved' && res B07 PASS "a restore record that stopped being approved during the wait is a NO-GO" || { res B07 FAIL "unapproved restore not blocked"; tail -3 "$W/out-b7.txt"; }
mkbk 2; ( sleep 9; cp "$BKD/wacrm_pre_audios_T.dump" "$W/keep"; head -c 300000 /dev/urandom > "$BKD/wacrm_pre_audios_T.dump"; h=$(sha256sum "$BKD/wacrm_pre_audios_T.dump" | cut -d' ' -f1); echo "$h  wacrm_pre_audios_T.dump" > "$BKD/wacrm_pre_audios_T.dump.sha256"; sed -i "s/^sha256=.*/sha256=$h/" "$BKD/wacrm_pre_audios_T.dump.restore-ok" ) & BGS="$BGS $!"
r=$(CONFIRM_APPLY_076=yes run b8 apply); wait 2>/dev/null
nogo b8 "$r" 'not the one validated at the start' && res B08 PASS "a different backup swapped in consistently (new bytes, new hash, new record) is still refused: it is not the one validated at the start" || { res B08 FAIL "swapped backup accepted"; tail -3 "$W/out-b8.txt"; }
# B9: a valid backup lets the apply complete, with both revalidations recorded
mkbk 2; T_BACKUP_MAX_SEC=3000 QUIET_NEED=5; export T_BACKUP_MAX_SEC QUIET_NEED
r=$(CONFIRM_APPLY_076=yes run b9 apply)
[ "$r" = 0 ] && grep -q 'BK1 PASS' "$W/out-b9.txt" && grep -q 'BK-attempt1 PASS' "$W/out-b9.txt" && grep -q 'APPLY 076 PASS' "$W/out-b9.txt" && [ "$(st)" = "1/2" ] && res B09 PASS "a valid backup lets the apply continue: BK1 and BK-attempt1 PASS, all V01-V07 passed, 076 applied" || { res B09 FAIL "valid backup did not allow the apply"; grep -E 'FAIL|BK|NO-GO' "$W/out-b9.txt" | head -5; }
# B10: the rollback is NOT gated by the age of the backup (emergency rollback hours later must stay possible)
touch -d '-9999 seconds' "$BKD/wacrm_pre_audios_T.dump"; export T_BACKUP_MAX_SEC=60
r=$(CONFIRM_ROLLBACK_076=yes run b10 rollback)
[ "$r" = 0 ] && grep -q 'ROLLBACK 076 PASS' "$W/out-b10.txt" && [ "$(st)" = "0/0" ] && res B10 PASS "rollback works with an expired backup (not gated), restores the exact structure" || { res B10 FAIL "rollback was blocked or failed"; grep -E 'FAIL|ABORT' "$W/out-b10.txt" | head -4; }
echo "---- $PASS PASS, $FAIL FAIL"; [ "$FAIL" -eq 0 ] && echo "BACKUP REVALIDATION TEST PASS" || echo "BACKUP REVALIDATION TEST FAIL"; [ "$FAIL" -eq 0 ]
