-- Executed only by GitHub's disposable local Supabase Postgres after all migrations.
-- This test runs in a transaction and never leaves test events behind.
BEGIN;
DO $qa$
DECLARE
  a uuid; b uuid; claim record; reclaim record;
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

  UPDATE public.whatsapp_webhook_inbox SET processed_at=now()-interval '8 days' WHERE id=a;
  n := public.whatsapp_webhook_inbox_prune(200);
  IF n <> 1 THEN RAISE EXCEPTION 'completed retention did not prune expected row'; END IF;
  SELECT count(*) INTO n FROM public.whatsapp_webhook_inbox WHERE id=b AND state='dead';
  IF n <> 1 THEN RAISE EXCEPTION 'prune deleted dead letter'; END IF;
END $qa$;
ROLLBACK;
