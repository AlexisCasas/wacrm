#!/usr/bin/env bash
# Builds the ISOLATED QA stack for the "Confirmar pedido" E2E (synthetic data only, loopback ports only, no production access):
#   qa-pg            Postgres (supabase/postgres) with two databases: wacrm and inka (a replica of InkaClick's confirmed_orders + triggers)
#   qa-rest-wacrm    PostgREST over wacrm            qa-rest-inka   PostgREST over inka
#   qa-proxy         strips the /rest/v1 prefix the Supabase gateway normally strips (127.0.0.1:18091 -> wacrm, 18092 -> inka)
#   qa-edge-off      real Supabase edge runtime (Deno) serving wacrm-confirmed-orders with verify_jwt OFF  (127.0.0.1:18083)
#   qa-edge-on       same with verify_jwt ON, to show the gateway rejects a non-JWT Bearer secret          (127.0.0.1:18084)
#
# Required: WACRM_SCHEMA_DUMP  a SCHEMA-ONLY pg_dump -Fc of a WACRM database (the Supabase CLI is not needed; with it, apply the repo's
#                              migrations to a local stack instead)  |  INKACLICK_REPO  path to an InkaClick-Saas checkout
# Output:   $QA_DIR/env.json (synthetic JWT secret, service JWT, receiver token). Then:  see README.md
set -euo pipefail
: "${WACRM_SCHEMA_DUMP:?}" "${INKACLICK_REPO:?}"
HERE="$(cd "$(dirname "$0")" && pwd)"; REPO="$(cd "$HERE/../../.." && pwd)"; QA_DIR="${QA_DIR:-$(mktemp -d)}"; PW=qa_synthetic_pw
"$HERE/teardown.sh" >/dev/null 2>&1 || true
docker network create qa-net >/dev/null
docker run -d --name qa-pg --network qa-net --memory 2g -e POSTGRES_PASSWORD=$PW supabase/postgres:17.6.1.136 >/dev/null
until docker exec qa-pg pg_isready -U postgres -q 2>/dev/null; do sleep 2; done; sleep 6
docker exec qa-pg psql -U supabase_admin -d postgres -qc "CREATE DATABASE wacrm" -c "CREATE DATABASE inka" -c "ALTER ROLE authenticator WITH LOGIN PASSWORD '$PW'"
docker exec -i qa-pg pg_restore -s -U supabase_admin -d wacrm --no-owner < "$WACRM_SCHEMA_DUMP" 2>/dev/null || true
for m in 20261101000000_order_confirmations 20261102000000_order_sellers_from_members; do
  docker exec -i qa-pg psql -U supabase_admin -d wacrm -v ON_ERROR_STOP=1 -q < "$REPO/supabase/migrations/$m.sql"
done
for f in supabase/tests/00_replica_confirmed_orders.sql supabase/migrations/20261101010000_wacrm_confirmed_orders.sql; do
  docker exec -i qa-pg psql -U supabase_admin -d inka -v ON_ERROR_STOP=1 -q < "$INKACLICK_REPO/$f" >/dev/null
done
docker exec qa-pg psql -U supabase_admin -d inka -qc "GRANT USAGE ON SCHEMA public TO service_role; GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role"
docker exec qa-pg psql -U supabase_admin -d wacrm -qc "GRANT USAGE ON SCHEMA public TO service_role"
node -e '
const c=require("crypto"),fs=require("fs");const secret=c.randomBytes(24).toString("hex");const b=o=>Buffer.from(JSON.stringify(o)).toString("base64url");
const sign=r=>{const h=b({alg:"HS256",typ:"JWT"}),p=b({role:r,iss:"qa-synthetic",exp:2000000000});return h+"."+p+"."+c.createHmac("sha256",secret).update(h+"."+p).digest("base64url")};
fs.writeFileSync(process.argv[1]+"/env.json",JSON.stringify({secret,service:sign("service_role"),orderToken:c.randomBytes(24).toString("hex")}));' "$QA_DIR"
SECRET=$(node -pe 'require(process.argv[1]).secret' "$QA_DIR/env.json"); SVC=$(node -pe 'require(process.argv[1]).service' "$QA_DIR/env.json"); TOK=$(node -pe 'require(process.argv[1]).orderToken' "$QA_DIR/env.json")
for spec in "wacrm 18081" "inka 18082"; do set -- $spec
  docker run -d --name qa-rest-$1 --network qa-net -p 127.0.0.1:$2:3000 -e PGRST_DB_URI="postgres://authenticator:$PW@qa-pg:5432/$1" -e PGRST_DB_SCHEMAS=public -e PGRST_DB_ANON_ROLE=anon -e PGRST_JWT_SECRET="$SECRET" postgrest/postgrest:v14.17 >/dev/null
done
docker run -d --name qa-proxy --network qa-net -p 127.0.0.1:18091:3001 -p 127.0.0.1:18092:3002 -v "$HERE/proxy.js.txt:/proxy.js:ro" node:20-alpine node /proxy.js >/dev/null
mkdir -p "$QA_DIR/functions/main" "$QA_DIR/functions/wacrm-confirmed-orders"
cp "$HERE/functions-main/index.ts.txt" "$QA_DIR/functions/main/index.ts"; cp "$INKACLICK_REPO/supabase/functions/wacrm-confirmed-orders/index.ts" "$QA_DIR/functions/wacrm-confirmed-orders/index.ts"
for spec in "off false 18083" "on true 18084"; do set -- $spec
  docker run -d --name qa-edge-$1 --network qa-net -p 127.0.0.1:$3:9000 -v "$QA_DIR/functions:/home/deno/functions:ro" -e JWT_SECRET="$SECRET" -e VERIFY_JWT=$2 \
    -e SUPABASE_URL=http://qa-proxy:3002 -e SUPABASE_SERVICE_ROLE_KEY="$SVC" -e WACRM_ORDERS_TOKEN="$TOK" supabase/edge-runtime:v1.74.0 start --main-service /home/deno/functions/main >/dev/null
done
echo "QA stack up. QA_DIR=$QA_DIR"
