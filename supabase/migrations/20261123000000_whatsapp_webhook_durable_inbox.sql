-- Durable Meta WhatsApp deliveries, inserted ONLY after per-tenant HMAC validation.
-- Private-by-RLS despite residing in public for the existing self-hosted PostgREST deployment.
-- The payload contains customer PII. Never expose this table, RPC output, or raw payload in logs.
CREATE TABLE IF NOT EXISTS public.whatsapp_webhook_inbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payload_sha256 text NOT NULL UNIQUE CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'processing', 'processed', 'dead')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  deliveries integer NOT NULL DEFAULT 1 CHECK (deliveries >= 1),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  claim_token uuid,
  processed_at timestamptz,
  last_error_code text CHECK (last_error_code IS NULL OR length(last_error_code) <= 64)
);
CREATE INDEX IF NOT EXISTS whatsapp_webhook_inbox_due_idx
  ON public.whatsapp_webhook_inbox (next_attempt_at, first_seen_at)
  WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS whatsapp_webhook_inbox_leases_idx
  ON public.whatsapp_webhook_inbox (lease_until)
  WHERE state = 'processing';
CREATE INDEX IF NOT EXISTS whatsapp_webhook_inbox_processed_idx
  ON public.whatsapp_webhook_inbox (processed_at)
  WHERE state = 'processed';

ALTER TABLE public.whatsapp_webhook_inbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.whatsapp_webhook_inbox FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_webhook_inbox TO service_role;

-- The caller already verified Meta's HMAC using the correct tenant's app secret.
-- A duplicate delivery increments diagnostics but NEVER reopens a processed event.
CREATE OR REPLACE FUNCTION public.whatsapp_webhook_inbox_enqueue(p_digest text, p_payload jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  IF p_digest IS NULL OR p_digest !~ '^[a-f0-9]{64}$'
    OR p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object'
    OR jsonb_typeof(p_payload -> 'entry') IS DISTINCT FROM 'array'
  THEN RAISE EXCEPTION 'invalid webhook payload' USING ERRCODE = '22023'; END IF;
  INSERT INTO public.whatsapp_webhook_inbox (payload_sha256, payload)
  VALUES (p_digest, p_payload)
  ON CONFLICT (payload_sha256) DO UPDATE
    SET deliveries = public.whatsapp_webhook_inbox.deliveries + 1,
        last_seen_at = now()
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Claim atomically with SKIP LOCKED. Only one worker may own a row at a time.
-- Expired leases are recovered after crashes. The unique token fences out
-- late completion from a stale worker whose lease was taken over.
CREATE OR REPLACE FUNCTION public.whatsapp_webhook_inbox_claim(
  p_limit integer DEFAULT 5, p_event_id uuid DEFAULT NULL)
RETURNS TABLE(id uuid, payload jsonb, token uuid)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT q.id FROM public.whatsapp_webhook_inbox q
    WHERE (p_event_id IS NULL OR q.id = p_event_id)
      AND (
        (q.state = 'pending' AND q.next_attempt_at <= now())
        OR (q.state = 'processing' AND q.lease_until < now())
      )
      AND q.attempts < 10
    ORDER BY q.first_seen_at
    LIMIT LEAST(20, GREATEST(1, COALESCE(p_limit, 5)))
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.whatsapp_webhook_inbox q
  SET state = 'processing',
      attempts = q.attempts + 1,
      claim_token = gen_random_uuid(),
      lease_until = now() + interval '180 seconds'
  FROM due
  WHERE q.id = due.id
  RETURNING q.id, q.payload, q.claim_token;
END $$;

CREATE OR REPLACE FUNCTION public.whatsapp_webhook_inbox_complete(p_id uuid, p_token uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  UPDATE public.whatsapp_webhook_inbox
  SET state = 'processed', claim_token = NULL, lease_until = NULL,
      processed_at = now(), last_error_code = NULL
  WHERE id = p_id AND state = 'processing' AND claim_token = p_token
    AND lease_until >= now();
  RETURN FOUND;
END $$;

-- Failed payloads remain stored and visible to operators; never silently discard.
-- 10 attempts -> dead letter, requiring explicit triage (not auto-deleted).
CREATE OR REPLACE FUNCTION public.whatsapp_webhook_inbox_fail(
  p_id uuid, p_token uuid, p_error_code text DEFAULT 'processing_failed')
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  UPDATE public.whatsapp_webhook_inbox
  SET state = CASE WHEN attempts >= 10 THEN 'dead' ELSE 'pending' END,
      claim_token = NULL, lease_until = NULL,
      next_attempt_at = now() + make_interval(secs => LEAST(3600, (5 * power(2.0, LEAST(attempts, 10)))::integer)),
      last_error_code = left(regexp_replace(COALESCE(p_error_code, 'processing_failed'), '[^a-z0-9_]', '', 'g'), 64)
  WHERE id = p_id AND state = 'processing' AND claim_token = p_token;
  RETURN FOUND;
END $$;

-- Bounded retention for completed deliveries only. Pending/dead never pruned.
CREATE OR REPLACE FUNCTION public.whatsapp_webhook_inbox_prune(p_limit integer DEFAULT 200)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE v_count integer;
BEGIN
  WITH old AS (
    SELECT id FROM public.whatsapp_webhook_inbox
    WHERE state = 'processed' AND processed_at < now() - interval '7 days'
    ORDER BY processed_at
    LIMIT LEAST(1000, GREATEST(1, COALESCE(p_limit, 200)))
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.whatsapp_webhook_inbox q USING old WHERE q.id = old.id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION public.whatsapp_webhook_inbox_enqueue(text,jsonb),
  public.whatsapp_webhook_inbox_claim(integer,uuid),
  public.whatsapp_webhook_inbox_complete(uuid,uuid),
  public.whatsapp_webhook_inbox_fail(uuid,uuid,text),
  public.whatsapp_webhook_inbox_prune(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.whatsapp_webhook_inbox_enqueue(text,jsonb),
  public.whatsapp_webhook_inbox_claim(integer,uuid),
  public.whatsapp_webhook_inbox_complete(uuid,uuid),
  public.whatsapp_webhook_inbox_fail(uuid,uuid,text),
  public.whatsapp_webhook_inbox_prune(integer) TO service_role;
