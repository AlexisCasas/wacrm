# SYNC-04 - Durable bidirectional transport

This phase wires the SYNC ledger to server-to-server delivery without enabling it.

WACRM to InkaClick:
- claim_order_sync_outbound leases only locally-originated events.
- runOrderSyncOutbox sends an envelope to INKACLICK_SYNC_EVENTS_URL.
- Global kill switch: ORDER_SYNC_ENABLED=true plus URL and ORDER_SYNC_TOKEN.
- /api/orders/sync/cron is protected by the existing AUTOMATION_CRON_SECRET.
- No schedule is installed by this change.

InkaClick to WACRM:
- order-sync-outbox is a protected Edge Function.
- It requires ORDER_SYNC_CRON_TOKEN and stays inert unless ORDER_SYNC_ENABLED=true.
- Target is WACRM_SYNC_EVENTS_URL.

Receivers preserve origin_system and origin_event_id. SYNC-04 initially accepts payment.snapshot only.

Delivery semantics:
- 2xx -> applied
- 409 -> conflict
- 408/429/5xx/network -> retry
- other 4xx -> dead_letter
- attempts are bounded and stale claims expire
