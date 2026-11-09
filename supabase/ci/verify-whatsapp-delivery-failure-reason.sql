-- PR #91: isolated behavioural assertions for Meta delivery-failure reasons.
-- Run ONLY on an isolated, disposable Supabase PostgreSQL with migration
-- 20261113000000_whatsapp_delivery_failure_reason.sql applied.
-- e.g. psql -v ON_ERROR_STOP=1 -1 -f supabase/ci/verify-whatsapp-delivery-failure-reason.sql
-- Never point this at production. All synthetic rows are rolled back.
BEGIN;
SET LOCAL statement_timeout = '30s';

DO $qa$
DECLARE
  u_a uuid := gen_random_uuid();
  u_b uuid := gen_random_uuid();
  account_a uuid;
  account_b uuid;
  contact_a uuid;
  contact_b uuid;
  conversation_a uuid;
  conversation_b uuid;
  msg_a uuid;
  msg_b uuid;
  msg_sent uuid;
  msg_delivered uuid;
  msg_read uuid;
  msg_customer uuid;
  msg_bot uuid;
  shared_wamid text := 'wamid.qa91.shared.' || gen_random_uuid()::text;
  unique_wamid text := 'wamid.qa91.only-a.' || gen_random_uuid()::text;
  changed integer;
  checked integer := 0;
BEGIN
  -- 01: migration installed columns + exact function signature.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'messages' AND column_name = 'delivery_error_code')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'messages' AND column_name = 'delivery_error_title')
     OR to_regprocedure('public.record_whatsapp_delivery_failure(uuid,text,integer,text)') IS NULL THEN
    RAISE EXCEPTION '01: migration columns or RPC missing';
  END IF;
  checked := checked + 1;

  -- 02: least-privilege RPC. Require service_role and prohibit browser roles.
  IF NOT has_function_privilege('service_role',
      'public.record_whatsapp_delivery_failure(uuid,text,integer,text)', 'EXECUTE')
     OR has_function_privilege('anon',
      'public.record_whatsapp_delivery_failure(uuid,text,integer,text)', 'EXECUTE')
     OR has_function_privilege('authenticated',
      'public.record_whatsapp_delivery_failure(uuid,text,integer,text)', 'EXECUTE') THEN
    RAISE EXCEPTION '02: RPC grants incorrect';
  END IF;
  checked := checked + 1;

  INSERT INTO auth.users (id, email)
    VALUES (u_a, 'qa91-a-' || replace(u_a::text, '-', '') || '@example.invalid'),
           (u_b, 'qa91-b-' || replace(u_b::text, '-', '') || '@example.invalid');
  SELECT account_id INTO STRICT account_a FROM public.profiles WHERE user_id = u_a;
  SELECT account_id INTO STRICT account_b FROM public.profiles WHERE user_id = u_b;
  IF account_a = account_b THEN RAISE EXCEPTION 'setup: expected distinct accounts'; END IF;
  INSERT INTO public.contacts (user_id, account_id, phone, name)
    VALUES (u_a, account_a, '519' || left(replace(u_a::text, '-', ''), 8), 'QA A')
    RETURNING id INTO contact_a;
  INSERT INTO public.contacts (user_id, account_id, phone, name)
    VALUES (u_b, account_b, '519' || left(replace(u_b::text, '-', ''), 8), 'QA B')
    RETURNING id INTO contact_b;
  INSERT INTO public.conversations (user_id, account_id, contact_id)
    VALUES (u_a, account_a, contact_a) RETURNING id INTO conversation_a;
  INSERT INTO public.conversations (user_id, account_id, contact_id)
    VALUES (u_b, account_b, contact_b) RETURNING id INTO conversation_b;

  INSERT INTO public.messages (conversation_id, sender_type, content_type, content_text, message_id, status)
    VALUES (conversation_a, 'agent', 'text', 'synthetic qa', shared_wamid, 'failed')
    RETURNING id INTO msg_a;
  INSERT INTO public.messages (conversation_id, sender_type, content_type, content_text, message_id, status)
    VALUES (conversation_b, 'agent', 'text', 'synthetic qa', shared_wamid, 'failed')
    RETURNING id INTO msg_b;
  INSERT INTO public.messages (conversation_id, sender_type, content_type, content_text, message_id, status)
    VALUES (conversation_a, 'agent', 'text', 'synthetic qa', unique_wamid, 'sent')
    RETURNING id INTO msg_sent;
  INSERT INTO public.messages (conversation_id, sender_type, content_type, content_text, message_id, status)
    VALUES (conversation_a, 'agent', 'text', 'synthetic qa', 'wamid.qa91.del.' || gen_random_uuid()::text, 'delivered')
    RETURNING id INTO msg_delivered;
  INSERT INTO public.messages (conversation_id, sender_type, content_type, content_text, message_id, status)
    VALUES (conversation_a, 'agent', 'text', 'synthetic qa', 'wamid.qa91.read.' || gen_random_uuid()::text, 'read')
    RETURNING id INTO msg_read;
  INSERT INTO public.messages (conversation_id, sender_type, content_type, content_text, message_id, status)
    VALUES (conversation_a, 'customer', 'text', 'synthetic qa', 'wamid.qa91.in.' || gen_random_uuid()::text, 'failed')
    RETURNING id INTO msg_customer;
  INSERT INTO public.messages (conversation_id, sender_type, content_type, content_text, message_id, status)
    VALUES (conversation_a, 'bot', 'text', 'synthetic qa', 'wamid.qa91.bot.' || gen_random_uuid()::text, 'failed')
    RETURNING id INTO msg_bot;

  -- 03: write accepted for a failed outbound message in the same account.
  SELECT public.record_whatsapp_delivery_failure(account_a, shared_wamid, 131026, 'Undeliverable')
    INTO changed;
  IF changed <> 1 THEN RAISE EXCEPTION '03: expected one updated row, got %', changed; END IF;
  checked := checked + 1;

  -- 04: code and title actually persisted.
  IF NOT EXISTS (SELECT 1 FROM public.messages WHERE id = msg_a
                 AND delivery_error_code = 131026 AND delivery_error_title = 'Undeliverable') THEN
    RAISE EXCEPTION '04: wrong saved code or title';
  END IF;
  checked := checked + 1;

  -- 05: same wamid in another account is untouched.
  IF EXISTS (SELECT 1 FROM public.messages WHERE id = msg_b
             AND (delivery_error_code IS NOT NULL OR delivery_error_title IS NOT NULL)) THEN
    RAISE EXCEPTION '05: cross-account contamination';
  END IF;
  checked := checked + 1;

  -- 06: repeated status events do not replace an existing reason.
  PERFORM public.record_whatsapp_delivery_failure(account_a, shared_wamid, 999999, 'Overwrite attempt');
  IF NOT EXISTS (SELECT 1 FROM public.messages WHERE id = msg_a
                 AND delivery_error_code = 131026 AND delivery_error_title = 'Undeliverable') THEN
    RAISE EXCEPTION '06: replay overwrote stored reason';
  END IF;
  checked := checked + 1;

  -- 07: the other account can independently store its own reason.
  SELECT public.record_whatsapp_delivery_failure(account_b, shared_wamid, 131047, 'Other account')
    INTO changed;
  IF changed <> 1 OR NOT EXISTS (SELECT 1 FROM public.messages WHERE id = msg_b
                 AND delivery_error_code = 131047) THEN
    RAISE EXCEPTION '07: other account could not record its own reason';
  END IF;
  checked := checked + 1;

  -- 08: long digits are masked even if client sanitization was bypassed.
  PERFORM public.record_whatsapp_delivery_failure(account_a,
    (SELECT message_id FROM public.messages WHERE id = msg_bot), 131026,
    'Contact 51939665944 rejected');
  IF (SELECT delivery_error_title FROM public.messages WHERE id = msg_bot) <> 'Contact # rejected' THEN
    RAISE EXCEPTION '08: database failed to mask phone';
  END IF;
  checked := checked + 1;

  -- 09: neither sent nor delivered/read statuses can be annotated.
  SELECT public.record_whatsapp_delivery_failure(account_a, unique_wamid, 131026, 'Must ignore')
    INTO changed;
  IF changed <> 0 OR EXISTS (
    SELECT 1 FROM public.messages
     WHERE id IN (msg_sent, msg_delivered, msg_read)
       AND delivery_error_code IS NOT NULL
  ) THEN RAISE EXCEPTION '09: altered a non-failed message'; END IF;
  checked := checked + 1;

  -- 10: inbound messages must not receive an outbound delivery error.
  SELECT public.record_whatsapp_delivery_failure(account_a,
    (SELECT message_id FROM public.messages WHERE id = msg_customer), 131026, 'Ignore')
    INTO changed;
  IF changed <> 0 OR (SELECT delivery_error_code FROM public.messages WHERE id = msg_customer) IS NOT NULL THEN
    RAISE EXCEPTION '10: altered an inbound message';
  END IF;
  checked := checked + 1;

  -- 11: unknown wamid is a harmless no-op.
  SELECT public.record_whatsapp_delivery_failure(account_a, 'wamid.qa91.unknown', 131026, 'Ignore')
    INTO changed;
  IF changed <> 0 THEN RAISE EXCEPTION '11: missing message unexpectedly updated'; END IF;
  checked := checked + 1;

  -- 12: invalid codes are refused.
  SELECT public.record_whatsapp_delivery_failure(account_a, shared_wamid, -1, 'Invalid')
    INTO changed;
  IF changed <> 0 THEN RAISE EXCEPTION '12: invalid code accepted'; END IF;
  checked := checked + 1;

  -- 13: changing error metadata never changes delivery status.
  IF (SELECT status FROM public.messages WHERE id = msg_a) <> 'failed'
    OR (SELECT status FROM public.messages WHERE id = msg_b) <> 'failed'
    OR (SELECT status FROM public.messages WHERE id = msg_bot) <> 'failed'
    OR (SELECT status FROM public.messages WHERE id = msg_sent) <> 'sent'
    OR (SELECT status FROM public.messages WHERE id = msg_delivered) <> 'delivered'
    OR (SELECT status FROM public.messages WHERE id = msg_read) <> 'read' THEN
    RAISE EXCEPTION '13: message delivery status modified';
  END IF;
  checked := checked + 1;
  RAISE NOTICE 'PR91 SQL checks: % PASS (synthetic data; rolled back)', checked;
END
$qa$;

ROLLBACK;
