#!/usr/bin/env bash
# ISOLATED QA stack for the Google Sheets export (synthetic data only, loopback only, no production access):
#   qs-pg (supabase/postgres, database `wacrm`) + qs-rest (PostgREST) + qs-proxy (/rest/v1 prefix) -> http://127.0.0.1:18191
# Needs WACRM_SCHEMA_DUMP: a pg_dump -Fc of a WACRM database that already contains the orders tables (a restore of a prod backup works: ONLY its
# schema is loaded, `pg_restore -s`). The new migration is applied on top. Writes $QA_DIR/env.json (synthetic JWT secret + service JWT).
set -euo pipefail
: "${WACRM_SCHEMA_DUMP:?}"
HERE="$(cd "$(dirname "$0")" && pwd)"; REPO="$(cd "$HERE/../../.." && pwd)"; QA_DIR="${QA_DIR:-$(mktemp -d)}"; PW=qa_synthetic_pw
"$HERE/teardown.sh" >/dev/null 2>&1 || true
docker network create qs-net >/dev/null
docker run -d --name qs-pg --network qs-net --memory 2g -e POSTGRES_PASSWORD=$PW supabase/postgres:17.6.1.136 >/dev/null
until docker exec qs-pg pg_isready -U postgres -q 2>/dev/null; do sleep 2; done; sleep 6
docker exec qs-pg psql -U supabase_admin -d postgres -qc "CREATE DATABASE wacrm" -c "ALTER ROLE authenticator WITH LOGIN PASSWORD '$PW'"
docker exec -i qs-pg pg_restore -s -U supabase_admin -d wacrm --no-owner < "$WACRM_SCHEMA_DUMP" 2>/dev/null || true
docker exec qs-pg psql -U supabase_admin -d wacrm -Atc "select to_regclass('public.order_confirmation_items') is not null" | grep -q t || { echo "schema dump lacks the orders tables"; exit 1; }
docker exec -i qs-pg psql -U supabase_admin -d wacrm -v ON_ERROR_STOP=1 -q < "$REPO/supabase/migrations/20261109000000_order_sheet_exports.sql"
docker exec qs-pg psql -U supabase_admin -d wacrm -qc "GRANT USAGE ON SCHEMA public TO service_role" -c "NOTIFY pgrst, 'reload schema'"
node -e '
const c=require("crypto"),fs=require("fs");const secret=c.randomBytes(24).toString("hex");const b=o=>Buffer.from(JSON.stringify(o)).toString("base64url");
const h=b({alg:"HS256",typ:"JWT"}),p=b({role:"service_role",iss:"qa-synthetic",exp:2000000000});
fs.writeFileSync(process.argv[1]+"/env.json",JSON.stringify({secret,service:h+"."+p+"."+c.createHmac("sha256",secret).update(h+"."+p).digest("base64url")}));' "$QA_DIR"
SECRET=$(node -pe 'require(process.argv[1]).secret' "$QA_DIR/env.json")
docker run -d --name qs-rest --network qs-net -e PGRST_DB_URI="postgres://authenticator:$PW@qs-pg:5432/wacrm" -e PGRST_DB_SCHEMAS=public -e PGRST_DB_ANON_ROLE=anon -e PGRST_JWT_SECRET="$SECRET" postgrest/postgrest:v14.17 >/dev/null
docker run -d --name qs-proxy --network qs-net -p 127.0.0.1:18191:3001 -v "$HERE/proxy.js.txt:/proxy.js:ro" node:20-alpine node /proxy.js >/dev/null
echo "QA stack up. QA_DIR=$QA_DIR"
