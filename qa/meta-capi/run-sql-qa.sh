#!/usr/bin/env bash
# Meta CAPI / ad attribution SQL QA on a DISPOSABLE PostgreSQL (internal Docker network: no internet, no Meta). Synthetic data only.
# Applies ALL migrations (001..latest), runs qa/meta-capi/test.sql, then checks the documented rollback and re-apply.
set -uo pipefail
cd "$(dirname "$0")/../.."
IMAGE="${QA_PG_IMAGE:-supabase/postgres:17.6.1.136}"
ID=$$; NET="capi-qa-net-$ID"; DB="capi-qa-db-$ID"
cleanup() { docker rm -f "$DB" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; }; trap cleanup EXIT
docker network create --internal "$NET" >/dev/null
docker run -d --name "$DB" --network "$NET" -e POSTGRES_PASSWORD=qa "$IMAGE" >/dev/null
psql_() { docker exec -i "$DB" psql -U supabase_admin -h /var/run/postgresql -d postgres -X "$@"; }
for _ in $(seq 1 120); do sleep 1; log="$(docker logs "$DB" 2>&1 || true)"
  if grep -q 'PostgreSQL init process complete' <<<"$log" && [ "$(grep -c 'ready to accept connections' <<<"$log")" -ge 2 ] && psql_ -Atqc 'select 1' >/dev/null 2>&1; then break; fi; done
export PGOPTIONS="-c client_min_messages=warning"
psql_ -q < qa/flows-safe-save/bootstrap.sql >/dev/null
for f in supabase/migrations/*.sql; do psql_ -q -v ON_ERROR_STOP=1 < "$f" >/dev/null 2>&1 || { echo "migration failed: $f" >&2; exit 1; }; done
echo "== migrations applied"
export PGOPTIONS="-c client_min_messages=notice"
OUT=$(psql_ -q < qa/meta-capi/test.sql 2>&1); echo "$OUT" | grep -E "PASS|FAIL|ERROR|RESULT"
echo "== rollback"
psql_ -q -v ON_ERROR_STOP=1 < docs/integrations/meta-capi/ROLLBACK.sql >/dev/null && echo "rollback applied" || { echo "ROLLBACK FAILED"; exit 1; }
echo "tables left: $(psql_ -Atq -c "select count(*) from information_schema.tables where table_name in ('contact_ad_clicks','meta_capi_settings','meta_capi_events','meta_capi_attempts')")  (expected 0)"
echo "existing tables intact: $(psql_ -Atq -c "select count(*) from information_schema.tables where table_name in ('contact_ad_attributions','order_confirmations','order_confirmation_items','contacts')")  (expected 4)"
psql_ -q -v ON_ERROR_STOP=1 < supabase/migrations/20261111000000_meta_capi_ad_results.sql >/dev/null && echo "re-apply after rollback OK"
echo "$OUT" | grep -q "FAIL" && exit 1
echo "$OUT" | grep -q "RESULT" || exit 1
exit 0
