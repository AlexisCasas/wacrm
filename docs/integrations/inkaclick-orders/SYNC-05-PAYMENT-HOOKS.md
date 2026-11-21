# SYNC-05 — Automatic payment hooks

SYNC-03 can emit/apply payment snapshots and SYNC-04 can transport them. SYNC-05 closes the local-capture gap.

## WACRM

The existing PR-06 transaction already calls order_payments_after_change after every confirmed financial change. SYNC-05 keeps the existing finalization evaluation and then emits the final WACRM payment.snapshot in the same transaction.

Imported InkaClick delta payments use source=inkaclick_sync. A BEFORE INSERT trigger marks the transaction with app.order_sync_origin=inkaclick. The after-change hook sees that marker and skips WACRM-origin emission.

Result:

- local WACRM payment/void/correction/total correction -> one final local snapshot;
- imported InkaClick payment -> financial state changes, but no bounce event back to InkaClick;
- rollback -> payment and snapshot both roll back.
