-- SYNC-04 - Durable event transport lease/receipt primitives.
-- ADDITIVE and INERT until an application worker calls claim_order_sync_outbound.
-- No cron, trigger, HTTP call or business-table write is installed by this migration.

ALTER TABLE public.order_sync_receipts
  ADD COLUMN IF NOT EXISTS claim_token UUID,
  ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS order_sync_receipts_claim_idx
  ON public.order_sync_receipts (consumer_system, status, lease_until, updated_at)
  WHERE status IN ('pending', 'processing');

CREATE OR REPLACE FUNCTION public.claim_order_sync_outbound(
  p_consumer TEXT,
  p_limit INTEGER DEFAULT 10,
  p_lease_seconds INTEGER DEFAULT 120,
  p_max_attempts INTEGER DEFAULT 8
)
RETURNS TABLE (
  event_id UUID,
  origin_system TEXT,
  origin_event_id UUID,
  canonical_order_id UUID,
  event_type TEXT,
  event_version INTEGER,
  idempotency_key TEXT,
  occurred_at TIMESTAMPTZ,
  payload JSONB,
  attempts INTEGER,
  claim_token UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_consumer NOT IN ('wacrm', 'inkaclick')
     OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
     OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 10 AND 900
     OR p_max_attempts IS NULL OR p_max_attempts NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION 'invalid_sync_claim_request' USING ERRCODE='22023';
  END IF;

  INSERT INTO public.order_sync_receipts (event_id, consumer_system)
  SELECT e.id, p_consumer
  FROM public.order_sync_outbound_events e
  WHERE e.origin_system <> p_consumer
    AND NOT EXISTS (
      SELECT 1 FROM public.order_sync_receipts r
      WHERE r.event_id=e.id AND r.consumer_system=p_consumer
    )
  ORDER BY e.recorded_at, e.id
  LIMIT LEAST(500, p_limit * 5)
  ON CONFLICT (event_id, consumer_system) DO NOTHING;

  UPDATE public.order_sync_receipts r
  SET status='dead_letter', claim_token=NULL, lease_until=NULL,
      last_error_code=COALESCE(r.last_error_code,'attempts_exhausted'),
      updated_at=clock_timestamp(), applied_at=NULL
  WHERE r.consumer_system=p_consumer
    AND r.status='processing'
    AND r.lease_until < clock_timestamp()
    AND r.attempts >= p_max_attempts;

  RETURN QUERY
  WITH candidate AS (
    SELECT r.event_id
    FROM public.order_sync_receipts r
    JOIN public.order_sync_outbound_events e ON e.id=r.event_id
    WHERE r.consumer_system=p_consumer
      AND e.origin_system <> p_consumer
      AND r.attempts < p_max_attempts
      AND (
        r.status='pending'
        OR (r.status='processing' AND r.lease_until < clock_timestamp())
      )
    ORDER BY e.recorded_at, e.id
    FOR UPDATE OF r SKIP LOCKED
    LIMIT p_limit
  ),
  claimed AS (
    UPDATE public.order_sync_receipts r
    SET status='processing',
        attempts=r.attempts+1,
        claim_token=gen_random_uuid(),
        lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds),
        updated_at=clock_timestamp(),
        last_error_code=NULL,
        applied_at=NULL
    FROM candidate c
    WHERE r.event_id=c.event_id AND r.consumer_system=p_consumer
    RETURNING r.event_id, r.attempts, r.claim_token
  )
  SELECT e.id, e.origin_system, e.origin_event_id, e.canonical_order_id, e.event_type, e.event_version,
         e.idempotency_key, e.occurred_at, e.payload, c.attempts, c.claim_token
  FROM claimed c
  JOIN public.order_sync_outbound_events e ON e.id=c.event_id
  ORDER BY e.recorded_at, e.id;
END;
$$;
ALTER FUNCTION public.claim_order_sync_outbound(TEXT,INTEGER,INTEGER,INTEGER) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.finish_order_sync_outbound(
  p_event UUID,
  p_consumer TEXT,
  p_claim_token UUID,
  p_outcome TEXT,
  p_error_code TEXT DEFAULT NULL
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status TEXT;
BEGIN
  IF p_consumer NOT IN ('wacrm','inkaclick')
     OR p_claim_token IS NULL
     OR p_outcome NOT IN ('applied','retry','conflict','dead_letter')
     OR (p_error_code IS NOT NULL AND p_error_code !~ '^[a-z0-9_]{1,64}$') THEN
    RAISE EXCEPTION 'invalid_sync_finish_request' USING ERRCODE='22023';
  END IF;

  UPDATE public.order_sync_receipts r
  SET status=CASE p_outcome
      WHEN 'applied' THEN 'applied'
      WHEN 'retry' THEN 'pending'
      WHEN 'conflict' THEN 'conflict'
      ELSE 'dead_letter'
    END,
    claim_token=NULL,
    lease_until=NULL,
    last_error_code=CASE WHEN p_outcome='applied' THEN NULL ELSE COALESCE(p_error_code,p_outcome) END,
    updated_at=clock_timestamp(),
    applied_at=CASE WHEN p_outcome='applied' THEN clock_timestamp() ELSE NULL END
  WHERE r.event_id=p_event
    AND r.consumer_system=p_consumer
    AND r.status='processing'
    AND r.claim_token=p_claim_token
  RETURNING r.status INTO v_status;

  RETURN v_status;
END;
$$;
ALTER FUNCTION public.finish_order_sync_outbound(UUID,TEXT,UUID,TEXT,TEXT) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.claim_order_sync_outbound(TEXT,INTEGER,INTEGER,INTEGER),
  public.finish_order_sync_outbound(UUID,TEXT,UUID,TEXT,TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_order_sync_outbound(TEXT,INTEGER,INTEGER,INTEGER),
  public.finish_order_sync_outbound(UUID,TEXT,UUID,TEXT,TEXT)
  TO service_role;
