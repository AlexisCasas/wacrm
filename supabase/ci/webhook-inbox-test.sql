-- Executed only by GitHub's disposable local Supabase Postgres after all migrations.
-- Single DO statement: supabase db query uses a prepared statement and rejects
-- BEGIN/DO/ROLLBACK in one file. This database is disposable on CI.
DO $qa$
DECLARE
  a uuid; b uuid; c uuid; d uuid; claim record; reclaim record;
  n integer; ok boolean;
BEGIN
  IF has_table_privilege('anon','public.whatsapp_webhook_inbox','SELECT')
    OR has_table_privilege('authenticated','public.whatsapp_webhook_inbox','INSERT')
    OR has_function_privilege('anon','public.whatsapp_webhook_inbox_claim(integer,uuid)','EXECUTE')
  THEN RAISE EXCEPTION 'webhook inbox exposed to client roles'; END IF;

  a := public.whatsapp_webhook_inbox_enqueue(repeat('a',64), '{"entry":[]}'::jsonb);
  IF a IS NULL THEN RAISE EXCEPTION 'enqueue missing uuid'; END IF;
  IF public.whatsapp_webhook_inbox_enqueue(repeat('a',64), '{"entry":[]}'::jsonb) <> a
  THEN RAISE EXCEPTION 'same delivery created duplicate row'; END IF;
  SELECT deliveries INTO n FROM public.whatsapp_webhook_inbox WHERE id=a;
  IF n<>2 THEN RAISE EXCEPTION 'duplicate delivery counter not incremented'; END IF;

  SELECT * INTO claim FROM public.whatsapp_webhook_inbox_claim(1,a);
  IF claim.id IS DISTINCT FROM a OR claim.token IS NULL THEN RAISE EXCEPTION 'claim failed'; END IF;
  SELECT count(*) INTO n FROM public.whatsapp_webhook_inbox_claim(1,a);
  IF n<>0 THEN RAISE EXCEPTION 'leased event claimed twice'; END IF;
  IF NOT public.whatsapp_webhook_inbox_complete(a,claim.token) THEN RAISE EXCEPTION 'completion failed'; END IF;
  SELECT count(*) INTO n FROM public.whatsapp_webhook_inbox_claim(1,a);
  IF n<>0 THEN RAISE EXCEPTION 'processed event was claimed again'; END IF;
  IF public.whatsapp_webhook_inbox_enqueue(repeat('a',64), '{"entry":[]}'::jsonb) <> a
  THEN RAISE EXCEPTION 'duplicate after processing got new event'; END IF;
  SELECT state, deliveries INTO claim FROM public.whatsapp_webhook_inbox WHERE id=a;
  IF claim.state <> 'processed' OR claim.deliveries <> 3 THEN RAISE EXCEPTION 'processed state reopened'; END IF;

  b := public.whatsapp_webhook_inbox_enqueue(repeat('b',64), '{"entry":[]}'::jsonb);
  SELECT * INTO claim FROM public.whatsapp_webhook_inbox_claim(1,b);
  UPDATE public.whatsapp_webhook_inbox SET lease_until=now()-interval '1 second' WHERE id=b;
  SELECT * INTO reclaim FROM public.whatsapp_webhook_inbox_claim(1,b);
  IF reclaim.token IS NULL OR reclaim.token=claim.token THEN RAISE EXCEPTION 'expired lease not reclaimed/fenced'; END IF;
  IF public.whatsapp_webhook_inbox_complete(b,claim.token) THEN RAISE EXCEPTION 'stale token completed event'; END IF;
  IF NOT public.whatsapp_webhook_inbox_fail(b,reclaim.token,'processing_failed') THEN RAISE EXCEPTION 'fail did not requeue'; END IF;
  SELECT state, attempts INTO claim FROM public.whatsapp_webhook_inbox WHERE id=b;
  IF claim.state <> 'pending' OR claim.attempts <> 2 THEN RAISE EXCEPTION 'retry state or count invalid'; END IF;

  UPDATE public.whatsapp_webhook_inbox SET attempts=9, next_attempt_at=now()-interval '1 second' WHERE id=b;
  SELECT * INTO claim FROM public.whatsapp_webhook_inbox_claim(1,b);
  IF claim.token IS NULL THEN RAISE EXCEPTION 'final attempt was not claimed'; END IF;
  IF NOT public.whatsapp_webhook_inbox_fail(b,claim.token,'processing_failed') THEN RAISE EXCEPTION 'final failure could not be marked'; END IF;
  SELECT state INTO claim FROM public.whatsapp_webhook_inbox WHERE id=b;
  IF claim.state <> 'dead' THEN RAISE EXCEPTION 'dead-letter not recorded'; END IF;

  -- Regression: a worker crashes on attempt #10; no fail() RPC is called.
  -- The next claim must retire the expired lease instead of leaving an
  -- unclaimable processing row forever.
  c := public.whatsapp_webhook_inbox_enqueue(repeat('c',64), '{"entry":[]}'::jsonb);
  UPDATE public.whatsapp_webhook_inbox SET attempts=9, next_attempt_at=now()-interval '1 second' WHERE id=c;
  SELECT * INTO claim FROM public.whatsapp_webhook_inbox_claim(1,c);
  IF claim.token IS NULL THEN RAISE EXCEPTION 'final lease test could not claim'; END IF;
  UPDATE public.whatsapp_webhook_inbox SET lease_until=now()-interval '1 second' WHERE id=c;
  SELECT count(*) INTO n FROM public.whatsapp_webhook_inbox_claim(1,c);
  IF n <> 0 THEN RAISE EXCEPTION 'exhausted crashed lease was claimed again'; END IF;
  SELECT state, last_error_code INTO claim FROM public.whatsapp_webhook_inbox WHERE id=c;
  IF claim.state <> 'dead' OR claim.last_error_code <> 'lease_exhausted'
  THEN RAISE EXCEPTION 'exhausted crashed lease stuck processing'; END IF;

  -- Only processed deliveries older than 72 hours are pruned.
  -- A 71-hour processed delivery, dead letters and pending work survive.
  d := public.whatsapp_webhook_inbox_enqueue(repeat('d',64), '{"entry":[]}'::jsonb);
  SELECT * INTO claim FROM public.whatsapp_webhook_inbox_claim(1,d);
  IF claim.token IS NULL OR NOT public.whatsapp_webhook_inbox_complete(d,claim.token)
  THEN RAISE EXCEPTION 'retention boundary test completion failed'; END IF;
  UPDATE public.whatsapp_webhook_inbox SET processed_at=now()-interval '73 hours' WHERE id=a;
  UPDATE public.whatsapp_webhook_inbox SET processed_at=now()-interval '71 hours' WHERE id=d;
  n := public.whatsapp_webhook_inbox_prune(200);
  IF n <> 1 THEN RAISE EXCEPTION 'completed 72h retention did not prune exactly one older row'; END IF;
  SELECT count(*) INTO n FROM public.whatsapp_webhook_inbox WHERE id=a;
  IF n <> 0 THEN RAISE EXCEPTION 'processed item older than 72h survived'; END IF;
  SELECT count(*) INTO n FROM public.whatsapp_webhook_inbox WHERE id=d AND state='processed';
  IF n <> 1 THEN RAISE EXCEPTION 'processed item younger than 72h was pruned'; END IF;
  SELECT count(*) INTO n FROM public.whatsapp_webhook_inbox WHERE id=b AND state='dead';
  IF n <> 1 THEN RAISE EXCEPTION 'prune deleted dead letter'; END IF;
  SELECT count(*) INTO n FROM public.whatsapp_webhook_inbox WHERE id=c AND state='dead';
  IF n <> 1 THEN RAISE EXCEPTION 'prune deleted expired terminal lease'; END IF;
  SELECT count(*) INTO n FROM public.whatsapp_webhook_inbox WHERE state='pending';
  IF n <> 0 THEN RAISE EXCEPTION 'unexpected pending rows in retention test'; END IF;
END $qa$;
