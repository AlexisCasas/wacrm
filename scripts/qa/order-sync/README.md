# SYNC-00 + SYNC-01 — read-only order reconciliation

This tool establishes the first safe layer for WACRM ↔ InkaClick coexistence. It **does not connect to either database** and has no write path to business data. It consumes sanitized JSON snapshots produced with the provided SELECT-only SQL and emits a JSON report plus a compact console summary.

Canonical identity is always `WACRM public.order_confirmations.id`. InkaClick's own `id` is only `legacy_inkaclick_id`; no third order id is introduced. This matches the existing InkaClick receiver, where `confirmed_orders.external_order_id` stores the WACRM order UUID.

## Guardrails

- `SYNC_RECONCILE_READ_ONLY=1` is mandatory.
- Database/network URLs are rejected as CLI inputs; only regular snapshot files are accepted.
- SQL files contain SELECT/CTEs only and intentionally omit raw name, phone and DNI values. Customer comparison uses presence flags only.
- The report never writes back, fixes, deletes, imports or backfills anything.
- `--out` uses exclusive create (`wx`, mode `0600`) so an existing report is never overwritten silently.
- A missing production-domain adapter is reported as `UNKNOWN`, never as an empty value.

## Production coverage rule

The repository copy of InkaClick verifies the core `confirmed_orders` contract, but it does not contain the entire current production schema for voucher / Shalom / message ledgers. Therefore `inkaclick_snapshot.sql` intentionally covers only fields verified in `confirmed_orders`:

- canonical id / legacy id
- customer completeness
- product
- total
- initial paid amount
- remaining balance
- packing proxy from the current order status

Voucher, Shalom, tracking and messages are marked `coverage=false` until the production metadata probe is run. This prevents a false conclusion such as "InkaClick has no voucher" when the real meaning is "this snapshot has not queried the voucher table yet".

Run `sql/inkaclick_schema_probe.sql` against production in READ ONLY mode first. It returns metadata only (table/column/routine names, no row values or PII). Once exact tables are confirmed, extend the adapter and change only those coverage flags to true.

## Snapshot extraction

Files:

- `sql/wacrm_snapshot.sql` — full WACRM domains currently modeled.
- `sql/inkaclick_snapshot.sql` — verified InkaClick core only.
- `sql/inkaclick_schema_probe.sql` — metadata-only discovery for the remaining production domains.

Run every query inside an explicit read-only transaction using the established production access path. The reconciler itself cannot connect to either database.

## Reconcile

```bash
SYNC_RECONCILE_READ_ONLY=1 node scripts/qa/order-sync/reconcile.cjs \
  --wacrm /secure/tmp/wacrm.json \
  --inkaclick /secure/tmp/inkaclick.json \
  --out /secure/tmp/reconciliation.json
```

Order statuses:

- `MATCH`
- `WACRM_AHEAD`
- `INKACLICK_AHEAD`
- `CONFLICT`
- `MISSING_IN_WACRM`
- `MISSING_IN_INKACLICK`
- `LEGACY`

Per-domain state can additionally be `UNKNOWN` when one side's snapshot deliberately does not cover that domain. `INCOMPLETE_COVERAGE` counts canonical orders that have at least one unknown domain.

The report also counts `HELD_NOT_DELIVERED`, invalid/duplicate mappings and duplicate voucher groups only where voucher coverage is real. No automatic correction is part of SYNC-00/01.
