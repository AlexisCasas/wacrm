# SYNC-00 + SYNC-01 — read-only order reconciliation

This tool establishes the first safe layer for WACRM ↔ InkaClick coexistence. It **does not connect to either database** and has no write path to business data. It consumes two sanitized JSON snapshots produced with the provided `SELECT`-only SQL and emits a JSON report plus a compact console summary.

Canonical identity is always `WACRM public.order_confirmations.id`. InkaClick's own `id` is only `legacy_inkaclick_id`; no third order id is introduced.

## Guardrails

- `SYNC_RECONCILE_READ_ONLY=1` is mandatory.
- Database/network URLs are rejected as CLI inputs; only regular snapshot files are accepted.
- SQL files contain `SELECT`/CTEs only and intentionally omit raw name, phone and DNI values. Customer comparison uses presence flags only.
- The report never writes back, fixes, deletes, imports or backfills anything.
- `--out` uses exclusive create (`wx`, mode `0600`) so an existing report is never overwritten silently.

## Snapshot extraction

Run each query against the correct database in an explicit read-only transaction and redirect the one-JSON-object-per-row result into a JSON array using your normal psql wrapper. Do not run either query through a service that mutates data.

Files:

- `sql/wacrm_snapshot.sql`
- `sql/inkaclick_snapshot.sql`

The snapshot contract intentionally contains only operational comparison fields: canonical id, legacy InkaClick id, total, paid, balance, product key, customer completeness flags, voucher identifiers, packing state, Shalom guide/state and message-sent booleans.

## Reconcile

```bash
SYNC_RECONCILE_READ_ONLY=1 node scripts/qa/order-sync/reconcile.cjs \
  --wacrm /secure/tmp/wacrm.json \
  --inkaclick /secure/tmp/inkaclick.json \
  --out /secure/tmp/reconciliation.json
```

Statuses:

- `MATCH`
- `WACRM_AHEAD`
- `INKACLICK_AHEAD`
- `CONFLICT`
- `MISSING_IN_WACRM`
- `MISSING_IN_INKACLICK`
- `LEGACY`

The report also counts `HELD_NOT_DELIVERED`, invalid/duplicate mappings and duplicate voucher groups. No automatic correction is part of SYNC-00/01.
