# F3 — Durable dispatch ledger for inbound WhatsApp messages

## 1. Diagnosis (confirmed root cause)

`processMessage()` (webhook-processor.ts) stores the inbound message with
`upsert(..., { onConflict: 'conversation_id,message_id', ignoreDuplicates: true }).select('id')` and only AFTER that
starts the fan-out: Flow runner, automations, AI auto-reply and the public `message.received` webhook.

The insert is also the idempotency boundary: when it returns no row ("replay"), the function returns immediately.

If the process dies (OOM, `docker restart`, deploy, host reboot) between the insert and the fan-out, the durable inbox
(or Meta) replays the event, the insert reports a duplicate, and the function returns early. **The message is in the
Inbox, but its Flow / automations / AI reply / webhook were never dispatched, and nothing will ever dispatch them.**

Reproduced (`L0` in the QA suite): kill after the message insert, expire the lease, run the cron twice -> message stored once,
zero dispatches.

Not duplicated today (and must stay so): because a replay returns early, nothing is dispatched twice. Any fix that simply
"dispatches on replay" would double-start Flows (the engine dedupes replies by `reply_received` events, NOT the message that
started the run), double-send AI replies and double-fire automations (`automation_logs` has no per-message uniqueness).

Out of scope (documented, unchanged): the individual dispatchers swallow their own errors (log only); `conversation.created`
is emitted before the message insert; the unread bump / reopen / broadcast-reply bookkeeping is not idempotent and keeps running
only on the first insert.

## 2. Design

A write-ahead row `inbound_dispatch_ledger (account_id, wamid)` is created BEFORE the message insert
(`inbound_dispatch_begin`). Therefore "message exists" implies "ledger row exists" for every message handled after this change.
No cross-statement atomicity is required: intent precedes the effect.

Steps: `flows`, `automations`, `ai`, `webhook`. Each goes `pending -> started -> done` (or `skipped`, or `reconcile`).
Transitions are fenced by a claim token + 180 s lease (`inbound_dispatch_claim`, `_step`, `_finish`, `_release`).

Resume rules (a replay of an already-stored message):

| step state found | action |
|---|---|
| `done`, `skipped`, `reconcile` | never run again |
| `pending` | run it |
| `started` (outcome unknown), Flows / automations | run only if the database shows NO trace since the intent was recorded (`inbound_dispatch_has_trace`); with a trace -> `reconcile` |
| `started`, AI reply / public webhook | always `reconcile` (an external effect with unknown result is never repeated) |

A `reconcile` Flow step makes the processor assume the Flow consumed the message (no content-level automations, no AI), so a
message a Flow may already have answered is not answered twice. Rows with a `reconcile` step end `needs_reconciliation`:
kept forever, visible with a query, never retried.

Recovery uses the mechanism that already exists: the durable inbox keeps the event until the processor returns, and its
authenticated cron re-claims expired leases. No second engine, no new cron.
Concurrency: two workers on the same WAMID -> the second gets `busy` and throws, so the inbox retries it later (it then finds
`completed`). Limits: 5 claims per message, then `failed` (parked, visible). Retention: only `completed` rows older than 14 days
are pruned (by the existing cron call). Legacy: a stored message with no ledger row is recorded as handled and NEVER dispatched.

Failure mode: if any ledger call fails, the processor behaves exactly as before this change (no ledger). Reception never
becomes less available than today.

## 3. Files

- `supabase/migrations/20261125000000_whatsapp_inbound_dispatch_ledger.sql` (new table + 8 service-role functions; touches no existing object)
- `src/lib/whatsapp/dispatch-ledger.ts` (new), `dispatch-ledger.test.ts` (new)
- `src/lib/whatsapp/webhook-processor.ts` (write-ahead begin, replay resume, steps wrapped; business logic of every step unchanged)
- `src/app/api/whatsapp/webhook/cron/route.ts` (+ ledger prune call)
- `src/app/api/whatsapp/webhook/route.test.ts` (existing mock ignores the ledger RPCs; with the ledger "unavailable" the old suite passes unchanged = proof of identical legacy behaviour)
- `supabase/ci/dispatch-ledger-test.sql`

## 4. Evidence (isolated QA: real route handlers, real PostgREST, disposable PostgreSQL, no network)

`L0` reproduces the loss on the old behaviour. `P0`, `S1`–`S6`, `C1`–`C7` (15 scenarios) cover: crash after the insert and before the
claim; crash after Flows and before automations; crash inside the Flow start after it created its run (also the model for order
creation, which happens inside Flow nodes); crash while sending the AI reply; crash before the public webhook; Docker restart
recovery by cron; two workers on one WAMID; Meta redelivery (same and different bytes); same WAMID in two accounts; legacy
messages; ledger unavailable; bounded attempts; retention.

## 5. Deployment plan (NOT executed; each step needs its own authorization)

1. Build from the deployed base + this change (no other code). 2. Backup. 3. Apply the migration alone (additive; the running
image ignores the new table). 4. Blue/green deploy. 5. Watch: `needs_reconciliation`, `failed`, stuck `processing`, `busy`.

Rollback: deploy the previous image (`webhook-min-2976064a`); the ledger table stays, unused. `needs_reconciliation` / `pending`
rows left behind describe messages whose dispatch must be reviewed by hand. DB restore is never part of a rollback.

## 6. Monitoring queries (read-only)

```sql
select state, count(*) from inbound_dispatch_ledger group by 1;
select account_id, count(*) from inbound_dispatch_ledger where state in ('needs_reconciliation','failed') group by 1;
select count(*) from inbound_dispatch_ledger where state='processing' and lease_until < now() - interval '5 minutes';
```

## 7. Residual risks

Steps with unknown outcome are never repeated, so a kill during an AI reply or a public webhook loses that effect (flagged, not
duplicated). A kill inside a Flow after it started but before its first recorded event is repeated only when the database shows
no trace at all. `needs_reconciliation` has no UI or notification yet.
