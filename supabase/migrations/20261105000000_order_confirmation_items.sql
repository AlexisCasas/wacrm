-- PR-1: account-gated, immutable order details in WACRM.
-- No change to InkaClick receiver or existing orders.
-- Requires 073_audio_guide_catalog and 20261102000000_order_sellers_from_members.

ALTER TABLE public.order_integration_settings
  ADD COLUMN IF NOT EXISTS multiproduct_enabled BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.order_confirmations
  ADD CONSTRAINT order_confirmations_id_account_unique UNIQUE (id, account_id);

CREATE TABLE public.order_confirmation_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID NOT NULL,
  account_id UUID NOT NULL,
  line_number SMALLINT NOT NULL,
  catalog_product_id UUID,
  product_name TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  unit_price NUMERIC(12,2) NOT NULL,
  subtotal NUMERIC(12,2) GENERATED ALWAYS AS (quantity * unit_price) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT order_confirmation_items_parent_fkey FOREIGN KEY (order_id, account_id)
    REFERENCES public.order_confirmations (id, account_id) ON DELETE CASCADE,
  CONSTRAINT order_confirmation_items_line_unique UNIQUE (order_id, line_number),
  CONSTRAINT order_confirmation_items_line_range CHECK (line_number BETWEEN 1 AND 20),
  CONSTRAINT order_confirmation_items_name_check CHECK (
    btrim(product_name) <> '' AND product_name = btrim(product_name)
    AND char_length(product_name) <= 150 AND product_name !~ E'[\n\r\t]'
  ),
  CONSTRAINT order_confirmation_items_qty_check CHECK (quantity BETWEEN 1 AND 10000),
  CONSTRAINT order_confirmation_items_price_check CHECK (
    unit_price > 0 AND subtotal > 0 AND subtotal < 10000000
  )
);
CREATE INDEX order_confirmation_items_account_order_idx
  ON public.order_confirmation_items (account_id, order_id);

COMMENT ON TABLE public.order_confirmation_items IS
  'Frozen line-item snapshots of a confirmed order; legacy orders need no detail rows.';

CREATE OR REPLACE FUNCTION public.order_confirmation_items_freeze()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'confirmed order items are immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER order_confirmation_items_freeze
  BEFORE UPDATE ON public.order_confirmation_items
  FOR EACH ROW EXECUTE FUNCTION public.order_confirmation_items_freeze();

ALTER TABLE public.order_confirmation_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.order_confirmation_items FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.order_confirmation_items TO authenticated;
GRANT ALL ON TABLE public.order_confirmation_items TO service_role;
CREATE POLICY order_confirmation_items_select ON public.order_confirmation_items
  FOR SELECT TO authenticated USING (public.is_account_member(account_id, 'agent'));

-- Keep the current seller-aware function signature and all existing gates.

CREATE OR REPLACE FUNCTION public.create_order_confirmation(
  p_account UUID, p_contact UUID, p_conversation UUID, p_actor UUID, p_actor_name TEXT, p_request_key TEXT, p_seller UUID, p_fields JSONB
) RETURNS TABLE (order_id UUID, created BOOLEAN)
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_id UUID;
  v_enabled BOOLEAN;
  v_feature BOOLEAN;
  v_seller_name TEXT;
  v_items JSONB := p_fields->'items';
  v_line RECORD;
  v_line_name TEXT;
  v_line_qty INTEGER;
  v_line_unit NUMERIC(12,2);
  v_line_catalog UUID;
  v_multiproduct_enabled BOOLEAN := FALSE;
  v_summary TEXT := '';
  v_total_units INTEGER := 0;
  v_total_price NUMERIC := 0;
BEGIN
  SELECT COALESCE(s.confirm_enabled, FALSE), COALESCE(s.enabled, FALSE) INTO v_feature, v_enabled
    FROM (SELECT 1) one LEFT JOIN order_integration_settings s ON s.account_id = p_account;
  IF NOT v_feature THEN
    RAISE EXCEPTION 'feature_disabled' USING ERRCODE = '42501';
  END IF;
  IF p_request_key IS NULL OR btrim(p_request_key) = '' OR char_length(p_request_key) > 100 THEN
    RAISE EXCEPTION 'invalid request key';
  END IF;
  -- Viewers are read-only: they may be chosen as seller, never confirm.
  IF NOT EXISTS (SELECT 1 FROM profiles p WHERE p.user_id = p_actor AND p.account_id = p_account AND p.account_role IN ('owner', 'admin', 'agent')) THEN
    RAISE EXCEPTION 'actor_not_allowed' USING ERRCODE = '42501';
  END IF;
  IF p_contact IS NOT NULL AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.id = p_contact AND c.account_id = p_account) THEN
    RAISE EXCEPTION 'contact does not belong to the account';
  END IF;
  IF p_conversation IS NOT NULL AND NOT EXISTS (SELECT 1 FROM conversations v WHERE v.id = p_conversation AND v.account_id = p_account) THEN
    RAISE EXCEPTION 'conversation does not belong to the account';
  END IF;
  SELECT c.name INTO v_seller_name FROM order_seller_candidates(p_account) c WHERE c.user_id = p_seller;
  IF v_seller_name IS NULL THEN
    RAISE EXCEPTION 'seller is not a member of the account';
  END IF;


  -- The legacy no-items path is intentionally unchanged. The new path is
  -- allowed only when this account's multiproduct switch is true.
  IF p_fields ? 'items' THEN
    SELECT COALESCE(s.multiproduct_enabled, FALSE) INTO v_multiproduct_enabled
      FROM public.order_integration_settings s WHERE s.account_id = p_account;
    IF NOT COALESCE(v_multiproduct_enabled, FALSE) THEN
      RAISE EXCEPTION 'multiproduct_disabled' USING ERRCODE = '42501';
    END IF;
    IF jsonb_typeof(v_items) IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'invalid_order_items' USING ERRCODE = '22023';
    END IF;
    IF jsonb_array_length(v_items) NOT BETWEEN 1 AND 20 THEN
      RAISE EXCEPTION 'invalid_order_items' USING ERRCODE = '22023';
    END IF;

    FOR v_line IN
      SELECT obj AS item, ord AS line_no
        FROM jsonb_array_elements(v_items) WITH ORDINALITY AS j(obj, ord)
    LOOP
      IF jsonb_typeof(v_line.item) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'invalid_order_items' USING ERRCODE = '22023';
      END IF;
      v_line_name := btrim(COALESCE(v_line.item->>'product_name', ''));
      IF v_line_name = '' OR char_length(v_line_name) > 150
         OR v_line_name ~ E'[\n\r\t]' THEN
        RAISE EXCEPTION 'invalid_order_items' USING ERRCODE = '22023';
      END IF;
      IF COALESCE(v_line.item->>'quantity', '') !~ '^[0-9]{1,5}$' THEN
        RAISE EXCEPTION 'invalid_order_items' USING ERRCODE = '22023';
      END IF;
      v_line_qty := (v_line.item->>'quantity')::INTEGER;
      IF v_line_qty NOT BETWEEN 1 AND 10000 THEN
        RAISE EXCEPTION 'invalid_order_items' USING ERRCODE = '22023';
      END IF;
      IF COALESCE(v_line.item->>'unit_price', '') !~ '^[0-9]{1,7}\.[0-9]{2}$' THEN
        RAISE EXCEPTION 'invalid_order_items' USING ERRCODE = '22023';
      END IF;
      v_line_unit := (v_line.item->>'unit_price')::NUMERIC(12,2);
      IF v_line_unit <= 0 OR v_line_unit * v_line_qty >= 10000000 THEN
        RAISE EXCEPTION 'invalid_order_items' USING ERRCODE = '22023';
      END IF;
      IF NULLIF(v_line.item->>'catalog_product_id', '') IS NOT NULL THEN
        BEGIN
          v_line_catalog := (v_line.item->>'catalog_product_id')::UUID;
        EXCEPTION WHEN invalid_text_representation THEN
          RAISE EXCEPTION 'invalid_catalog_product' USING ERRCODE = '22023';
        END;
        IF NOT EXISTS (
          SELECT 1 FROM public.audio_guide_products c
           WHERE c.id = v_line_catalog AND c.account_id = p_account AND c.active
        ) THEN
          RAISE EXCEPTION 'invalid_catalog_product' USING ERRCODE = '22023';
        END IF;
      END IF;
      v_total_units := v_total_units + v_line_qty;
      v_total_price := v_total_price + (v_line_unit * v_line_qty);
      IF v_total_units > 10000 OR v_total_price >= 10000000 THEN
        RAISE EXCEPTION 'invalid_order_items' USING ERRCODE = '22023';
      END IF;
      v_summary := v_summary || CASE WHEN v_line.line_no = 1 THEN '' ELSE E'\n' END
        || v_line_qty::TEXT || ' x ' || v_line_name;
    END LOOP;
    IF char_length(v_summary) > 500
       OR p_fields->>'product' IS DISTINCT FROM v_summary
       OR p_fields->>'quantity' IS DISTINCT FROM v_total_units::TEXT
       OR COALESCE(p_fields->>'price', '') !~ '^[0-9]{1,7}\.[0-9]{2}$' THEN
      RAISE EXCEPTION 'order_items_mismatch' USING ERRCODE = '22023';
    END IF;
    IF (p_fields->>'price')::NUMERIC IS DISTINCT FROM v_total_price THEN
      RAISE EXCEPTION 'order_items_mismatch' USING ERRCODE = '22023';
    END IF;
  END IF;

  INSERT INTO order_confirmations AS o (
    account_id, contact_id, conversation_id, confirmed_by, confirmed_by_name, request_key, seller_user_id, seller_name,
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
    -- Header and details commit atomically, with the same stable order ID.
    IF p_fields ? 'items' THEN
      INSERT INTO public.order_confirmation_items (
        order_id, account_id, line_number, catalog_product_id,
        product_name, quantity, unit_price
      )
      SELECT v_id, p_account, j.ord::SMALLINT,
             NULLIF(j.obj->>'catalog_product_id', '')::UUID,
             j.obj->>'product_name',
             (j.obj->>'quantity')::INTEGER,
             (j.obj->>'unit_price')::NUMERIC(12,2)
        FROM jsonb_array_elements(v_items) WITH ORDINALITY AS j(obj, ord);
    END IF;
    RETURN QUERY SELECT v_id, TRUE;
  ELSE
    RETURN QUERY SELECT o.id, FALSE FROM order_confirmations o WHERE o.account_id = p_account AND o.request_key = p_request_key;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.create_order_confirmation(UUID, UUID, UUID, UUID, TEXT, TEXT, UUID, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_order_confirmation(UUID, UUID, UUID, UUID, TEXT, TEXT, UUID, JSONB)
  TO service_role;
