-- Logistics Inbox: distinguish main products from accessories.
-- Additive only. Existing rows remain main products.
-- Accessories still contribute to the order total.

ALTER TABLE public.order_confirmation_items
  ADD COLUMN IF NOT EXISTS item_type TEXT NOT NULL DEFAULT 'product';

ALTER TABLE public.order_confirmation_items
  DROP CONSTRAINT IF EXISTS order_confirmation_items_item_type_check;

ALTER TABLE public.order_confirmation_items
  ADD CONSTRAINT order_confirmation_items_item_type_check
  CHECK (item_type IN ('product', 'accessory'));

COMMENT ON COLUMN public.order_confirmation_items.item_type IS
  'Classifies a confirmed-order line as a main product or accessory. Both contribute to order total; accessories can be excluded from commercial metrics/commissions.';

-- Reinstall the existing edit RPC with additive item_type support.
-- Missing item_type is intentionally normalized to product for backwards compatibility.

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
      IF COALESCE(NULLIF(v_line.item->>'item_type',''), 'product') NOT IN ('product', 'accessory') THEN RAISE EXCEPTION 'invalid_order_items' USING ERRCODE = '22023'; END IF;
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
    SELECT COALESCE(jsonb_agg(jsonb_build_object('product_name', i.product_name, 'quantity', i.quantity, 'unit_price', i.unit_price, 'item_type', i.item_type) ORDER BY i.line_number), '[]'::JSONB)
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
  IF p_fields ? 'items' AND (v_old_items IS DISTINCT FROM (SELECT jsonb_agg(jsonb_build_object('product_name', btrim(j.obj->>'product_name'), 'quantity', (j.obj->>'quantity')::INTEGER, 'unit_price', (j.obj->>'unit_price')::NUMERIC(12,2), 'item_type', COALESCE(NULLIF(j.obj->>'item_type',''), 'product')) ORDER BY j.ord) FROM jsonb_array_elements(v_items) WITH ORDINALITY j(obj, ord))) THEN
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
    INSERT INTO public.order_confirmation_items (order_id, account_id, line_number, catalog_product_id, product_name, quantity, unit_price, item_type)
      SELECT p_order, p_account, j.ord::SMALLINT, NULLIF(j.obj->>'catalog_product_id','')::UUID, btrim(j.obj->>'product_name'), (j.obj->>'quantity')::INTEGER, (j.obj->>'unit_price')::NUMERIC(12,2), COALESCE(NULLIF(j.obj->>'item_type',''), 'product')
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
