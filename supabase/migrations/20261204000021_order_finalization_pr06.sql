-- PR-06 · "PEDIDO COMPLETAMENTE FINALIZADO" = LOGISTICA ENTREGADO  AND  FINANZAS PAID, the manual delivery for orders WITHOUT Shalom tracking, and the multi-order
-- rule of the automatic return (it corrects the gap PR-05C left open). ADDITIVE: no PR-01..PR-05 migration is edited; PR-05C's functions are replaced by CREATE OR REPLACE here.
--
--   * finalized_at = the moment the LAST of the two conditions was met (greatest(paid_at, delivered_at)), never the cron's hour. PR-05C then counts +10 minutes from it.
--   * evaluate_order_finalization calls mark_order_finalized (source 'pr06_paid_and_delivered'); if a payment is voided / corrected so the order stops being paid BEFORE the
--     return ran, clear_order_finalized; if the return ALREADY happened the routing is NOT reverted (the fact is recorded as an event).
--   * Logistics "delivered" is: a Shalom shipment delivered (PR-05)  OR  a MANUAL delivery (this file) for carriers / orders without Shalom tracking. The manual delivery is
--     manual, audited, idempotent and is refused for an order whose Shalom shipment is active / delivered.
--   * Multi-order rule: a conversation returns to Comercial only when EVERY relevant order of it (tracked orders = those with an order_financials row, while PR-06 is ON for the
--     account) has a live finalization; historical (not_tracked) orders never block; the 10-minute grace counts from the LAST required finalization.

-- 1. Manual delivery ----------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.order_manual_deliveries (
  order_id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  delivered_at TIMESTAMPTZ NOT NULL,
  note TEXT CHECK (note IS NULL OR char_length(note) <= 300),
  delivered_by UUID,
  delivered_by_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT order_manual_deliveries_order_fk FOREIGN KEY (order_id, account_id) REFERENCES public.order_confirmations (id, account_id)
);
ALTER TABLE public.order_manual_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.order_manual_deliveries FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.order_manual_deliveries TO authenticated;
GRANT ALL ON public.order_manual_deliveries TO service_role;
DROP POLICY IF EXISTS order_manual_deliveries_select ON public.order_manual_deliveries;
CREATE POLICY order_manual_deliveries_select ON public.order_manual_deliveries FOR SELECT USING (public.order_payments_access(account_id));

CREATE OR REPLACE FUNCTION public.order_manual_deliveries_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'a manual delivery is immutable' USING ERRCODE = '42501'; END IF;
  IF public.order_logistics_history_protected(OLD.account_id, OLD.order_id) THEN RAISE EXCEPTION 'order_manual_deliveries rows cannot be deleted' USING ERRCODE = '42501'; END IF;
  RETURN OLD;
END;
$$;
ALTER FUNCTION public.order_manual_deliveries_guard() OWNER TO postgres;
DROP TRIGGER IF EXISTS order_manual_deliveries_guard ON public.order_manual_deliveries;
CREATE TRIGGER order_manual_deliveries_guard BEFORE UPDATE OR DELETE ON public.order_manual_deliveries FOR EACH ROW EXECUTE FUNCTION public.order_manual_deliveries_guard();

-- A Shalom guide can not be registered for an order already delivered by hand (one logistics truth per order).
CREATE OR REPLACE FUNCTION public.order_shipments_no_manual_delivery()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.order_manual_deliveries d WHERE d.order_id = NEW.order_id) THEN
    RAISE EXCEPTION 'manual_delivery_exists' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.order_shipments_no_manual_delivery() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.order_shipments_no_manual_delivery() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS order_shipments_no_manual_delivery ON public.order_shipments;
CREATE TRIGGER order_shipments_no_manual_delivery BEFORE INSERT ON public.order_shipments FOR EACH ROW EXECUTE FUNCTION public.order_shipments_no_manual_delivery();

-- The logistics side of the finalization: delivered by Shalom (PR-05) or by hand.
CREATE OR REPLACE FUNCTION public.order_delivery_info(p_account UUID, p_order UUID)
RETURNS TABLE (delivered BOOLEAN, delivered_at TIMESTAMPTZ, source TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_at TIMESTAMPTZ;
BEGIN
  SELECT s.status_changed_at INTO v_at FROM public.order_shipments s
   WHERE s.order_id = p_order AND s.account_id = p_account AND s.logistic_status = 'delivered' AND s.tracking_state = 'delivered';
  IF FOUND AND v_at IS NOT NULL THEN RETURN QUERY SELECT TRUE, v_at, 'shalom'::TEXT; RETURN; END IF;
  SELECT d.delivered_at INTO v_at FROM public.order_manual_deliveries d WHERE d.order_id = p_order AND d.account_id = p_account;
  IF FOUND THEN RETURN QUERY SELECT TRUE, v_at, 'manual'::TEXT; RETURN; END IF;
  RETURN QUERY SELECT FALSE, NULL::TIMESTAMPTZ, NULL::TEXT;
END;
$$;
ALTER FUNCTION public.order_delivery_info(UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.order_delivery_info(UUID, UUID) FROM PUBLIC, anon, authenticated, service_role;

-- 2. The finalization evaluator --------------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.order_payments_evaluate_finalization(p_account UUID, p_order UUID, p_actor UUID, p_actor_name TEXT, p_now TIMESTAMPTZ)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  f public.order_financials%ROWTYPE;
  z public.order_finalizations%ROWTYPE;
  d RECORD;
  v_at TIMESTAMPTZ;
  v_res JSONB;
  v_total NUMERIC(12, 2);
BEGIN
  IF NOT COALESCE((SELECT ps.order_payments_enabled FROM public.order_payment_settings ps WHERE ps.account_id = p_account), FALSE)
     OR NOT COALESCE((SELECT s.logistics_mvp_enabled FROM public.order_integration_settings s WHERE s.account_id = p_account), FALSE) THEN
    RETURN 'disabled';
  END IF;
  SELECT * INTO f FROM public.order_financials x WHERE x.order_id = p_order AND x.account_id = p_account;
  IF NOT FOUND THEN RETURN 'not_tracked'; END IF;
  SELECT * INTO d FROM public.order_delivery_info(p_account, p_order);
  SELECT * INTO z FROM public.order_finalizations x WHERE x.order_id = p_order AND x.account_id = p_account;
  SELECT o.price INTO v_total FROM public.order_confirmations o WHERE o.id = p_order;

  IF f.financial_status = 'paid' AND d.delivered THEN
    v_at := GREATEST(f.paid_at, d.delivered_at);
    IF NOT FOUND OR z.order_id IS NULL OR z.return_state = 'skipped_cleared' THEN
      v_res := public.mark_order_finalized(p_account, p_order, 'pr06_paid_and_delivered', p_actor, v_at);
      IF COALESCE((v_res->>'created')::BOOLEAN, FALSE) OR COALESCE((v_res->>'reopened')::BOOLEAN, FALSE) THEN
        PERFORM public.order_payments_log(p_account, p_order, NULL, 'finalization_marked', p_actor, p_actor_name, NULL, NULL, NULL, f.paid_confirmed, f.paid_confirmed,
          0, 0, f.financial_status, f.financial_status, NULL, NULL, jsonb_build_object('finalized_at', v_at, 'delivered_source', d.source, 'paid_at', f.paid_at, 'delivered_at', d.delivered_at), p_now);
        RETURN 'marked';
      END IF;
    END IF;
    RETURN 'already';
  END IF;

  -- the order is NOT (or no longer) completely finalized
  IF z.order_id IS NOT NULL AND z.source = 'pr06_paid_and_delivered' THEN
    IF z.return_state = 'pending' THEN
      PERFORM public.clear_order_finalized(p_account, p_order, 'payment_reverted', p_now);
      PERFORM public.order_payments_log(p_account, p_order, NULL, 'finalization_cleared', p_actor, p_actor_name, NULL, NULL, NULL, f.paid_confirmed, f.paid_confirmed,
        GREATEST(v_total - f.paid_confirmed, 0), GREATEST(v_total - f.paid_confirmed, 0), f.financial_status, f.financial_status, NULL, 'payment_reverted', '{}'::jsonb, p_now);
      RETURN 'cleared';
    ELSIF z.return_state = 'returned' THEN
      -- the conversation already went back to Comercial: it is NOT moved again; the fact is recorded
      PERFORM public.order_payments_log(p_account, p_order, NULL, 'finalization_revoked_after_return', p_actor, p_actor_name, NULL, NULL, NULL, f.paid_confirmed, f.paid_confirmed,
        GREATEST(v_total - f.paid_confirmed, 0), GREATEST(v_total - f.paid_confirmed, 0), f.financial_status, f.financial_status, NULL, 'payment_reverted_after_return', '{}'::jsonb, p_now);
      RETURN 'revoked_after_return';
    END IF;
  END IF;
  RETURN 'not_finalized';
END;
$$;
ALTER FUNCTION public.order_payments_evaluate_finalization(UUID, UUID, UUID, TEXT, TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.order_payments_evaluate_finalization(UUID, UUID, UUID, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated, service_role;

-- the hook the payment RPCs already call
CREATE OR REPLACE FUNCTION public.order_payments_after_change(p_account UUID, p_order UUID, p_actor UUID, p_actor_name TEXT, p_now TIMESTAMPTZ)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.order_payments_evaluate_finalization(p_account, p_order, p_actor, p_actor_name, p_now);
END;
$$;
ALTER FUNCTION public.order_payments_after_change(UUID, UUID, UUID, TEXT, TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.order_payments_after_change(UUID, UUID, UUID, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated, service_role;

-- 3. Manual delivery RPC ---------------------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mark_order_delivered_manual(p_account UUID, p_actor UUID, p_order UUID, p_note TEXT DEFAULT NULL, p_now TIMESTAMPTZ DEFAULT now())
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  a RECORD;
  v_status TEXT;
  v_ship TEXT;
  v_existing public.order_manual_deliveries%ROWTYPE;
BEGIN
  SELECT * INTO a FROM public.order_payments_actor(p_account, p_actor);
  PERFORM public.order_logistics_require_order(p_account, p_order);
  PERFORM public.order_payments_lock(p_order);
  SELECT * INTO v_existing FROM public.order_manual_deliveries d WHERE d.order_id = p_order;
  IF FOUND THEN RETURN jsonb_build_object('ok', TRUE, 'changed', FALSE, 'delivered_at', v_existing.delivered_at); END IF;
  SELECT s.tracking_state INTO v_ship FROM public.order_shipments s WHERE s.order_id = p_order AND s.account_id = p_account;
  IF FOUND AND v_ship IN ('active', 'requires_attention', 'delivered') THEN RETURN jsonb_build_object('ok', FALSE, 'reason', 'shalom_tracking_active'); END IF;
  SELECT l.status INTO v_status FROM public.order_logistics l WHERE l.order_id = p_order AND l.account_id = p_account;
  IF v_status IS DISTINCT FROM 'ready_for_dispatch' THEN RETURN jsonb_build_object('ok', FALSE, 'reason', 'not_ready_for_dispatch'); END IF;

  INSERT INTO public.order_manual_deliveries (order_id, account_id, delivered_at, note, delivered_by, delivered_by_name)
  VALUES (p_order, p_account, p_now, NULLIF(left(btrim(p_note), 300), ''), p_actor, a.actor_name);
  PERFORM public.order_payments_log(p_account, p_order, NULL, 'order_delivered_manual', p_actor, a.actor_name, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULLIF(left(btrim(p_note), 300), ''),
    jsonb_build_object('delivered_at', p_now), p_now);
  IF EXISTS (SELECT 1 FROM public.order_financials f WHERE f.order_id = p_order) THEN
    PERFORM public.order_payments_evaluate_finalization(p_account, p_order, p_actor, a.actor_name, p_now);
  END IF;
  RETURN jsonb_build_object('ok', TRUE, 'changed', TRUE, 'delivered_at', p_now);
END;
$$;
ALTER FUNCTION public.mark_order_delivered_manual(UUID, UUID, UUID, TEXT, TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.mark_order_delivered_manual(UUID, UUID, UUID, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_order_delivered_manual(UUID, UUID, UUID, TEXT, TIMESTAMPTZ) TO service_role;

-- 4. Sweeper for the cron: orders delivered by Shalom AFTER being paid (nothing in PR-05 calls the evaluator), or any order a worker missed. Durable and idempotent.
DROP FUNCTION IF EXISTS public.evaluate_order_finalizations(TIMESTAMPTZ, INTEGER);
CREATE OR REPLACE FUNCTION public.evaluate_order_finalizations(p_now TIMESTAMPTZ DEFAULT now(), p_limit INTEGER DEFAULT 200, p_account UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r RECORD;
  v_marked INTEGER := 0;
  v_res TEXT;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 THEN RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023'; END IF;
  FOR r IN
    SELECT f.order_id, f.account_id
      FROM public.order_financials f
      JOIN public.order_payment_settings ps ON ps.account_id = f.account_id AND ps.order_payments_enabled
      JOIN public.order_integration_settings s ON s.account_id = f.account_id AND s.logistics_mvp_enabled
      LEFT JOIN public.order_finalizations z ON z.order_id = f.order_id
     WHERE f.financial_status = 'paid' AND (p_account IS NULL OR f.account_id = p_account) AND (z.order_id IS NULL OR z.return_state = 'skipped_cleared')
       AND (EXISTS (SELECT 1 FROM public.order_shipments sh WHERE sh.order_id = f.order_id AND sh.logistic_status = 'delivered' AND sh.tracking_state = 'delivered')
            OR EXISTS (SELECT 1 FROM public.order_manual_deliveries md WHERE md.order_id = f.order_id))
     ORDER BY f.updated_at
     LIMIT p_limit
  LOOP
    PERFORM public.order_payments_lock(r.order_id);
    v_res := public.order_payments_evaluate_finalization(r.account_id, r.order_id, NULL, 'system', p_now);
    IF v_res = 'marked' THEN v_marked := v_marked + 1; END IF;
  END LOOP;
  RETURN jsonb_build_object('marked', v_marked);
END;
$$;
ALTER FUNCTION public.evaluate_order_finalizations(TIMESTAMPTZ, INTEGER, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.evaluate_order_finalizations(TIMESTAMPTZ, INTEGER, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.evaluate_order_finalizations(TIMESTAMPTZ, INTEGER, UUID) TO service_role;

-- 5. The automatic return with the MULTI-ORDER rule (replaces PR-05C's function: the 3-argument one is dropped and the same one gains an OPTIONAL p_account filter, used by tests so
--    suites never process each other's rows; the cron calls it without it. Same grants, same audit reason / shapes.)
DROP FUNCTION IF EXISTS public.return_finalized_conversations(TIMESTAMPTZ, INTEGER, INTEGER);
CREATE OR REPLACE FUNCTION public.return_finalized_conversations(p_now TIMESTAMPTZ DEFAULT now(), p_grace_minutes INTEGER DEFAULT 10, p_limit INTEGER DEFAULT 100, p_account UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r RECORD;
  t RECORD;
  v_stage TEXT;
  v_version INTEGER;
  v_group_max TIMESTAMPTZ;
  v_state TEXT;
  v_returned INTEGER := 0;
  v_skipped INTEGER := 0;
  v_deferred INTEGER := 0;
  v_payments_on BOOLEAN;
BEGIN
  IF p_grace_minutes IS NULL OR p_grace_minutes < 0 OR p_limit IS NULL OR p_limit < 1 THEN RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023'; END IF;

  -- (a) orders WITHOUT a conversation: nothing to return (recorded, as before)
  WITH done AS (
    UPDATE public.order_finalizations f SET return_state = 'skipped_no_conversation', return_at = p_now
      FROM public.order_confirmations o, public.order_integration_settings s
     WHERE o.id = f.order_id AND o.account_id = f.account_id AND o.conversation_id IS NULL AND s.account_id = f.account_id AND s.logistics_mvp_enabled
       AND f.return_state = 'pending' AND f.cleared_at IS NULL AND f.finalized_at + make_interval(mins => p_grace_minutes) <= p_now AND (p_account IS NULL OR f.account_id = p_account)
    RETURNING f.order_id
  ) SELECT count(*) INTO v_skipped FROM done;

  -- (b) one decision per CONVERSATION
  FOR r IN
    SELECT DISTINCT o.conversation_id, f.account_id
      FROM public.order_finalizations f
      JOIN public.order_confirmations o ON o.id = f.order_id AND o.account_id = f.account_id
      JOIN public.order_integration_settings s ON s.account_id = f.account_id AND s.logistics_mvp_enabled
     WHERE f.return_state = 'pending' AND f.cleared_at IS NULL AND o.conversation_id IS NOT NULL AND (p_account IS NULL OR f.account_id = p_account)
     LIMIT p_limit
  LOOP
    -- the SAME lock the derive / confirm paths take (serializes two workers and any human action)
    SELECT c.stage, c.version INTO v_stage, v_version FROM public.conversation_routing c WHERE c.conversation_id = r.conversation_id AND c.account_id = r.account_id FOR UPDATE;
    v_stage := CASE WHEN FOUND THEN v_stage ELSE NULL END;

    -- the live finalizations of this conversation (returned ones count: they ARE finalized) and the LAST required one
    SELECT max(f.finalized_at) INTO v_group_max
      FROM public.order_finalizations f JOIN public.order_confirmations o ON o.id = f.order_id AND o.account_id = f.account_id
     WHERE o.conversation_id = r.conversation_id AND o.account_id = r.account_id AND f.cleared_at IS NULL;

    SELECT COALESCE((SELECT ps.order_payments_enabled FROM public.order_payment_settings ps WHERE ps.account_id = r.account_id), FALSE) INTO v_payments_on;
    -- a relevant (tracked) order of the chat WITHOUT a live finalization is still operative: the conversation stays where it is
    IF v_payments_on AND EXISTS (
      SELECT 1 FROM public.order_confirmations o2
       WHERE o2.conversation_id = r.conversation_id AND o2.account_id = r.account_id
         AND EXISTS (SELECT 1 FROM public.order_financials fin WHERE fin.order_id = o2.id)
         AND NOT EXISTS (SELECT 1 FROM public.order_finalizations ff WHERE ff.order_id = o2.id AND ff.cleared_at IS NULL)
    ) THEN
      v_deferred := v_deferred + 1;
      CONTINUE;
    END IF;
    IF v_group_max + make_interval(mins => p_grace_minutes) > p_now THEN CONTINUE; END IF;

    -- the pending rows of the group (re-read under the lock: another worker may have resolved them)
    SELECT f.order_id, f.routing_version_at INTO t
      FROM public.order_finalizations f JOIN public.order_confirmations o ON o.id = f.order_id AND o.account_id = f.account_id
     WHERE o.conversation_id = r.conversation_id AND o.account_id = r.account_id AND f.return_state = 'pending' AND f.cleared_at IS NULL
     ORDER BY f.finalized_at DESC, f.order_id LIMIT 1 FOR UPDATE OF f;
    IF NOT FOUND THEN CONTINUE; END IF;

    IF v_stage IS DISTINCT FROM 'logistics' THEN
      v_state := 'skipped_not_logistics';
    ELSIF v_version IS DISTINCT FROM t.routing_version_at THEN
      v_state := 'skipped_routing_changed';       -- a more recent routing decision exists: never overwritten
    ELSE
      UPDATE public.conversation_routing SET stage = 'commercial', updated_at = p_now, updated_by = NULL, version = version + 1 WHERE conversation_id = r.conversation_id AND account_id = r.account_id;
      INSERT INTO public.conversation_routing_events (account_id, conversation_id, from_stage, to_stage, reason, actor_user_id, actor_name, order_id)
      VALUES (r.account_id, r.conversation_id, 'logistics', 'commercial', 'order_finalized_grace_elapsed', NULL, 'system', t.order_id);
      v_state := 'returned';
    END IF;
    UPDATE public.order_finalizations f SET return_state = v_state, return_at = p_now
     WHERE f.return_state = 'pending' AND f.cleared_at IS NULL
       AND f.order_id IN (SELECT o.id FROM public.order_confirmations o WHERE o.conversation_id = r.conversation_id AND o.account_id = r.account_id);
    IF v_state = 'returned' THEN v_returned := v_returned + 1; ELSE v_skipped := v_skipped + 1; END IF;
  END LOOP;
  RETURN jsonb_build_object('returned', v_returned, 'skipped', v_skipped, 'deferred', v_deferred);
END;
$$;
ALTER FUNCTION public.return_finalized_conversations(TIMESTAMPTZ, INTEGER, INTEGER, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.return_finalized_conversations(TIMESTAMPTZ, INTEGER, INTEGER, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.return_finalized_conversations(TIMESTAMPTZ, INTEGER, INTEGER, UUID) TO service_role;
