-- READ-ONLY monitoring / reconciliation queries for inbound_dispatch_ledger. Internal ids only: no phone numbers, no message text.
-- Run with:  psql -X -At -F' | ' -f dispatch-ledger-monitor.sql   (set :deploy_ts below to the time the ledger was activated)
\set deploy_ts '2026-01-01T00:00:00Z'

-- M1 ledger state overview
select 'M1 state' as q, state, count(*) as n, coalesce(min(updated_at)::text,'') as oldest from public.inbound_dispatch_ledger group by state order by state;

-- M2 messages whose AI reply / public webhook / Flow / automations need a HUMAN decision (never retried automatically).
-- Open the conversation with conversation_id; decide whether the customer was already answered.
select 'M2 reconcile' as q, l.account_id, c.id as conversation_id, c.contact_id, l.wamid_ref, l.updated_at,
       l.steps->>'flows' as flows, l.steps->>'automations' as automations, l.steps->>'ai' as ai, l.steps->>'webhook' as webhook
from (select *, left(md5(wamid),10) as wamid_ref from public.inbound_dispatch_ledger) l
left join public.messages m on m.message_id = l.wamid
left join public.conversations c on c.id = m.conversation_id and c.account_id = l.account_id
where l.state = 'needs_reconciliation' order by l.updated_at;
-- M2b the same, aggregated by kind of unresolved effect
select 'M2b by step' as q, k.step, count(*) as n from public.inbound_dispatch_ledger l, lateral jsonb_each_text(l.steps) k(step, st)
where l.state = 'needs_reconciliation' and k.st = 'reconcile' group by k.step order by 3 desc;

-- M3 parked after 5 attempts, or stuck (should be 0)
select 'M3 failed' as q, count(*) as n from public.inbound_dispatch_ledger where state = 'failed';
select 'M3 stuck processing >5m' as q, count(*) as n from public.inbound_dispatch_ledger where state = 'processing' and lease_until < now() - interval '5 minutes';
select 'M3 pending >10m (intent without a finished dispatch)' as q, count(*) as n from public.inbound_dispatch_ledger where state = 'pending' and updated_at < now() - interval '10 minutes';

-- M4 LEDGER-UNAVAILABLE DETECTOR: customer messages stored after activation that have NO ledger row. Expected 0.
-- (When the ledger RPCs fail the processor falls back to the old behaviour and logs "[dispatch-ledger] begin unavailable"; this query proves how many messages were affected.)
select 'M4 messages without ledger row (ledger was unavailable)' as q, count(*) as n
from public.messages m join public.conversations c on c.id = m.conversation_id
left join public.inbound_dispatch_ledger l on l.account_id = c.account_id and l.wamid = m.message_id
where m.sender_type = 'customer' and m.message_id is not null and m.created_at > :'deploy_ts'::timestamptz and l.wamid is null;
