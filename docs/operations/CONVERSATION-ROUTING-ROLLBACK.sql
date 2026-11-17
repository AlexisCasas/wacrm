-- ============================================================
-- ROLLBACK of 20261128000000_conversation_routing.sql  (authorization only: NO order, conversation or message is deleted or changed)
-- Restores the PR-02 behaviour: the stage of a conversation is again "has a confirmed order" (20261127000000).
-- Run as the table owner (postgres) in ONE transaction. After it, deploy the application image WITHOUT the routing UI/API (or keep it: GET/POST routes
-- would answer errors and the button would simply not appear).
-- WARNING: dropping the tables DELETES the routing history (audit). Export it first if you need it:
--   \copy (SELECT * FROM public.conversation_routing_events ORDER BY created_at) TO 'conversation_routing_events.csv' CSV HEADER
--   \copy (SELECT * FROM public.conversation_routing) TO 'conversation_routing.csv' CSV HEADER
-- Shortcut without SQL: UPDATE order_integration_settings SET logistics_mvp_enabled = FALSE WHERE account_id = '<ACCOUNT_ID>'  (legacy Inbox at once).
-- ============================================================
BEGIN;

-- 1. PR-02 index (needed by the PR-02 helper) -- recreated BEFORE the helper goes back.
CREATE INDEX IF NOT EXISTS order_confirmations_account_conversation_idx
  ON public.order_confirmations (account_id, conversation_id)
  WHERE conversation_id IS NOT NULL;

-- 2. Helper back to the PR-02 definition (stage = EXISTS order_confirmations). Same signature, hardening and grants.
CREATE OR REPLACE FUNCTION public.conversation_operational_access(p_account_id uuid, p_conversation_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid UUID := auth.uid();
  v_enabled BOOLEAN;
  v_member BOOLEAN;
  v_role public.operational_role_enum;
  v_has_order BOOLEAN;
BEGIN
  -- Not signed in: never (the membership check of the policies already denies it; returning FALSE here also hides the account's flag state).
  IF v_uid IS NULL OR p_account_id IS NULL THEN
    RETURN FALSE;
  END IF;

  -- ONE lookup for the account flag and the caller's membership/area in THIS account (the helper runs once per visible row, so it stays cheap).
  SELECT COALESCE(s.logistics_mvp_enabled, FALSE), (p.user_id IS NOT NULL), p.operational_role
    INTO v_enabled, v_member, v_role
    FROM (SELECT 1) one
    LEFT JOIN order_integration_settings s ON s.account_id = p_account_id
    LEFT JOIN profiles p ON p.user_id = v_uid AND p.account_id = p_account_id;

  -- Flag OFF (or no settings row): legacy behaviour. This function adds nothing; membership stays the job of the existing policy terms.
  IF NOT v_enabled THEN
    RETURN TRUE;
  END IF;

  -- Flag ON: the caller must be a member of THIS account (cross-account never) and have an operational area (NULL = no operational access).
  IF NOT v_member OR v_role IS NULL THEN
    RETURN FALSE;
  END IF;

  IF v_role = 'supervisor' THEN
    RETURN TRUE;
  END IF;

  -- Stage, derived from the persisted order (uses order_confirmations_account_conversation_idx).
  v_has_order := p_conversation_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM order_confirmations o WHERE o.account_id = p_account_id AND o.conversation_id = p_conversation_id
  );

  IF v_role = 'commercial' THEN
    RETURN NOT v_has_order;
  END IF;
  IF v_role = 'logistics' THEN
    RETURN v_has_order;
  END IF;
  RETURN FALSE;
END;
$function$;

-- 3. create_order_confirmation back to the exact previous body (without the routing call). ACL / owner are untouched by CREATE OR REPLACE.
CREATE OR REPLACE FUNCTION public.create_order_confirmation(p_account uuid, p_contact uuid, p_conversation uuid, p_actor uuid, p_actor_name text, p_request_key text, p_seller uuid, p_fields jsonb)
 RETURNS TABLE(order_id uuid, created boolean)
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
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
             btrim(j.obj->>'product_name'),
             (j.obj->>'quantity')::INTEGER,
             (j.obj->>'unit_price')::NUMERIC(12,2)
        FROM jsonb_array_elements(v_items) WITH ORDINALITY AS j(obj, ord);
    END IF;
    -- A NEWLY confirmed order stops the contact's automations in the SAME transaction: if this fails the order is not created either, and a
    -- retry of the same request_key (v_id IS NULL below) never repeats the effect, so a later "Reanudar" is not undone by a retry.
    PERFORM public.stop_contact_automations_for_order(
      p_account,
      COALESCE(p_contact, (SELECT v.contact_id FROM conversations v WHERE v.id = p_conversation AND v.account_id = p_account)),
      p_actor
    );
    RETURN QUERY SELECT v_id, TRUE;
  ELSE
    RETURN QUERY SELECT o.id, FALSE FROM order_confirmations o WHERE o.account_id = p_account AND o.request_key = p_request_key;
  END IF;
END;
$function$;

-- 4. Policies that reference the helper from the routing tables go away with the tables; then the internal and public functions.
DROP FUNCTION IF EXISTS public.derive_conversation_to_commercial(UUID);
DROP FUNCTION IF EXISTS public.apply_order_confirmed_routing(UUID, UUID, UUID, TEXT, UUID);
DROP FUNCTION IF EXISTS public.backfill_conversation_routing(UUID);

-- 5. Tables (also leaves the supabase_realtime publication). Events first (it is the one with the immutability guard).
DROP TABLE IF EXISTS public.conversation_routing_events;
DROP TABLE IF EXISTS public.conversation_routing;
DROP FUNCTION IF EXISTS public.conversation_routing_events_guard();

-- 6. The composite-FK target index exists only for the routing tables (this migration created it).
DROP INDEX IF EXISTS public.conversations_id_account_unique;

COMMIT;
