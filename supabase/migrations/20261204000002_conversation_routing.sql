-- ============================================================
-- 20261128000000_conversation_routing
--
-- PR-03: explicit operational routing of a conversation between COMERCIAL and LOGISTICA, replacing the PR-02 rule "an order exists => logistics".
-- The conversation, its id, its messages and its orders are NEVER moved, copied or closed: only WHO may work it changes.
--
-- MODEL (these are rules of the model, not temporary fallbacks):
--   * stage in { commercial, logistics, shared }.
--       commercial : Comercial works the chat.            logistics : Logistica works the chat.
--       shared     : Comercial AND Logistica work the SAME chat (Logistica keeps managing the existing order, Comercial handles a new sale).
--       Supervisor may access every stage.
--   * ABSENCE OF A ROW IN conversation_routing MEANS stage = 'commercial'. A conversation only gets a row when it leaves the commercial stage.
--     Consequently: a new conversation needs no write, and the backfill below creates rows only for conversations that already have an order.
--   * Transitions (the ONLY writers; browsers cannot write these tables):
--       commercial | shared -> logistics : inside create_order_confirmation, same transaction as the new order (reason order_confirmed).
--       logistics -> shared              : derive_conversation_to_commercial(), by Logistica or Supervisor (reason derived_to_commercial).
--     logistics -> commercial / shared -> commercial (a later "delivered" definition) is RESERVED (reason logistics_completed) and NOT implemented.
--   * Everything is by account flag: order_integration_settings.logistics_mvp_enabled = FALSE keeps EXACTLY the legacy behaviour (the access helper
--     answers TRUE and the existing membership terms decide; create_order_confirmation writes NO routing; derive is refused; the backfill skips the
--     account). Routing exists only for accounts with the flag ON. Enabling the flag on an account later REQUIRES running
--     backfill_conversation_routing(<account>) first (documented in CONVERSATION-ROUTING-PR03.md), which is idempotent.
--
-- CONTENTS
--   1. UNIQUE (id, account_id) on conversations (enables the account-scoped composite FK; non-destructive).
--   2. conversation_routing (current stage) and conversation_routing_events (immutable audit): RLS on, browser = SELECT only.
--   3. conversation_operational_access(): same signature, now driven by the routing stage (no longer by order_confirmations).
--   4. apply_order_confirmed_routing() (internal) + create_order_confirmation() calling it in the same transaction.
--   5. derive_conversation_to_commercial().
--   6. Backfill (only accounts with logistics_mvp_enabled = TRUE): conversations WITH a confirmed order -> stage logistics, reason backfill.
--      Conversations WITHOUT an order get NO row (= commercial). Implemented as backfill_conversation_routing(), reusable per account.
--   7. Drops the PR-02 index order_confirmations_account_conversation_idx (the helper no longer queries orders per row).
-- Messages are NOT touched (no artificial messages, no new sender_type). Rollback: docs/operations/CONVERSATION-ROUTING-ROLLBACK.sql.
-- Deploy order: after 20261127000000, BEFORE the application image of PR-03.
-- ============================================================

-- 1. Composite FK target (id is already unique; this only adds the account to the key).
CREATE UNIQUE INDEX IF NOT EXISTS conversations_id_account_unique ON public.conversations (id, account_id);

-- 2. Current stage.
CREATE TABLE IF NOT EXISTS public.conversation_routing (
  conversation_id UUID PRIMARY KEY,
  account_id      UUID NOT NULL,
  stage           TEXT NOT NULL CHECK (stage IN ('commercial', 'logistics', 'shared')),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by      UUID,                       -- no FK on purpose (audit survives user deletion); NULL = system / backfill
  version         INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT conversation_routing_conversation_fk
    FOREIGN KEY (conversation_id, account_id) REFERENCES public.conversations (id, account_id) ON DELETE CASCADE
);
COMMENT ON TABLE public.conversation_routing IS
  'Operational stage of a conversation. NO ROW = stage commercial (model rule). Written only by SECURITY DEFINER functions.';

-- Immutable history.
CREATE TABLE IF NOT EXISTS public.conversation_routing_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL,
  conversation_id UUID NOT NULL,
  from_stage      TEXT NOT NULL CHECK (from_stage IN ('commercial', 'logistics', 'shared')),   -- the EFFECTIVE stage (no row = commercial)
  to_stage        TEXT NOT NULL CHECK (to_stage IN ('commercial', 'logistics', 'shared')),
  reason          TEXT NOT NULL CHECK (reason IN ('order_confirmed', 'derived_to_commercial', 'backfill', 'logistics_completed')),  -- logistics_completed: RESERVED, never emitted yet
  actor_user_id   UUID,                       -- no FK on purpose (immutability); NULL = system / backfill
  actor_name      TEXT NOT NULL,              -- snapshot at the time of the transition
  order_id        UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),   -- real time of the transition (several can happen inside one transaction)
  CONSTRAINT conversation_routing_events_distinct CHECK (from_stage <> to_stage),
  CONSTRAINT conversation_routing_events_order_required CHECK (reason NOT IN ('order_confirmed', 'backfill') OR order_id IS NOT NULL),
  CONSTRAINT conversation_routing_events_derive_shape CHECK (reason <> 'derived_to_commercial' OR (from_stage = 'logistics' AND to_stage = 'shared' AND actor_user_id IS NOT NULL)),
  CONSTRAINT conversation_routing_events_conversation_fk
    FOREIGN KEY (conversation_id, account_id) REFERENCES public.conversations (id, account_id) ON DELETE CASCADE,
  CONSTRAINT conversation_routing_events_order_fk
    FOREIGN KEY (order_id, account_id) REFERENCES public.order_confirmations (id, account_id)
);
COMMENT ON TABLE public.conversation_routing_events IS
  'Append-only audit of every routing transition (who, when, from, to, why, which order). UPDATE is always rejected; DELETE only as part of deleting the conversation.';

-- One transition per order and one backfill per conversation: retries / re-runs cannot duplicate them.
CREATE UNIQUE INDEX IF NOT EXISTS conversation_routing_events_order_once
  ON public.conversation_routing_events (order_id) WHERE reason = 'order_confirmed';
CREATE UNIQUE INDEX IF NOT EXISTS conversation_routing_events_backfill_once
  ON public.conversation_routing_events (conversation_id) WHERE reason = 'backfill';
-- Timeline of one conversation (UI: "Derivada a Comercial por ...").
CREATE INDEX IF NOT EXISTS conversation_routing_events_conversation_idx
  ON public.conversation_routing_events (conversation_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.conversation_routing_events_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'conversation_routing_events is append-only' USING ERRCODE = '42501';
  END IF;
  -- DELETE is allowed only while the parent conversation is being deleted (FK cascade: the parent row is already gone).
  IF EXISTS (SELECT 1 FROM public.conversations c WHERE c.id = OLD.conversation_id) THEN
    RAISE EXCEPTION 'conversation_routing_events is append-only' USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END;
$$;
ALTER FUNCTION public.conversation_routing_events_guard() OWNER TO postgres;

DROP TRIGGER IF EXISTS conversation_routing_events_guard ON public.conversation_routing_events;
CREATE TRIGGER conversation_routing_events_guard
  BEFORE UPDATE OR DELETE ON public.conversation_routing_events
  FOR EACH ROW EXECUTE FUNCTION public.conversation_routing_events_guard();

ALTER TABLE public.conversation_routing ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_routing_events ENABLE ROW LEVEL SECURITY;

-- Browsers (anon / authenticated) may only READ, and only what the conversation policies already let them see. No write policy exists.
REVOKE ALL ON public.conversation_routing FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.conversation_routing_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.conversation_routing TO authenticated;
GRANT SELECT ON public.conversation_routing_events TO authenticated;
GRANT ALL ON public.conversation_routing TO service_role;
GRANT ALL ON public.conversation_routing_events TO service_role;

DROP POLICY IF EXISTS conversation_routing_select ON public.conversation_routing;
CREATE POLICY conversation_routing_select ON public.conversation_routing
  FOR SELECT USING (is_account_member(account_id) AND public.conversation_operational_access(account_id, conversation_id));

DROP POLICY IF EXISTS conversation_routing_events_select ON public.conversation_routing_events;
CREATE POLICY conversation_routing_events_select ON public.conversation_routing_events
  FOR SELECT USING (is_account_member(account_id) AND public.conversation_operational_access(account_id, conversation_id));

-- Live updates of the stage (a conversation that becomes `shared` reaches Comercial's Inbox through this table: Realtime evaluates the policy
-- on the NEW row version, so the commercial user starts receiving it). Adding a table to the publication is non-destructive.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'conversation_routing') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.conversation_routing;
  END IF;
END
$$;

-- 3. Access helper: SAME signature and security properties as 20261127000000; the stage now comes from conversation_routing (absent row = commercial).
--    One query for flag + membership/area + stage (it runs once per visible row).
CREATE OR REPLACE FUNCTION public.conversation_operational_access(
  p_account_id UUID,
  p_conversation_id UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_enabled BOOLEAN;
  v_member BOOLEAN;
  v_role public.operational_role_enum;
  v_stage TEXT;
BEGIN
  IF v_uid IS NULL OR p_account_id IS NULL THEN
    RETURN FALSE;
  END IF;

  SELECT COALESCE(s.logistics_mvp_enabled, FALSE), (p.user_id IS NOT NULL), p.operational_role, COALESCE(r.stage, 'commercial')
    INTO v_enabled, v_member, v_role, v_stage
    FROM (SELECT 1) one
    LEFT JOIN order_integration_settings s ON s.account_id = p_account_id
    LEFT JOIN profiles p ON p.user_id = v_uid AND p.account_id = p_account_id
    LEFT JOIN conversation_routing r ON r.conversation_id = p_conversation_id AND r.account_id = p_account_id;

  -- Flag OFF (or no settings row): legacy behaviour; the existing membership terms of the policies decide.
  IF NOT v_enabled THEN
    RETURN TRUE;
  END IF;

  -- Flag ON: a member of THIS account with an operational area (NULL area = no access, owner/admin included).
  IF NOT v_member OR v_role IS NULL THEN
    RETURN FALSE;
  END IF;

  IF v_role = 'supervisor' THEN
    RETURN TRUE;
  END IF;
  IF v_role = 'commercial' THEN
    RETURN v_stage IN ('commercial', 'shared');
  END IF;
  IF v_role = 'logistics' THEN
    RETURN v_stage IN ('logistics', 'shared');
  END IF;
  RETURN FALSE;
END;
$$;

-- 4. Internal transition used by create_order_confirmation (service role only). Locks the routing row, so concurrent confirmations serialize.
CREATE OR REPLACE FUNCTION public.apply_order_confirmed_routing(
  p_account UUID,
  p_conversation UUID,
  p_actor UUID,
  p_actor_name TEXT,
  p_order UUID
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_stage TEXT;
  v_rows BIGINT;
BEGIN
  IF p_conversation IS NULL THEN
    RETURN;
  END IF;

  -- Flag OFF (or no settings row): legacy behaviour, NOTHING is written (no routing row, no event, no new failure mode for the order flow).
  IF NOT COALESCE((SELECT s.logistics_mvp_enabled FROM order_integration_settings s WHERE s.account_id = p_account), FALSE) THEN
    RETURN;
  END IF;

  SELECT r.stage INTO v_stage FROM conversation_routing r
   WHERE r.conversation_id = p_conversation AND r.account_id = p_account FOR UPDATE;

  IF NOT FOUND THEN
    -- No row = commercial. Create it as logistics; if a concurrent transaction created it first, fall through to the locked update path.
    INSERT INTO conversation_routing (conversation_id, account_id, stage, updated_by, version)
    VALUES (p_conversation, p_account, 'logistics', p_actor, 1)
    ON CONFLICT (conversation_id) DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows > 0 THEN
      INSERT INTO conversation_routing_events (account_id, conversation_id, from_stage, to_stage, reason, actor_user_id, actor_name, order_id)
      VALUES (p_account, p_conversation, 'commercial', 'logistics', 'order_confirmed', p_actor, COALESCE(NULLIF(btrim(p_actor_name), ''), 'unknown'), p_order)
      ON CONFLICT DO NOTHING;
      RETURN;
    END IF;
    SELECT r.stage INTO v_stage FROM conversation_routing r
     WHERE r.conversation_id = p_conversation AND r.account_id = p_account FOR UPDATE;
  END IF;

  -- logistics stays logistics (no transition, no event); commercial / shared -> logistics.
  IF v_stage IS DISTINCT FROM 'logistics' THEN
    UPDATE conversation_routing
       SET stage = 'logistics', updated_at = now(), updated_by = p_actor, version = version + 1
     WHERE conversation_id = p_conversation AND account_id = p_account;
    INSERT INTO conversation_routing_events (account_id, conversation_id, from_stage, to_stage, reason, actor_user_id, actor_name, order_id)
    VALUES (p_account, p_conversation, v_stage, 'logistics', 'order_confirmed', p_actor, COALESCE(NULLIF(btrim(p_actor_name), ''), 'unknown'), p_order)
    ON CONFLICT DO NOTHING;
  END IF;
END;
$$;

ALTER FUNCTION public.apply_order_confirmed_routing(UUID, UUID, UUID, TEXT, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.apply_order_confirmed_routing(UUID, UUID, UUID, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_order_confirmed_routing(UUID, UUID, UUID, TEXT, UUID) TO service_role;

-- create_order_confirmation: body IDENTICAL to the previous version (20261120000000 / 20261121000000 lineage) except for ONE added statement,
-- the PERFORM of apply_order_confirmed_routing right after the order (and its items and the automation stop) exist, in the same transaction.
-- Signature, language, search_path, owner and ACL (postgres + service_role only) are unchanged.
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
    -- Conversation routing (migration 20261128000000): the handoff to Logistics happens in THIS transaction, only after the order row exists.
    -- A retry of the same request_key never reaches this branch (v_id IS NULL), so it cannot repeat the transition.
    PERFORM public.apply_order_confirmed_routing(p_account, p_conversation, p_actor, p_actor_name, v_id);
    RETURN QUERY SELECT v_id, TRUE;
  ELSE
    RETURN QUERY SELECT o.id, FALSE FROM order_confirmations o WHERE o.account_id = p_account AND o.request_key = p_request_key;
  END IF;
END;
$function$;

-- 5. Logistics / Supervisor hand the chat to Comercial for a NEW sale. Idempotent; locks the routing row (double click safe).
CREATE OR REPLACE FUNCTION public.derive_conversation_to_commercial(p_conversation_id UUID)
RETURNS TABLE (stage TEXT, changed BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_account UUID;
  v_role public.operational_role_enum;
  v_name TEXT;
  v_account_role TEXT;
  v_conv_account UUID;
  v_enabled BOOLEAN;
  v_stage TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT p.account_id, p.operational_role, COALESCE(NULLIF(btrim(p.full_name), ''), p.email, 'unknown'), p.account_role
    INTO v_account, v_role, v_name, v_account_role
    FROM profiles p WHERE p.user_id = v_uid;
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;
  -- Viewers are read-only everywhere (same rule as create_order_confirmation): an operational area never turns a viewer into a writer.
  IF v_account_role IS DISTINCT FROM 'owner' AND v_account_role IS DISTINCT FROM 'admin' AND v_account_role IS DISTINCT FROM 'agent' THEN
    RAISE EXCEPTION 'Viewers cannot derive a conversation' USING ERRCODE = '42501';
  END IF;

  -- Missing and cross-account conversations are indistinguishable on purpose.
  SELECT c.account_id INTO v_conv_account FROM conversations c WHERE c.id = p_conversation_id;
  IF v_conv_account IS NULL OR v_conv_account <> v_account THEN
    RAISE EXCEPTION 'conversation_not_accessible' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(s.logistics_mvp_enabled, FALSE) INTO v_enabled FROM order_integration_settings s WHERE s.account_id = v_account;
  IF NOT COALESCE(v_enabled, FALSE) THEN
    RAISE EXCEPTION 'operational_roles_disabled' USING ERRCODE = '42501';
  END IF;
  IF v_role IS NULL OR v_role NOT IN ('logistics', 'supervisor') THEN
    RAISE EXCEPTION 'Only logistics or supervisor can derive a conversation to commercial' USING ERRCODE = '42501';
  END IF;

  -- Serialize concurrent clicks on the same conversation.
  SELECT r.stage INTO v_stage FROM conversation_routing r
   WHERE r.conversation_id = p_conversation_id AND r.account_id = v_account FOR UPDATE;

  IF NOT FOUND OR v_stage = 'commercial' THEN
    RAISE EXCEPTION 'invalid_transition' USING ERRCODE = '22023';       -- commercial conversations are not derived (nothing to hand over)
  END IF;
  IF v_stage = 'shared' THEN
    RETURN QUERY SELECT 'shared'::TEXT, FALSE;                         -- already shared: idempotent, no new event
    RETURN;
  END IF;

  UPDATE conversation_routing r
     SET stage = 'shared', updated_at = now(), updated_by = v_uid, version = r.version + 1
   WHERE r.conversation_id = p_conversation_id AND r.account_id = v_account;
  -- Orders and messages are deliberately NOT touched.
  INSERT INTO conversation_routing_events (account_id, conversation_id, from_stage, to_stage, reason, actor_user_id, actor_name, order_id)
  VALUES (v_account, p_conversation_id, 'logistics', 'shared', 'derived_to_commercial', v_uid, v_name, NULL);

  RETURN QUERY SELECT 'shared'::TEXT, TRUE;
END;
$$;

ALTER FUNCTION public.derive_conversation_to_commercial(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.derive_conversation_to_commercial(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.derive_conversation_to_commercial(UUID) TO authenticated;

-- 6. Backfill, ONLY for accounts with logistics_mvp_enabled = TRUE: conversations that ALREADY have a confirmed order are in the logistics stage
--    (reason backfill, once per conversation). Conversations without an order get NO row (= commercial). Accounts with the flag OFF are skipped
--    entirely. Idempotent / re-runnable: existing rows are left alone and the event is written only for the rows this call inserted.
--    Also the procedure to run (per account) BEFORE turning the flag ON for an account that already has confirmed orders.
CREATE OR REPLACE FUNCTION public.backfill_conversation_routing(p_account UUID DEFAULT NULL)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rows BIGINT;
BEGIN
  WITH first_order AS (
    SELECT DISTINCT ON (o.conversation_id) o.conversation_id, o.account_id, o.id AS order_id
      FROM public.order_confirmations o
      JOIN public.conversations c ON c.id = o.conversation_id AND c.account_id = o.account_id
      JOIN public.order_integration_settings s ON s.account_id = o.account_id AND s.logistics_mvp_enabled
     WHERE o.conversation_id IS NOT NULL
       AND (p_account IS NULL OR o.account_id = p_account)
     ORDER BY o.conversation_id, o.confirmed_at, o.id
  ), inserted AS (
    INSERT INTO public.conversation_routing (conversation_id, account_id, stage, updated_by, version)
    SELECT f.conversation_id, f.account_id, 'logistics', NULL, 1 FROM first_order f
    ON CONFLICT (conversation_id) DO NOTHING
    RETURNING conversation_id
  ), ev AS (
    INSERT INTO public.conversation_routing_events (account_id, conversation_id, from_stage, to_stage, reason, actor_user_id, actor_name, order_id)
    SELECT f.account_id, f.conversation_id, 'commercial', 'logistics', 'backfill', NULL, 'migration backfill', f.order_id
      FROM first_order f JOIN inserted i ON i.conversation_id = f.conversation_id
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_rows FROM inserted;
  RETURN v_rows;
END;
$$;

ALTER FUNCTION public.backfill_conversation_routing(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.backfill_conversation_routing(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backfill_conversation_routing(UUID) TO service_role;

SELECT public.backfill_conversation_routing(NULL);

-- 7. The PR-02 stage lookup index is no longer used by anything (the helper reads conversation_routing by primary key).
DROP INDEX IF EXISTS public.order_confirmations_account_conversation_idx;
