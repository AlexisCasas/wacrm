-- ============================================================
-- 20261101000000_order_confirmations
--
-- "Confirmar pedido": one frozen record per confirmed order, plus a durable outbox that delivers it to InkaClick. PURELY ADDITIVE: new tables and
-- functions only; no existing table, column, policy or function changes, so the previous application image keeps working (image-only rollback).
-- Nothing is sent anywhere until the application calls these functions AND an account's integration switch is on (it is off by default).
--
--   1. order_integration_settings     per-account switch (off by default). Switching it off stops delivery only; confirmed orders are untouched.
--   2. order_sellers                  per-account catalogue of commercial sellers (the "Vendedor" of an order is NOT the user who clicks).
--   3. order_confirmations            the order: 13 business fields frozen at confirmation + author + delivery state. Immutable business fields.
--   4. order_confirmation_deliveries  one row per delivery attempt (history of attempts, errors and retries). No personal data in errors.
--   5. Functions (service role only): create_order_confirmation (idempotent), claim_order_deliveries (SKIP LOCKED lease),
--      finish_order_delivery, acknowledge_order_delivery.
--
-- delivery_status: held (integration was off at confirmation, never sent automatically) | pending | sending | sent (HTTP success) |
--                  acknowledged (receiver confirmed it by reconciliation) | failed (4xx, needs a person) | dead (attempts exhausted)
-- ============================================================

CREATE TABLE public.order_integration_settings (
  account_id UUID PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.order_sellers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT order_sellers_name_form CHECK (btrim(name) <> '' AND name = btrim(name) AND char_length(name) <= 80),
  CONSTRAINT order_sellers_account_key UNIQUE (account_id, name_key)
);

CREATE TABLE public.order_confirmations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
  conversation_id UUID REFERENCES public.conversations(id) ON DELETE SET NULL,
  -- Future optional link to deals (F2); not used yet.
  deal_id UUID REFERENCES public.deals(id) ON DELETE SET NULL,

  -- The 13 business fields, frozen at confirmation.
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  customer_name TEXT NOT NULL,
  dni TEXT,
  phone TEXT NOT NULL,
  product TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  price NUMERIC(12,2) NOT NULL,
  order_description TEXT,
  agency TEXT NOT NULL DEFAULT 'Shalom',
  destination TEXT NOT NULL,
  seller_name TEXT NOT NULL,
  order_status TEXT NOT NULL DEFAULT 'Pedido confirmado',
  department TEXT,

  -- Who confirmed (the signed-in user) and who is the commercial seller (a different thing).
  confirmed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  confirmed_by_name TEXT NOT NULL,
  seller_id UUID REFERENCES public.order_sellers(id) ON DELETE SET NULL,

  -- Stable client token: two clicks / a retried request with the same key are ONE order.
  request_key TEXT NOT NULL,

  delivery_status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_until TIMESTAMPTZ,
  last_error_code TEXT,
  inkaclick_order_id UUID,
  sent_at TIMESTAMPTZ,
  acknowledged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT order_confirmations_request_key UNIQUE (account_id, request_key),
  CONSTRAINT order_confirmations_quantity_check CHECK (quantity BETWEEN 1 AND 10000),
  -- price is the order TOTAL; 0 would make InkaClick mark the order as paid.
  CONSTRAINT order_confirmations_price_check CHECK (price > 0 AND price < 10000000),
  CONSTRAINT order_confirmations_status_check CHECK (order_status = 'Pedido confirmado'),
  CONSTRAINT order_confirmations_delivery_check CHECK (
    delivery_status IN ('held', 'pending', 'sending', 'sent', 'acknowledged', 'failed', 'dead')
  ),
  CONSTRAINT order_confirmations_text_form CHECK (
    btrim(customer_name) <> '' AND btrim(phone) <> '' AND btrim(product) <> '' AND btrim(destination) <> '' AND btrim(seller_name) <> ''
    AND (order_description IS NULL OR char_length(order_description) <= 2000)
  )
);

CREATE INDEX order_confirmations_due_idx ON public.order_confirmations (next_attempt_at)
  WHERE delivery_status IN ('pending', 'sending');
CREATE INDEX order_confirmations_contact_idx ON public.order_confirmations (account_id, contact_id, confirmed_at DESC);

CREATE TABLE public.order_confirmation_deliveries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID NOT NULL REFERENCES public.order_confirmations(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  outcome TEXT NOT NULL DEFAULT 'started',
  http_status INTEGER,
  error_code TEXT,
  -- Sanitised by the application: never a name, DNI or phone.
  error_detail TEXT,
  CONSTRAINT order_confirmation_deliveries_attempt UNIQUE (order_id, attempt),
  CONSTRAINT order_confirmation_deliveries_outcome CHECK (outcome IN ('started', 'sent', 'retry', 'rejected', 'dead', 'abandoned')),
  CONSTRAINT order_confirmation_deliveries_detail CHECK (error_detail IS NULL OR char_length(error_detail) <= 300)
);

-- Frozen fields: an order is a record of what was confirmed. Only delivery bookkeeping may change.
--   * Business fields and snapshots (names, prices, ...) never change.
--   * References (contact, conversation, seller, deal) may only go from a value to NULL: that is exactly what ON DELETE SET NULL does when the
--     referenced row is deleted, and the snapshots keep the order readable. A reference can never be re-pointed or filled in afterwards.
--   * On INSERT every reference must belong to the order's account, and the seller name must be the seller's name (create_order_confirmation
--     checks this too; the trigger covers any other writer).
CREATE FUNCTION public.order_confirmations_freeze()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.contact_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.id = NEW.contact_id AND c.account_id = NEW.account_id) THEN
      RAISE EXCEPTION 'reference from another account (contact)';
    END IF;
    IF NEW.conversation_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM conversations v WHERE v.id = NEW.conversation_id AND v.account_id = NEW.account_id) THEN
      RAISE EXCEPTION 'reference from another account (conversation)';
    END IF;
    IF NEW.deal_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM deals d WHERE d.id = NEW.deal_id AND d.account_id = NEW.account_id) THEN
      RAISE EXCEPTION 'reference from another account (deal)';
    END IF;
    IF NEW.seller_id IS NOT NULL THEN
      IF NOT EXISTS (SELECT 1 FROM order_sellers s WHERE s.id = NEW.seller_id AND s.account_id = NEW.account_id) THEN
        RAISE EXCEPTION 'reference from another account (seller)';
      END IF;
      IF NEW.seller_name IS DISTINCT FROM (SELECT s.name FROM order_sellers s WHERE s.id = NEW.seller_id) THEN
        RAISE EXCEPTION 'seller name differs from the referenced seller';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
     OR NEW.customer_name IS DISTINCT FROM OLD.customer_name
     OR NEW.dni IS DISTINCT FROM OLD.dni
     OR NEW.phone IS DISTINCT FROM OLD.phone
     OR NEW.product IS DISTINCT FROM OLD.product
     OR NEW.quantity IS DISTINCT FROM OLD.quantity
     OR NEW.price IS DISTINCT FROM OLD.price
     OR NEW.order_description IS DISTINCT FROM OLD.order_description
     OR NEW.agency IS DISTINCT FROM OLD.agency
     OR NEW.destination IS DISTINCT FROM OLD.destination
     OR NEW.seller_name IS DISTINCT FROM OLD.seller_name
     OR NEW.order_status IS DISTINCT FROM OLD.order_status
     OR NEW.department IS DISTINCT FROM OLD.department
     OR NEW.confirmed_by_name IS DISTINCT FROM OLD.confirmed_by_name
     OR NEW.request_key IS DISTINCT FROM OLD.request_key
     -- References: only value -> NULL.
     OR (NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by AND NEW.confirmed_by IS NOT NULL)
     OR (NEW.contact_id IS DISTINCT FROM OLD.contact_id AND NEW.contact_id IS NOT NULL)
     OR (NEW.conversation_id IS DISTINCT FROM OLD.conversation_id AND NEW.conversation_id IS NOT NULL)
     OR (NEW.seller_id IS DISTINCT FROM OLD.seller_id AND NEW.seller_id IS NOT NULL)
     OR (NEW.deal_id IS DISTINCT FROM OLD.deal_id AND NEW.deal_id IS NOT NULL)
  THEN
    RAISE EXCEPTION 'a confirmed order is immutable';
  END IF;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER order_confirmations_freeze BEFORE INSERT OR UPDATE ON public.order_confirmations
  FOR EACH ROW EXECUTE FUNCTION public.order_confirmations_freeze();

-- ---------------------------------------------------------------
-- RLS: members read their own account; every write goes through the service role (the API checks the caller's role first).
-- ---------------------------------------------------------------
ALTER TABLE public.order_integration_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_sellers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_confirmation_deliveries ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.order_integration_settings, public.order_sellers, public.order_confirmations, public.order_confirmation_deliveries
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.order_integration_settings, public.order_sellers, public.order_confirmations, public.order_confirmation_deliveries
  TO authenticated;
GRANT ALL ON TABLE public.order_integration_settings, public.order_sellers, public.order_confirmations, public.order_confirmation_deliveries
  TO service_role;

CREATE POLICY order_integration_settings_select ON public.order_integration_settings
  FOR SELECT USING (public.is_account_member(account_id, 'admin'));
CREATE POLICY order_sellers_select ON public.order_sellers
  FOR SELECT USING (public.is_account_member(account_id, 'agent'));
CREATE POLICY order_confirmations_select ON public.order_confirmations
  FOR SELECT USING (public.is_account_member(account_id, 'agent'));
CREATE POLICY order_confirmation_deliveries_select ON public.order_confirmation_deliveries
  FOR SELECT USING (public.is_account_member(account_id, 'agent'));

-- ---------------------------------------------------------------
-- Functions (SECURITY INVOKER, service role only).
-- ---------------------------------------------------------------

-- Idempotent create. The same (account, request_key) returns the SAME order with created = FALSE. The contact and conversation must belong
-- to the account. Delivery starts 'pending' only when the account's switch is on at this moment; otherwise 'held' (never auto-released).
CREATE FUNCTION public.create_order_confirmation(
  p_account UUID, p_contact UUID, p_conversation UUID, p_actor UUID, p_actor_name TEXT, p_request_key TEXT, p_seller UUID, p_fields JSONB
) RETURNS TABLE (order_id UUID, created BOOLEAN)
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_id UUID;
  v_enabled BOOLEAN;
  v_seller_name TEXT;
BEGIN
  IF p_request_key IS NULL OR btrim(p_request_key) = '' OR char_length(p_request_key) > 100 THEN
    RAISE EXCEPTION 'invalid request key';
  END IF;
  IF p_contact IS NOT NULL AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.id = p_contact AND c.account_id = p_account) THEN
    RAISE EXCEPTION 'contact does not belong to the account';
  END IF;
  IF p_conversation IS NOT NULL AND NOT EXISTS (SELECT 1 FROM conversations v WHERE v.id = p_conversation AND v.account_id = p_account) THEN
    RAISE EXCEPTION 'conversation does not belong to the account';
  END IF;
  SELECT s.name INTO v_seller_name FROM order_sellers s WHERE s.id = p_seller AND s.account_id = p_account AND s.active;
  IF v_seller_name IS NULL THEN
    RAISE EXCEPTION 'seller is not an active seller of the account';
  END IF;
  SELECT COALESCE((SELECT s.enabled FROM order_integration_settings s WHERE s.account_id = p_account), FALSE) INTO v_enabled;

  INSERT INTO order_confirmations AS o (
    account_id, contact_id, conversation_id, confirmed_by, confirmed_by_name, request_key, seller_id, seller_name,
    customer_name, dni, phone, product, quantity, price, order_description, agency, destination, department, delivery_status
  ) VALUES (
    p_account, p_contact, p_conversation, p_actor, p_actor_name, p_request_key, p_seller, v_seller_name,
    p_fields->>'customer_name', NULLIF(btrim(p_fields->>'dni'), ''), p_fields->>'phone', p_fields->>'product',
    (p_fields->>'quantity')::INTEGER, (p_fields->>'price')::NUMERIC(12,2), NULLIF(btrim(p_fields->>'order_description'), ''),
    COALESCE(NULLIF(btrim(p_fields->>'agency'), ''), 'Shalom'), p_fields->>'destination', NULLIF(btrim(p_fields->>'department'), ''),
    CASE WHEN v_enabled THEN 'pending' ELSE 'held' END
  )
  ON CONFLICT (account_id, request_key) DO NOTHING
  RETURNING o.id INTO v_id;

  IF v_id IS NOT NULL THEN
    RETURN QUERY SELECT v_id, TRUE;
  ELSE
    RETURN QUERY SELECT o.id, FALSE FROM order_confirmations o WHERE o.account_id = p_account AND o.request_key = p_request_key;
  END IF;
END;
$$;

-- Lease the due orders of accounts whose switch is on. An expired lease means the previous attempt died without reporting: it is retried
-- (the receiver is idempotent) unless attempts are exhausted, in which case the order goes to 'dead' instead.
CREATE FUNCTION public.claim_order_deliveries(p_limit INTEGER DEFAULT 10, p_lease_seconds INTEGER DEFAULT 120, p_max_attempts INTEGER DEFAULT 8)
RETURNS SETOF public.order_confirmations
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  UPDATE order_confirmations o SET delivery_status = 'dead', last_error_code = 'lease_expired_max_attempts', locked_until = NULL
   WHERE o.delivery_status = 'sending' AND o.locked_until < NOW() AND o.attempts >= p_max_attempts;
  UPDATE order_confirmation_deliveries d SET outcome = 'abandoned', finished_at = NOW()
   FROM order_confirmations o WHERE d.order_id = o.id AND d.outcome = 'started' AND o.delivery_status IN ('sending', 'dead') AND o.locked_until < NOW();

  RETURN QUERY
  WITH due AS (
    SELECT o.id FROM order_confirmations o
      JOIN order_integration_settings s ON s.account_id = o.account_id AND s.enabled
     WHERE (o.delivery_status = 'pending' AND o.next_attempt_at <= NOW())
        OR (o.delivery_status = 'sending' AND o.locked_until < NOW() AND o.attempts < p_max_attempts)
     ORDER BY o.next_attempt_at
     LIMIT GREATEST(p_limit, 1)
     FOR UPDATE OF o SKIP LOCKED
  ), upd AS (
    UPDATE order_confirmations o
       SET delivery_status = 'sending', attempts = o.attempts + 1, locked_until = NOW() + make_interval(secs => p_lease_seconds)
      FROM due WHERE o.id = due.id
    RETURNING o.*
  ), ins AS (
    INSERT INTO order_confirmation_deliveries (order_id, account_id, attempt)
    SELECT upd.id, upd.account_id, upd.attempts FROM upd
    RETURNING 1
  )
  SELECT upd.* FROM upd;
END;
$$;

-- Report the result of one attempt. outcome: sent | retry | rejected. Stale reports (lease already taken over by a later attempt) are ignored.
CREATE FUNCTION public.finish_order_delivery(
  p_order UUID, p_attempt INTEGER, p_outcome TEXT, p_http_status INTEGER, p_error_code TEXT, p_error_detail TEXT,
  p_inkaclick_id UUID, p_retry_at TIMESTAMPTZ, p_max_attempts INTEGER DEFAULT 8
) RETURNS TEXT
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_attempts INTEGER;
  v_status TEXT;
  v_final TEXT;
BEGIN
  IF p_outcome NOT IN ('sent', 'retry', 'rejected') THEN
    RAISE EXCEPTION 'invalid outcome';
  END IF;
  SELECT o.attempts, o.delivery_status INTO v_attempts, v_status FROM order_confirmations o WHERE o.id = p_order FOR UPDATE;
  IF NOT FOUND OR v_status <> 'sending' OR v_attempts <> p_attempt THEN
    RETURN 'ignored';
  END IF;

  v_final := CASE
    WHEN p_outcome = 'sent' THEN 'sent'
    WHEN p_outcome = 'rejected' THEN 'failed'
    WHEN v_attempts >= p_max_attempts THEN 'dead'
    ELSE 'pending'
  END;

  UPDATE order_confirmation_deliveries d
     SET outcome = CASE WHEN v_final = 'dead' THEN 'dead' ELSE p_outcome END, finished_at = NOW(), http_status = p_http_status,
         error_code = p_error_code, error_detail = left(p_error_detail, 300)
   WHERE d.order_id = p_order AND d.attempt = p_attempt;

  UPDATE order_confirmations o
     SET delivery_status = v_final, locked_until = NULL, last_error_code = CASE WHEN p_outcome = 'sent' THEN NULL ELSE p_error_code END,
         inkaclick_order_id = COALESCE(p_inkaclick_id, o.inkaclick_order_id),
         sent_at = CASE WHEN v_final = 'sent' THEN NOW() ELSE o.sent_at END,
         next_attempt_at = CASE WHEN v_final = 'pending' THEN COALESCE(p_retry_at, NOW()) ELSE o.next_attempt_at END
   WHERE o.id = p_order;
  RETURN v_final;
END;
$$;

-- Reconciliation: the receiver confirmed it holds the order (by external id). Only from 'sent'.
CREATE FUNCTION public.acknowledge_order_delivery(p_order UUID, p_inkaclick_id UUID) RETURNS BOOLEAN
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  UPDATE order_confirmations o SET delivery_status = 'acknowledged', acknowledged_at = NOW(), inkaclick_order_id = p_inkaclick_id
   WHERE o.id = p_order AND o.delivery_status IN ('sent', 'acknowledged');
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.create_order_confirmation(UUID, UUID, UUID, UUID, TEXT, TEXT, UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_order_deliveries(INTEGER, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_order_delivery(UUID, INTEGER, TEXT, INTEGER, TEXT, TEXT, UUID, TIMESTAMPTZ, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.acknowledge_order_delivery(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_order_confirmation(UUID, UUID, UUID, UUID, TEXT, TEXT, UUID, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_order_deliveries(INTEGER, INTEGER, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_order_delivery(UUID, INTEGER, TEXT, INTEGER, TEXT, TEXT, UUID, TIMESTAMPTZ, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.acknowledge_order_delivery(UUID, UUID) TO service_role;
