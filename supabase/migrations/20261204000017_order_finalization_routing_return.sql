-- PR-05C · canonical "pedido completamente finalizado" SIGNAL + the durable automatic return of the conversation to COMERCIAL 10 minutes later.
--
-- WHAT THIS IS (and is not):
--   * Routing of a conversation and the state of an order are INDEPENDENT. Nothing here cancels / edits an order, Shalom, the voucher, the packaging, the
--     pickup condition or any payment. Only WHO works the conversation changes, on the SAME conversation_id with the SAME history (PR-03's model).
--   * The signal is `order_finalizations` (one row per order, written ONLY by a service-role function; the browser cannot read or write it). WHEN the business
--     rule is met ("completamente finalizado") is NOT decided here: PR-06 (financial part) will call mark_order_finalized(). PR-05C only builds the
--     infrastructure; QA simulates the signal with scripts. Nothing in the product marks an order as finalized today and no existing order is touched.
--   * The existing manual button "Derivar a Comercial" (PR-03, logistics -> shared) is NOT modified and keeps priority over the automation.
--
-- THE AUTOMATIC RETURN (durable: it lives in the database, a restart of the app loses nothing; the app cron only calls the function):
--   order_finalized_at = T  ->  eligible at T + grace (10 min)  ->  return_finalized_conversations() applies logistics -> commercial ONLY IF the conversation
--   is STILL in `logistics` AND its routing version is the one recorded when the order was finalized (any human / other transition in between bumps the
--   version, so a more recent decision is never overwritten). Otherwise it is a NO-OP that is recorded (return_state) and never retried.
--   Once per order (row lock + terminal return_state + unique audit index); two workers = one application. The transition is SYSTEM:
--   conversation_routing_events.reason = 'order_finalized_grace_elapsed', actor_user_id NULL, actor_name 'system', order_id set.

-- 1. The audit reason (additive: the PR-03 migration is not edited).
ALTER TABLE public.conversation_routing_events DROP CONSTRAINT IF EXISTS conversation_routing_events_reason_check;
ALTER TABLE public.conversation_routing_events ADD CONSTRAINT conversation_routing_events_reason_check
  CHECK (reason IN ('order_confirmed', 'derived_to_commercial', 'backfill', 'logistics_completed', 'order_finalized_grace_elapsed'));
ALTER TABLE public.conversation_routing_events DROP CONSTRAINT IF EXISTS conversation_routing_events_finalized_shape;
ALTER TABLE public.conversation_routing_events ADD CONSTRAINT conversation_routing_events_finalized_shape
  CHECK (reason <> 'order_finalized_grace_elapsed' OR (from_stage = 'logistics' AND to_stage = 'commercial' AND actor_user_id IS NULL AND order_id IS NOT NULL));
CREATE UNIQUE INDEX IF NOT EXISTS conversation_routing_events_finalized_once
  ON public.conversation_routing_events (order_id) WHERE reason = 'order_finalized_grace_elapsed';

-- 2. The signal.
CREATE TABLE IF NOT EXISTS public.order_finalizations (
  order_id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  finalized_at TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL CHECK (char_length(source) BETWEEN 1 AND 40),          -- who declared it ('qa_simulation' today; PR-06 will name its own)
  finalized_by UUID,                                                           -- no FK on purpose (audit survives user deletion); NULL = system
  routing_stage_at TEXT,                                                       -- the conversation's stage when finalized (NULL = no conversation)
  routing_version_at INTEGER,                                                  -- its routing version then (0 = no row yet): the "expected state"
  cleared_at TIMESTAMPTZ,                                                      -- finalized by mistake / corrected BEFORE the return ran
  cleared_reason TEXT CHECK (cleared_reason IS NULL OR char_length(cleared_reason) <= 80),
  return_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (return_state IN ('pending', 'returned', 'skipped_not_logistics', 'skipped_routing_changed', 'skipped_cleared', 'skipped_no_conversation')),
  return_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT order_finalizations_order_fk FOREIGN KEY (order_id, account_id) REFERENCES public.order_confirmations (id, account_id),
  CONSTRAINT order_finalizations_shape CHECK (
    (return_state = 'pending' AND return_at IS NULL)
    OR (return_state <> 'pending' AND return_at IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS order_finalizations_due_idx ON public.order_finalizations (finalized_at) WHERE return_state = 'pending';

ALTER TABLE public.order_finalizations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.order_finalizations FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.order_finalizations TO service_role;
-- no policy and no grant: the browser can neither read nor write the signal.

CREATE OR REPLACE FUNCTION public.order_finalizations_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF public.order_logistics_history_protected(OLD.account_id, OLD.order_id) THEN
      RAISE EXCEPTION 'order_finalizations rows cannot be deleted' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.order_id IS DISTINCT FROM OLD.order_id OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'finalization identity is immutable' USING ERRCODE = '42501';
  END IF;
  -- a CLEARED declaration may be re-opened (skipped_cleared -> pending); every other resolution is final
  IF OLD.return_state <> 'pending' AND NOT (OLD.return_state = 'skipped_cleared' AND NEW.return_state = 'pending')
     AND (NEW.return_state IS DISTINCT FROM OLD.return_state OR NEW.finalized_at IS DISTINCT FROM OLD.finalized_at) THEN
    RAISE EXCEPTION 'a resolved finalization is final' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.order_finalizations_guard() OWNER TO postgres;
DROP TRIGGER IF EXISTS order_finalizations_guard ON public.order_finalizations;
CREATE TRIGGER order_finalizations_guard BEFORE UPDATE OR DELETE ON public.order_finalizations FOR EACH ROW EXECUTE FUNCTION public.order_finalizations_guard();

-- 3. Declare the signal. Idempotent: the FIRST declaration wins (a repeat changes nothing). Re-declaring after a clear re-opens it only while nothing was applied.
CREATE OR REPLACE FUNCTION public.mark_order_finalized(p_account UUID, p_order UUID, p_source TEXT, p_actor UUID DEFAULT NULL, p_now TIMESTAMPTZ DEFAULT now())
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conv UUID;
  v_stage TEXT;
  v_version INTEGER;
  v_enabled BOOLEAN;
  f public.order_finalizations%ROWTYPE;
BEGIN
  IF p_account IS NULL OR p_order IS NULL OR p_source IS NULL OR btrim(p_source) = '' THEN RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023'; END IF;
  SELECT o.conversation_id INTO v_conv FROM public.order_confirmations o WHERE o.id = p_order AND o.account_id = p_account;
  IF NOT FOUND THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  SELECT COALESCE(s.logistics_mvp_enabled, FALSE) INTO v_enabled FROM public.order_integration_settings s WHERE s.account_id = p_account;
  IF NOT COALESCE(v_enabled, FALSE) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;

  SELECT * INTO f FROM public.order_finalizations x WHERE x.order_id = p_order FOR UPDATE;
  IF FOUND THEN
    IF f.cleared_at IS NOT NULL AND f.return_state = 'skipped_cleared' THEN
      -- re-declared after a correction: the clock restarts from the NEW moment, with a fresh expected routing state
      SELECT r.stage, r.version INTO v_stage, v_version FROM public.conversation_routing r WHERE r.conversation_id = v_conv AND r.account_id = p_account;
      UPDATE public.order_finalizations
         SET finalized_at = p_now, source = btrim(p_source), finalized_by = p_actor, cleared_at = NULL, cleared_reason = NULL, return_state = 'pending', return_at = NULL,
             routing_stage_at = CASE WHEN v_conv IS NULL THEN NULL ELSE COALESCE(v_stage, 'commercial') END, routing_version_at = CASE WHEN v_conv IS NULL THEN NULL ELSE COALESCE(v_version, 0) END
       WHERE order_id = p_order;
      RETURN jsonb_build_object('ok', TRUE, 'created', FALSE, 'reopened', TRUE, 'finalized_at', p_now);
    END IF;
    RETURN jsonb_build_object('ok', TRUE, 'created', FALSE, 'finalized_at', f.finalized_at, 'return_state', f.return_state);
  END IF;

  SELECT r.stage, r.version INTO v_stage, v_version FROM public.conversation_routing r WHERE r.conversation_id = v_conv AND r.account_id = p_account;
  INSERT INTO public.order_finalizations (order_id, account_id, finalized_at, source, finalized_by, routing_stage_at, routing_version_at)
  VALUES (p_order, p_account, p_now, btrim(p_source), p_actor, CASE WHEN v_conv IS NULL THEN NULL ELSE COALESCE(v_stage, 'commercial') END, CASE WHEN v_conv IS NULL THEN NULL ELSE COALESCE(v_version, 0) END)
  ON CONFLICT (order_id) DO NOTHING;
  RETURN jsonb_build_object('ok', TRUE, 'created', TRUE, 'finalized_at', p_now);
END;
$$;
ALTER FUNCTION public.mark_order_finalized(UUID, UUID, TEXT, UUID, TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.mark_order_finalized(UUID, UUID, TEXT, UUID, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_order_finalized(UUID, UUID, TEXT, UUID, TIMESTAMPTZ) TO service_role;

-- 4. The order stops being finalized (a permitted correction) BEFORE the return ran: the automation no longer applies.
CREATE OR REPLACE FUNCTION public.clear_order_finalized(p_account UUID, p_order UUID, p_reason TEXT DEFAULT NULL, p_now TIMESTAMPTZ DEFAULT now())
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  f public.order_finalizations%ROWTYPE;
BEGIN
  SELECT * INTO f FROM public.order_finalizations x WHERE x.order_id = p_order AND x.account_id = p_account FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', FALSE, 'reason', 'not_finalized'); END IF;
  IF f.return_state = 'skipped_cleared' THEN RETURN jsonb_build_object('ok', TRUE, 'changed', FALSE); END IF;
  IF f.return_state <> 'pending' THEN RETURN jsonb_build_object('ok', FALSE, 'reason', 'already_resolved', 'return_state', f.return_state); END IF;
  UPDATE public.order_finalizations
     SET cleared_at = p_now, cleared_reason = left(p_reason, 80), return_state = 'skipped_cleared', return_at = p_now
   WHERE order_id = p_order;
  RETURN jsonb_build_object('ok', TRUE, 'changed', TRUE);
END;
$$;
ALTER FUNCTION public.clear_order_finalized(UUID, UUID, TEXT, TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.clear_order_finalized(UUID, UUID, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clear_order_finalized(UUID, UUID, TEXT, TIMESTAMPTZ) TO service_role;

-- 5. The durable return. Called by the app cron (and by nothing else). `>=` : exactly +10 minutes is eligible.
CREATE OR REPLACE FUNCTION public.return_finalized_conversations(p_now TIMESTAMPTZ DEFAULT now(), p_grace_minutes INTEGER DEFAULT 10, p_limit INTEGER DEFAULT 100)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r RECORD;
  v_stage TEXT;
  v_version INTEGER;
  v_returned INTEGER := 0;
  v_skipped INTEGER := 0;
  v_state TEXT;
BEGIN
  IF p_grace_minutes IS NULL OR p_grace_minutes < 0 OR p_limit IS NULL OR p_limit < 1 THEN RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023'; END IF;
  FOR r IN
    SELECT f.order_id, f.account_id, f.routing_version_at, o.conversation_id
      FROM public.order_finalizations f
      JOIN public.order_confirmations o ON o.id = f.order_id AND o.account_id = f.account_id
      JOIN public.order_integration_settings s ON s.account_id = f.account_id AND s.logistics_mvp_enabled
     WHERE f.return_state = 'pending' AND f.cleared_at IS NULL AND f.finalized_at + make_interval(mins => p_grace_minutes) <= p_now
     ORDER BY f.finalized_at, f.order_id
     LIMIT p_limit
       FOR UPDATE OF f SKIP LOCKED
  LOOP
    v_state := NULL;
    IF r.conversation_id IS NULL THEN
      v_state := 'skipped_no_conversation';
    ELSE
      -- the SAME lock the derive / confirm paths take: a concurrent human action either finishes first (version moves) or waits
      SELECT c.stage, c.version INTO v_stage, v_version FROM public.conversation_routing c
       WHERE c.conversation_id = r.conversation_id AND c.account_id = r.account_id FOR UPDATE;
      IF NOT FOUND OR v_stage IS DISTINCT FROM 'logistics' THEN
        v_state := 'skipped_not_logistics';
      ELSIF v_version IS DISTINCT FROM r.routing_version_at THEN
        v_state := 'skipped_routing_changed';      -- a more recent routing decision exists: the automation never overwrites it
      ELSE
        UPDATE public.conversation_routing SET stage = 'commercial', updated_at = p_now, updated_by = NULL, version = version + 1
         WHERE conversation_id = r.conversation_id AND account_id = r.account_id;
        INSERT INTO public.conversation_routing_events (account_id, conversation_id, from_stage, to_stage, reason, actor_user_id, actor_name, order_id)
        VALUES (r.account_id, r.conversation_id, 'logistics', 'commercial', 'order_finalized_grace_elapsed', NULL, 'system', r.order_id);
        v_state := 'returned';
      END IF;
    END IF;
    UPDATE public.order_finalizations SET return_state = v_state, return_at = p_now WHERE order_id = r.order_id;
    IF v_state = 'returned' THEN v_returned := v_returned + 1; ELSE v_skipped := v_skipped + 1; END IF;
  END LOOP;
  RETURN jsonb_build_object('returned', v_returned, 'skipped', v_skipped);
END;
$$;
ALTER FUNCTION public.return_finalized_conversations(TIMESTAMPTZ, INTEGER, INTEGER) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.return_finalized_conversations(TIMESTAMPTZ, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.return_finalized_conversations(TIMESTAMPTZ, INTEGER, INTEGER) TO service_role;
