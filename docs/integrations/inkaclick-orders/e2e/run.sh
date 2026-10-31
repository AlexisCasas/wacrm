#!/usr/bin/env bash
# Disposable HTTP end-to-end of the InkaClick receiver (wacrm-confirmed-orders). Nothing here touches production: its own Docker network, NO published
# ports, synthetic secrets generated per run and thrown away, a schema REPLICA (no real data). Usage:
#   INKA=/path/to/InkaClick-Saas ./run.sh        # INKA = checkout of InkaClick-Saas at the commit to test
set -euo pipefail
: "${INKA:?set INKA to an InkaClick-Saas checkout}"
HERE=$(cd "$(dirname "$0")" && pwd); W=$(mktemp -d); trap 'docker compose -f "$W/compose.yml" --env-file "$W/.env" down -v >/dev/null 2>&1 || true; rm -rf "$W"' EXIT
cp -r "$HERE"/compose.yml "$HERE"/kong.yml "$HERE"/*.mjs "$HERE"/functions "$W"/
mkdir -p "$W/functions/wacrm-confirmed-orders" "$W/sql"
cp "$INKA/supabase/functions/wacrm-confirmed-orders/index.ts" "$W/functions/wacrm-confirmed-orders/"
cp "$INKA/supabase/tests/00_replica_confirmed_orders.sql" "$W/sql/00.sql"; cp "$INKA/supabase/migrations/20261101010000_wacrm_confirmed_orders.sql" "$W/sql/10.sql"
python3 - "$W" <<'PY'
import sys,hmac,hashlib,base64,json,secrets,os
W=sys.argv[1]; b=lambda x: base64.urlsafe_b64encode(x).rstrip(b'=').decode(); sec=secrets.token_hex(32)
def jwt(role):
    h=b(json.dumps({"alg":"HS256","typ":"JWT"}).encode()); p=b(json.dumps({"role":role,"iss":"e2e","exp":4102444800}).encode())
    return f"{h}.{p}."+b(hmac.new(sec.encode(),f"{h}.{p}".encode(),hashlib.sha256).digest())
open(W+'/.env','w').write(f"PGPASS={secrets.token_hex(16)}\nJWT_SECRET={sec}\nSERVICE_KEY={jwt('service_role')}\nANON_KEY={jwt('anon')}\nWACRM_TOKEN={secrets.token_hex(24)}\n"); os.chmod(W+'/.env',0o600)
PY
cd "$W"; set -a; . ./.env; set +a
DC="docker compose -f compose.yml --env-file .env"; PSQL="docker exec -i inka-e2e-db-1 psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q"
$DC up -d db; until docker exec inka-e2e-db-1 pg_isready -U postgres -h localhost >/dev/null 2>&1; do sleep 2; done; sleep 6
$PSQL < sql/00.sql; $PSQL < sql/10.sql; $PSQL -c "ALTER ROLE authenticator WITH PASSWORD '$PGPASS'"
$DC up -d; sleep 20
RUN="docker run --rm --network inka-e2e_default -e WACRM_TOKEN -e SERVICE_KEY -v $W:/w:ro node:20-alpine node"
$RUN /w/qa.mjs; $RUN /w/lost.mjs; $RUN /w/mc.mjs
echo "--- DB: wacrm rows / distinct ids / events"; $PSQL -At -c "select count(*),count(distinct external_order_id) from confirmed_orders where source='wacrm'; select outcome,count(*) from wacrm_order_events group by 1"
echo "--- log leak check (expect 0 0)"; docker logs inka-e2e-edge-1 2>&1 | grep -cE "$WACRM_TOKEN|Sintetico|Perdido|5190000" || true; docker logs inka-e2e-gw-1 2>&1 | grep -cE "$WACRM_TOKEN|Sintetico" || true
