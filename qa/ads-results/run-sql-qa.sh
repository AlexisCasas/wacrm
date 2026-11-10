#!/usr/bin/env bash
# Ads results by product SQL QA on a DISPOSABLE PostgreSQL (internal Docker network: no internet, no Meta). Synthetic data only.
# Applies ALL migrations (001..latest), runs qa/ads-results/test.sql, then checks the documented rollback and re-apply.
set -uo pipefail
cd "$(dirname "$0")/../.."
IMAGE="${QA_PG_IMAGE:-supabase/postgres:17.6.1.136}"
ID=$$; NET="adsprod-qa-net-$ID"; DB="adsprod-qa-db-$ID"
cleanup() { docker rm -f "$DB" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; }; trap cleanup EXIT
docker network create --internal "$NET" >/dev/null
docker run -d --name "$DB" --network "$NET" -e POSTGRES_PASSWORD=qa "$IMAGE" >/dev/null
psql_() { docker exec -i "$DB" psql -U supabase_admin -h /var/run/postgresql -d postgres -X "$@"; }
for _ in $(seq 1 120); do sleep 1; log="$(docker logs "$DB" 2>&1 || true)"
  if grep -q 'PostgreSQL init process complete' <<<"$log" && [ "$(grep -c 'ready to accept connections' <<<"$log")" -ge 2 ] && psql_ -Atqc 'select 1' >/dev/null 2>&1; then break; fi; done
export PGOPTIONS="-c client_min_messages=warning"
psql_ -q < qa/flows-safe-save/bootstrap.sql >/dev/null
for f in supabase/migrations/*.sql; do psql_ -q -v ON_ERROR_STOP=1 < "$f" >/dev/null 2>&1 || { echo "migration failed: $f" >&2; exit 1; }; done
echo "== migrations applied (full order by name)"
# Dependency check on a SECOND fresh database that only has the migrations up to the items table (20261105000000_order_confirmation_items):
# This cutoff intentionally excludes the independent contacts migration 20261105000001; only the order items prerequisite is required.
# the new migration must apply there, i.e. it needs nothing created later.
DB2="adsprod-qa-dep-$ID"; trap 'docker rm -f "$DB2" >/dev/null 2>&1 || true; cleanup' EXIT
docker run -d --name "$DB2" --network "$NET" -e POSTGRES_PASSWORD=qa "$IMAGE" >/dev/null
psql2() { docker exec -i "$DB2" psql -U supabase_admin -h /var/run/postgresql -d postgres -X "$@"; }
for _ in $(seq 1 120); do sleep 1; log="$(docker logs "$DB2" 2>&1 || true)"
  if grep -q 'PostgreSQL init process complete' <<<"$log" && [ "$(grep -c 'ready to accept connections' <<<"$log")" -ge 2 ] && psql2 -Atqc 'select 1' >/dev/null 2>&1; then break; fi; done
export PGOPTIONS="-c client_min_messages=warning"
psql2 -q < qa/flows-safe-save/bootstrap.sql >/dev/null 2>&1
for f in $(ls supabase/migrations/*.sql | awk -F/ '{ if ($NF <= "20261105000000_order_confirmation_items.sql") print }'); do psql2 -q -v ON_ERROR_STOP=1 < "$f" >/tmp/depcheck.err 2>&1 || { echo "dep-check: prerequisite migration failed: $f" >&2; head -5 /tmp/depcheck.err >&2; exit 1; }; done
psql2 -q -v ON_ERROR_STOP=1 < supabase/migrations/20261114000000_ads_results_by_product.sql >/dev/null 2>&1 && echo "dependency check OK: applies on a DB with only migrations <= 20261105000000_order_confirmation_items" || { echo "DEPENDENCY CHECK FAILED"; exit 1; }
# The migration must contain no DDL/DML on tables or columns (functions only).
grep -qiE 'CREATE TABLE|ALTER TABLE|ALTER COLUMN|ADD COLUMN|INSERT INTO|UPDATE |DELETE FROM|DROP TABLE|CREATE INDEX|CREATE TRIGGER|CREATE POLICY' supabase/migrations/20261114000000_ads_results_by_product.sql && { echo "MIGRATION TOUCHES TABLES/DATA"; exit 1; } || echo "migration contains functions only (no tables, columns, data, triggers, policies)"
export PGOPTIONS="-c client_min_messages=notice"
OUT=$(psql_ -q < qa/ads-results/test.sql 2>&1); echo "$OUT" | grep -E "PASS|FAIL|ERROR|RESULT"
echo "== rollback"
psql_ -q -v ON_ERROR_STOP=1 < docs/integrations/ads-results/ROLLBACK-by-product.sql >/dev/null && echo "rollback applied" || { echo "ROLLBACK FAILED"; exit 1; }
echo "functions left: $(psql_ -Atq -c "select count(*) from pg_proc where proname in ('ads_results_by_product')")  (expected 0)"
echo "existing report function intact: $(psql_ -Atq -c "select count(*) from pg_proc where proname='ads_results_report'")  (expected 1)"
psql_ -q -v ON_ERROR_STOP=1 < supabase/migrations/20261114000000_ads_results_by_product.sql >/dev/null && echo "re-apply after rollback OK"
echo "== rollback (breakdown function)"
psql_ -q -v ON_ERROR_STOP=1 < docs/integrations/ads-results/ROLLBACK-product-ad-breakdown.sql >/dev/null && echo "rollback applied" || { echo "ROLLBACK FAILED"; exit 1; }
echo "breakdown functions left: $(psql_ -Atq -c "select count(*) from pg_proc where proname='ads_results_product_ad_breakdown'")  (expected 0)"
echo "by_product / report / attribution intact: $(psql_ -Atq -c "select count(*) from pg_proc where proname in ('ads_results_by_product','ads_results_report','order_ad_attribution')")  (expected 3)"
psql_ -q -v ON_ERROR_STOP=1 < supabase/migrations/20261115000000_ads_results_product_ad_breakdown.sql >/dev/null && echo "re-apply after rollback OK (breakdown)"
LAST=$(ls supabase/migrations/*.sql | xargs -n1 basename | sort | tail -1); echo "breakdown migration orders after its dependencies: $([ "$(ls supabase/migrations | sort | tail -1)" = "20261115000000_ads_results_product_ad_breakdown.sql" ] && echo yes || echo NO) (last=$LAST)"
echo "$OUT" | grep -q "FAIL" && exit 1
echo "$OUT" | grep -q "RESULT" || exit 1
exit 0
