# SYNC-03A — Financial snapshot contract

SYNC-03A creates a common read model for comparing financial state between WACRM and InkaClick. It does **not** synchronize or mutate payments yet.

## Canonical fields

Both sides expose:

- `canonical_order_id` — always the WACRM order UUID
- `source_system`
- `total`
- `paid_confirmed`
- `balance`
- `financial_status`
- `tracked`

## WACRM historical safety

A missing `order_financials` row means the order is **not tracked by WACRM finance**. It does not mean "unpaid".

Therefore:

- `paid_confirmed = NULL`
- `balance = NULL`
- `financial_status = not_tracked`
- `tracked = false`

This prevents legacy InkaClick payments from being overwritten by an invented WACRM zero.

## Next step

SYNC-03B will consume the two financial snapshots and produce deterministic financial events. Applying those events remains disabled until conflict rules and production reconciliation are verified.
