-- PR-06 · FINANCIAL axis of the order: payments, balance and financial status. ADDITIVE: no PR-01..PR-05 migration, table, function or test is edited.
--
-- MODEL (decisions closed with the business):
--   * The total of the order is order_confirmations.price (immutable, trigger order_confirmations_freeze). It is NEVER copied or edited here: the balance is
--     always `price - paid_confirmed`, computed by the database. Currency: PEN only ('S/' in the UI); the column keeps the model extensible.
--   * An order has ZERO, ONE or MANY payments (order_payments). `kind` (advance | balance | full | other) is INFORMATIVE: it never drives the calculation.
--     paid_confirmed = SUM(amount) of the payments in status `confirmed`. A payment is manual: recorded -> confirmed | rejected; confirmed -> voided.
--   * order_financials holds the CURRENT financial status of the orders that are TRACKED: unpaid | partially_paid | paid. "NOT TRACKED" (historical orders,
--     confirmed before the account activated PR-06) simply has NO ROW: nothing is backfilled, no order is marked unpaid, no payment is inferred from vouchers.
--   * order_payment_events is the append-only audit (who / how much / when / evidence / balance before and after).
--   * A validated PR-04 voucher NEVER creates a payment: it can only be LINKED as evidence of a payment a person confirms.
--   * The browser can only READ; every write goes through SECURITY DEFINER functions only service_role can execute (next migration).
--   * Per account: order_payment_settings.order_payments_enabled (default FALSE) AND logistics_mvp_enabled. OFF = no UI, no writes, no finalization; data is kept.
--   * Refunds / monetary returns are NOT implemented; the model (kind, statuses, events) is extensible to them.

-- 1. Settings ------------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.order_payment_settings (
  account_id UUID PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  order_payments_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  -- first moment the feature was turned ON for the account: orders confirmed BEFORE it are not tracked (historical); never reset by turning it OFF / ON.
  activated_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.order_payment_settings_activation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.activated_at IS DISTINCT FROM OLD.activated_at AND OLD.activated_at IS NOT NULL THEN
    NEW.activated_at := OLD.activated_at;
  END IF;
  IF NEW.order_payments_enabled AND NEW.activated_at IS NULL THEN
    NEW.activated_at := now();
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.order_payment_settings_activation() OWNER TO postgres;
DROP TRIGGER IF EXISTS order_payment_settings_activation ON public.order_payment_settings;
CREATE TRIGGER order_payment_settings_activation BEFORE INSERT OR UPDATE ON public.order_payment_settings FOR EACH ROW EXECUTE FUNCTION public.order_payment_settings_activation();

-- 2. Access helpers (auth.uid() based, used by RLS) -------------------------------------------------------------------------------------------------
-- Logistica / Supervisor with BOTH flags ON, a member of the account with an owner|admin|agent account role (viewers never).
CREATE OR REPLACE FUNCTION public.order_payments_access(p_account_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.profiles p
      JOIN public.order_integration_settings s ON s.account_id = p.account_id AND s.logistics_mvp_enabled
      JOIN public.order_payment_settings ps ON ps.account_id = p.account_id AND ps.order_payments_enabled
     WHERE p.user_id = auth.uid()
       AND p.account_id = p_account_id
       AND p.operational_role IN ('logistics', 'supervisor')
       AND p.account_role IN ('owner', 'admin', 'agent')
  )
$$;
ALTER FUNCTION public.order_payments_access(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.order_payments_access(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.order_payments_access(UUID) TO authenticated, service_role;

-- READ-ONLY summary (Total / Pagado / Saldo / Estado): Logistica and Supervisor, plus COMERCIAL for a conversation it can currently work (PR-03 routing).
CREATE OR REPLACE FUNCTION public.order_payments_summary_access(p_account_id UUID, p_conversation_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.profiles p
      JOIN public.order_integration_settings s ON s.account_id = p.account_id AND s.logistics_mvp_enabled
      JOIN public.order_payment_settings ps ON ps.account_id = p.account_id AND ps.order_payments_enabled
     WHERE p.user_id = auth.uid()
       AND p.account_id = p_account_id
       AND p.account_role IN ('owner', 'admin', 'agent')
       AND (
         p.operational_role IN ('logistics', 'supervisor')
         OR (p.operational_role = 'commercial' AND p_conversation_id IS NOT NULL AND public.conversation_operational_access(p_account_id, p_conversation_id))
       )
  )
$$;
ALTER FUNCTION public.order_payments_summary_access(UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.order_payments_summary_access(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.order_payments_summary_access(UUID, UUID) TO authenticated, service_role;

-- 3. order_payments ---------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.order_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  order_id UUID NOT NULL,
  request_key TEXT NOT NULL,
  amount NUMERIC(12, 2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'PEN',
  kind TEXT NOT NULL,
  method TEXT,                       -- free text on purpose: no closed list exists in the business
  operation_number TEXT,
  paid_at TIMESTAMPTZ NOT NULL,      -- when the customer paid (declared by the operator)
  status TEXT NOT NULL DEFAULT 'recorded',
  evidence_document_id UUID REFERENCES public.order_documents(id),
  notes TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  supersedes_payment_id UUID REFERENCES public.order_payments(id),   -- a CORRECTION points at the payment it voided
  overpayment_reason TEXT,           -- Supervisor exception
  registered_by UUID, registered_by_name TEXT NOT NULL, registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_by UUID, confirmed_by_name TEXT, confirmed_at TIMESTAMPTZ,
  rejected_by UUID, rejected_by_name TEXT, rejected_at TIMESTAMPTZ, rejected_reason TEXT,
  voided_by UUID, voided_by_name TEXT, voided_at TIMESTAMPTZ, voided_reason TEXT,
  row_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT order_payments_order_fk FOREIGN KEY (order_id, account_id) REFERENCES public.order_confirmations (id, account_id),
  CONSTRAINT order_payments_amount_check CHECK (amount > 0 AND amount < 10000000),
  CONSTRAINT order_payments_currency_check CHECK (currency = 'PEN'),
  CONSTRAINT order_payments_kind_check CHECK (kind IN ('advance', 'balance', 'full', 'other')),
  CONSTRAINT order_payments_status_check CHECK (status IN ('recorded', 'confirmed', 'rejected', 'voided')),
  CONSTRAINT order_payments_text_form CHECK (
    char_length(btrim(request_key)) BETWEEN 1 AND 100
    AND (method IS NULL OR char_length(method) BETWEEN 1 AND 40)
    AND (operation_number IS NULL OR char_length(operation_number) BETWEEN 1 AND 60)
    AND (notes IS NULL OR char_length(notes) <= 500)
    AND char_length(source) BETWEEN 1 AND 30
    AND (rejected_reason IS NULL OR char_length(rejected_reason) <= 300)
    AND (voided_reason IS NULL OR char_length(voided_reason) <= 300)
    AND (overpayment_reason IS NULL OR char_length(overpayment_reason) <= 300)
  ),
  CONSTRAINT order_payments_status_shape CHECK (
    (status <> 'confirmed' OR confirmed_at IS NOT NULL)
    AND (status <> 'rejected' OR (rejected_at IS NOT NULL AND rejected_reason IS NOT NULL))
    AND (status <> 'voided' OR (voided_at IS NOT NULL AND voided_reason IS NOT NULL AND confirmed_at IS NOT NULL))
  ),
  CONSTRAINT order_payments_request_key UNIQUE (account_id, request_key)
);
CREATE INDEX IF NOT EXISTS order_payments_order_idx ON public.order_payments (order_id, created_at);
-- the same evidence can not back two LIVE payments; an operation number can not be used twice while the payment is live (voided / rejected release it)
CREATE UNIQUE INDEX IF NOT EXISTS order_payments_one_live_evidence ON public.order_payments (evidence_document_id)
  WHERE evidence_document_id IS NOT NULL AND status IN ('recorded', 'confirmed');
CREATE UNIQUE INDEX IF NOT EXISTS order_payments_one_live_operation ON public.order_payments (account_id, operation_number)
  WHERE operation_number IS NOT NULL AND status IN ('recorded', 'confirmed');

CREATE OR REPLACE FUNCTION public.order_payments_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF public.order_logistics_history_protected(OLD.account_id, OLD.order_id) THEN
      RAISE EXCEPTION 'order_payments rows cannot be deleted' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;
  -- the money data of a payment is IMMUTABLE for ever: a mistake is rejected / voided and registered again (a correction), never edited.
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.request_key IS DISTINCT FROM OLD.request_key OR NEW.amount IS DISTINCT FROM OLD.amount OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.method IS DISTINCT FROM OLD.method OR NEW.operation_number IS DISTINCT FROM OLD.operation_number
     OR NEW.paid_at IS DISTINCT FROM OLD.paid_at OR NEW.evidence_document_id IS DISTINCT FROM OLD.evidence_document_id OR NEW.notes IS DISTINCT FROM OLD.notes
     OR NEW.source IS DISTINCT FROM OLD.source OR NEW.supersedes_payment_id IS DISTINCT FROM OLD.supersedes_payment_id
     OR NEW.registered_by IS DISTINCT FROM OLD.registered_by OR NEW.registered_at IS DISTINCT FROM OLD.registered_at OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'payment data is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT ((OLD.status = 'recorded' AND NEW.status IN ('confirmed', 'rejected')) OR (OLD.status = 'confirmed' AND NEW.status = 'voided')) THEN
      RAISE EXCEPTION 'illegal payment transition % -> %', OLD.status, NEW.status USING ERRCODE = '22023';
    END IF;
  ELSIF OLD.status IN ('rejected', 'voided') THEN
    RAISE EXCEPTION 'a % payment is final', OLD.status USING ERRCODE = '42501';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.order_payments_guard() OWNER TO postgres;
DROP TRIGGER IF EXISTS order_payments_guard ON public.order_payments;
CREATE TRIGGER order_payments_guard BEFORE UPDATE OR DELETE ON public.order_payments FOR EACH ROW EXECUTE FUNCTION public.order_payments_guard();

-- 4. order_financials (CURRENT status of the TRACKED orders; no row = not tracked) --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.order_financials (
  order_id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  paid_confirmed NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (paid_confirmed >= 0),
  financial_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (financial_status IN ('unpaid', 'partially_paid', 'paid')),
  paid_at TIMESTAMPTZ,               -- the moment the status BECAME paid (NULL while not paid): one of the two clocks of the finalization
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT order_financials_order_fk FOREIGN KEY (order_id, account_id) REFERENCES public.order_confirmations (id, account_id) ON DELETE CASCADE,
  CONSTRAINT order_financials_paid_shape CHECK ((financial_status = 'paid') = (paid_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS order_financials_status_idx ON public.order_financials (account_id, financial_status);

CREATE OR REPLACE FUNCTION public.order_financials_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.order_id IS DISTINCT FROM OLD.order_id OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'financial identity is immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.order_financials_guard() OWNER TO postgres;
DROP TRIGGER IF EXISTS order_financials_guard ON public.order_financials;
CREATE TRIGGER order_financials_guard BEFORE UPDATE ON public.order_financials FOR EACH ROW EXECUTE FUNCTION public.order_financials_guard();

-- A new order of an account that ALREADY activated PR-06 starts TRACKED (unpaid). Orders confirmed before the activation have no row (not_tracked) and
-- nothing creates one for them. The function is a plain INSERT guarded by the settings row: with the feature never activated it does nothing at all.
CREATE OR REPLACE FUNCTION public.order_financials_seed()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.order_payment_settings s WHERE s.account_id = NEW.account_id AND s.activated_at IS NOT NULL) THEN
    INSERT INTO public.order_financials (order_id, account_id) VALUES (NEW.id, NEW.account_id) ON CONFLICT (order_id) DO NOTHING;
  END IF;
  RETURN NULL;
END;
$$;
ALTER FUNCTION public.order_financials_seed() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.order_financials_seed() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS order_confirmations_financials_seed ON public.order_confirmations;
CREATE TRIGGER order_confirmations_financials_seed AFTER INSERT ON public.order_confirmations FOR EACH ROW EXECUTE FUNCTION public.order_financials_seed();

-- 5. order_payment_events (append-only audit) --------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.order_payment_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  order_id UUID NOT NULL,
  payment_id UUID REFERENCES public.order_payments(id),
  event_type TEXT NOT NULL,
  actor_user_id UUID,                -- no FK on purpose (the audit survives user deletion); NULL = system
  actor_name TEXT NOT NULL,
  amount NUMERIC(12, 2),
  status_before TEXT,
  status_after TEXT,
  paid_before NUMERIC(12, 2),
  paid_after NUMERIC(12, 2),
  balance_before NUMERIC(12, 2),     -- pending balance (price - paid_confirmed, never negative) before / after
  balance_after NUMERIC(12, 2),
  financial_status_before TEXT,
  financial_status_after TEXT,
  evidence_document_id UUID,
  reason TEXT CHECK (reason IS NULL OR char_length(reason) <= 300),
  detail JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object' AND octet_length(detail::text) <= 4000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT order_payment_events_order_fk FOREIGN KEY (order_id, account_id) REFERENCES public.order_confirmations (id, account_id) ON DELETE CASCADE,
  CONSTRAINT order_payment_events_type_check CHECK (event_type IN (
    'payment_registered', 'payment_confirmed', 'payment_rejected', 'payment_voided', 'payment_corrected', 'overpayment_exception',
    'finalization_marked', 'finalization_cleared', 'finalization_revoked_after_return', 'order_delivered_manual'
  ))
);
CREATE INDEX IF NOT EXISTS order_payment_events_order_idx ON public.order_payment_events (order_id, created_at);
-- one event of each lifecycle type per payment: a retry can never write it twice
CREATE UNIQUE INDEX IF NOT EXISTS order_payment_events_payment_once ON public.order_payment_events (payment_id, event_type)
  WHERE payment_id IS NOT NULL AND event_type IN ('payment_registered', 'payment_confirmed', 'payment_rejected', 'payment_voided', 'payment_corrected', 'overpayment_exception');

CREATE OR REPLACE FUNCTION public.order_payment_events_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'order_payment_events is append-only' USING ERRCODE = '42501';
  END IF;
  IF public.order_logistics_history_protected(OLD.account_id, OLD.order_id) THEN
    RAISE EXCEPTION 'order_payment_events is append-only' USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END;
$$;
ALTER FUNCTION public.order_payment_events_guard() OWNER TO postgres;
DROP TRIGGER IF EXISTS order_payment_events_guard ON public.order_payment_events;
CREATE TRIGGER order_payment_events_guard BEFORE UPDATE OR DELETE ON public.order_payment_events FOR EACH ROW EXECUTE FUNCTION public.order_payment_events_guard();

-- 6. RLS: browsers only READ ---------------------------------------------------------------------------------------------------------------------------
ALTER TABLE public.order_payment_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_financials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_payment_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.order_payment_settings, public.order_payments, public.order_financials, public.order_payment_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.order_payment_settings, public.order_payments, public.order_financials, public.order_payment_events TO authenticated;
GRANT ALL ON public.order_payment_settings, public.order_payments, public.order_financials, public.order_payment_events TO service_role;

DROP POLICY IF EXISTS order_payment_settings_select ON public.order_payment_settings;
CREATE POLICY order_payment_settings_select ON public.order_payment_settings FOR SELECT USING (public.order_payments_access(account_id));
DROP POLICY IF EXISTS order_payments_select ON public.order_payments;
CREATE POLICY order_payments_select ON public.order_payments FOR SELECT USING (public.order_payments_access(account_id));
DROP POLICY IF EXISTS order_payment_events_select ON public.order_payment_events;
CREATE POLICY order_payment_events_select ON public.order_payment_events FOR SELECT USING (public.order_payments_access(account_id));
-- the summary (no per-payment data, no evidence, no events) is ALSO readable by Comercial for a chat it can currently work
DROP POLICY IF EXISTS order_financials_select ON public.order_financials;
CREATE POLICY order_financials_select ON public.order_financials FOR SELECT USING (
  public.order_payments_summary_access(account_id, (SELECT o.conversation_id FROM public.order_confirmations o WHERE o.id = order_financials.order_id AND o.account_id = order_financials.account_id))
);
