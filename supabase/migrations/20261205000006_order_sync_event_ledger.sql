-- SYNC-02 · Bidirectional coexistence event ledger.
-- ADDITIVE ONLY: creates a PII-agnostic event envelope and receipt table. It does NOT attach triggers to business tables,
-- does NOT emit any business event, does NOT call InkaClick, and does NOT modify payments, vouchers, logistics, Shalom or messages.
--
-- Canonical identity is ALWAYS the WACRM order UUID. A remote/internal InkaClick id is never stored as a second business identity here.
-- Loop prevention is structural: imported events preserve origin_system; WACRM outbound workers must read ONLY order_sync_outbound_events,
-- whose predicate is origin_system = 'wacrm'. An event imported from InkaClick can therefore never be re-published as a WACRM-origin event.

CREATE TABLE IF NOT EXISTS public.order_sync_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_order_id UUID NOT NULL,
  origin_system TEXT NOT NULL,
  origin_event_id UUID NOT NULL,
  event_type TEXT NOT NULL,
  event_version INTEGER NOT NULL DEFAULT 1,
  idempotency_key TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT order_sync_events_origin_check CHECK (origin_system IN ('wacrm', 'inkaclick')),
  CONSTRAINT order_sync_events_type_form CHECK (event_type ~ '^[a-z][a-z0-9_]{0,31}\.[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT order_sync_events_version_check CHECK (event_version BETWEEN 1 AND 1000),
  CONSTRAINT order_sync_events_idempotency_form CHECK (char_length(btrim(idempotency_key)) BETWEEN 1 AND 160),
  CONSTRAINT order_sync_events_payload_shape CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 16384),
  CONSTRAINT order_sync_events_origin_event_unique UNIQUE (origin_system, origin_event_id),
  CONSTRAINT order_sync_events_idempotency_unique UNIQUE (origin_system, idempotency_key)
);
CREATE INDEX IF NOT EXISTS order_sync_events_order_idx ON public.order_sync_events (canonical_order_id, occurred_at, id);
CREATE INDEX IF NOT EXISTS order_sync_events_origin_idx ON public.order_sync_events (origin_system, recorded_at, id);

CREATE OR REPLACE FUNCTION public.order_sync_events_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'order_sync_events is append-only' USING ERRCODE = '42501';
END;
$$;
ALTER FUNCTION public.order_sync_events_immutable() OWNER TO postgres;
DROP TRIGGER IF EXISTS order_sync_events_immutable ON public.order_sync_events;
CREATE TRIGGER order_sync_events_immutable BEFORE UPDATE OR DELETE ON public.order_sync_events
  FOR EACH ROW EXECUTE FUNCTION public.order_sync_events_immutable();

CREATE TABLE IF NOT EXISTS public.order_sync_receipts (
  event_id UUID NOT NULL REFERENCES public.order_sync_events(id) ON DELETE RESTRICT,
  consumer_system TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  applied_at TIMESTAMPTZ,
  PRIMARY KEY (event_id, consumer_system),

  CONSTRAINT order_sync_receipts_consumer_check CHECK (consumer_system IN ('wacrm', 'inkaclick')),
  CONSTRAINT order_sync_receipts_status_check CHECK (status IN ('pending', 'processing', 'applied', 'ignored', 'conflict', 'dead_letter')),
  CONSTRAINT order_sync_receipts_attempts_check CHECK (attempts >= 0),
  CONSTRAINT order_sync_receipts_error_form CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z0-9_]{1,64}$'),
  CONSTRAINT order_sync_receipts_applied_shape CHECK ((status = 'applied') = (applied_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS order_sync_receipts_open_idx
  ON public.order_sync_receipts (consumer_system, updated_at, event_id)
  WHERE status IN ('pending', 'processing', 'conflict');

CREATE OR REPLACE VIEW public.order_sync_outbound_events AS
SELECT e.*
FROM public.order_sync_events e
WHERE e.origin_system = 'wacrm';

ALTER TABLE public.order_sync_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_sync_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.order_sync_events, public.order_sync_receipts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.order_sync_outbound_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.order_sync_events, public.order_sync_receipts, public.order_sync_outbound_events TO service_role;

CREATE OR REPLACE FUNCTION public.record_order_sync_event(
  p_canonical_order UUID,
  p_origin_system TEXT,
  p_origin_event UUID,
  p_event_type TEXT,
  p_event_version INTEGER,
  p_idempotency_key TEXT,
  p_occurred_at TIMESTAMPTZ,
  p_payload JSONB DEFAULT '{}'::jsonb
)
RETURNS TABLE(event_id UUID, created BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.order_sync_events%ROWTYPE;
BEGIN
  IF p_canonical_order IS NULL OR p_origin_event IS NULL OR p_occurred_at IS NULL THEN
    RAISE EXCEPTION 'invalid_sync_event_identity' USING ERRCODE = '22023';
  END IF;
  IF p_origin_system NOT IN ('wacrm', 'inkaclick') THEN
    RAISE EXCEPTION 'invalid_sync_origin' USING ERRCODE = '22023';
  END IF;
  IF p_event_type IS NULL OR p_event_type !~ '^[a-z][a-z0-9_]{0,31}\.[a-z][a-z0-9_]{0,63}$' THEN
    RAISE EXCEPTION 'invalid_sync_event_type' USING ERRCODE = '22023';
  END IF;
  IF p_event_version IS NULL OR p_event_version < 1 OR p_event_version > 1000 THEN
    RAISE EXCEPTION 'invalid_sync_event_version' USING ERRCODE = '22023';
  END IF;
  IF p_idempotency_key IS NULL OR char_length(btrim(p_idempotency_key)) NOT BETWEEN 1 AND 160 THEN
    RAISE EXCEPTION 'invalid_sync_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR octet_length(p_payload::text) > 16384 THEN
    RAISE EXCEPTION 'invalid_sync_payload' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.order_sync_events (
    canonical_order_id, origin_system, origin_event_id, event_type, event_version, idempotency_key, occurred_at, payload
  ) VALUES (
    p_canonical_order, p_origin_system, p_origin_event, p_event_type, p_event_version, btrim(p_idempotency_key), p_occurred_at, p_payload
  )
  ON CONFLICT DO NOTHING
  RETURNING * INTO v_row;

  IF v_row.id IS NOT NULL THEN
    RETURN QUERY SELECT v_row.id, TRUE;
    RETURN;
  END IF;

  SELECT * INTO v_row
  FROM public.order_sync_events e
  WHERE e.origin_system = p_origin_system AND e.origin_event_id = p_origin_event;

  IF v_row.id IS NULL THEN
    -- The origin_event_id was new but another row already owns the idempotency key.
    SELECT * INTO v_row
    FROM public.order_sync_events e
    WHERE e.origin_system = p_origin_system AND e.idempotency_key = btrim(p_idempotency_key);
  END IF;

  IF v_row.id IS NULL
     OR v_row.canonical_order_id IS DISTINCT FROM p_canonical_order
     OR v_row.origin_event_id IS DISTINCT FROM p_origin_event
     OR v_row.event_type IS DISTINCT FROM p_event_type
     OR v_row.event_version IS DISTINCT FROM p_event_version
     OR v_row.idempotency_key IS DISTINCT FROM btrim(p_idempotency_key)
     OR v_row.occurred_at IS DISTINCT FROM p_occurred_at
     OR v_row.payload IS DISTINCT FROM p_payload THEN
    RAISE EXCEPTION 'sync_event_identity_conflict' USING ERRCODE = '23505';
  END IF;

  RETURN QUERY SELECT v_row.id, FALSE;
END;
$$;
ALTER FUNCTION public.record_order_sync_event(UUID,TEXT,UUID,TEXT,INTEGER,TEXT,TIMESTAMPTZ,JSONB) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.ensure_order_sync_receipt(
  p_origin_system TEXT,
  p_origin_event UUID,
  p_consumer_system TEXT
)
RETURNS TABLE(event_id UUID, created BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event UUID;
  v_rows INTEGER;
BEGIN
  IF p_consumer_system NOT IN ('wacrm', 'inkaclick') OR p_origin_system NOT IN ('wacrm', 'inkaclick') THEN
    RAISE EXCEPTION 'invalid_sync_system' USING ERRCODE = '22023';
  END IF;
  IF p_consumer_system = p_origin_system THEN
    RAISE EXCEPTION 'sync_receipt_consumer_is_origin' USING ERRCODE = '22023';
  END IF;

  SELECT e.id INTO v_event
  FROM public.order_sync_events e
  WHERE e.origin_system = p_origin_system AND e.origin_event_id = p_origin_event;
  IF v_event IS NULL THEN RAISE EXCEPTION 'sync_event_not_found' USING ERRCODE = 'P0002'; END IF;

  INSERT INTO public.order_sync_receipts (event_id, consumer_system)
  VALUES (v_event, p_consumer_system)
  ON CONFLICT (event_id, consumer_system) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  RETURN QUERY SELECT v_event, v_rows = 1;
END;
$$;
ALTER FUNCTION public.ensure_order_sync_receipt(TEXT,UUID,TEXT) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.record_order_sync_event(UUID,TEXT,UUID,TEXT,INTEGER,TEXT,TIMESTAMPTZ,JSONB),
  public.ensure_order_sync_receipt(TEXT,UUID,TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_order_sync_event(UUID,TEXT,UUID,TEXT,INTEGER,TEXT,TIMESTAMPTZ,JSONB),
  public.ensure_order_sync_receipt(TEXT,UUID,TEXT)
  TO service_role;
