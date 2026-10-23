#!/usr/bin/env bash
# REHEARSAL OF aplicar-076.sh ITSELF on a throwaway PostgreSQL (--network none, destroyed on exit), schema built from migrations 001..075. It never touches
# supabase-db: the script under test refuses ENSAYO_SINTETICO=1 against that container. Proves the procedure (preflight, apply, verify, observation,
# retries on lock timeout, refusal on every failed pin, guarded rollback, re-apply), not the data of production.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; QA="$HERE/.."; MIGDIR="${MIG076_DIR:-/opt/apps/wacrm-audios-sel1/supabase/migrations}"
IMAGE="${ENSAYO_PG_IMAGE:-supabase/postgres:17.6.1.136}"; NAME="aplicar076-test-$$-$RANDOM"; W="$(mktemp -d)"; PASS=0; FAIL=0
cleanup() { [ -n "${BG:-}" ] && kill "$BG" 2>/dev/null; rm -rf "$W"; docker rm -f "$NAME" >/dev/null 2>&1 || true; }; trap cleanup EXIT
res() { if [ "$2" = PASS ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi; echo "PROCTEST-RESULT $1 $2 $3"; }
p() { docker exec -i -e PGOPTIONS="-c client_min_messages=warning" "$NAME" psql -U supabase_admin -h /var/run/postgresql -d postgres -X -q -A -t -v ON_ERROR_STOP=1 "$@"; }
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
# pins for THIS throwaway database (what the real run takes from the reviewed constants)
p < "$HERE/digest-estructura.sql" | LC_ALL=C sort > "$W/d.txt"; p < "$QA/matriz-permisos.sql" | LC_ALL=C sort > "$W/matrix-ref.txt"
export ENSAYO_SINTETICO=1 DB_CONTAINER="$NAME" APP_CONTAINER="" MATRIX_PROD="$W/matrix-ref.txt" T_SHA_MATRIX_PROD="$(sha256sum "$W/matrix-ref.txt" | cut -d' ' -f1)" \
  T_PRE_DIGEST="$(md5sum < "$W/d.txt" | cut -c1-32)" T_PRE_DIGEST_LINES="$(wc -l < "$W/d.txt")" EXPECT_COUNTS="3/3/0/0" MIG076="$MIGDIR/076_audio_guide_selection.sql" QUIET_NEED=5 WAIT_MAX=90
S="${APLICAR:-$HERE/aplicar-076.sh}"; run() { local tag="$1"; shift; EVID_DIR="$W/ev-$tag" bash "$S" "$@" > "$W/out-$tag.txt" 2>&1; echo $?; }
st() { p -c "SELECT (to_regclass('public.audio_guide_purposes') IS NOT NULL)::int || '/' || (SELECT count(*) FROM pg_proc WHERE proname IN ('audio_guide_save_purpose','audio_guide_open_selected_request'))"; }

[ "$(run t1 preflight)" = 0 ] && grep -q 'PREFLIGHT 076 PASS' "$W/out-t1.txt" && res T01 PASS "preflight passes on a clean database ($(grep -c 'PROD076-RESULT PF.. PASS' "$W/out-t1.txt") checks)" || { res T01 FAIL "preflight failed"; tail -5 "$W/out-t1.txt"; }
[ "$(CONFIRM_APPLY_076=no run t2 apply)" != 0 ] && [ "$(st)" = "0/0" ] && res T02 PASS "apply without CONFIRM_APPLY_076=yes is refused and changes nothing" || res T02 FAIL "apply ran without confirmation"
# every pin that fails must stop BEFORE any change
r=$(T_PRE_DIGEST=00000000000000000000000000000000 run t3 preflight); [ "$r" != 0 ] && grep -q 'PF04 FAIL' "$W/out-t3.txt" && res T03 PASS "a changed structure digest fails PF04" || res T03 FAIL "digest mismatch not detected"
r=$(EXPECT_COUNTS=9/9/0/0 run t4 preflight); [ "$r" != 0 ] && grep -q 'PF06 FAIL' "$W/out-t4.txt" && res T04 PASS "different data counts fail PF06" || res T04 FAIL "count mismatch not detected"
r=$(T_SHA_MIG=0000 run t5 preflight); [ "$r" != 0 ] && grep -q 'PF01 FAIL' "$W/out-t5.txt" && res T05 PASS "a modified migration file fails PF01" || res T05 FAIL "file hash mismatch not detected"
r=$(MATRIX_PROD="$W/d.txt" T_SHA_MATRIX_PROD=$(sha256sum "$W/d.txt" | cut -d' ' -f1) run t6 preflight); [ "$r" != 0 ] && grep -q 'PF05 FAIL' "$W/out-t6.txt" && res T06 PASS "a different privilege reference fails PF05" || res T06 FAIL "privilege mismatch not detected"
( { printf 'BEGIN;\nSELECT 1;\n'; sleep 20; } | docker exec -i "$NAME" psql -U supabase_admin -h /var/run/postgresql -d postgres -X -q >/dev/null 2>&1 ) & BG=$!; sleep 3
r=$(run t7 preflight); [ "$r" != 0 ] && grep -q 'PF07 FAIL' "$W/out-t7.txt" && res T07 PASS "an idle-in-transaction session is reported by PF07" || res T07 FAIL "blocker not detected"
wait $BG 2>/dev/null; BG=""; sleep 1
# the real apply, while a session holds a lock for ~45 s: the first attempts must give up after 3 s (lock_timeout), retry, and finally succeed
( docker exec -i "$NAME" psql -U supabase_admin -h /var/run/postgresql -d postgres -X -q -c "BEGIN; LOCK TABLE public.audio_guide_items IN SHARE MODE; SELECT pg_sleep(45); COMMIT;" >/dev/null 2>&1 ) & BG=$!; sleep 2
r=$(CONFIRM_APPLY_076=yes run t8 apply); wait $BG 2>/dev/null; BG=""
grep -q 'retryable' "$W/out-t8.txt" && res T08 PASS "a held lock made the first attempt(s) give up after the 3 s lock timeout and retry ($(grep -c 'retryable' "$W/out-t8.txt") retry)" || res T08 FAIL "no lock-timeout retry observed"
[ "$r" = 0 ] && grep -q 'APPLY 076 PASS' "$W/out-t8.txt" && [ "$(st)" = "1/2" ] && res T09 PASS "apply completed, all post-conditions V01-V07 passed ($(grep -c 'PROD076-RESULT V.. PASS' "$W/out-t8.txt") of 7)" || { res T09 FAIL "apply did not complete"; grep -E 'FAIL|ABORT|NON-RETRY|retry' "$W/out-t8.txt" | head -6; }
[ "$(run t10 preflight)" != 0 ] && grep -q 'PF03 FAIL' "$W/out-t10.txt" && res T10 PASS "preflight refuses to run again once 076 is present (single use)" || res T10 FAIL "preflight accepted an applied database"
# rollback: refused without confirmation, refused when data exists, exact when empty
[ "$(CONFIRM_ROLLBACK_076=no run t11 rollback)" != 0 ] && [ "$(st)" = "1/2" ] && res T11 PASS "rollback without CONFIRM_ROLLBACK_076=yes is refused" || res T11 FAIL "rollback ran without confirmation"
p >/dev/null <<'SQL'
SET session_replication_role = replica;
INSERT INTO public.accounts (id, name, owner_user_id) VALUES ('a0000000-0000-4000-8000-000000000001', 'stub', gen_random_uuid());
SET session_replication_role = origin;
SELECT public.audio_guide_save_purpose('a0000000-0000-4000-8000-000000000001'::uuid, NULL, 'Presentacion', 'presentacion', true);
SQL
[ "$(p -c "SELECT count(*) FROM public.audio_guide_purposes")" = 1 ] || { echo "ABORT: could not create the test purpose"; exit 2; }
r=$(CONFIRM_ROLLBACK_076=yes run t12 rollback); [ "$r" != 0 ] && grep -q 'ROLLBACK FORBIDDEN' "$W/out-t12.txt" && [ "$(st)" = "1/2" ] && res T12 PASS "rollback is FORBIDDEN once a purpose exists (nothing removed)" || res T12 FAIL "rollback ran with data present"
p -c "DELETE FROM public.audio_guide_purposes" >/dev/null && p -c "SET session_replication_role = replica; DELETE FROM public.accounts WHERE name = 'stub'" >/dev/null
r=$(CONFIRM_ROLLBACK_076=yes run t13 rollback); [ "$r" = 0 ] && grep -q 'ROLLBACK 076 PASS' "$W/out-t13.txt" && [ "$(st)" = "0/0" ] && res T13 PASS "with no new data the rollback restores the exact structure, data and privileges ($(grep -c 'PROD076-RESULT R.. PASS' "$W/out-t13.txt") of 7 checks)" || { res T13 FAIL "rollback did not restore"; grep -E 'FAIL|ABORT' "$W/out-t13.txt" | head -5; }
r=$(CONFIRM_APPLY_076=yes run t14 apply); [ "$r" = 0 ] && [ "$(st)" = "1/2" ] && res T14 PASS "after a rollback, apply works again" || res T14 FAIL "second apply failed"
[ -s "$W/ev-t8/MANIFEST.sha256" ] && (cd "$W/ev-t8" && sha256sum -c MANIFEST.sha256 >/dev/null 2>&1) && [ "$(stat -c %a "$W/ev-t8")" = 700 ] && res T15 PASS "the evidence folder is mode 700 and its SHA-256 manifest verifies" || { res T15 FAIL "evidence manifest"; ls -la "$W/ev-t8" | head -30; (cd "$W/ev-t8" && sha256sum -c MANIFEST.sha256 2>&1 | grep -v ': OK' | head -5); stat -c '%a' "$W/ev-t8"; }
echo "---- $PASS PASS, $FAIL FAIL"; [ "$FAIL" -eq 0 ] && echo "PROCEDURE TEST PASS" || echo "PROCEDURE TEST FAIL"; [ "$FAIL" -eq 0 ]
