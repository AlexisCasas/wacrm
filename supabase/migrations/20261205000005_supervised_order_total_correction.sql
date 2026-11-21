-- Supervised, append-only correction of order_confirmations.price.  This is
-- deliberately narrow: it neither imports nor changes historical payments.

CREATE TABLE IF NOT EXISTS public.order_total_corrections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  order_id UUID NOT NULL,
  old_total NUMERIC(12,2) NOT NULL CHECK (old_total > 0),
  new_total NUMERIC(12,2) NOT NULL CHECK (new_total > 0),
  reason TEXT NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 300),
  actor_user_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT order_total_corrections_order_fk FOREIGN KEY (order_id, account_id)
    REFERENCES public.order_confirmations(id, account_id)
);
CREATE INDEX IF NOT EXISTS order_total_corrections_order_idx
  ON public.order_total_corrections (account_id, order_id, created_at);
ALTER TABLE public.order_total_corrections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.order_total_corrections FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.order_total_corrections TO authenticated;
GRANT ALL ON public.order_total_corrections TO service_role;
DROP POLICY IF EXISTS order_total_corrections_select ON public.order_total_corrections;
CREATE POLICY order_total_corrections_select ON public.order_total_corrections
  FOR SELECT USING (public.order_payments_access(account_id));

-- The audit is append-only, including for service_role.  The only writer is
-- correct_order_total below.
CREATE OR REPLACE FUNCTION public.order_total_corrections_guard()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'order total correction audit is append-only' USING ERRCODE = '42501';
END;
$$;
ALTER FUNCTION public.order_total_corrections_guard() OWNER TO postgres;
DROP TRIGGER IF EXISTS order_total_corrections_guard ON public.order_total_corrections;
CREATE TRIGGER order_total_corrections_guard BEFORE UPDATE OR DELETE ON public.order_total_corrections
  FOR EACH ROW EXECUTE FUNCTION public.order_total_corrections_guard();

-- Preserve the historic freeze verbatim except for one transaction-local flag
-- set only inside the SECURITY DEFINER RPC.  Normal UPDATE price remains
-- impossible; other frozen columns remain impossible in every path.
CREATE OR REPLACE FUNCTION public.order_confirmations_freeze()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.contact_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.id = NEW.contact_id AND c.account_id = NEW.account_id) THEN RAISE EXCEPTION 'reference from another account (contact)'; END IF;
    IF NEW.conversation_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM conversations v WHERE v.id = NEW.conversation_id AND v.account_id = NEW.account_id) THEN RAISE EXCEPTION 'reference from another account (conversation)'; END IF;
    IF NEW.deal_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM deals d WHERE d.id = NEW.deal_id AND d.account_id = NEW.account_id) THEN RAISE EXCEPTION 'reference from another account (deal)'; END IF;
    IF NEW.seller_id IS NOT NULL THEN
      IF NOT EXISTS (SELECT 1 FROM order_sellers s WHERE s.id = NEW.seller_id AND s.account_id = NEW.account_id) THEN RAISE EXCEPTION 'reference from another account (seller)'; END IF;
      IF NEW.seller_name IS DISTINCT FROM (SELECT s.name FROM order_sellers s WHERE s.id = NEW.seller_id) THEN RAISE EXCEPTION 'seller name differs from the referenced seller'; END IF;
    END IF;
    IF NEW.seller_user_id IS NOT NULL THEN
      IF NOT EXISTS (SELECT 1 FROM order_seller_candidates(NEW.account_id) c WHERE c.user_id = NEW.seller_user_id) THEN RAISE EXCEPTION 'reference from another account (seller member)'; END IF;
      IF NEW.seller_name IS DISTINCT FROM (SELECT c.name FROM order_seller_candidates(NEW.account_id) c WHERE c.user_id = NEW.seller_user_id) THEN RAISE EXCEPTION 'seller name differs from the member name'; END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at OR NEW.customer_name IS DISTINCT FROM OLD.customer_name OR NEW.dni IS DISTINCT FROM OLD.dni
     OR NEW.phone IS DISTINCT FROM OLD.phone OR NEW.product IS DISTINCT FROM OLD.product OR NEW.quantity IS DISTINCT FROM OLD.quantity
     OR (NEW.price IS DISTINCT FROM OLD.price AND current_setting('app.correct_order_total', true) IS DISTINCT FROM 'on')
     OR NEW.order_description IS DISTINCT FROM OLD.order_description OR NEW.agency IS DISTINCT FROM OLD.agency OR NEW.destination IS DISTINCT FROM OLD.destination
     OR NEW.seller_name IS DISTINCT FROM OLD.seller_name OR NEW.order_status IS DISTINCT FROM OLD.order_status OR NEW.department IS DISTINCT FROM OLD.department
     OR NEW.confirmed_by_name IS DISTINCT FROM OLD.confirmed_by_name OR NEW.request_key IS DISTINCT FROM OLD.request_key
     OR (NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by AND NEW.confirmed_by IS NOT NULL)
     OR (NEW.contact_id IS DISTINCT FROM OLD.contact_id AND NEW.contact_id IS NOT NULL)
     OR (NEW.conversation_id IS DISTINCT FROM OLD.conversation_id AND NEW.conversation_id IS NOT NULL)
     OR (NEW.seller_id IS DISTINCT FROM OLD.seller_id AND NEW.seller_id IS NOT NULL)
     OR (NEW.seller_user_id IS DISTINCT FROM OLD.seller_user_id AND NEW.seller_user_id IS NOT NULL)
     OR (NEW.deal_id IS DISTINCT FROM OLD.deal_id AND NEW.deal_id IS NOT NULL)
  THEN RAISE EXCEPTION 'a confirmed order is immutable'; END IF;
  NEW.updated_at := NOW(); RETURN NEW;
END;
$$;
ALTER FUNCTION public.order_confirmations_freeze() OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.correct_order_total(
  p_account UUID, p_actor UUID, p_order UUID, p_new_total TEXT, p_reason TEXT, p_now TIMESTAMPTZ DEFAULT now()
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE a RECORD; o public.order_confirmations%ROWTYPE; f public.order_financials%ROWTYPE;
  v_new NUMERIC(12,2); v_paid NUMERIC(12,2); v_recalc JSONB;
BEGIN
  SELECT * INTO a FROM public.order_payments_actor(p_account, p_actor);
  IF a.actor_role <> 'supervisor' THEN RAISE EXCEPTION 'supervisor_required' USING ERRCODE = '42501'; END IF;
  IF p_new_total IS NULL OR btrim(p_new_total) !~ '^[0-9]{1,7}(\.[0-9]{1,2})?$' OR btrim(p_new_total)::NUMERIC <= 0 THEN RAISE EXCEPTION 'invalid_total' USING ERRCODE = '22023'; END IF;
  v_new := btrim(p_new_total)::NUMERIC(12,2);
  IF p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 1 AND 300 THEN RAISE EXCEPTION 'reason_required' USING ERRCODE = '22023'; END IF;
  PERFORM public.order_payments_lock(p_order);
  SELECT * INTO o FROM public.order_confirmations WHERE id = p_order AND account_id = p_account FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  IF EXISTS (SELECT 1 FROM public.order_manual_deliveries d WHERE d.order_id=p_order AND d.account_id=p_account)
     OR EXISTS (SELECT 1 FROM public.order_shipments s WHERE s.order_id=p_order AND s.account_id=p_account AND s.logistic_status='delivered' AND s.tracking_state='delivered')
     OR EXISTS (SELECT 1 FROM public.order_finalizations z WHERE z.order_id=p_order AND z.account_id=p_account AND z.cleared_at IS NULL) THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'order_closed');
  END IF;
  SELECT * INTO f FROM public.order_financials WHERE order_id=p_order AND account_id=p_account FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', FALSE, 'reason', 'not_tracked'); END IF;
  SELECT COALESCE(SUM(amount),0) INTO v_paid FROM public.order_payments WHERE order_id=p_order AND account_id=p_account AND status='confirmed';
  IF v_new < v_paid THEN RETURN jsonb_build_object('ok', FALSE, 'reason', 'below_paid', 'paid_confirmed', v_paid); END IF;
  IF o.price = v_new THEN RETURN jsonb_build_object('ok', TRUE, 'changed', FALSE, 'total', o.price, 'paid_confirmed', v_paid, 'pending_balance', GREATEST(o.price-v_paid,0)); END IF;
  PERFORM set_config('app.correct_order_total', 'on', true);
  UPDATE public.order_confirmations SET price=v_new WHERE id=p_order AND account_id=p_account;
  INSERT INTO public.order_total_corrections(account_id,order_id,old_total,new_total,reason,actor_user_id)
    VALUES(p_account,p_order,o.price,v_new,btrim(p_reason),p_actor);
  v_recalc := public.order_payments_recalc(p_account,p_order,p_now);
  PERFORM public.order_payments_after_change(p_account,p_order,p_actor,a.actor_name,p_now);
  RETURN jsonb_build_object('ok',TRUE,'changed',TRUE,'old_total',o.price,'total',v_new,
    'paid_confirmed',(v_recalc->>'paid_after')::NUMERIC,'pending_balance',(v_recalc->>'balance_after')::NUMERIC,'financial_status',v_recalc->>'status_after');
END;
$$;
ALTER FUNCTION public.correct_order_total(UUID, UUID, UUID, TEXT, TEXT, TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.correct_order_total(UUID, UUID, UUID, TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.correct_order_total(UUID, UUID, UUID, TEXT, TEXT, TIMESTAMPTZ) TO service_role;
