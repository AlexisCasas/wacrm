#!/usr/bin/env bash
# Isolated test (throwaway PostgreSQL, --network none, destroyed on exit) of the ROLES, RLS and EXECUTE rights that migration 076 grants, using the real
# client roles with JWT claims: NOT as superuser. Schema = migrations 001..076. Synthetic data only. Never touches production.
set -uo pipefail
MIGDIR="${MIG076_DIR:-/opt/apps/wacrm-audios-sel1/supabase/migrations}"; HERE="$(cd "$(dirname "$0")" && pwd)"; BOOT="$HERE/../../flows-safe-save/bootstrap.sql"
IMAGE="${ENSAYO_PG_IMAGE:-supabase/postgres:17.6.1.136}"; NAME="rls076-test-$$-$RANDOM"; PASS=0; FAIL=0
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }; trap cleanup EXIT
res() { if [ "$2" = PASS ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi; echo "RLSTEST-RESULT $1 $2 $3"; }
p() { docker exec -i -e PGOPTIONS="-c client_min_messages=warning" "$NAME" psql -U supabase_admin -h /var/run/postgresql -d postgres -X -q -A -t -v ON_ERROR_STOP=1 "$@"; }
docker run -d --name "$NAME" --network none --label wacrm.ensayo=076-selftest --pull never -e POSTGRES_PASSWORD=t "$IMAGE" >/dev/null || { echo "ABORT: container"; exit 2; }
ok=0; for _ in $(seq 1 120); do sleep 1; l="$(docker logs "$NAME" 2>&1)"; grep -q 'init process complete' <<<"$l" && [ "$(grep -c 'ready to accept' <<<"$l")" -ge 2 ] && p -c 'select 1' >/dev/null 2>&1 && { ok=1; break; }; done
[ "$ok" = 1 ] || { echo "ABORT: db"; exit 2; }
p < "$BOOT" >/dev/null || exit 2
for f in "$MIGDIR"/*.sql; do n="$(basename "$f" | cut -c1-3)"; [ "$n" -le 76 ] && { p < "$f" >/dev/null 2>/tmp/rls.err || { echo "ABORT migration $f"; head -2 /tmp/rls.err; exit 2; }; }; done
p >/dev/null <<'SQL' || { echo 'ABORT: seed failed'; exit 2; }
INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) VALUES
 ('c1000000-0000-4000-8000-0000000000a1','00000000-0000-0000-0000-000000000000','authenticated','authenticated','rls-a@example.test','{"full_name":"RLS A"}'::jsonb, now(), now()),
 ('d2000000-0000-4000-8000-0000000000b2','00000000-0000-0000-0000-000000000000','authenticated','authenticated','rls-b@example.test','{"full_name":"RLS B"}'::jsonb, now(), now());
CREATE TABLE public.qa_ctx AS SELECT (SELECT account_id FROM public.profiles WHERE user_id='c1000000-0000-4000-8000-0000000000a1') a, (SELECT account_id FROM public.profiles WHERE user_id='d2000000-0000-4000-8000-0000000000b2') b;
GRANT SELECT ON public.qa_ctx TO anon, authenticated, service_role;
SET session_replication_role = replica;
INSERT INTO public.audio_guide_products (id, account_id, product_key, display_name) SELECT 'a1000000-0000-4000-8000-000000000001'::uuid, a, 'p a', 'P A' FROM public.qa_ctx UNION ALL SELECT 'b1000000-0000-4000-8000-000000000001'::uuid, b, 'p b', 'P B' FROM public.qa_ctx;
INSERT INTO public.audio_guide_items (id, account_id, product_id, position, voice_sha256, voice_path, bytes, duration_ms, pre_delay_seconds)
 SELECT 'a2000000-0000-4000-8000-000000000001'::uuid, a, 'a1000000-0000-4000-8000-000000000001'::uuid, 1, repeat('1',64), 'account-' || a || '/' || repeat('1',64) || '.ogg', 1000, 5000, 5 FROM public.qa_ctx
 UNION ALL SELECT 'b2000000-0000-4000-8000-000000000001'::uuid, b, 'b1000000-0000-4000-8000-000000000001'::uuid, 1, repeat('2',64), 'account-' || b || '/' || repeat('2',64) || '.ogg', 1000, 5000, 5 FROM public.qa_ctx;
SET session_replication_role = origin;
SELECT public.audio_guide_save_purpose(a, NULL, 'Presentacion A', 'presentacion a', true) FROM public.qa_ctx;
SELECT public.audio_guide_save_purpose(b, NULL, 'Presentacion B', 'presentacion b', true) FROM public.qa_ctx;
SELECT public.audio_guide_save_identifier(a, NULL, 'Principal A', 'principal a', true) FROM public.qa_ctx;
SELECT public.audio_guide_save_identifier(b, NULL, 'Principal B', 'principal b', true) FROM public.qa_ctx;
SQL
[ "$(p -c "SELECT (SELECT count(*) FROM public.audio_guide_purposes)||'/'||(SELECT count(*) FROM public.audio_guide_identifiers)||'/'||(SELECT count(*) FROM public.audio_guide_items)||'/'||(SELECT count(*) FROM public.qa_ctx WHERE a IS NOT NULL AND b IS NOT NULL AND a<>b)")" = "2/2/2/1" ] || { echo 'ABORT: the synthetic data was not created (an empty database would make the denial tests meaningless)'; exit 2; }
# as(role, user, sql) -> prints the result or the SQLSTATE; runs as the REAL client role with JWT claims, inside a rolled-back transaction
as() { local role="$1" uid="$2" sql="$3"
  p -c "BEGIN; SET LOCAL ROLE $role; SELECT set_config('request.jwt.claims', json_build_object('sub','$uid','role','$role')::text, true), set_config('request.jwt.claim.sub','$uid',true), set_config('request.jwt.claim.role','$role',true) \\gset" 2>/dev/null >/dev/null
  printf 'BEGIN;\nSET LOCAL ROLE %s;\nSELECT set_config(%s, %s, true);\nSELECT set_config(%s, %s, true);\nDO $$ BEGIN PERFORM 1; END $$;\n%s\nROLLBACK;\n' "$role" "'request.jwt.claims'" "json_build_object('sub','$uid','role','$role')::text" "'request.jwt.claim.sub'" "'$uid'" "$sql" | docker exec -i -e PGOPTIONS="-c client_min_messages=warning" "$NAME" psql -U supabase_admin -h /var/run/postgresql -d postgres -X -q -A -t -v ON_ERROR_STOP=1 2>&1 | grep -v '^$' | grep -v -E '^[a-f0-9]{0,2}$|^\{|^[0-9a-f-]{36}$' | tail -3 | tr '\n' ' ' | cut -c1-160; }
UA=c1000000-0000-4000-8000-0000000000a1; UB=d2000000-0000-4000-8000-0000000000b2; UX=e3000000-0000-4000-8000-0000000000c3
code() { grep -o -E 'permission denied|42501|violates row-level security' <<<"$1" | head -1; }
r="$(as authenticated $UA "SELECT count(*), min(name) FROM public.audio_guide_purposes;")"; [ "$r" = "1|Presentacion A " ] && res R01 PASS "member of account A, role authenticated, sees ONLY A's purposes ($r)" || res R01 FAIL "unexpected: '$r'"
r="$(as authenticated $UB "SELECT count(*), min(name) FROM public.audio_guide_identifiers;")"; [ "$r" = "1|Principal B " ] && res R02 PASS "member of account B sees ONLY B's identifiers ($r)" || res R02 FAIL "unexpected: '$r'"
r="$(as authenticated $UX "SELECT (SELECT count(*) FROM public.audio_guide_purposes) || '/' || (SELECT count(*) FROM public.audio_guide_identifiers) || '/' || (SELECT count(*) FROM public.audio_guide_items);")"; [ "$r" = "0/0/0 " ] && res R03 PASS "an authenticated user who belongs to no account sees nothing ($r)" || res R03 FAIL "unexpected: '$r'"
r="$(as anon $UA "SELECT count(*) FROM public.audio_guide_purposes;")"; [ -n "$(code "$r")" ] && res R04 PASS "anon cannot read the new tables ($(code "$r"))" || res R04 FAIL "anon was not denied: '$r'"
bad=0; for stmt in "INSERT INTO public.audio_guide_purposes (account_id, name, name_key) SELECT a, 'x', 'x' FROM public.qa_ctx;" "UPDATE public.audio_guide_purposes SET name = 'hack';" "DELETE FROM public.audio_guide_identifiers;" "UPDATE public.audio_guide_items SET purpose_id = NULL;" "UPDATE public.audio_guide_requests SET node_key = 'x';"; do r="$(as authenticated $UA "$stmt")"; [ -n "$(code "$r")" ] || { bad=1; echo "   not denied: $stmt -> $r"; }; done
[ "$bad" = 0 ] && res R05 PASS "authenticated cannot INSERT/UPDATE/DELETE purposes, identifiers or classify audios (every write is denied)" || res R05 FAIL "a write was not denied"
r="$(as authenticated $UA "SELECT count(*) || '/' || count(*) FILTER (WHERE purpose_id IS NULL) FROM public.audio_guide_items;")"; [ "$r" = "1/1 " ] && res R06 PASS "authenticated reads only its own account's audios, new columns included ($r)" || res R06 FAIL "unexpected: '$r'"
bad=0; for fn in "save_purpose(NULL::uuid,NULL::uuid)" "save_identifier(NULL::uuid,NULL::uuid)" "delete_purpose(NULL::uuid,NULL::uuid)" "delete_identifier(NULL::uuid,NULL::uuid)" "classify_item(NULL::uuid,NULL::uuid,NULL::int,NULL::uuid,NULL::uuid)" "open_selected_request(NULL::uuid,NULL::uuid,NULL::uuid,NULL::uuid,NULL::text,NULL::text,NULL::int,NULL::uuid,NULL::uuid,NULL::text)" "record_selected_skip(NULL::uuid,NULL::uuid,NULL::uuid,NULL::uuid,NULL::text,NULL::text,NULL::text,NULL::uuid,NULL::uuid,NULL::text)"; do
  for role in anon authenticated; do r="$(as $role $UA "SELECT public.audio_guide_$fn;")"; [ -n "$(code "$r")" ] || { bad=1; echo "   $role could call $fn -> $r"; }; done; done
[ "$bad" = 0 ] && res R07 PASS "anon and authenticated are denied EXECUTE on all 7 functions (14 calls, permission denied)" || res R07 FAIL "a client role could execute a function"
r="$(as service_role $UA "SELECT (public.audio_guide_save_purpose((SELECT a FROM public.qa_ctx), NULL, 'Nueva', 'nueva', true)->>'ok');")"; [ "$r" = "true " ] && res R08 PASS "service_role can execute the functions (creates a purpose)" || res R08 FAIL "service_role denied: '$r'"
p >/dev/null -c "CREATE ROLE qa_nobody NOLOGIN"; r="$(p -c "SELECT bool_or(has_function_privilege('qa_nobody', p.oid, 'EXECUTE')) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname IN ('audio_guide_save_purpose','audio_guide_save_identifier','audio_guide_delete_purpose','audio_guide_delete_identifier','audio_guide_classify_item','audio_guide_open_selected_request','audio_guide_record_selected_skip')")"; [ "$r" = f ] && res R09 PASS "a role with no grants (stands for PUBLIC) cannot execute any of the 7 functions" || res R09 FAIL "PUBLIC-equivalent role can execute ($r)"
echo "---- $PASS PASS, $FAIL FAIL"; [ "$FAIL" -eq 0 ] && echo "RLS/PERMISSIONS TEST PASS" || echo "RLS/PERMISSIONS TEST FAIL"; [ "$FAIL" -eq 0 ]
