-- CI: inbound_dispatch_ledger behaviour (migration 20261125000000). Runs inside one DO block; raises on the first failure.
DO $$
DECLARE a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); u uuid := gen_random_uuid(); u2 uuid := gen_random_uuid(); c record; r boolean; s text;
BEGIN
  IF to_regclass('auth.users') IS NOT NULL THEN INSERT INTO auth.users(id, email) VALUES (u, 'ledger-ci@example.test') ON CONFLICT DO NOTHING; END IF;
  INSERT INTO public.accounts(id, name, owner_user_id) VALUES (a, 'ledger-ci', u);
  -- begin is idempotent: the first call creates, the second reports it existed
  IF NOT public.inbound_dispatch_begin(a, 'w1', true, false) THEN RAISE EXCEPTION 'begin should create'; END IF;
  IF public.inbound_dispatch_begin(a, 'w1', false, true) THEN RAISE EXCEPTION 'begin must not create twice'; END IF;
  SELECT * INTO c FROM public.inbound_dispatch_claim(a, 'w1');
  IF c.outcome <> 'claimed' OR NOT c.is_first_inbound OR c.contact_created THEN RAISE EXCEPTION 'claim must return the FIRST attempt flags, got %', c.outcome; END IF;
  -- a live lease is busy for a second worker
  IF (SELECT outcome FROM public.inbound_dispatch_claim(a, 'w1')) <> 'busy' THEN RAISE EXCEPTION 'second claim must be busy'; END IF;
  -- fenced transitions: a wrong token changes nothing
  IF public.inbound_dispatch_step(a, 'w1', gen_random_uuid(), 'flows', 'started') THEN RAISE EXCEPTION 'wrong token accepted'; END IF;
  IF NOT public.inbound_dispatch_step(a, 'w1', c.token, 'flows', 'started') THEN RAISE EXCEPTION 'step started refused'; END IF;
  IF NOT public.inbound_dispatch_step(a, 'w1', c.token, 'flows', 'done', true) THEN RAISE EXCEPTION 'step done refused'; END IF;
  BEGIN PERFORM public.inbound_dispatch_step(a, 'w1', c.token, 'nope', 'done'); RAISE EXCEPTION 'invalid step accepted';
  EXCEPTION WHEN sqlstate '22023' THEN NULL; END;
  -- a step left reconcile parks the row; it is never claimable again and never pruned
  PERFORM public.inbound_dispatch_step(a, 'w1', c.token, 'ai', 'reconcile');
  IF public.inbound_dispatch_finish(a, 'w1', c.token) <> 'needs_reconciliation' THEN RAISE EXCEPTION 'finish must park for reconciliation'; END IF;
  IF (SELECT outcome FROM public.inbound_dispatch_claim(a, 'w1')) <> 'reconcile' THEN RAISE EXCEPTION 'parked row must not be claimable'; END IF;
  UPDATE public.inbound_dispatch_ledger SET completed_at = now() - interval '90 days' WHERE account_id = a;
  PERFORM public.inbound_dispatch_prune(1000);
  IF NOT EXISTS (SELECT 1 FROM public.inbound_dispatch_ledger WHERE account_id = a AND wamid = 'w1') THEN RAISE EXCEPTION 'reconcile row was pruned'; END IF;
  -- expired lease is recoverable; 5 claims park it as failed
  PERFORM public.inbound_dispatch_begin(a, 'w2', false, false);
  FOR i IN 1..5 LOOP
    SELECT * INTO c FROM public.inbound_dispatch_claim(a, 'w2');
    IF c.outcome <> 'claimed' THEN RAISE EXCEPTION 'claim % should succeed, got %', i, c.outcome; END IF;
    UPDATE public.inbound_dispatch_ledger SET lease_until = now() - interval '1 second' WHERE account_id = a AND wamid = 'w2';
  END LOOP;
  IF (SELECT outcome FROM public.inbound_dispatch_claim(a, 'w2')) <> 'failed' THEN RAISE EXCEPTION '6th claim must park as failed'; END IF;
  -- same wamid in another account is independent
  IF to_regclass('auth.users') IS NOT NULL THEN INSERT INTO auth.users(id, email) VALUES (u2, 'ledger-ci-b@example.test') ON CONFLICT DO NOTHING; END IF;
  INSERT INTO public.accounts(id, name, owner_user_id) VALUES (b, 'ledger-ci-b', u2);
  IF NOT public.inbound_dispatch_begin(b, 'w1', false, false) THEN RAISE EXCEPTION 'same wamid in another account must create its own row'; END IF;
END $$;
