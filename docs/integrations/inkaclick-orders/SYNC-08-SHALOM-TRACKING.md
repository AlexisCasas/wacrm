# SYNC-08 — Shalom guide/tracking parity

WACRM keeps PR-05 order_shipments and its poller as the local source of truth. InkaClick-origin guide/tracking is stored separately in order_shipment_sync_state.

Shared statuses are at_origin, in_transit, at_destination and delivered. For one guide the mirror can only advance; it never regresses. A newer corrected guide can replace only the remote mirror.

Local order_shipments changes emit PII-free shipment.snapshot events. The WACRM panel shows the remote mirror read-only and does not offer a second guide registration when only the remote guide exists.
