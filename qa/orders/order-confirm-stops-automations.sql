-- Behaviour QA for 20261120000000_order_confirm_stops_automations.sql.
-- SAFE ANYWHERE: every object is a session TEMP object (temp tables shadow the real ones because pg_temp is first in each copied function's
-- search_path). Nothing real is read or written and nothing persists. Run:  psql -v ON_ERROR_STOP=1 -f <this file>
-- The function bodies below are copied from the migration by qa/orders tooling and are asserted identical by the vitest static test.

CREATE TEMP TABLE contacts (id uuid PRIMARY KEY, account_id uuid NOT NULL, blocked boolean NOT NULL DEFAULT false);
CREATE TEMP TABLE conversations (id uuid PRIMARY KEY, account_id uuid NOT NULL, contact_id uuid);
CREATE TEMP TABLE flow_runs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid, contact_id uuid, status text, ended_at timestamptz, end_reason text, wait_until timestamptz, started_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TEMP TABLE automation_logs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TEMP TABLE automation_steps (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), automation_id uuid, position int, parent_step_id uuid, branch text, step_type text);
CREATE TEMP TABLE automation_pending_executions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), automation_id uuid, account_id uuid, user_id uuid, contact_id uuid, log_id uuid, parent_step_id uuid, branch text,
  next_step_position int, context jsonb, run_at timestamptz, status text, retry_count int NOT NULL DEFAULT 0, retry_reason text, retry_step_id uuid);
CREATE TEMP TABLE contact_automation_settings (contact_id uuid PRIMARY KEY, account_id uuid NOT NULL, keyword_automations_paused boolean NOT NULL DEFAULT false,
  order_stop_at timestamptz, updated_at timestamptz, updated_by_user_id uuid);
CREATE TEMP TABLE order_integration_settings (account_id uuid PRIMARY KEY, confirm_enabled boolean, enabled boolean, multiproduct_enabled boolean);
CREATE TEMP TABLE profiles (user_id uuid, account_id uuid, account_role text);
CREATE TEMP TABLE order_confirmations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid, contact_id uuid, conversation_id uuid, confirmed_by uuid, confirmed_by_name text,
  request_key text, seller_user_id uuid, seller_name text, customer_name text, dni text, phone text, product text, quantity int, price numeric, order_description text,
  agency text, destination text, department text, delivery_status text, UNIQUE (account_id, request_key));
CREATE TEMP TABLE order_confirmation_items (order_id uuid, account_id uuid, line_number smallint, catalog_product_id uuid, product_name text, quantity int, unit_price numeric);
CREATE TEMP TABLE audio_guide_products (id uuid, account_id uuid, active boolean);
CREATE FUNCTION pg_temp.order_seller_candidates(p_account uuid) RETURNS TABLE (user_id uuid, name text) LANGUAGE sql AS $f$ SELECT user_id, 'Vendedor QA'::text FROM profiles WHERE account_id = p_account $f$;

CREATE OR REPLACE FUNCTION pg_temp.stop_contact_automations_for_order(p_account UUID, p_contact UUID, p_actor UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_temp, public AS $$
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

CREATE OR REPLACE FUNCTION pg_temp.automation_run_stopped_by_order(p_account UUID, p_contact UUID, p_log UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_temp, public AS $$
  SELECT EXISTS (
    SELECT 1
      FROM contact_automation_settings s
     WHERE s.contact_id = p_contact AND s.account_id = p_account AND s.order_stop_at IS NOT NULL
       AND ((s.keyword_automations_paused AND s.updated_at = s.order_stop_at)
            OR EXISTS (SELECT 1 FROM automation_logs l WHERE l.id = p_log AND l.created_at <= s.order_stop_at))
  );
$$;

CREATE OR REPLACE FUNCTION pg_temp.flow_run_stopped_by_order(p_account UUID, p_contact UUID, p_run UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_temp, public AS $$
  SELECT EXISTS (
    SELECT 1
      FROM contact_automation_settings s
     WHERE s.contact_id = p_contact AND s.account_id = p_account AND s.order_stop_at IS NOT NULL
       AND ((s.keyword_automations_paused AND s.updated_at = s.order_stop_at)
            OR EXISTS (SELECT 1 FROM flow_runs r WHERE r.id = p_run AND r.account_id = p_account AND r.started_at <= s.order_stop_at))
  );
$$;

CREATE OR REPLACE FUNCTION pg_temp.ai_reply_stopped_by_order(p_account UUID, p_contact UUID, p_since TIMESTAMPTZ)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_temp, public AS $$
  SELECT EXISTS (
    SELECT 1
      FROM contact_automation_settings s
     WHERE s.contact_id = p_contact AND s.account_id = p_account AND s.order_stop_at IS NOT NULL
       AND ((s.keyword_automations_paused AND s.updated_at = s.order_stop_at)
            OR (p_since IS NOT NULL AND p_since <= s.order_stop_at))
  );
$$;

CREATE OR REPLACE FUNCTION pg_temp.create_order_confirmation(
  p_account UUID, p_contact UUID, p_conversation UUID, p_actor UUID, p_actor_name TEXT, p_request_key TEXT, p_seller UUID, p_fields JSONB
) RETURNS TABLE (order_id UUID, created BOOLEAN)
LANGUAGE plpgsql SET search_path = pg_temp, public AS $$
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
  SELECT c.name INTO v_seller_name FROM pg_temp.order_seller_candidates(p_account) c WHERE c.user_id = p_seller;
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
    PERFORM pg_temp.stop_contact_automations_for_order(
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

CREATE OR REPLACE FUNCTION pg_temp.schedule_automation_wait_if_contact_active(
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
SET search_path = pg_temp, public
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

  IF pg_temp.automation_run_stopped_by_order(p_account_id, p_contact_id, p_log_id) THEN
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

CREATE OR REPLACE FUNCTION pg_temp.schedule_automation_retry_if_contact_active(
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
SET search_path = pg_temp, public
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

  IF pg_temp.automation_run_stopped_by_order(p_account_id, p_contact_id, p_log_id) THEN
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

CREATE FUNCTION pg_temp.check(label text, ok boolean) RETURNS void LANGUAGE plpgsql AS $f$ BEGIN IF NOT ok THEN RAISE EXCEPTION 'FAIL: %', label; END IF; RAISE NOTICE 'ok   %', label; END $f$;

-- ids: account A=a1.., user U (confirmer+seller), contact C, conversation V; a different account B / contact for the tenant check
INSERT INTO contacts VALUES ('c1000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001'),('c2000000-0000-4000-8000-000000000002','a2000000-0000-4000-8000-000000000002');
INSERT INTO conversations VALUES ('d1000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001');
INSERT INTO profiles VALUES ('b1000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001','agent');
INSERT INTO order_integration_settings VALUES ('a1000000-0000-4000-8000-000000000001', true, true, false);

-- earlier automation work of the contact (BEFORE the sale): a wait, a Meta retry, an active Flow, a Flow parked at a durable wait, and the log that started them
INSERT INTO automation_logs (id, created_at) VALUES ('f1000000-0000-4000-8000-000000000001', clock_timestamp() - interval '1 hour');
INSERT INTO automation_steps (id, automation_id, position, parent_step_id, branch, step_type) VALUES ('e1000000-0000-4000-8000-000000000001','91000000-0000-4000-8000-000000000001',2,NULL,NULL,'send_message');
INSERT INTO automation_pending_executions (id, automation_id, account_id, user_id, contact_id, log_id, next_step_position, context, run_at, status) VALUES
  ('71000000-0000-4000-8000-000000000001','91000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001','f1000000-0000-4000-8000-000000000001',2,'{}', now() + interval '2 days', 'pending');
INSERT INTO automation_pending_executions (id, automation_id, account_id, user_id, contact_id, log_id, next_step_position, context, run_at, status, retry_count, retry_reason, retry_step_id) VALUES
  ('71000000-0000-4000-8000-000000000002','91000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001','f1000000-0000-4000-8000-000000000001',2,'{}', now() + interval '1 minute', 'pending', 1, 'meta_pair_rate_limit','e1000000-0000-4000-8000-000000000001');
INSERT INTO automation_pending_executions (id, automation_id, account_id, user_id, contact_id, log_id, next_step_position, context, run_at, status) VALUES
  ('71000000-0000-4000-8000-000000000003','91000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001','f1000000-0000-4000-8000-000000000001',3,'{}', now() - interval '1 minute', 'running');
INSERT INTO flow_runs (id, account_id, contact_id, status, wait_until) VALUES
  ('61000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001','active', NULL);
-- a second contact-less-related run of ANOTHER contact must stay untouched
INSERT INTO flow_runs (id, account_id, contact_id, status, wait_until) VALUES
  ('61000000-0000-4000-8000-0000000000ff','a2000000-0000-4000-8000-000000000002','c2000000-0000-4000-8000-000000000002','active', now() + interval '3 days');

-- 3. a FAILED confirmation changes nothing (feature off -> exception, whole statement rolled back)
UPDATE order_integration_settings SET confirm_enabled = false;
DO $t$ BEGIN PERFORM * FROM pg_temp.create_order_confirmation('a1000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001','d1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','Asesor','req-fail','b1000000-0000-4000-8000-000000000001','{"customer_name":"Cliente","phone":"51900000001","product":"Amoladora","quantity":1,"price":"100.00","destination":"Lima"}'::jsonb);
  EXCEPTION WHEN insufficient_privilege THEN NULL; END $t$;
UPDATE order_integration_settings SET confirm_enabled = true;
SELECT pg_temp.check('3 failed confirmation: no pause row, runs and pendings untouched, no order',
  NOT EXISTS (SELECT 1 FROM contact_automation_settings) AND (SELECT count(*) FROM flow_runs WHERE status='active') = 2
  AND (SELECT count(*) FROM automation_pending_executions WHERE status IN ('pending','running')) = 3 AND NOT EXISTS (SELECT 1 FROM order_confirmations));

-- 1. a NEW confirmed order pauses the contact
SELECT order_id IS NOT NULL AND created AS created_ok FROM pg_temp.create_order_confirmation('a1000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001','d1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','Asesor','req-1','b1000000-0000-4000-8000-000000000001','{"customer_name":"Cliente","phone":"51900000001","product":"Amoladora","quantity":1,"price":"100.00","destination":"Lima"}'::jsonb) \gset
SELECT pg_temp.check('1 new confirmed order -> contact paused (keyword_automations_paused=true, order_stop_at set)',
  (:'created_ok')::boolean AND (SELECT keyword_automations_paused AND order_stop_at IS NOT NULL FROM contact_automation_settings WHERE contact_id='c1000000-0000-4000-8000-000000000001'));
SELECT pg_temp.check('5/6 earlier Automation wait, Meta retry and running execution are all cancelled (done)', (SELECT count(*) FROM automation_pending_executions WHERE status='done') = 3 AND NOT EXISTS (SELECT 1 FROM automation_pending_executions WHERE status IN ('pending','running')));
SELECT pg_temp.check('7 active Flow run closed as paused_by_agent / order_confirmed', (SELECT status = 'paused_by_agent' AND end_reason = 'order_confirmed' FROM flow_runs WHERE id='61000000-0000-4000-8000-000000000001'));
SELECT pg_temp.check('other contacts are untouched (tenant isolation)', (SELECT status = 'active' FROM flow_runs WHERE id='61000000-0000-4000-8000-0000000000ff') AND NOT EXISTS (SELECT 1 FROM contact_automation_settings WHERE contact_id='c2000000-0000-4000-8000-000000000002'));
SELECT pg_temp.check('12 the contact is NOT blocked (manual messages keep working)', NOT (SELECT blocked FROM contacts WHERE id='c1000000-0000-4000-8000-000000000001'));

-- 8. a durable wait that was due can never be claimed again (claim_due_flow_waits requires status='active' AND wait_until <= now())
INSERT INTO flow_runs (id, account_id, contact_id, status, wait_until) VALUES ('61000000-0000-4000-8000-000000000002','a1000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001','active', now() - interval '1 minute');
SELECT pg_temp.stop_contact_automations_for_order('a1000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001');
SELECT pg_temp.check('8 durable wait previo: no run is claimable any more (status active AND wait_until due)', NOT EXISTS (SELECT 1 FROM flow_runs WHERE account_id='a1000000-0000-4000-8000-000000000001' AND status='active' AND wait_until IS NOT NULL AND wait_until <= now()));

-- 4. the SAME request_key again: created=false and NO effect (a manual Reanudar in between is not undone)
UPDATE contact_automation_settings SET keyword_automations_paused = false WHERE contact_id='c1000000-0000-4000-8000-000000000001';   -- what PUT automation-pause {paused:false} does
SELECT created AS retry_created FROM pg_temp.create_order_confirmation('a1000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001','d1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','Asesor','req-1','b1000000-0000-4000-8000-000000000001','{"customer_name":"Cliente","phone":"51900000001","product":"Amoladora","quantity":1,"price":"100.00","destination":"Lima"}'::jsonb) \gset
SELECT pg_temp.check('4 retry of the same request_key: created=false and the contact stays resumed (idempotent, no duplicate effect)', NOT (:'retry_created')::boolean AND NOT (SELECT keyword_automations_paused FROM contact_automation_settings WHERE contact_id='c1000000-0000-4000-8000-000000000001') AND (SELECT count(*) FROM order_confirmations) = 1);

-- 9/10. after Reanudar: NEW automations are allowed, OLD ones are not revived
INSERT INTO automation_logs (id, created_at) VALUES ('f2000000-0000-4000-8000-000000000002', clock_timestamp() + interval '1 second');   -- a run started AFTER the sale
SELECT pg_temp.check('9 new automation started after the sale can schedule its wait', pg_temp.schedule_automation_wait_if_contact_active('91000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001','f2000000-0000-4000-8000-000000000002',NULL,NULL,2,'{}'::jsonb, now() + interval '1 day'));
SELECT pg_temp.check('10 Reanudar does not revive: old pendings stay done, old runs stay paused_by_agent', NOT EXISTS (SELECT 1 FROM automation_pending_executions WHERE id IN ('71000000-0000-4000-8000-000000000001','71000000-0000-4000-8000-000000000002','71000000-0000-4000-8000-000000000003') AND status <> 'done')
  AND NOT EXISTS (SELECT 1 FROM flow_runs WHERE id IN ('61000000-0000-4000-8000-000000000001','61000000-0000-4000-8000-000000000002') AND status <> 'paused_by_agent'));
SELECT pg_temp.check('5/6 an execution that started BEFORE the sale cannot schedule a new wait or a retry afterwards',
  NOT pg_temp.schedule_automation_wait_if_contact_active('91000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001','f1000000-0000-4000-8000-000000000001',NULL,NULL,2,'{}'::jsonb, now() + interval '1 day')
  AND NOT pg_temp.schedule_automation_retry_if_contact_active('91000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001','f1000000-0000-4000-8000-000000000001',NULL,NULL,2,'{}'::jsonb, now() + interval '1 minute',1,'meta_pair_rate_limit','e1000000-0000-4000-8000-000000000001'));

-- 11. a SECOND order after Reanudar pauses again
SELECT created AS second_created FROM pg_temp.create_order_confirmation('a1000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001',NULL,'b1000000-0000-4000-8000-000000000001','Asesor','req-2','b1000000-0000-4000-8000-000000000001','{"customer_name":"Cliente","phone":"51900000001","product":"Taladro","quantity":1,"price":"80.00","destination":"Lima"}'::jsonb) \gset
SELECT pg_temp.check('11 new confirmation after Reanudar pauses again', (:'second_created')::boolean AND (SELECT keyword_automations_paused FROM contact_automation_settings WHERE contact_id='c1000000-0000-4000-8000-000000000001'));
SELECT pg_temp.check('tenant: a contact of another account is never stopped through this account', NOT pg_temp.stop_contact_automations_for_order('a1000000-0000-4000-8000-000000000001','c2000000-0000-4000-8000-000000000002','b1000000-0000-4000-8000-000000000001') AND (SELECT status = 'active' FROM flow_runs WHERE id='61000000-0000-4000-8000-0000000000ff'));

-- Flow fence (flow_run_stopped_by_order): the sender guard refuses an automatic send of a run that STARTED at/before order_stop_at.
UPDATE contact_automation_settings SET keyword_automations_paused = false WHERE contact_id='c1000000-0000-4000-8000-000000000001';   -- Reanudar
INSERT INTO flow_runs (id, account_id, contact_id, status, wait_until) VALUES ('61000000-0000-4000-8000-000000000003','a1000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001','active', NULL);   -- NEW run after the sale
SELECT pg_temp.check('F1 a Flow run that started BEFORE the order is fenced (its next outbound is refused)', pg_temp.flow_run_stopped_by_order('a1000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001','61000000-0000-4000-8000-000000000001'));
SELECT pg_temp.check('F2 the durable-wait run that was parked at the order is fenced too', pg_temp.flow_run_stopped_by_order('a1000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001','61000000-0000-4000-8000-000000000002'));
SELECT pg_temp.check('F3 after Reanudar a NEW Flow run (started after the order) is NOT fenced and can send', NOT pg_temp.flow_run_stopped_by_order('a1000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001','61000000-0000-4000-8000-000000000003'));
SELECT pg_temp.check('F4 Reanudar did not unfence the old runs (they stay fenced after the contact was resumed)', pg_temp.flow_run_stopped_by_order('a1000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001','61000000-0000-4000-8000-000000000001'));
SELECT pg_temp.check('F5 other contacts / accounts are never fenced', NOT pg_temp.flow_run_stopped_by_order('a2000000-0000-4000-8000-000000000002','c2000000-0000-4000-8000-000000000002','61000000-0000-4000-8000-0000000000ff') AND NOT pg_temp.flow_run_stopped_by_order('a1000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001','61000000-0000-4000-8000-0000000000ff'));
SELECT pg_temp.check('F6 a contact never stopped by an order has no fence at all', NOT pg_temp.flow_run_stopped_by_order('a2000000-0000-4000-8000-000000000002','c2000000-0000-4000-8000-000000000002','61000000-0000-4000-8000-0000000000ff'));
-- a SECOND order after Reanudar fences the run that was started in between, and only that older one
SELECT created AS third_created FROM pg_temp.create_order_confirmation('a1000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001',NULL,'b1000000-0000-4000-8000-000000000001','Asesor','req-3','b1000000-0000-4000-8000-000000000001','{"customer_name":"Cliente","phone":"51900000001","product":"Sierra","quantity":1,"price":"60.00","destination":"Lima"}'::jsonb) \gset
SELECT pg_temp.check('6 a new order after Reanudar fences the Flow run started in between (and stops it)', pg_temp.flow_run_stopped_by_order('a1000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001','61000000-0000-4000-8000-000000000003') AND (SELECT status = 'paused_by_agent' AND end_reason = 'order_confirmed' FROM flow_runs WHERE id='61000000-0000-4000-8000-000000000003'));

-- AI auto-reply fence (ai_reply_stopped_by_order) and the "still paused by the order" rule shared by the three fences.
-- State now: order #3 just paused the contact (paused = true, updated_at = order_stop_at).
SELECT pg_temp.check('AI1 contact still paused by the order: any AI reply is refused, whatever its start time', pg_temp.ai_reply_stopped_by_order('a1000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001', clock_timestamp() + interval '1 hour'));
SELECT pg_temp.check('AI2 the same rule stops NEW Automations and NEW Flow runs while paused by the order (nothing automatic until Reanudar)',
  pg_temp.automation_run_stopped_by_order('a1000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001','f2000000-0000-4000-8000-000000000002')
  AND pg_temp.flow_run_stopped_by_order('a1000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001','61000000-0000-4000-8000-000000000003'));
UPDATE contact_automation_settings SET keyword_automations_paused = false, updated_at = clock_timestamp() WHERE contact_id='c1000000-0000-4000-8000-000000000001';   -- what PUT automation-pause {paused:false} writes
SELECT pg_temp.check('AI3 after Reanudar an AI activity that STARTED BEFORE the order is still refused (generation already in flight when the order was confirmed)',
  pg_temp.ai_reply_stopped_by_order('a1000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001', (SELECT order_stop_at - interval '1 second' FROM contact_automation_settings WHERE contact_id='c1000000-0000-4000-8000-000000000001')));
SELECT pg_temp.check('AI4 after Reanudar a NEW customer interaction (AI activity after the order) is answered normally',
  NOT pg_temp.ai_reply_stopped_by_order('a1000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001', clock_timestamp()));
INSERT INTO automation_logs (id, created_at) VALUES ('f3000000-0000-4000-8000-000000000003', clock_timestamp() + interval '1 minute');   -- a NEW run after the order
INSERT INTO flow_runs (id, account_id, contact_id, status, wait_until, started_at) VALUES ('61000000-0000-4000-8000-000000000004','a1000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001','active', NULL, clock_timestamp() + interval '1 minute');
SELECT pg_temp.check('AI5 after Reanudar a NEW automation/flow execution (started after the order) works again, the older ones stay fenced',
  NOT pg_temp.automation_run_stopped_by_order('a1000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001','f3000000-0000-4000-8000-000000000003')
  AND NOT pg_temp.flow_run_stopped_by_order('a1000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001','61000000-0000-4000-8000-000000000004')
  AND pg_temp.flow_run_stopped_by_order('a1000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001','61000000-0000-4000-8000-000000000003'));
UPDATE contact_automation_settings SET keyword_automations_paused = true, updated_at = clock_timestamp() + interval '2 minutes' WHERE contact_id='c1000000-0000-4000-8000-000000000001';   -- a MANUAL Pausar later
SELECT pg_temp.check('AI6 a manual Pausar made later is NOT an order pause: the AI keeps answering (that switch never paused the AI) and new executions are not fenced',
  NOT pg_temp.ai_reply_stopped_by_order('a1000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001', clock_timestamp() + interval '3 minutes')
  AND NOT pg_temp.automation_run_stopped_by_order('a1000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001','f3000000-0000-4000-8000-000000000003'));
SELECT pg_temp.check('AI7 a contact that never had an order: no AI fence at all', NOT pg_temp.ai_reply_stopped_by_order('a2000000-0000-4000-8000-000000000002','c2000000-0000-4000-8000-000000000002', clock_timestamp()));
