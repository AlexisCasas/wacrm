# WACRM / Meta WhatsApp — webhook inbox durable (PR-B / P0)

## Problem / scope

Previously POST /api/whatsapp/webhook returned HTTP 200 before processing even attempted to persist the inbound event. A temporary PostgREST/Envoy failure inside Next `after()` was therefore **not retried by Meta**. The inbox applies to all WACRM WhatsApp tenants, including Keyler BSUID traffic, status changes and template notifications. It does **not** change Meta routing or ManyChat subscriptions.

## Contract

1. Parse routing identifiers from the **untrusted** raw request (no mutation).
2. Verify the exact body with the tenant-specific HMAC-SHA256 app secret(s); preserve the per-routing-unit intersection rule.
3. Only after successful HMAC, insert the complete event into `whatsapp_webhook_inbox` using a SHA-256 digest of the raw bytes. The event JSON contains customer PII; access is service role only (RLS on, grants revoked for public/anon/authenticated). **Never log or export raw payload.**
4. If persistence fails: return **503** and `Retry-After: 5`, never 200. A duplicate exact delivery updates only delivery counters; it never reopens a processed event.
5. Once persisted: return 200, schedule immediate processing through Next `after()`, AND rely on an independent authenticated cron to catch any abandoned delivery. Both consumers call the same atomic claim RPC with a 180-second lease and fencing token.
6. On success: mark processed. On a thrown core error: release with exponential retry; after 10 failed attempts: `dead`, retained for investigation. The worker does not log customer content or identifiers.
7. Prune only `processed` rows older than 7 days. Never prune `pending`, `processing` or `dead`.

**Limits:** the existing `messages(conversation_id,message_id)` unique index prevents a replay from storing and dispatching a duplicate inbound message. It cannot guarantee exactly-once delivery of outbound/third-party actions if the process crashes between their own side effects. Also, some existing downstream noncritical errors are best-effort (e.g. unread bump, AI, public webhooks) and are outside this P0. This PR must not be advertised as an absolute zero-loss/exactly-once guarantee.

## Deployment: NOT AUTHORIZED BY THIS PR

The user will separately instruct Claude Code in the VPS after GitHub QA. Do not merge or deploy automatically from this runbook.

1. Freeze the exact commit and confirm production image/migrations. Preserve current image and a usable DB backup.
2. Validate the SQL migration on a disposable restore, including anonymous access denial, a 503 simulation, duplicate enqueue, lease fencing, expired lease reclaim, processed retention and a dead-letter case.
3. Apply **`20261123000000_whatsapp_webhook_durable_inbox.sql` first**. Check that RPCs and indexes exist. Do not run the new image before the migration is ready: otherwise the app returns 503 to authentic webhook requests.
4. **Install a root-owned recurring POST cron every minute** to `https://crm.globaltechup.com/api/whatsapp/webhook/cron` with the existing `AUTOMATION_CRON_SECRET` in the `x-cron-secret` header. Keep credentials in a protected local file, not in the URL, shell history, git, process command line, or audit logs. No cron = events may wait indefinitely after a process crash.
5. Deploy only the approved, tested image. Smoke check signature 401 for invalid signatures, 503 when storage is simulated unavailable (isolated QA only), 200 on authenticated durable insert, and POST-only cron 401/405 guards.
6. Validate real inbound ordinary-phone and BSUID contact messages, media and interactive taps. Validate statuses and template events. Confirm exactly one customer message and one Flow start on duplicate Meta delivery. Confirm no regression in orders and other tenants.
7. Force-kill a disposable worker after enqueue, then drain with cron and verify recovery in isolated QA. Do not inject errors into production traffic.
8. Monitor first hour and next 24h: pending age, dead count, retries, cron availability, Meta 502/503, 401/403, accepted events, persisted messages, duplicate suppression, flow starts, audio and orders.

## Operational queries (read only)

```sql
SELECT state, count(*) AS events, min(first_seen_at) AS oldest
FROM public.whatsapp_webhook_inbox GROUP BY state ORDER BY state;

SELECT count(*) AS pending_over_5min FROM public.whatsapp_webhook_inbox
WHERE state = 'pending' AND first_seen_at < now() - interval '5 minutes';

SELECT attempts, count(*) FROM public.whatsapp_webhook_inbox
WHERE state IN ('pending','processing','dead') GROUP BY attempts ORDER BY attempts;
```

A `dead` row or growing oldest pending age is an alert, **not** evidence that Meta stopped delivering messages. Inspect by technical event UUID in restricted DB tooling, without exposing payload. Never automatically requeue dead-letter events until the root cause and duplicate side-effects are understood.

## Rollback

* Stop the newly installed webhook recovery cron. Restore the previous image through the existing protected deployment rollback procedure. The previous image ignores the new table. Keep the new table and events for investigation; **never drop queued deliveries during rollback**.
* If recovering to the previous app, ensure Meta retries and pending inbox deliveries are reconciled before deleting any code/data. If the durable migration cannot be applied, do **not** run the new image.
* A separate follow-up is required to investigate Caddy's 502 connection resets and PostgREST/Envoy 503 errors; this inbox mitigates losses but does not eliminate their underlying causes.

## Acceptance gates

- HMAC rejection before queue insert.
- DB unavailable => no successful HTTP 200.
- Concurrent cron and immediate worker => one claimed delivery.
- Meta duplicate => same inbox row, no repeated inbound message/Flow.
- Worker crash => lease reclaim then successful replay.
- Failing payload => bounded retry then observable dead letter.
- Strict tenant routing unchanged, other accounts unaffected.
- All CI tests and isolated Postgres migration replay PASS before VPS authorization.
