-- READ-ONLY monitor for the cut-over window. Never writes. Run it every few minutes:
--   psql -X -At -v ON_ERROR_STOP=1 -v account_id=<uuid> -v since='2026-11-08 08:00:00+00' -v silence_minutes=3 -f cutover-watch.sql
-- Every line starts with a verdict word (OK / ALERT / INFO) so a person or a script can scan it.
\set ON_ERROR_STOP on
SELECT CASE WHEN count(*) = 0 THEN 'OK    failed outbound since window: 0' ELSE 'ALERT failed outbound since window: ' || count(*) END
  FROM public.messages m JOIN public.conversations c ON c.id = m.conversation_id
 WHERE c.account_id = :'account_id' AND m.sender_type <> 'customer' AND m.status = 'failed' AND m.created_at >= :'since'::timestamptz;

-- duplicates: the same conversation got the same text/type twice from us within 60 s (two engines answering the same inbound)
SELECT CASE WHEN count(*) = 0 THEN 'OK    duplicate replies (same conversation, same content, <60 s): 0' ELSE 'ALERT duplicate replies (same conversation, same content, <60 s): ' || count(*) END
  FROM (SELECT m.conversation_id, m.content_type, coalesce(m.content_text, m.media_url, '') AS body, m.created_at,
               lag(m.created_at) OVER (PARTITION BY m.conversation_id, m.content_type, coalesce(m.content_text, m.media_url, '') ORDER BY m.created_at) AS prev
          FROM public.messages m JOIN public.conversations c ON c.id = m.conversation_id
         WHERE c.account_id = :'account_id' AND m.sender_type <> 'customer' AND m.created_at >= :'since'::timestamptz) d
 WHERE d.prev IS NOT NULL AND d.created_at - d.prev < interval '60 seconds';

-- silence: an inbound customer message older than N minutes with NO outbound afterwards in that conversation (nobody answered)
SELECT CASE WHEN count(*) = 0 THEN 'OK    unanswered inbound older than ' || :'silence_minutes' || ' min: 0' ELSE 'ALERT unanswered inbound older than ' || :'silence_minutes' || ' min: ' || count(*) END
  FROM (SELECT m.conversation_id, max(m.created_at) AS last_in
          FROM public.messages m JOIN public.conversations c ON c.id = m.conversation_id
         WHERE c.account_id = :'account_id' AND m.sender_type = 'customer' AND m.created_at >= :'since'::timestamptz
           AND m.created_at < now() - (:'silence_minutes' || ' minutes')::interval GROUP BY m.conversation_id) i
 WHERE NOT EXISTS (SELECT 1 FROM public.messages o WHERE o.conversation_id = i.conversation_id AND o.sender_type <> 'customer' AND o.created_at > i.last_in);

-- flow runs: outcome and stuck runs
SELECT 'INFO  flow runs since window: ' || count(*) || ' (ended ok ' || count(*) FILTER (WHERE end_reason = 'end_node') || ', failed ' || count(*) FILTER (WHERE end_reason IS NOT NULL AND end_reason <> 'end_node') || ', open ' || count(*) FILTER (WHERE ended_at IS NULL) || ')'
  FROM public.flow_runs WHERE account_id = :'account_id' AND started_at >= :'since'::timestamptz;
SELECT CASE WHEN count(*) = 0 THEN 'OK    flow runs failed since window: 0' ELSE 'ALERT flow runs failed since window: ' || count(*) END
  FROM public.flow_runs WHERE account_id = :'account_id' AND started_at >= :'since'::timestamptz AND end_reason IS NOT NULL AND end_reason <> 'end_node';
SELECT CASE WHEN count(*) = 0 THEN 'OK    runs stuck >30 min with no wait scheduled: 0' ELSE 'ALERT runs stuck >30 min with no wait scheduled: ' || count(*) END
  FROM public.flow_runs WHERE account_id = :'account_id' AND ended_at IS NULL AND wait_until IS NULL AND last_advanced_at < now() - interval '30 minutes';

-- only the approved wave may run: any run of a flow that is not in the active set is an ALERT
SELECT 'INFO  active flows now: ' || count(*) FROM public.flows WHERE account_id = :'account_id' AND status = 'active';

-- throughput
SELECT 'INFO  inbound ' || count(*) FILTER (WHERE m.sender_type = 'customer') || ' / outbound bot ' || count(*) FILTER (WHERE m.sender_type = 'bot') || ' / outbound agent ' || count(*) FILTER (WHERE m.sender_type = 'agent') || ' since window'
  FROM public.messages m JOIN public.conversations c ON c.id = m.conversation_id WHERE c.account_id = :'account_id' AND m.created_at >= :'since'::timestamptz;
