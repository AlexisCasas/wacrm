-- Autonomous operation of Pedidos Confirmados: controlled EDIT and CANCELLATION (anulacion) with a full audit trail.
-- Additive only: two new append-only tables, two new SECURITY DEFINER RPCs (service_role only), cancellation guards (BEFORE INSERT) on the child tables,
-- and ONE extra branch in the order freeze trigger that is reachable only through the edit RPC (transaction-local flag). No existing row is touched.

CREATE TABLE IF NOT EXISTS public.order_edits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  order_id UUID NOT NULL,
  actor_user_id UUID NOT NULL,
  actor_name TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 300),
  changes JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT order_edits_order_fk FOREIGN KEY (order_id, account_id) REFERENCES public.order_confirmations(id, account_id)
);
CREATE INDEX IF NOT EXISTS order_edits_order_idx ON public.order_edits (account_id, order_id, created_at);

CREATE TABLE IF NOT EXISTS public.order_cancellations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  order_id UUID NOT NULL,
  reason TEXT NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 300),
  actor_user_id UUID NOT NULL,
  actor_name TEXT NOT NULL,
  paid_confirmed NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (paid_confirmed >= 0),
  refund_required BOOLEAN NOT NULL DEFAULT FALSE,
  shipment_stopped BOOLEAN NOT NULL DEFAULT FALSE,
  customer_notice TEXT NOT NULL DEFAULT 'not_requested' CHECK (customer_notice IN ('not_requested','pending','sent','failed')),
  cancelled_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT order_cancellations_order_fk FOREIGN KEY (order_id, account_id) REFERENCES public.order_confirmations(id, account_id),
  CONSTRAINT order_cancellations_one_per_order UNIQUE (account_id, order_id),
  CONSTRAINT order_cancellations_refund_shape CHECK (refund_required = (paid_confirmed > 0))
);

ALTER TABLE public.order_edits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_cancellations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.order_edits, public.order_cancellations FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.order_edits, public.order_cancellations TO authenticated;
GRANT ALL ON public.order_edits, public.order_cancellations TO service_role;
DROP POLICY IF EXISTS order_edits_select ON public.order_edits;
CREATE POLICY order_edits_select ON public.order_edits FOR SELECT USING (public.is_account_member(account_id, 'agent'::public.account_role_enum));
DROP POLICY IF EXISTS order_cancellations_select ON public.order_cancellations;
CREATE POLICY order_cancellations_select ON public.order_cancellations FOR SELECT USING (public.is_account_member(account_id, 'agent'::public.account_role_enum));

-- Both audits are append-only, for every role including service_role (customer_notice is the only column that may move, and only forward from 'pending').
CREATE OR REPLACE FUNCTION public.order_edits_guard() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN RAISE EXCEPTION 'order edit audit is append-only' USING ERRCODE = '42501'; END; $$;
ALTER FUNCTION public.order_edits_guard() OWNER TO postgres;
DROP TRIGGER IF EXISTS order_edits_guard ON public.order_edits;
CREATE TRIGGER order_edits_guard BEFORE UPDATE OR DELETE ON public.order_edits FOR EACH ROW EXECUTE FUNCTION public.order_edits_guard();

CREATE OR REPLACE FUNCTION public.order_cancellations_guard() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.customer_notice IN ('pending') AND NEW.customer_notice IN ('sent','failed')
     AND (to_jsonb(NEW) - 'customer_notice') = (to_jsonb(OLD) - 'customer_notice') THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'order cancellation audit is append-only' USING ERRCODE = '42501';
END; $$;
ALTER FUNCTION public.order_cancellations_guard() OWNER TO postgres;
DROP TRIGGER IF EXISTS order_cancellations_guard ON public.order_cancellations;
CREATE TRIGGER order_cancellations_guard BEFORE UPDATE OR DELETE ON public.order_cancellations FOR EACH ROW EXECUTE FUNCTION public.order_cancellations_guard();

-- Freeze trigger: historic body verbatim + one controlled-edit branch.
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
  -- Controlled edit (edit_order_confirmation, SECURITY DEFINER only): the identity / provenance of the order stays frozen; the commercial data may change and
  -- every change is recorded in order_edits by the same transaction.
  IF current_setting('app.edit_order', true) = 'on' THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.account_id IS DISTINCT FROM OLD.account_id
       OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at OR NEW.order_status IS DISTINCT FROM OLD.order_status
       OR NEW.confirmed_by_name IS DISTINCT FROM OLD.confirmed_by_name OR NEW.request_key IS DISTINCT FROM OLD.request_key
       OR (NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by AND NEW.confirmed_by IS NOT NULL)
       OR (NEW.contact_id IS DISTINCT FROM OLD.contact_id AND NEW.contact_id IS NOT NULL)
       OR (NEW.conversation_id IS DISTINCT FROM OLD.conversation_id AND NEW.conversation_id IS NOT NULL)
       OR (NEW.deal_id IS DISTINCT FROM OLD.deal_id AND NEW.deal_id IS NOT NULL)
    THEN RAISE EXCEPTION 'a confirmed order is immutable'; END IF;
    NEW.updated_at := NOW(); RETURN NEW;
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

-- A cancelled order accepts no new money, evidence, shipment, template or packaging movement. Existing rows are never touched or deleted.
CREATE OR REPLACE FUNCTION public.order_cancelled_guard() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.order_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.order_cancellations c WHERE c.order_id = NEW.order_id AND c.account_id = NEW.account_id) THEN
    RAISE EXCEPTION 'order_cancelled' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;
ALTER FUNCTION public.order_cancelled_guard() OWNER TO postgres;
DROP TRIGGER IF EXISTS order_cancelled_guard ON public.order_payments;
CREATE TRIGGER order_cancelled_guard BEFORE INSERT ON public.order_payments FOR EACH ROW EXECUTE FUNCTION public.order_cancelled_guard();
DROP TRIGGER IF EXISTS order_cancelled_guard ON public.order_documents;
CREATE TRIGGER order_cancelled_guard BEFORE INSERT ON public.order_documents FOR EACH ROW EXECUTE FUNCTION public.order_cancelled_guard();
DROP TRIGGER IF EXISTS order_cancelled_guard ON public.order_shipments;
CREATE TRIGGER order_cancelled_guard BEFORE INSERT ON public.order_shipments FOR EACH ROW EXECUTE FUNCTION public.order_cancelled_guard();
DROP TRIGGER IF EXISTS order_cancelled_guard ON public.order_template_dispatches;
CREATE TRIGGER order_cancelled_guard BEFORE INSERT ON public.order_template_dispatches FOR EACH ROW EXECUTE FUNCTION public.order_cancelled_guard();

CREATE OR REPLACE FUNCTION public.order_cancelled_logistics_guard() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF (TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status)
     AND EXISTS (SELECT 1 FROM public.order_cancellations c WHERE c.order_id = NEW.order_id AND c.account_id = NEW.account_id) THEN
    RAISE EXCEPTION 'order_cancelled' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;
ALTER FUNCTION public.order_cancelled_logistics_guard() OWNER TO postgres;
DROP TRIGGER IF EXISTS order_cancelled_guard ON public.order_logistics;
CREATE TRIGGER order_cancelled_guard BEFORE INSERT OR UPDATE ON public.order_logistics FOR EACH ROW EXECUTE FUNCTION public.order_cancelled_logistics_guard();

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- edit_order_confirmation: the ONLY way to change a confirmed order. Logistics / Supervisor (the payments gate). Whitelisted fields; money is derived from the lines by
-- the database, never taken from the caller; the new total can never be below what is already confirmed as paid; closed or cancelled orders refuse.
-- ---------------------------------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.edit_order_confirmation(
  p_account UUID, p_actor UUID, p_order UUID, p_fields JSONB, p_reason TEXT, p_now TIMESTAMPTZ DEFAULT now()
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  a RECORD; o public.order_confirmations%ROWTYPE; k TEXT; v_old JSONB; v_new JSONB; v_changes JSONB := '{}'::JSONB;
  v_text TEXT; v_seller UUID; v_seller_name TEXT;
  v_items JSONB; v_line RECORD; v_qty INTEGER; v_unit NUMERIC(12,2); v_name TEXT; v_catalog UUID;
  v_summary TEXT := ''; v_units INTEGER := 0; v_total NUMERIC := 0; v_has_items BOOLEAN; v_paid NUMERIC(12,2);
  n_customer TEXT; n_dni TEXT; n_phone TEXT; n_desc TEXT; n_agency TEXT; n_dest TEXT; n_dept TEXT; n_product TEXT; n_qty INTEGER; n_price NUMERIC(12,2);
  n_seller_user UUID; n_seller_name TEXT; v_total_changed BOOLEAN := FALSE; v_old_items JSONB := NULL; v_recalc JSONB;
BEGIN
  SELECT * INTO a FROM public.order_payments_actor(p_account, p_actor);
  IF p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 1 AND 300 THEN RAISE EXCEPTION 'reason_required' USING ERRCODE = '22023'; END IF;
  IF p_fields IS NULL OR jsonb_typeof(p_fields) IS DISTINCT FROM 'object' OR p_fields = '{}'::JSONB THEN RAISE EXCEPTION 'invalid_fields' USING ERRCODE = '22023'; END IF;
  FOR k IN SELECT jsonb_object_keys(p_fields) LOOP
    IF k NOT IN ('customer_name','dni','phone','order_description','agency','destination','department','seller_user_id','product','quantity','items') THEN
      RAISE EXCEPTION 'invalid_fields' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  PERFORM public.order_payments_lock(p_order);
  SELECT * INTO o FROM public.order_confirmations WHERE id = p_order AND account_id = p_account FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  IF EXISTS (SELECT 1 FROM public.order_cancellations c WHERE c.order_id = p_order AND c.account_id = p_account) THEN RETURN jsonb_build_object('ok', FALSE, 'reason', 'order_cancelled'); END IF;
  IF EXISTS (SELECT 1 FROM public.order_manual_deliveries d WHERE d.order_id=p_order AND d.account_id=p_account)
     OR EXISTS (SELECT 1 FROM public.order_shipments s WHERE s.order_id=p_order AND s.account_id=p_account AND s.logistic_status='delivered' AND s.tracking_state='delivered')
     OR EXISTS (SELECT 1 FROM public.order_finalizations z WHERE z.order_id=p_order AND z.account_id=p_account AND z.cleared_at IS NULL) THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'order_closed');
  END IF;

  n_customer := o.customer_name; n_dni := o.dni; n_phone := o.phone; n_desc := o.order_description; n_agency := o.agency; n_dest := o.destination; n_dept := o.department;
  n_product := o.product; n_qty := o.quantity; n_price := o.price; n_seller_user := o.seller_user_id; n_seller_name := o.seller_name;

  IF p_fields ? 'customer_name' THEN n_customer := btrim(COALESCE(p_fields->>'customer_name','')); IF n_customer = '' OR char_length(n_customer) > 150 THEN RAISE EXCEPTION 'invalid_fields' USING ERRCODE = '22023'; END IF; END IF;
  IF p_fields ? 'phone' THEN n_phone := btrim(COALESCE(p_fields->>'phone','')); IF n_phone = '' OR char_length(n_phone) > 40 THEN RAISE EXCEPTION 'invalid_fields' USING ERRCODE = '22023'; END IF; END IF;
  IF p_fields ? 'destination' THEN n_dest := btrim(COALESCE(p_fields->>'destination','')); IF n_dest = '' OR char_length(n_dest) > 150 THEN RAISE EXCEPTION 'invalid_fields' USING ERRCODE = '22023'; END IF; END IF;
  IF p_fields ? 'agency' THEN n_agency := btrim(COALESCE(p_fields->>'agency','')); IF n_agency = '' OR char_length(n_agency) > 100 THEN RAISE EXCEPTION 'invalid_fields' USING ERRCODE = '22023'; END IF; END IF;
  IF p_fields ? 'dni' THEN n_dni := NULLIF(btrim(COALESCE(p_fields->>'dni','')), ''); IF char_length(COALESCE(n_dni,'')) > 20 THEN RAISE EXCEPTION 'invalid_fields' USING ERRCODE = '22023'; END IF; END IF;
  IF p_fields ? 'order_description' THEN n_desc := NULLIF(btrim(COALESCE(p_fields->>'order_description','')), ''); IF char_length(COALESCE(n_desc,'')) > 1000 THEN RAISE EXCEPTION 'invalid_fields' USING ERRCODE = '22023'; END IF; END IF;
  IF p_fields ? 'department' THEN n_dept := NULLIF(btrim(COALESCE(p_fields->>'department','')), ''); IF char_length(COALESCE(n_dept,'')) > 100 THEN RAISE EXCEPTION 'invalid_fields' USING ERRCODE = '22023'; END IF; END IF;

  IF p_fields ? 'seller_user_id' THEN
    BEGIN v_seller := (p_fields->>'seller_user_id')::UUID; EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'invalid_fields' USING ERRCODE = '22023'; END;
    SELECT c.name INTO v_seller_name FROM public.order_seller_candidates(p_account) c WHERE c.user_id = v_seller;
    IF v_seller_name IS NULL THEN RAISE EXCEPTION 'invalid_seller' USING ERRCODE = '22023'; END IF;
    n_seller_user := v_seller; n_seller_name := v_seller_name;
  END IF;

  SELECT EXISTS (SELECT 1 FROM public.order_confirmation_items i WHERE i.order_id = p_order AND i.account_id = p_account) INTO v_has_items;
  IF p_fields ? 'items' THEN
    IF NOT COALESCE((SELECT s.multiproduct_enabled FROM public.order_integration_settings s WHERE s.account_id = p_account), FALSE) THEN RAISE EXCEPTION 'multiproduct_disabled' USING ERRCODE = '42501'; END IF;
    IF p_fields ? 'product' OR p_fields ? 'quantity' THEN RAISE EXCEPTION 'invalid_fields' USING ERRCODE = '22023'; END IF;
    v_items := p_fields->'items';
    IF jsonb_typeof(v_items) IS DISTINCT FROM 'array' OR jsonb_array_length(v_items) NOT BETWEEN 1 AND 20 THEN RAISE EXCEPTION 'invalid_order_items' USING ERRCODE = '22023'; END IF;
    FOR v_line IN SELECT obj AS item, ord AS line_no FROM jsonb_array_elements(v_items) WITH ORDINALITY AS j(obj, ord) LOOP
      IF jsonb_typeof(v_line.item) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'invalid_order_items' USING ERRCODE = '22023'; END IF;
      v_name := btrim(COALESCE(v_line.item->>'product_name',''));
      IF v_name = '' OR char_length(v_name) > 150 OR v_name ~ E'[\n\r\t]' THEN RAISE EXCEPTION 'invalid_order_items' USING ERRCODE = '22023'; END IF;
      IF COALESCE(v_line.item->>'quantity','') !~ '^[0-9]{1,5}$' THEN RAISE EXCEPTION 'invalid_order_items' USING ERRCODE = '22023'; END IF;
      v_qty := (v_line.item->>'quantity')::INTEGER;
      IF v_qty NOT BETWEEN 1 AND 10000 THEN RAISE EXCEPTION 'invalid_order_items' USING ERRCODE = '22023'; END IF;
      IF COALESCE(v_line.item->>'unit_price','') !~ '^[0-9]{1,7}\.[0-9]{2}$' THEN RAISE EXCEPTION 'invalid_order_items' USING ERRCODE = '22023'; END IF;
      v_unit := (v_line.item->>'unit_price')::NUMERIC(12,2);
      IF v_unit <= 0 OR v_unit * v_qty >= 10000000 THEN RAISE EXCEPTION 'invalid_order_items' USING ERRCODE = '22023'; END IF;
      IF NULLIF(v_line.item->>'catalog_product_id','') IS NOT NULL THEN
        BEGIN v_catalog := (v_line.item->>'catalog_product_id')::UUID; EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'invalid_catalog_product' USING ERRCODE = '22023'; END;
        IF NOT EXISTS (SELECT 1 FROM public.audio_guide_products c WHERE c.id = v_catalog AND c.account_id = p_account AND c.active) THEN RAISE EXCEPTION 'invalid_catalog_product' USING ERRCODE = '22023'; END IF;
      END IF;
      v_units := v_units + v_qty; v_total := v_total + v_unit * v_qty;
      IF v_units > 10000 OR v_total >= 10000000 THEN RAISE EXCEPTION 'invalid_order_items' USING ERRCODE = '22023'; END IF;
      v_summary := v_summary || CASE WHEN v_line.line_no = 1 THEN '' ELSE E'\n' END || v_qty::TEXT || ' x ' || v_name;
    END LOOP;
    IF char_length(v_summary) > 500 THEN RAISE EXCEPTION 'invalid_order_items' USING ERRCODE = '22023'; END IF;
    n_product := v_summary; n_qty := v_units; n_price := v_total::NUMERIC(12,2);
    SELECT COALESCE(jsonb_agg(jsonb_build_object('product_name', i.product_name, 'quantity', i.quantity, 'unit_price', i.unit_price) ORDER BY i.line_number), '[]'::JSONB)
      INTO v_old_items FROM public.order_confirmation_items i WHERE i.order_id = p_order AND i.account_id = p_account;
  ELSE
    IF p_fields ? 'product' OR p_fields ? 'quantity' THEN
      IF v_has_items THEN RAISE EXCEPTION 'use_items' USING ERRCODE = '22023'; END IF;
      IF p_fields ? 'product' THEN n_product := btrim(COALESCE(p_fields->>'product','')); IF n_product = '' OR char_length(n_product) > 500 THEN RAISE EXCEPTION 'invalid_fields' USING ERRCODE = '22023'; END IF; END IF;
      IF p_fields ? 'quantity' THEN
        IF COALESCE(p_fields->>'quantity','') !~ '^[0-9]{1,5}$' OR (p_fields->>'quantity')::INTEGER NOT BETWEEN 1 AND 10000 THEN RAISE EXCEPTION 'invalid_fields' USING ERRCODE = '22023'; END IF;
        n_qty := (p_fields->>'quantity')::INTEGER;
      END IF;
    END IF;
  END IF;

  IF n_customer IS DISTINCT FROM o.customer_name THEN v_changes := v_changes || jsonb_build_object('customer_name', jsonb_build_object('old', o.customer_name, 'new', n_customer)); END IF;
  IF n_dni IS DISTINCT FROM o.dni THEN v_changes := v_changes || jsonb_build_object('dni', jsonb_build_object('old', o.dni, 'new', n_dni)); END IF;
  IF n_phone IS DISTINCT FROM o.phone THEN v_changes := v_changes || jsonb_build_object('phone', jsonb_build_object('old', o.phone, 'new', n_phone)); END IF;
  IF n_desc IS DISTINCT FROM o.order_description THEN v_changes := v_changes || jsonb_build_object('order_description', jsonb_build_object('old', o.order_description, 'new', n_desc)); END IF;
  IF n_agency IS DISTINCT FROM o.agency THEN v_changes := v_changes || jsonb_build_object('agency', jsonb_build_object('old', o.agency, 'new', n_agency)); END IF;
  IF n_dest IS DISTINCT FROM o.destination THEN v_changes := v_changes || jsonb_build_object('destination', jsonb_build_object('old', o.destination, 'new', n_dest)); END IF;
  IF n_dept IS DISTINCT FROM o.department THEN v_changes := v_changes || jsonb_build_object('department', jsonb_build_object('old', o.department, 'new', n_dept)); END IF;
  IF n_seller_user IS DISTINCT FROM o.seller_user_id THEN v_changes := v_changes || jsonb_build_object('seller', jsonb_build_object('old', o.seller_name, 'new', n_seller_name)); END IF;
  IF n_product IS DISTINCT FROM o.product THEN v_changes := v_changes || jsonb_build_object('product', jsonb_build_object('old', o.product, 'new', n_product)); END IF;
  IF n_qty IS DISTINCT FROM o.quantity THEN v_changes := v_changes || jsonb_build_object('quantity', jsonb_build_object('old', o.quantity, 'new', n_qty)); END IF;
  IF n_price IS DISTINCT FROM o.price THEN v_changes := v_changes || jsonb_build_object('total', jsonb_build_object('old', o.price, 'new', n_price)); v_total_changed := TRUE; END IF;
  IF p_fields ? 'items' AND (v_old_items IS DISTINCT FROM (SELECT jsonb_agg(jsonb_build_object('product_name', btrim(j.obj->>'product_name'), 'quantity', (j.obj->>'quantity')::INTEGER, 'unit_price', (j.obj->>'unit_price')::NUMERIC(12,2)) ORDER BY j.ord) FROM jsonb_array_elements(v_items) WITH ORDINALITY j(obj, ord))) THEN
    v_changes := v_changes || jsonb_build_object('items', jsonb_build_object('old', v_old_items, 'new', v_items));
  END IF;
  IF v_changes = '{}'::JSONB THEN RETURN jsonb_build_object('ok', TRUE, 'changed', FALSE); END IF;

  SELECT COALESCE(SUM(amount),0) INTO v_paid FROM public.order_payments WHERE order_id=p_order AND account_id=p_account AND status='confirmed';
  IF n_price < v_paid THEN RETURN jsonb_build_object('ok', FALSE, 'reason', 'below_paid', 'paid_confirmed', v_paid); END IF;

  PERFORM set_config('app.edit_order', 'on', true);
  IF v_total_changed THEN PERFORM set_config('app.correct_order_total', 'on', true); END IF;
  UPDATE public.order_confirmations SET customer_name=n_customer, dni=n_dni, phone=n_phone, order_description=n_desc, agency=n_agency, destination=n_dest, department=n_dept,
         product=n_product, quantity=n_qty, price=n_price, seller_user_id=n_seller_user, seller_name=n_seller_name,
         seller_id = CASE WHEN n_seller_user IS DISTINCT FROM o.seller_user_id THEN NULL ELSE seller_id END
   WHERE id = p_order AND account_id = p_account;
  IF p_fields ? 'items' THEN
    DELETE FROM public.order_confirmation_items WHERE order_id = p_order AND account_id = p_account;
    INSERT INTO public.order_confirmation_items (order_id, account_id, line_number, catalog_product_id, product_name, quantity, unit_price)
      SELECT p_order, p_account, j.ord::SMALLINT, NULLIF(j.obj->>'catalog_product_id','')::UUID, btrim(j.obj->>'product_name'), (j.obj->>'quantity')::INTEGER, (j.obj->>'unit_price')::NUMERIC(12,2)
        FROM jsonb_array_elements(v_items) WITH ORDINALITY AS j(obj, ord);
  END IF;
  PERFORM set_config('app.edit_order', 'off', true);
  PERFORM set_config('app.correct_order_total', 'off', true);
  INSERT INTO public.order_edits (account_id, order_id, actor_user_id, actor_name, reason, changes) VALUES (p_account, p_order, p_actor, a.actor_name, btrim(p_reason), v_changes);
  IF v_total_changed THEN
    INSERT INTO public.order_total_corrections (account_id, order_id, old_total, new_total, reason, actor_user_id) VALUES (p_account, p_order, o.price, n_price, 'edit: ' || left(btrim(p_reason), 290), p_actor);
    v_recalc := public.order_payments_recalc(p_account, p_order, p_now);
    PERFORM public.order_payments_after_change(p_account, p_order, p_actor, a.actor_name, p_now);
  END IF;
  RETURN jsonb_build_object('ok', TRUE, 'changed', TRUE, 'fields', (SELECT jsonb_agg(key) FROM jsonb_object_keys(v_changes) AS key), 'total', n_price,
    'pending_balance', GREATEST(n_price - v_paid, 0));
END; $$;
ALTER FUNCTION public.edit_order_confirmation(UUID, UUID, UUID, JSONB, TEXT, TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.edit_order_confirmation(UUID, UUID, UUID, JSONB, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.edit_order_confirmation(UUID, UUID, UUID, JSONB, TEXT, TIMESTAMPTZ) TO service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- cancel_order_confirmation: anulacion. Never deletes or edits money: it records the cancellation, stops Shalom tracking (no more queries), and flags a refund when
-- confirmed payments exist (those need a Supervisor and an explicit acknowledgement). Delivered / finalized orders refuse. Idempotent.
-- ---------------------------------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cancel_order_confirmation(
  p_account UUID, p_actor UUID, p_order UUID, p_reason TEXT, p_ack_paid BOOLEAN DEFAULT FALSE, p_now TIMESTAMPTZ DEFAULT now()
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE a RECORD; o public.order_confirmations%ROWTYPE; s public.order_shipments%ROWTYPE; v_paid NUMERIC(12,2); v_stopped BOOLEAN := FALSE;
BEGIN
  SELECT * INTO a FROM public.order_payments_actor(p_account, p_actor);
  IF p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 1 AND 300 THEN RAISE EXCEPTION 'reason_required' USING ERRCODE = '22023'; END IF;
  PERFORM public.order_payments_lock(p_order);
  SELECT * INTO o FROM public.order_confirmations WHERE id = p_order AND account_id = p_account FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  IF EXISTS (SELECT 1 FROM public.order_cancellations c WHERE c.order_id = p_order AND c.account_id = p_account) THEN RETURN jsonb_build_object('ok', TRUE, 'changed', FALSE); END IF;
  IF EXISTS (SELECT 1 FROM public.order_manual_deliveries d WHERE d.order_id=p_order AND d.account_id=p_account)
     OR EXISTS (SELECT 1 FROM public.order_shipments x WHERE x.order_id=p_order AND x.account_id=p_account AND x.logistic_status='delivered' AND x.tracking_state='delivered')
     OR EXISTS (SELECT 1 FROM public.order_finalizations z WHERE z.order_id=p_order AND z.account_id=p_account AND z.cleared_at IS NULL) THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'order_closed');
  END IF;
  SELECT COALESCE(SUM(amount),0) INTO v_paid FROM public.order_payments WHERE order_id=p_order AND account_id=p_account AND status='confirmed';
  IF v_paid > 0 THEN
    IF a.actor_role <> 'supervisor' THEN RETURN jsonb_build_object('ok', FALSE, 'reason', 'supervisor_required', 'paid_confirmed', v_paid); END IF;
    IF p_ack_paid IS NOT TRUE THEN RETURN jsonb_build_object('ok', FALSE, 'reason', 'paid_requires_ack', 'paid_confirmed', v_paid); END IF;
  END IF;
  SELECT * INTO s FROM public.order_shipments x WHERE x.order_id = p_order AND x.account_id = p_account FOR UPDATE;
  IF FOUND AND s.tracking_state IN ('active','requires_attention') THEN
    UPDATE public.order_shipments SET tracking_state = 'stopped', stop_reason = 'order_cancelled', stopped_by = p_actor, stopped_at = p_now, next_poll_at = NULL, claim_token = NULL, lease_until = NULL WHERE id = s.id;
    PERFORM public.order_shipments_resolve_alerts(p_account, p_order, 'stopped', p_actor, a.actor_name, s.identifier_version, p_now);
    v_stopped := TRUE;
  END IF;
  INSERT INTO public.order_cancellations (account_id, order_id, reason, actor_user_id, actor_name, paid_confirmed, refund_required, shipment_stopped, cancelled_at)
    VALUES (p_account, p_order, btrim(p_reason), p_actor, a.actor_name, v_paid, v_paid > 0, v_stopped, p_now);
  RETURN jsonb_build_object('ok', TRUE, 'changed', TRUE, 'refund_required', v_paid > 0, 'paid_confirmed', v_paid, 'shipment_stopped', v_stopped);
END; $$;
ALTER FUNCTION public.cancel_order_confirmation(UUID, UUID, UUID, TEXT, BOOLEAN, TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.cancel_order_confirmation(UUID, UUID, UUID, TEXT, BOOLEAN, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_order_confirmation(UUID, UUID, UUID, TEXT, BOOLEAN, TIMESTAMPTZ) TO service_role;
