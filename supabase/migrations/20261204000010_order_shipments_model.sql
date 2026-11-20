-- ============================================================
-- 20261130000001_order_shipments_model
--
-- PR-05 (Shalom tracking) · data model. PURELY ADDITIVE. The PR-05 axis is SEPARATE from order_logistics.status (PR-04 keeps ending at
-- ready_for_dispatch; the UI derives what to show). Four tables, each with ONE independent responsibility (mixing them would break idempotency or clarity):
--
--   1. order_shipments        CURRENT state of the (single, active) Shalom guide of an order. Mutable on purpose; the only place the poller / claim / lease live.
--   2. order_shipment_events  append-only FUNCTIONAL history (registered, corrected, status changed, exception, attention, stopped, delivered, alerts).
--                             Never one row per poll: deduplicated by unique indexes so the same state never produces a second functional event.
--   3. order_shipment_polls   append-only TECHNICAL log of every query (when, trigger, outcome, http, latency, raw hash); purged by retention. Answers "which query
--                             produced this". Never read as operational state.
--   4. order_shipment_alerts  LIFECYCLE of the internal alert (open -> acknowledged -> resolved), unique per (order, destination episode, kind).
--
-- Settings live in order_shipment_settings (20261130000000). One order -> ONE active guide (MVP): a wrong guide is CORRECTED (identifier_version + 1),
-- never a second order / second row. No credential, no customer PII is stored here (the guide is masked in the audit).
-- ============================================================

-- ---------------------------------------------------------------
-- 1. order_shipments
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.order_shipments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  carrier TEXT NOT NULL DEFAULT 'shalom',

  -- The guide Shalom asks for: numero_orden + codigo (both mandatory). Formats are PROVISIONAL (derived from InkaClick aggregates, not a Shalom contract).
  tracking_number TEXT NOT NULL,
  tracking_code TEXT NOT NULL,
  identifier_version INTEGER NOT NULL DEFAULT 1,
  -- 'manual' today; 'ocr_prefill' is reserved for the day a real OCR extracts them (PR-04's OCR is untouched).
  identifier_source TEXT NOT NULL DEFAULT 'manual',

  -- Normalized WACRM status (NULL = no successful query yet). The raw Shalom answer is never the UI status.
  logistic_status TEXT,
  tracking_state TEXT NOT NULL DEFAULT 'active',
  stop_reason TEXT,
  stopped_by UUID,
  stopped_at TIMESTAMPTZ,
  status_changed_at TIMESTAMPTZ,

  -- En destino episode (entry -> exit). The 15-day alert is per (order, episode).
  destination_episode INTEGER NOT NULL DEFAULT 0,
  destination_entered_at TIMESTAMPTZ,
  destination_entered_source TEXT,

  -- Small, bounded summary of the last raw answer (flags + reparto/demora raw) and its hash. Debug / audit, never the UI status.
  last_raw JSONB,
  last_raw_hash TEXT,

  last_polled_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  -- Start time of the newest query already APPLIED: an older (late) response never overwrites a newer state.
  last_applied_started_at TIMESTAMPTZ,
  next_poll_at TIMESTAMPTZ,
  refresh_requested_at TIMESTAMPTZ,

  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  first_failure_at TIMESTAMPTZ,
  -- order | integration | credentials | exception (unknown Shalom state)
  last_error_kind TEXT,
  last_error_code TEXT,

  -- Claim / lease of the poller (FOR UPDATE SKIP LOCKED): one worker per query; a crashed worker's lease simply expires.
  claim_token UUID,
  lease_until TIMESTAMPTZ,

  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT order_shipments_order_fk FOREIGN KEY (order_id, account_id) REFERENCES public.order_confirmations (id, account_id) ON DELETE CASCADE,
  CONSTRAINT order_shipments_one_per_order UNIQUE (order_id),
  CONSTRAINT order_shipments_carrier_check CHECK (carrier = 'shalom'),
  CONSTRAINT order_shipments_number_form CHECK (tracking_number ~ '^[0-9]{6,12}$'),
  CONSTRAINT order_shipments_code_form CHECK (tracking_code ~ '^[A-Z0-9]{3,6}$'),
  CONSTRAINT order_shipments_source_check CHECK (identifier_source IN ('manual', 'ocr_prefill')),
  CONSTRAINT order_shipments_version_check CHECK (identifier_version >= 1 AND destination_episode >= 0 AND consecutive_failures >= 0),
  CONSTRAINT order_shipments_status_check CHECK (logistic_status IS NULL OR logistic_status IN ('at_origin', 'in_transit', 'at_destination', 'delivered')),
  CONSTRAINT order_shipments_state_check CHECK (tracking_state IN ('active', 'requires_attention', 'stopped', 'delivered')),
  CONSTRAINT order_shipments_error_kind_check CHECK (last_error_kind IS NULL OR last_error_kind IN ('order', 'integration', 'credentials', 'exception')),
  CONSTRAINT order_shipments_error_code_form CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z0-9_]{1,40}$'),
  CONSTRAINT order_shipments_stop_reason_form CHECK (stop_reason IS NULL OR stop_reason ~ '^[a-z0-9_]{1,40}$'),
  CONSTRAINT order_shipments_dest_source_check CHECK (destination_entered_source IS NULL OR destination_entered_source IN ('shalom', 'observed')),
  -- delivered <=> state delivered, and a finished / stopped shipment is never polled again.
  CONSTRAINT order_shipments_delivered_shape CHECK ((logistic_status = 'delivered') = (tracking_state = 'delivered')),
  CONSTRAINT order_shipments_closed_shape CHECK (
    tracking_state NOT IN ('delivered', 'stopped', 'requires_attention') OR (next_poll_at IS NULL AND claim_token IS NULL AND lease_until IS NULL)
  ),
  CONSTRAINT order_shipments_stopped_shape CHECK (
    (tracking_state = 'stopped') = (stop_reason IS NOT NULL AND stopped_by IS NOT NULL AND stopped_at IS NOT NULL)
  ),
  CONSTRAINT order_shipments_claim_shape CHECK ((claim_token IS NULL) = (lease_until IS NULL)),
  CONSTRAINT order_shipments_destination_shape CHECK (logistic_status IS DISTINCT FROM 'at_destination' OR (destination_episode >= 1 AND destination_entered_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS order_shipments_due_idx ON public.order_shipments (next_poll_at) WHERE tracking_state = 'active' AND next_poll_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS order_shipments_account_idx ON public.order_shipments (account_id, tracking_state, logistic_status);
CREATE INDEX IF NOT EXISTS order_shipments_destination_idx ON public.order_shipments (destination_entered_at) WHERE logistic_status = 'at_destination';

-- ---------------------------------------------------------------
-- 2. order_shipment_events (append-only functional history)
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.order_shipment_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  order_id UUID NOT NULL,
  event_type TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  identifier_version INTEGER,
  -- 'system' (cron / provider answer) or 'user' (Logística / Supervisor): who or what changed it.
  source TEXT NOT NULL DEFAULT 'system',
  actor_user_id UUID,
  actor_name TEXT NOT NULL DEFAULT 'system',
  -- No credential, no customer PII. The guide appears only MASKED + a short hash.
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT order_shipment_events_order_fk FOREIGN KEY (order_id, account_id) REFERENCES public.order_confirmations (id, account_id) ON DELETE CASCADE,
  CONSTRAINT order_shipment_events_type_check CHECK (event_type IN (
    'shipment_registered', 'identifier_corrected', 'refresh_requested',
    'status_changed', 'regression_ignored', 'exception_unknown_state',
    'requires_attention', 'attention_cleared', 'tracking_stopped', 'delivered',
    'alert_created', 'alert_acknowledged', 'alert_resolved'
  )),
  CONSTRAINT order_shipment_events_source_check CHECK (source IN ('system', 'user')),
  CONSTRAINT order_shipment_events_status_check CHECK (
    (from_status IS NULL OR from_status IN ('at_origin', 'in_transit', 'at_destination', 'delivered'))
    AND (to_status IS NULL OR to_status IN ('at_origin', 'in_transit', 'at_destination', 'delivered'))
  ),
  CONSTRAINT order_shipment_events_shape CHECK (jsonb_typeof(detail) = 'object' AND octet_length(detail::text) <= 2000)
);
CREATE INDEX IF NOT EXISTS order_shipment_events_order_idx ON public.order_shipment_events (order_id, created_at DESC);
-- The SAME technical state never produces a second functional event (idempotent under retries, two workers, repeated answers).
CREATE UNIQUE INDEX IF NOT EXISTS order_shipment_events_status_once
  ON public.order_shipment_events (order_id, identifier_version, to_status) WHERE event_type = 'status_changed';
CREATE UNIQUE INDEX IF NOT EXISTS order_shipment_events_regression_once
  ON public.order_shipment_events (order_id, identifier_version, from_status, to_status) WHERE event_type = 'regression_ignored';
CREATE UNIQUE INDEX IF NOT EXISTS order_shipment_events_unknown_once
  ON public.order_shipment_events (order_id, identifier_version, ((detail ->> 'raw_hash'))) WHERE event_type = 'exception_unknown_state';
CREATE UNIQUE INDEX IF NOT EXISTS order_shipment_events_delivered_once
  ON public.order_shipment_events (order_id) WHERE event_type = 'delivered';

-- ---------------------------------------------------------------
-- 3. order_shipment_polls (append-only technical log, purged by retention)
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.order_shipment_polls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  order_id UUID NOT NULL,
  identifier_version INTEGER NOT NULL,
  claim_token UUID,
  trigger TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ NOT NULL,
  -- What the provider answered (classified): ok | unknown_state | not_found | invalid_identifier | rate_limited | credentials | server_error | timeout |
  -- invalid_json | degraded_order | degraded_integration
  outcome TEXT NOT NULL,
  http_status INTEGER,
  latency_ms INTEGER,
  normalized_status TEXT,
  raw_hash TEXT,
  error_code TEXT,
  -- Applied to the shipment, or ignored (late answer, previous guide version, lost claim, finished / stopped shipment).
  applied BOOLEAN NOT NULL,
  ignored_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT order_shipment_polls_order_fk FOREIGN KEY (order_id, account_id) REFERENCES public.order_confirmations (id, account_id) ON DELETE CASCADE,
  CONSTRAINT order_shipment_polls_trigger_check CHECK (trigger IN ('cron', 'manual')),
  CONSTRAINT order_shipment_polls_outcome_check CHECK (outcome IN (
    'ok', 'unknown_state', 'not_found', 'invalid_identifier', 'rate_limited', 'credentials', 'server_error', 'timeout', 'invalid_json', 'degraded_order', 'degraded_integration'
  )),
  CONSTRAINT order_shipment_polls_form CHECK (
    (error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,40}$') AND (ignored_reason IS NULL OR ignored_reason ~ '^[a-z0-9_]{1,40}$')
  )
);
CREATE INDEX IF NOT EXISTS order_shipment_polls_order_idx ON public.order_shipment_polls (order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS order_shipment_polls_created_idx ON public.order_shipment_polls (created_at);

-- ---------------------------------------------------------------
-- 4. order_shipment_alerts (lifecycle; the notification is only the CHANNEL)
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.order_shipment_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  order_id UUID NOT NULL,
  destination_episode INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'destination_15d',
  status TEXT NOT NULL DEFAULT 'open',
  -- America/Lima calendar day the 15-day threshold was reached.
  due_date DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_by UUID,
  acknowledged_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  resolved_reason TEXT,

  CONSTRAINT order_shipment_alerts_order_fk FOREIGN KEY (order_id, account_id) REFERENCES public.order_confirmations (id, account_id) ON DELETE CASCADE,
  -- ONE alert per episode of En destino, whatever the number of polls / cron ticks / workers.
  CONSTRAINT order_shipment_alerts_once UNIQUE (order_id, destination_episode, kind),
  CONSTRAINT order_shipment_alerts_kind_check CHECK (kind IN ('destination_15d')),
  CONSTRAINT order_shipment_alerts_status_check CHECK (status IN ('open', 'acknowledged', 'resolved')),
  CONSTRAINT order_shipment_alerts_reason_check CHECK (resolved_reason IS NULL OR resolved_reason IN ('delivered', 'left_destination', 'stopped')),
  CONSTRAINT order_shipment_alerts_shape CHECK (
    (status = 'resolved') = (resolved_at IS NOT NULL AND resolved_reason IS NOT NULL)
    AND (status <> 'acknowledged' OR (acknowledged_by IS NOT NULL AND acknowledged_at IS NOT NULL))
  )
);
CREATE INDEX IF NOT EXISTS order_shipment_alerts_open_idx ON public.order_shipment_alerts (account_id, status, created_at DESC) WHERE status <> 'resolved';

-- ---------------------------------------------------------------
-- Guards: history is protected like PR-04's (a row can only disappear when its parent order / account is already gone via FK cascade).
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.order_shipments_append_only_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '42501';
  END IF;
  IF public.order_logistics_history_protected(OLD.account_id, OLD.order_id) THEN
    RAISE EXCEPTION '% rows cannot be deleted', TG_TABLE_NAME USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END;
$$;
ALTER FUNCTION public.order_shipments_append_only_guard() OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.order_shipments_state_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF public.order_logistics_history_protected(OLD.account_id, OLD.order_id) THEN
      RAISE EXCEPTION '% rows cannot be deleted', TG_TABLE_NAME USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.order_id IS DISTINCT FROM OLD.order_id OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION '% identity is immutable', TG_TABLE_NAME USING ERRCODE = '42501';
  END IF;
  -- (one guard function serves two tables: columns are read through to_jsonb so each table only looks at its own)
  -- the guide version only ever grows
  IF TG_TABLE_NAME = 'order_shipments' AND (to_jsonb(NEW) ->> 'identifier_version')::integer < (to_jsonb(OLD) ->> 'identifier_version')::integer THEN
    RAISE EXCEPTION 'identifier_version can not decrease' USING ERRCODE = '42501';
  END IF;
  IF TG_TABLE_NAME = 'order_shipment_alerts' AND (
       (to_jsonb(NEW) ->> 'destination_episode') IS DISTINCT FROM (to_jsonb(OLD) ->> 'destination_episode')
    OR (to_jsonb(NEW) ->> 'kind') IS DISTINCT FROM (to_jsonb(OLD) ->> 'kind')) THEN
    RAISE EXCEPTION 'alert identity is immutable' USING ERRCODE = '42501';
  END IF;
  IF TG_TABLE_NAME = 'order_shipments' THEN NEW.updated_at := now(); END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.order_shipments_state_guard() OWNER TO postgres;

DROP TRIGGER IF EXISTS order_shipment_events_guard ON public.order_shipment_events;
CREATE TRIGGER order_shipment_events_guard BEFORE UPDATE OR DELETE ON public.order_shipment_events FOR EACH ROW EXECUTE FUNCTION public.order_shipments_append_only_guard();
DROP TRIGGER IF EXISTS order_shipment_polls_guard ON public.order_shipment_polls;
CREATE TRIGGER order_shipment_polls_guard BEFORE UPDATE ON public.order_shipment_polls FOR EACH ROW EXECUTE FUNCTION public.order_shipments_append_only_guard();
DROP TRIGGER IF EXISTS order_shipments_guard ON public.order_shipments;
CREATE TRIGGER order_shipments_guard BEFORE UPDATE OR DELETE ON public.order_shipments FOR EACH ROW EXECUTE FUNCTION public.order_shipments_state_guard();
DROP TRIGGER IF EXISTS order_shipment_alerts_guard ON public.order_shipment_alerts;
CREATE TRIGGER order_shipment_alerts_guard BEFORE UPDATE OR DELETE ON public.order_shipment_alerts FOR EACH ROW EXECUTE FUNCTION public.order_shipments_state_guard();

-- ---------------------------------------------------------------
-- RLS: SELECT only, for the same people PR-04 lets read the logistics axis AND only with shalom_tracking_enabled (order_shipments_access).
-- No INSERT / UPDATE / DELETE policy and no such privilege: every write goes through the service-role-only RPCs.
-- ---------------------------------------------------------------
ALTER TABLE public.order_shipments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_shipment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_shipment_polls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_shipment_alerts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.order_shipments, public.order_shipment_events, public.order_shipment_polls, public.order_shipment_alerts FROM anon, authenticated;
GRANT SELECT ON public.order_shipments, public.order_shipment_events, public.order_shipment_polls, public.order_shipment_alerts TO authenticated;

DROP POLICY IF EXISTS order_shipments_select ON public.order_shipments;
CREATE POLICY order_shipments_select ON public.order_shipments FOR SELECT USING (public.order_shipments_access(account_id));
DROP POLICY IF EXISTS order_shipment_events_select ON public.order_shipment_events;
CREATE POLICY order_shipment_events_select ON public.order_shipment_events FOR SELECT USING (public.order_shipments_access(account_id));
DROP POLICY IF EXISTS order_shipment_polls_select ON public.order_shipment_polls;
CREATE POLICY order_shipment_polls_select ON public.order_shipment_polls FOR SELECT USING (public.order_shipments_access(account_id));
DROP POLICY IF EXISTS order_shipment_alerts_select ON public.order_shipment_alerts;
CREATE POLICY order_shipment_alerts_select ON public.order_shipment_alerts FOR SELECT USING (public.order_shipments_access(account_id));
