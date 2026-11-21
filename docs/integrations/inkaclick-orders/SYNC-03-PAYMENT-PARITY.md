# SYNC-03 — Payment / balance parity

SYNC-03 is the first business-domain synchronization adapter. It remains inert until a later transport worker explicitly calls the RPCs.

## Contract

Both systems exchange a PII-free `payment.snapshot` event:

```json
{"total": 135.00, "paid": 30.00, "balance": 105.00}
```

The WACRM UUID is the only canonical order id.

## Monotonic money rule

Automatic synchronization may only move the receiver's confirmed paid amount forward.

- remote paid > local paid → apply only the positive delta;
- remote paid = local paid → idempotent no-op;
- remote paid < local paid → conflict, never reduce automatically;
- total mismatch → conflict;
- invalid `balance != total - paid` → conflict.

This rule prevents one stale system from erasing a newer payment in the other.

## WACRM import

An InkaClick snapshot that advances WACRM creates one synthetic confirmed delta payment:

- `source = inkaclick_sync`
- `method = sync_inkaclick`
- deterministic request key from the origin event
- no invented human actor
- audit events are written through the existing payment audit helper
- existing financial recalculation/finalization hooks are reused

Historical orders with no `order_financials` row are **not silently backfilled**; they are reported as `not_tracked`.

## WACRM export

`emit_wacrm_payment_snapshot` emits the current WACRM total/paid/balance using the financial row version as the idempotency version key.

No trigger or worker calls it yet.
