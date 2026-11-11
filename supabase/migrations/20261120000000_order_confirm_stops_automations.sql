-- ============================================================
-- 20261120000000_order_confirm_stops_automations
--
-- "Confirmar pedido" (create_order_confirmation) now stops the contact's automations, reusing the existing sidebar control
-- (contact_automation_settings.keyword_automations_paused -> "Estado: Pausadas" / "Reanudar"):
--   * the contact is paused (no NEW keyword Flows / keyword_match automations);
--   * every ACTIVE Flow run of the contact (this includes durable waits: a wait is an active run with wait_until) is closed as
--     status='paused_by_agent', end_reason='order_confirmed' -> it can never be claimed or resumed again;
--   * every pending/running Automation execution of the contact (waits AND Meta rate-limit retries) is swept to 'done', like blocking does;
--   * order_stop_at records the moment and is a DURABLE FENCE: any automatic send of an execution that STARTED at or before it (Automation log
--     created_at / Flow run started_at) is refused by the shared send guard (assertContactCanReceive) right before the provider call, and an
--     Automation run that was already executing can no longer schedule a NEW wait/retry (migration 044's row-lock pattern). Executions that
--     start AFTER the order (the contact was resumed) are never affected; the fence is NOT a permanent pause. While the contact is still paused
--     BY the order, no automatic send of any execution goes out until the seller presses Reanudar. The AI auto-reply uses the same fence
--     (ai_reply_stopped_by_order), checked before generating, before handing off/claiming a slot and in the shared sender guard.
-- "Reanudar" (PUT /api/contacts/[id]/automation-pause) only flips keyword_automations_paused: it cannot revive any of the above, and
-- NEW triggers/runs created after the stop (log created after order_stop_at) are unaffected.
-- Atomic and idempotent: the stop runs inside create_order_confirmation only when the order row was really inserted (a retry of the same
-- request_key inserts nothing and has no effect). Does NOT touch contacts.blocked, messages, conversations or manual sending.
--
-- Additive: one nullable column, four server-only functions, and CREATE OR REPLACE of three existing functions whose ONLY change is the
-- added statements marked in each. CREATE OR REPLACE keeps their existing owner and grants.
-- ORDER: migration -> deploy app (the sidebar refresh is UI only; the stop already works with the old app).
-- ROLLBACK: re-run the previous definitions from 20261105000000 (create_order_confirmation), 044 (schedule_automation_wait_if_contact_active)
-- and 050 (schedule_automation_retry_if_contact_active); the column and the two new functions may stay (unused).
-- ============================================================

ALTER TABLE public.contact_automation_settings ADD COLUMN IF NOT EXISTS order_stop_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION public.stop_contact_automations_for_order(p_account UUID, p_contact UUID, p_actor UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF p_contact IS NULL THEN RETURN FALSE; END IF;
  -- Same row lock the Automation schedulers take, so "schedule a wait" and "stop" are serialized.
  PERFORM 1 FROM contacts WHERE id = p_contact AND account_id = p_account FOR UPDATE;
  IF NOT FOUND THEN RETURN FALSE; END IF;

  INSERT INTO contact_automation_settings (contact_id, account_id, keyword_automations_paused, order_stop_at, updated_at, updated_by_user_id)
  VALUES (p_contact, p_account, TRUE, v_now, v_now, p_actor)
  ON CONFLICT (contact_id) DO UPDATE
    SET keyword_automations_paused = TRUE, order_stop_at = EXCLUDED.order_stop_at,
        updated_at = EXCLUDED.updated_at, updated_by_user_id = EXCLUDED.updated_by_user_id;

  -- Flows: an active run (including one parked at a durable wait) can neither be claimed nor resumed once it is not 'active'.
  UPDATE flow_runs SET status = 'paused_by_agent', ended_at = v_now, end_reason = 'order_confirmed'
   WHERE account_id = p_account AND contact_id = p_contact AND status = 'active';

  -- Automations: waits and retries queued earlier are cancelled for good (never revived by "Reanudar").
  UPDATE automation_pending_executions SET status = 'done'
   WHERE account_id = p_account AND contact_id = p_contact AND status IN ('pending', 'running');

  RETURN TRUE;
END;
$$;

-- The three fences share one rule. An AUTOMATIC send is refused when the contact has an order_stop_at AND either
--   (a) the contact is STILL paused by that order (keyword_automations_paused and updated_at = order_stop_at, i.e. nobody pressed Reanudar or
--       changed the switch since the stop), whatever the execution: nothing automatic goes out until the seller presses Reanudar; or
--   (b) the execution started at or before order_stop_at (it belongs to the activity the order closed): it stays dead even after Reanudar.
-- Executions that start after order_stop_at on a contact that was resumed are never affected, and a manual Pausar/Reanudar made later
-- (updated_at moves past order_stop_at) is not an order pause.

CREATE OR REPLACE FUNCTION public.automation_run_stopped_by_order(p_account UUID, p_contact UUID, p_log UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1
      FROM contact_automation_settings s
     WHERE s.contact_id = p_contact AND s.account_id = p_account AND s.order_stop_at IS NOT NULL
       AND ((s.keyword_automations_paused AND s.updated_at = s.order_stop_at)
            OR EXISTS (SELECT 1 FROM automation_logs l WHERE l.id = p_log AND l.created_at <= s.order_stop_at))
  );
$$;

CREATE OR REPLACE FUNCTION public.flow_run_stopped_by_order(p_account UUID, p_contact UUID, p_run UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1
      FROM contact_automation_settings s
     WHERE s.contact_id = p_contact AND s.account_id = p_account AND s.order_stop_at IS NOT NULL
       AND ((s.keyword_automations_paused AND s.updated_at = s.order_stop_at)
            OR EXISTS (SELECT 1 FROM flow_runs r WHERE r.id = p_run AND r.account_id = p_account AND r.started_at <= s.order_stop_at))
  );
$$;

-- AI auto-reply: p_since is when the AI activity (the dispatch that generates/sends the reply) started.
CREATE OR REPLACE FUNCTION public.ai_reply_stopped_by_order(p_account UUID, p_contact UUID, p_since TIMESTAMPTZ)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1
      FROM contact_automation_settings s
     WHERE s.contact_id = p_contact AND s.account_id = p_account AND s.order_stop_at IS NOT NULL
       AND ((s.keyword_automations_paused AND s.updated_at = s.order_stop_at)
            OR (p_since IS NOT NULL AND p_since <= s.order_stop_at))
  );
$$;

REVOKE ALL ON FUNCTION public.stop_contact_automations_for_order(UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stop_contact_automations_for_order(UUID, UUID, UUID) TO service_role;
REVOKE ALL ON FUNCTION public.ai_reply_stopped_by_order(UUID, UUID, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_reply_stopped_by_order(UUID, UUID, TIMESTAMPTZ) TO service_role;
REVOKE ALL ON FUNCTION public.flow_run_stopped_by_order(UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.flow_run_stopped_by_order(UUID, UUID, UUID) TO service_role;
REVOKE ALL ON FUNCTION public.automation_run_stopped_by_order(UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.automation_run_stopped_by_order(UUID, UUID, UUID) TO service_role;

-- ---- create_order_confirmation: unchanged except the PERFORM public.stop_contact_automations_for_order(...) block ----

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
$$;

-- ---- schedule_automation_wait_if_contact_active: unchanged except the automation_run_stopped_by_order check ----

CREATE OR REPLACE FUNCTION schedule_automation_wait_if_contact_active(
  p_automation_id UUID,
  p_account_id UUID,
  p_user_id UUID,
  p_contact_id UUID,
  p_log_id UUID,
  p_parent_step_id UUID,
  p_branch TEXT,
  p_next_step_position INTEGER,
  p_context JSONB,
  p_run_at TIMESTAMPTZ
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_blocked BOOLEAN;
BEGIN
  -- The SAME row lock block_contact_internal takes on the SAME
  -- contact row — see the serialization argument above.
  SELECT blocked INTO v_blocked
  FROM contacts
  WHERE id = p_contact_id AND account_id = p_account_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  IF v_blocked THEN
    RETURN FALSE;
  END IF;

  IF public.automation_run_stopped_by_order(p_account_id, p_contact_id, p_log_id) THEN
    RETURN FALSE;
  END IF;

  INSERT INTO automation_pending_executions (
    automation_id, account_id, user_id, contact_id, log_id,
    parent_step_id, branch, next_step_position, context, run_at, status
  ) VALUES (
    p_automation_id, p_account_id, p_user_id, p_contact_id, p_log_id,
    p_parent_step_id, p_branch, p_next_step_position, p_context, p_run_at, 'pending'
  );

  RETURN TRUE;
END;
$$;

-- ---- schedule_automation_retry_if_contact_active: unchanged except the automation_run_stopped_by_order check ----

CREATE OR REPLACE FUNCTION public.schedule_automation_retry_if_contact_active(
  p_automation_id UUID,
  p_account_id UUID,
  p_user_id UUID,
  p_contact_id UUID,
  p_log_id UUID,
  p_parent_step_id UUID,
  p_branch TEXT,
  p_next_step_position INTEGER,
  p_context JSONB,
  p_run_at TIMESTAMPTZ,
  p_retry_count INTEGER,
  p_retry_reason TEXT,
  p_retry_step_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_blocked BOOLEAN;
  v_step_matches BOOLEAN;
BEGIN
  -- ---- structural validation (no lock needed yet) ----
  IF p_retry_count IS NULL OR p_retry_count < 1 OR p_retry_count > 5 THEN
    RAISE EXCEPTION 'schedule_automation_retry_if_contact_active: p_retry_count must be between 1 and 5, got %', p_retry_count
      USING ERRCODE = '22023';
  END IF;

  IF p_retry_reason IS DISTINCT FROM 'meta_pair_rate_limit' THEN
    RAISE EXCEPTION 'schedule_automation_retry_if_contact_active: unsupported p_retry_reason %', p_retry_reason
      USING ERRCODE = '22023';
  END IF;

  IF p_retry_step_id IS NULL THEN
    RAISE EXCEPTION 'schedule_automation_retry_if_contact_active: p_retry_step_id is required'
      USING ERRCODE = '22023';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM automation_steps
    WHERE id = p_retry_step_id
      AND automation_id = p_automation_id
      AND position = p_next_step_position
      AND parent_step_id IS NOT DISTINCT FROM p_parent_step_id
      AND branch IS NOT DISTINCT FROM p_branch
      AND step_type IN ('send_message', 'send_media', 'send_buttons', 'send_list', 'send_template')
  ) INTO v_step_matches;

  IF NOT v_step_matches THEN
    RAISE EXCEPTION 'schedule_automation_retry_if_contact_active: p_retry_step_id % does not match an outbound send step at the given automation/position/parent/branch', p_retry_step_id
      USING ERRCODE = '22023';
  END IF;

  -- ---- same row lock + serialization argument as migration 044's
  -- schedule_automation_wait_if_contact_active — see that function's
  -- own comment for the full case-A/case-B proof. ----
  SELECT blocked INTO v_blocked
  FROM contacts
  WHERE id = p_contact_id AND account_id = p_account_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  IF v_blocked THEN
    RETURN FALSE;
  END IF;

  IF public.automation_run_stopped_by_order(p_account_id, p_contact_id, p_log_id) THEN
    RETURN FALSE;
  END IF;

  INSERT INTO automation_pending_executions (
    automation_id, account_id, user_id, contact_id, log_id,
    parent_step_id, branch, next_step_position, context, run_at, status,
    retry_count, retry_reason, retry_step_id
  ) VALUES (
    p_automation_id, p_account_id, p_user_id, p_contact_id, p_log_id,
    p_parent_step_id, p_branch, p_next_step_position, p_context, p_run_at, 'pending',
    p_retry_count, p_retry_reason, p_retry_step_id
  );

  RETURN TRUE;
END;
$$;
