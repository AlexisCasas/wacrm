# Confirmar pedido: isolated end-to-end QA

Runs the real WACRM route handlers and outbox code against an isolated stack that contains the real Supabase **edge runtime (Deno)** serving the
real `wacrm-confirmed-orders` function, an InkaClick-replica database and a WACRM database. Synthetic data only; every port is bound to
`127.0.0.1`; nothing talks to production.

```bash
export WACRM_SCHEMA_DUMP=/path/to/schema-only.dump     # pg_dump -Fc --schema-only of a WACRM database
export INKACLICK_REPO=/path/to/InkaClick-Saas          # checkout of main
export QA_DIR=$(mktemp -d)
scripts/qa/orders-e2e/setup.sh

export QA_E2E=1 NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:18091
export SUPABASE_SERVICE_ROLE_KEY=$(node -pe 'require(process.argv[1]).service' $QA_DIR/env.json)
export INKACLICK_ORDERS_TOKEN=$(node -pe 'require(process.argv[1]).orderToken' $QA_DIR/env.json)
export INKACLICK_ORDERS_URL=http://127.0.0.1:18083/wacrm-confirmed-orders
npx vitest run src/lib/orders/e2e.integration.test.ts

scripts/qa/orders-e2e/teardown.sh
```

The suite truncates tables, so it refuses to run unless `NEXT_PUBLIC_SUPABASE_URL` is a loopback address. It is skipped without `QA_E2E=1`.

`qa-edge-on` (port 18084) emulates the hosted gateway with `verify_jwt = true`: a Bearer secret that is not a JWT never reaches the function
(`{"msg":"Invalid JWT"}`), which is why the function MUST be deployed with `verify_jwt = false`.
