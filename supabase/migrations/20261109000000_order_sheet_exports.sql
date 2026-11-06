-- Google Sheets export of acknowledged order confirmations (one-way WhatsCRM -> Sheets).
-- The sheet is a reproducible projection; order_confirmations / order_confirmation_items stay the single source of truth.
-- Nothing here touches the InkaClick path: jobs are DISCOVERED by a pull (order_sheet_enqueue), never by a trigger on orders.
-- Everything is inert until a destination row is created with enabled = true (per account), so applying this is harmless.

CREATE TABLE public.order_sheet_destinations (
  account_id UUID PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  spreadsheet_id TEXT NOT NULL CHECK (spreadsheet_id ~ '^[A-Za-z0-9_-]{20,120}$'),
  registry_tab TEXT NOT NULL DEFAULT 'Registro de pedidos' CHECK (btrim(registry_tab) <> '' AND char_length(registry_tab) <= 100),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  -- only orders confirmed at or after this instant are exported (NULL = every acknowledged order)
  eligible_since TIMESTAMPTZ,
  layout_version SMALLINT NOT NULL DEFAULT 1,
  -- single-writer lease with a fencing token: one worker at a time appends to a given spreadsheet
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.order_sheet_exports (
  order_id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES public.order_sheet_destinations(account_id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'exported', 'dead', 'excluded')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_until TIMESTAMPTZ,
  exported_lines SMALLINT,
  exported_units INTEGER,
  exported_total NUMERIC(14,2),
  exported_at TIMESTAMPTZ,
  last_error_code TEXT,
  exclusion_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT order_sheet_exports_parent_fkey FOREIGN KEY (order_id, account_id)
    REFERENCES public.order_confirmations (id, account_id) ON DELETE CASCADE,
  CONSTRAINT order_sheet_exports_exported_check CHECK (status <> 'exported' OR (exported_lines >= 1 AND exported_at IS NOT NULL)),
  CONSTRAINT order_sheet_exports_excluded_check CHECK (status <> 'excluded' OR exclusion_reason IS NOT NULL)
);
CREATE INDEX order_sheet_exports_due_idx ON public.order_sheet_exports (account_id, next_attempt_at) WHERE status IN ('pending', 'processing');

-- Orders that must never be written as commercial sales (tests, manual cases). Decided by a person, one row per order.
CREATE TABLE public.order_sheet_exclusions (
  order_id UUID PRIMARY KEY,
  account_id UUID NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('test', 'manual')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT order_sheet_exclusions_parent_fkey FOREIGN KEY (order_id, account_id)
    REFERENCES public.order_confirmations (id, account_id) ON DELETE CASCADE
);

-- Operational log. Codes and counters only: never names, phones, DNIs or free text.
CREATE TABLE public.order_sheet_events (
  id BIGSERIAL PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES public.order_sheet_destinations(account_id) ON DELETE CASCADE,
  order_id UUID,
  event TEXT NOT NULL,
  code TEXT,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX order_sheet_events_account_idx ON public.order_sheet_events (account_id, created_at DESC);

ALTER TABLE public.order_sheet_destinations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_sheet_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_sheet_exclusions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_sheet_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.order_sheet_destinations, public.order_sheet_exports, public.order_sheet_exclusions, public.order_sheet_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.order_sheet_events_id_seq FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.order_sheet_destinations, public.order_sheet_exports, public.order_sheet_exclusions, public.order_sheet_events TO service_role;
GRANT USAGE ON SEQUENCE public.order_sheet_events_id_seq TO service_role;

-- Discovery: create a job for every eligible acknowledged order that has none. Idempotent; excluded orders get an 'excluded' row so they show up in the reconciliation.
CREATE FUNCTION public.order_sheet_enqueue(p_account UUID, p_limit INTEGER DEFAULT 2000)
RETURNS INTEGER LANGUAGE plpgsql SET search_path = public AS $$
DECLARE n INTEGER;
BEGIN
  WITH d AS (SELECT * FROM order_sheet_destinations WHERE account_id = p_account AND enabled),
  cand AS (
    SELECT o.id, o.account_id, x.reason
      FROM order_confirmations o
      JOIN d ON d.account_id = o.account_id
      LEFT JOIN order_sheet_exclusions x ON x.order_id = o.id
     WHERE o.delivery_status = 'acknowledged'
       AND (d.eligible_since IS NULL OR o.confirmed_at >= d.eligible_since)
       AND NOT EXISTS (SELECT 1 FROM order_sheet_exports e WHERE e.order_id = o.id)
     ORDER BY o.confirmed_at, o.id
     LIMIT GREATEST(p_limit, 1)
  ), ins AS (
    INSERT INTO order_sheet_exports (order_id, account_id, status, exclusion_reason)
    SELECT id, account_id, CASE WHEN reason IS NULL THEN 'pending' ELSE 'excluded' END, reason FROM cand
    ON CONFLICT (order_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO n FROM ins;
  RETURN n;
END $$;

-- Writer lease. Returns the fencing token, or NULL when another worker holds an unexpired lease (or the destination is off).
CREATE FUNCTION public.order_sheet_acquire(p_account UUID, p_lease_seconds INTEGER DEFAULT 240)
RETURNS UUID LANGUAGE plpgsql SET search_path = public AS $$
DECLARE tok UUID := gen_random_uuid();
BEGIN
  UPDATE order_sheet_destinations
     SET lease_token = tok, lease_expires_at = NOW() + make_interval(secs => p_lease_seconds)
   WHERE account_id = p_account AND enabled AND (lease_token IS NULL OR lease_expires_at < NOW());
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN tok;
END $$;

CREATE FUNCTION public.order_sheet_renew(p_account UUID, p_token UUID, p_lease_seconds INTEGER DEFAULT 240)
RETURNS BOOLEAN LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  UPDATE order_sheet_destinations SET lease_expires_at = NOW() + make_interval(secs => p_lease_seconds)
   WHERE account_id = p_account AND lease_token = p_token AND lease_expires_at >= NOW();
  RETURN FOUND;
END $$;

CREATE FUNCTION public.order_sheet_release(p_account UUID, p_token UUID)
RETURNS VOID LANGUAGE sql SET search_path = public AS $$
  UPDATE order_sheet_destinations SET lease_token = NULL, lease_expires_at = NULL WHERE account_id = p_account AND lease_token = p_token;
$$;

-- Claim due jobs. Only the current lease holder may claim. Jobs left 'processing' by a crashed worker become due again when their lock expires
-- (the exporter ALWAYS re-reads the sheet before appending, so a half-finished write is reconciled, never repeated).
CREATE FUNCTION public.order_sheet_claim(p_account UUID, p_token UUID, p_limit INTEGER DEFAULT 50, p_lock_seconds INTEGER DEFAULT 240, p_max_attempts INTEGER DEFAULT 8)
RETURNS SETOF public.order_sheet_exports LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM order_sheet_destinations WHERE account_id = p_account AND lease_token = p_token AND lease_expires_at >= NOW() AND enabled) THEN
    RETURN;
  END IF;
  UPDATE order_sheet_exports SET status = 'dead', last_error_code = COALESCE(last_error_code, 'lease_expired_max_attempts'), locked_until = NULL, updated_at = NOW()
   WHERE account_id = p_account AND status = 'processing' AND locked_until < NOW() AND attempts >= p_max_attempts;
  RETURN QUERY
  WITH due AS (
    SELECT e.order_id FROM order_sheet_exports e
     WHERE e.account_id = p_account
       AND ((e.status = 'pending' AND e.next_attempt_at <= NOW()) OR (e.status = 'processing' AND e.locked_until < NOW() AND e.attempts < p_max_attempts))
     ORDER BY e.created_at, e.order_id
     LIMIT GREATEST(p_limit, 1)
     FOR UPDATE SKIP LOCKED
  )
  UPDATE order_sheet_exports e SET status = 'processing', attempts = e.attempts + 1, locked_until = NOW() + make_interval(secs => p_lock_seconds), updated_at = NOW()
    FROM due WHERE e.order_id = due.order_id
  RETURNING e.*;
END $$;

-- Mark a claimed job exported. Verifies the fencing token so a worker that lost its lease cannot record success.
CREATE FUNCTION public.order_sheet_complete(p_order UUID, p_token UUID, p_lines INTEGER, p_units INTEGER, p_total NUMERIC)
RETURNS BOOLEAN LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  UPDATE order_sheet_exports e SET status = 'exported', exported_lines = p_lines, exported_units = p_units, exported_total = p_total,
         exported_at = NOW(), last_error_code = NULL, locked_until = NULL, updated_at = NOW()
    FROM order_sheet_destinations d
   WHERE e.order_id = p_order AND e.status = 'processing' AND d.account_id = e.account_id AND d.lease_token = p_token AND d.lease_expires_at >= NOW();
  RETURN FOUND;
END $$;

-- Failure: back to pending with a delay chosen by the caller, or dead once attempts are exhausted. Non-retryable errors go straight to dead.
CREATE FUNCTION public.order_sheet_fail(p_order UUID, p_token UUID, p_code TEXT, p_retry_in_seconds INTEGER, p_permanent BOOLEAN DEFAULT FALSE, p_max_attempts INTEGER DEFAULT 8)
RETURNS TEXT LANGUAGE plpgsql SET search_path = public AS $$
DECLARE st TEXT;
BEGIN
  UPDATE order_sheet_exports e
     SET status = CASE WHEN p_permanent OR e.attempts >= p_max_attempts THEN 'dead' ELSE 'pending' END,
         next_attempt_at = NOW() + make_interval(secs => GREATEST(p_retry_in_seconds, 0)),
         last_error_code = left(p_code, 80), locked_until = NULL, updated_at = NOW()
    FROM order_sheet_destinations d
   WHERE e.order_id = p_order AND e.status = 'processing' AND d.account_id = e.account_id AND d.lease_token = p_token AND d.lease_expires_at >= NOW()
  RETURNING e.status INTO st;
  RETURN st;
END $$;

-- Operator action: put dead jobs (or one order) back in the queue. Does not touch exported jobs.
CREATE FUNCTION public.order_sheet_requeue(p_account UUID, p_order UUID DEFAULT NULL)
RETURNS INTEGER LANGUAGE plpgsql SET search_path = public AS $$
DECLARE n INTEGER;
BEGIN
  WITH u AS (
    UPDATE order_sheet_exports SET status = 'pending', attempts = 0, next_attempt_at = NOW(), locked_until = NULL, updated_at = NOW()
     WHERE account_id = p_account AND status = 'dead' AND (p_order IS NULL OR order_id = p_order) RETURNING 1)
  SELECT count(*) INTO n FROM u;
  RETURN n;
END $$;

REVOKE ALL ON FUNCTION public.order_sheet_enqueue(UUID, INTEGER), public.order_sheet_acquire(UUID, INTEGER), public.order_sheet_renew(UUID, UUID, INTEGER),
  public.order_sheet_release(UUID, UUID), public.order_sheet_claim(UUID, UUID, INTEGER, INTEGER, INTEGER), public.order_sheet_complete(UUID, UUID, INTEGER, INTEGER, NUMERIC),
  public.order_sheet_fail(UUID, UUID, TEXT, INTEGER, BOOLEAN, INTEGER), public.order_sheet_requeue(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.order_sheet_enqueue(UUID, INTEGER), public.order_sheet_acquire(UUID, INTEGER), public.order_sheet_renew(UUID, UUID, INTEGER),
  public.order_sheet_release(UUID, UUID), public.order_sheet_claim(UUID, UUID, INTEGER, INTEGER, INTEGER), public.order_sheet_complete(UUID, UUID, INTEGER, INTEGER, NUMERIC),
  public.order_sheet_fail(UUID, UUID, TEXT, INTEGER, BOOLEAN, INTEGER), public.order_sheet_requeue(UUID, UUID) TO service_role;
