-- PR-06 · the only WRITERS of the financial axis. Every function is SECURITY DEFINER, executable ONLY by service_role, and RE-VALIDATES inside the database the
-- (account, actor) pair the backend derived from the session: both flags (logistics_mvp_enabled AND order_payments_enabled), operational area, account role
-- (viewers never) and ownership of the order. Cross-account and non-existent ids are indistinguishable (42501). Business refusals return {"ok": false, "reason": ...}.
--
-- The calculation is DETERMINISTIC and lives only here:  paid_confirmed = SUM(amount of the CONFIRMED payments);  pending_balance = price - paid_confirmed (never negative);
-- status: unpaid (paid = 0) | partially_paid (0 < paid < price) | paid (paid >= price). `price` (order_confirmations, immutable) is the only total.
-- Confirming a payment that EXCEEDS the pending balance is refused, except a SUPERVISOR with a mandatory reason (audited as overpayment_exception); the status never becomes "overpaid".
-- A mistake is never edited: a payment is rejected (before confirmation) or voided (after), and a correction = void + a new payment (Supervisor only, reason mandatory).
-- Operations on one order are serialized with a transaction-level advisory lock; every lifecycle event is unique per payment (a retry writes nothing twice).

CREATE OR REPLACE FUNCTION public.order_payments_lock(p_order UUID)
RETURNS VOID
LANGUAGE sql
AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('order_payments:' || p_order::text, 0))
$$;
ALTER FUNCTION public.order_payments_lock(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.order_payments_lock(UUID) FROM PUBLIC, anon, authenticated, service_role;

-- (account, actor) -> display name + operational role. Raises when the actor may not work payments in the account.
CREATE OR REPLACE FUNCTION public.order_payments_actor(p_account UUID, p_actor UUID)
RETURNS TABLE (actor_name TEXT, actor_role TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role public.operational_role_enum;
  v_account_role public.account_role_enum;
  v_name TEXT;
BEGIN
  IF p_account IS NULL OR p_actor IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  SELECT p.operational_role, p.account_role, COALESCE(NULLIF(btrim(p.full_name), ''), NULLIF(btrim(p.email), ''), 'unknown')
    INTO v_role, v_account_role, v_name
    FROM public.profiles p WHERE p.user_id = p_actor AND p.account_id = p_account;
  IF NOT FOUND THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  IF NOT COALESCE((SELECT s.logistics_mvp_enabled FROM public.order_integration_settings s WHERE s.account_id = p_account), FALSE)
     OR NOT COALESCE((SELECT ps.order_payments_enabled FROM public.order_payment_settings ps WHERE ps.account_id = p_account), FALSE) THEN
    RAISE EXCEPTION 'feature_disabled' USING ERRCODE = '42501';
  END IF;
  IF v_role IS NULL OR v_role NOT IN ('logistics', 'supervisor') OR v_account_role NOT IN ('owner', 'admin', 'agent') THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT v_name, v_role::TEXT;
END;
$$;
ALTER FUNCTION public.order_payments_actor(UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.order_payments_actor(UUID, UUID) FROM PUBLIC, anon, authenticated, service_role;

-- Audit writer.
CREATE OR REPLACE FUNCTION public.order_payments_log(
  p_account UUID, p_order UUID, p_payment UUID, p_type TEXT, p_actor UUID, p_actor_name TEXT, p_amount NUMERIC,
  p_status_before TEXT, p_status_after TEXT, p_paid_before NUMERIC, p_paid_after NUMERIC, p_balance_before NUMERIC, p_balance_after NUMERIC,
  p_fin_before TEXT, p_fin_after TEXT, p_evidence UUID, p_reason TEXT, p_detail JSONB DEFAULT '{}'::jsonb, p_now TIMESTAMPTZ DEFAULT clock_timestamp()
) RETURNS VOID
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.order_payment_events (account_id, order_id, payment_id, event_type, actor_user_id, actor_name, amount, status_before, status_after, paid_before, paid_after,
    balance_before, balance_after, financial_status_before, financial_status_after, evidence_document_id, reason, detail, created_at)
  VALUES (p_account, p_order, p_payment, p_type, p_actor, COALESCE(NULLIF(btrim(p_actor_name), ''), 'system'), p_amount, p_status_before, p_status_after, p_paid_before, p_paid_after,
    p_balance_before, p_balance_after, p_fin_before, p_fin_after, p_evidence, left(p_reason, 300), COALESCE(p_detail, '{}'::jsonb), GREATEST(p_now, clock_timestamp() - interval '1 second'))
  ON CONFLICT DO NOTHING;
END;
$$;
ALTER FUNCTION public.order_payments_log(UUID, UUID, UUID, TEXT, UUID, TEXT, NUMERIC, TEXT, TEXT, NUMERIC, NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT, UUID, TEXT, JSONB, TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.order_payments_log(UUID, UUID, UUID, TEXT, UUID, TEXT, NUMERIC, TEXT, TEXT, NUMERIC, NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT, UUID, TEXT, JSONB, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated, service_role;

-- The calculation. Locks the financial row; returns what changed. The caller already holds the order lock.
CREATE OR REPLACE FUNCTION public.order_payments_recalc(p_account UUID, p_order UUID, p_now TIMESTAMPTZ)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  f public.order_financials%ROWTYPE;
  v_total NUMERIC(12, 2);
  v_paid NUMERIC(12, 2);
  v_status TEXT;
  v_paid_at TIMESTAMPTZ;
BEGIN
  SELECT * INTO f FROM public.order_financials x WHERE x.order_id = p_order AND x.account_id = p_account FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_tracked' USING ERRCODE = '22023'; END IF;
  SELECT o.price INTO v_total FROM public.order_confirmations o WHERE o.id = p_order AND o.account_id = p_account;
  SELECT COALESCE(SUM(pm.amount), 0) INTO v_paid FROM public.order_payments pm WHERE pm.order_id = p_order AND pm.account_id = p_account AND pm.status = 'confirmed';
  v_status := CASE WHEN v_paid = 0 THEN 'unpaid' WHEN v_paid >= v_total THEN 'paid' ELSE 'partially_paid' END;
  v_paid_at := CASE WHEN v_status <> 'paid' THEN NULL WHEN f.financial_status = 'paid' THEN f.paid_at ELSE p_now END;
  UPDATE public.order_financials SET paid_confirmed = v_paid, financial_status = v_status, paid_at = v_paid_at, version = version + 1, updated_at = now() WHERE order_id = p_order;
  RETURN jsonb_build_object(
    'total', v_total, 'paid_before', f.paid_confirmed, 'paid_after', v_paid, 'status_before', f.financial_status, 'status_after', v_status,
    'balance_before', GREATEST(v_total - f.paid_confirmed, 0), 'balance_after', GREATEST(v_total - v_paid, 0), 'paid_at', v_paid_at);
END;
$$;
ALTER FUNCTION public.order_payments_recalc(UUID, UUID, TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.order_payments_recalc(UUID, UUID, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated, service_role;

-- HOOK called after every change that can move the financial status. Placeholder here (does nothing); the finalization migration replaces it.
CREATE OR REPLACE FUNCTION public.order_payments_after_change(p_account UUID, p_order UUID, p_actor UUID, p_actor_name TEXT, p_now TIMESTAMPTZ)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NULL;
END;
$$;
ALTER FUNCTION public.order_payments_after_change(UUID, UUID, UUID, TEXT, TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.order_payments_after_change(UUID, UUID, UUID, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated, service_role;

-- Evidence of a payment: a payment_proof of the SAME order, or a PR-04 voucher of that order (linked, never copied, never creating a payment by itself).
CREATE OR REPLACE FUNCTION public.order_payments_check_evidence(p_account UUID, p_order UUID, p_doc UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_doc IS NULL OR EXISTS (
    SELECT 1 FROM public.order_documents d
     WHERE d.id = p_doc AND d.account_id = p_account AND d.order_id = p_order
       AND ((d.kind = 'payment_proof' AND d.status = 'active') OR (d.kind = 'voucher' AND d.status IN ('pending_review', 'validated')))
  )
$$;
ALTER FUNCTION public.order_payments_check_evidence(UUID, UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.order_payments_check_evidence(UUID, UUID, UUID) FROM PUBLIC, anon, authenticated, service_role;

-- Shared validation of the declared payment data.
CREATE OR REPLACE FUNCTION public.order_payments_parse_amount(p_amount TEXT)
RETURNS NUMERIC
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF p_amount IS NULL OR btrim(p_amount) !~ '^[0-9]{1,7}(\.[0-9]{1,2})?$' OR btrim(p_amount)::NUMERIC <= 0 THEN
    RAISE EXCEPTION 'invalid_amount' USING ERRCODE = '22023';
  END IF;
  RETURN btrim(p_amount)::NUMERIC(12, 2);
END;
$$;
ALTER FUNCTION public.order_payments_parse_amount(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.order_payments_parse_amount(TEXT) FROM PUBLIC, anon, authenticated, service_role;

-- 1. Register (status recorded). Idempotent on request_key. ---------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.register_order_payment(
  p_account UUID, p_actor UUID, p_order UUID, p_request_key TEXT, p_amount TEXT, p_kind TEXT, p_method TEXT, p_operation_number TEXT,
  p_paid_at TIMESTAMPTZ, p_evidence UUID, p_notes TEXT, p_source TEXT DEFAULT 'manual', p_now TIMESTAMPTZ DEFAULT now()
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  a RECORD;
  v_amount NUMERIC(12, 2) := public.order_payments_parse_amount(p_amount);
  v_existing public.order_payments%ROWTYPE;
  f public.order_financials%ROWTYPE;
  v_total NUMERIC(12, 2);
  v_id UUID;
BEGIN
  SELECT * INTO a FROM public.order_payments_actor(p_account, p_actor);
  IF p_request_key IS NULL OR btrim(p_request_key) = '' OR char_length(p_request_key) > 100 OR p_kind IS NULL OR p_kind NOT IN ('advance', 'balance', 'full', 'other')
     OR p_paid_at IS NULL OR p_paid_at > p_now + interval '1 day' THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  PERFORM public.order_logistics_require_order(p_account, p_order);
  PERFORM public.order_payments_lock(p_order);

  SELECT * INTO v_existing FROM public.order_payments x WHERE x.account_id = p_account AND x.request_key = p_request_key;
  IF FOUND THEN
    IF v_existing.order_id <> p_order OR v_existing.amount <> v_amount OR v_existing.kind <> p_kind THEN RAISE EXCEPTION 'request_key_conflict' USING ERRCODE = '22023'; END IF;
    RETURN jsonb_build_object('ok', TRUE, 'created', FALSE, 'payment_id', v_existing.id, 'status', v_existing.status, 'row_version', v_existing.row_version);
  END IF;

  SELECT * INTO f FROM public.order_financials x WHERE x.order_id = p_order AND x.account_id = p_account;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', FALSE, 'reason', 'not_tracked'); END IF;
  IF NOT public.order_payments_check_evidence(p_account, p_order, p_evidence) THEN RETURN jsonb_build_object('ok', FALSE, 'reason', 'invalid_evidence'); END IF;
  SELECT o.price INTO v_total FROM public.order_confirmations o WHERE o.id = p_order;

  BEGIN
    INSERT INTO public.order_payments (account_id, order_id, request_key, amount, kind, method, operation_number, paid_at, status, evidence_document_id, notes, source, registered_by, registered_by_name, registered_at)
    VALUES (p_account, p_order, btrim(p_request_key), v_amount, p_kind, NULLIF(btrim(p_method), ''), NULLIF(btrim(p_operation_number), ''), p_paid_at, 'recorded', p_evidence,
            NULLIF(btrim(p_notes), ''), COALESCE(NULLIF(btrim(p_source), ''), 'manual'), p_actor, a.actor_name, p_now)
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    IF SQLERRM LIKE '%one_live_evidence%' THEN RETURN jsonb_build_object('ok', FALSE, 'reason', 'duplicate_evidence'); END IF;
    IF SQLERRM LIKE '%one_live_operation%' THEN RETURN jsonb_build_object('ok', FALSE, 'reason', 'duplicate_operation'); END IF;
    -- a concurrent call with the same request_key won the race: replay
    SELECT * INTO v_existing FROM public.order_payments x WHERE x.account_id = p_account AND x.request_key = p_request_key;
    IF FOUND THEN RETURN jsonb_build_object('ok', TRUE, 'created', FALSE, 'payment_id', v_existing.id, 'status', v_existing.status, 'row_version', v_existing.row_version); END IF;
    RAISE;
  END;

  PERFORM public.order_payments_log(p_account, p_order, v_id, 'payment_registered', p_actor, a.actor_name, v_amount, NULL, 'recorded', f.paid_confirmed, f.paid_confirmed,
    GREATEST(v_total - f.paid_confirmed, 0), GREATEST(v_total - f.paid_confirmed, 0), f.financial_status, f.financial_status, p_evidence, NULL,
    jsonb_build_object('kind', p_kind, 'method', NULLIF(btrim(p_method), ''), 'has_operation_number', NULLIF(btrim(p_operation_number), '') IS NOT NULL), p_now);
  RETURN jsonb_build_object('ok', TRUE, 'created', TRUE, 'payment_id', v_id, 'status', 'recorded', 'row_version', 1);
END;
$$;
ALTER FUNCTION public.register_order_payment(UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, UUID, TEXT, TEXT, TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.register_order_payment(UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, UUID, TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_order_payment(UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, UUID, TEXT, TEXT, TIMESTAMPTZ) TO service_role;

-- 2. Confirm (recorded -> confirmed). Logistica or Supervisor. Blocks an excess over the pending balance unless a Supervisor gives a reason. ----------------
CREATE OR REPLACE FUNCTION public.confirm_order_payment(
  p_account UUID, p_actor UUID, p_payment UUID, p_expected_version INTEGER DEFAULT NULL, p_overpayment_reason TEXT DEFAULT NULL, p_now TIMESTAMPTZ DEFAULT now()
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  a RECORD;
  pm public.order_payments%ROWTYPE;
  f public.order_financials%ROWTYPE;
  v_total NUMERIC(12, 2);
  v_pending NUMERIC(12, 2);
  v_reason TEXT := NULLIF(btrim(p_overpayment_reason), '');
  v_calc JSONB;
  v_excess NUMERIC(12, 2) := 0;
BEGIN
  SELECT * INTO a FROM public.order_payments_actor(p_account, p_actor);
  SELECT order_id INTO pm.order_id FROM public.order_payments x WHERE x.id = p_payment AND x.account_id = p_account;
  IF pm.order_id IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  PERFORM public.order_payments_lock(pm.order_id);
  SELECT * INTO pm FROM public.order_payments x WHERE x.id = p_payment AND x.account_id = p_account FOR UPDATE;
  IF p_expected_version IS NOT NULL AND pm.row_version <> p_expected_version THEN RETURN jsonb_build_object('ok', FALSE, 'reason', 'stale'); END IF;
  IF pm.status = 'confirmed' THEN RETURN jsonb_build_object('ok', TRUE, 'changed', FALSE, 'status', 'confirmed'); END IF;
  IF pm.status <> 'recorded' THEN RETURN jsonb_build_object('ok', FALSE, 'reason', 'not_confirmable', 'status', pm.status); END IF;

  SELECT * INTO f FROM public.order_financials x WHERE x.order_id = pm.order_id AND x.account_id = p_account FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', FALSE, 'reason', 'not_tracked'); END IF;
  SELECT o.price INTO v_total FROM public.order_confirmations o WHERE o.id = pm.order_id;
  v_pending := GREATEST(v_total - f.paid_confirmed, 0);
  IF pm.amount > v_pending THEN
    IF a.actor_role <> 'supervisor' THEN RETURN jsonb_build_object('ok', FALSE, 'reason', 'exceeds_balance', 'pending_balance', v_pending); END IF;
    IF v_reason IS NULL THEN RETURN jsonb_build_object('ok', FALSE, 'reason', 'overpayment_reason_required', 'pending_balance', v_pending); END IF;
    v_excess := pm.amount - v_pending;
  END IF;

  UPDATE public.order_payments SET status = 'confirmed', confirmed_by = p_actor, confirmed_by_name = a.actor_name, confirmed_at = p_now,
         overpayment_reason = CASE WHEN v_excess > 0 THEN left(v_reason, 300) ELSE NULL END, row_version = row_version + 1 WHERE id = pm.id;
  v_calc := public.order_payments_recalc(p_account, pm.order_id, p_now);
  PERFORM public.order_payments_log(p_account, pm.order_id, pm.id, 'payment_confirmed', p_actor, a.actor_name, pm.amount, 'recorded', 'confirmed',
    (v_calc->>'paid_before')::NUMERIC, (v_calc->>'paid_after')::NUMERIC, (v_calc->>'balance_before')::NUMERIC, (v_calc->>'balance_after')::NUMERIC,
    v_calc->>'status_before', v_calc->>'status_after', pm.evidence_document_id, NULL, jsonb_build_object('kind', pm.kind), p_now);
  IF v_excess > 0 THEN
    PERFORM public.order_payments_log(p_account, pm.order_id, pm.id, 'overpayment_exception', p_actor, a.actor_name, pm.amount, 'recorded', 'confirmed',
      (v_calc->>'paid_before')::NUMERIC, (v_calc->>'paid_after')::NUMERIC, (v_calc->>'balance_before')::NUMERIC, (v_calc->>'balance_after')::NUMERIC,
      v_calc->>'status_before', v_calc->>'status_after', pm.evidence_document_id, v_reason, jsonb_build_object('excess', v_excess), p_now);
  END IF;
  PERFORM public.order_payments_after_change(p_account, pm.order_id, p_actor, a.actor_name, p_now);
  RETURN jsonb_build_object('ok', TRUE, 'changed', TRUE, 'status', 'confirmed', 'financial_status', v_calc->>'status_after', 'paid_confirmed', (v_calc->>'paid_after')::NUMERIC,
    'pending_balance', (v_calc->>'balance_after')::NUMERIC, 'overpayment', v_excess > 0);
END;
$$;
ALTER FUNCTION public.confirm_order_payment(UUID, UUID, UUID, INTEGER, TEXT, TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.confirm_order_payment(UUID, UUID, UUID, INTEGER, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_order_payment(UUID, UUID, UUID, INTEGER, TEXT, TIMESTAMPTZ) TO service_role;

-- 3. Reject (recorded -> rejected): the proof is not valid. No effect on the balance. -----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reject_order_payment(
  p_account UUID, p_actor UUID, p_payment UUID, p_expected_version INTEGER DEFAULT NULL, p_reason TEXT DEFAULT NULL, p_now TIMESTAMPTZ DEFAULT now()
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  a RECORD;
  pm public.order_payments%ROWTYPE;
  f public.order_financials%ROWTYPE;
  v_total NUMERIC(12, 2);
  v_reason TEXT := NULLIF(btrim(p_reason), '');
BEGIN
  SELECT * INTO a FROM public.order_payments_actor(p_account, p_actor);
  SELECT order_id INTO pm.order_id FROM public.order_payments x WHERE x.id = p_payment AND x.account_id = p_account;
  IF pm.order_id IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  IF v_reason IS NULL OR char_length(v_reason) > 300 THEN RAISE EXCEPTION 'reason_required' USING ERRCODE = '22023'; END IF;
  PERFORM public.order_payments_lock(pm.order_id);
  SELECT * INTO pm FROM public.order_payments x WHERE x.id = p_payment AND x.account_id = p_account FOR UPDATE;
  IF p_expected_version IS NOT NULL AND pm.row_version <> p_expected_version THEN RETURN jsonb_build_object('ok', FALSE, 'reason', 'stale'); END IF;
  IF pm.status = 'rejected' THEN RETURN jsonb_build_object('ok', TRUE, 'changed', FALSE, 'status', 'rejected'); END IF;
  IF pm.status <> 'recorded' THEN RETURN jsonb_build_object('ok', FALSE, 'reason', 'not_rejectable', 'status', pm.status); END IF;
  SELECT * INTO f FROM public.order_financials x WHERE x.order_id = pm.order_id;
  SELECT o.price INTO v_total FROM public.order_confirmations o WHERE o.id = pm.order_id;
  UPDATE public.order_payments SET status = 'rejected', rejected_by = p_actor, rejected_by_name = a.actor_name, rejected_at = p_now, rejected_reason = v_reason, row_version = row_version + 1 WHERE id = pm.id;
  PERFORM public.order_payments_log(p_account, pm.order_id, pm.id, 'payment_rejected', p_actor, a.actor_name, pm.amount, 'recorded', 'rejected', f.paid_confirmed, f.paid_confirmed,
    GREATEST(v_total - f.paid_confirmed, 0), GREATEST(v_total - f.paid_confirmed, 0), f.financial_status, f.financial_status, pm.evidence_document_id, v_reason, '{}'::jsonb, p_now);
  RETURN jsonb_build_object('ok', TRUE, 'changed', TRUE, 'status', 'rejected');
END;
$$;
ALTER FUNCTION public.reject_order_payment(UUID, UUID, UUID, INTEGER, TEXT, TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.reject_order_payment(UUID, UUID, UUID, INTEGER, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reject_order_payment(UUID, UUID, UUID, INTEGER, TEXT, TIMESTAMPTZ) TO service_role;

-- 4. Void (confirmed -> voided). SUPERVISOR only, reason mandatory. Never deletes; recalculates. --------------------------------------------------------
CREATE OR REPLACE FUNCTION public.void_order_payment(
  p_account UUID, p_actor UUID, p_payment UUID, p_expected_version INTEGER DEFAULT NULL, p_reason TEXT DEFAULT NULL, p_now TIMESTAMPTZ DEFAULT now()
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  a RECORD;
  pm public.order_payments%ROWTYPE;
  v_calc JSONB;
  v_reason TEXT := NULLIF(btrim(p_reason), '');
BEGIN
  SELECT * INTO a FROM public.order_payments_actor(p_account, p_actor);
  IF a.actor_role <> 'supervisor' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  SELECT order_id INTO pm.order_id FROM public.order_payments x WHERE x.id = p_payment AND x.account_id = p_account;
  IF pm.order_id IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  IF v_reason IS NULL OR char_length(v_reason) > 300 THEN RAISE EXCEPTION 'reason_required' USING ERRCODE = '22023'; END IF;
  PERFORM public.order_payments_lock(pm.order_id);
  SELECT * INTO pm FROM public.order_payments x WHERE x.id = p_payment AND x.account_id = p_account FOR UPDATE;
  IF p_expected_version IS NOT NULL AND pm.row_version <> p_expected_version THEN RETURN jsonb_build_object('ok', FALSE, 'reason', 'stale'); END IF;
  IF pm.status = 'voided' THEN RETURN jsonb_build_object('ok', TRUE, 'changed', FALSE, 'status', 'voided'); END IF;
  IF pm.status <> 'confirmed' THEN RETURN jsonb_build_object('ok', FALSE, 'reason', 'not_voidable', 'status', pm.status); END IF;
  UPDATE public.order_payments SET status = 'voided', voided_by = p_actor, voided_by_name = a.actor_name, voided_at = p_now, voided_reason = v_reason, row_version = row_version + 1 WHERE id = pm.id;
  v_calc := public.order_payments_recalc(p_account, pm.order_id, p_now);
  PERFORM public.order_payments_log(p_account, pm.order_id, pm.id, 'payment_voided', p_actor, a.actor_name, pm.amount, 'confirmed', 'voided',
    (v_calc->>'paid_before')::NUMERIC, (v_calc->>'paid_after')::NUMERIC, (v_calc->>'balance_before')::NUMERIC, (v_calc->>'balance_after')::NUMERIC,
    v_calc->>'status_before', v_calc->>'status_after', pm.evidence_document_id, v_reason, '{}'::jsonb, p_now);
  PERFORM public.order_payments_after_change(p_account, pm.order_id, p_actor, a.actor_name, p_now);
  RETURN jsonb_build_object('ok', TRUE, 'changed', TRUE, 'status', 'voided', 'financial_status', v_calc->>'status_after', 'paid_confirmed', (v_calc->>'paid_after')::NUMERIC,
    'pending_balance', (v_calc->>'balance_after')::NUMERIC);
END;
$$;
ALTER FUNCTION public.void_order_payment(UUID, UUID, UUID, INTEGER, TEXT, TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.void_order_payment(UUID, UUID, UUID, INTEGER, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.void_order_payment(UUID, UUID, UUID, INTEGER, TEXT, TIMESTAMPTZ) TO service_role;

-- 5. Correct = void the confirmed payment + a NEW confirmed payment, in ONE transaction. SUPERVISOR only, reason mandatory. ----------------------------------
CREATE OR REPLACE FUNCTION public.correct_order_payment(
  p_account UUID, p_actor UUID, p_payment UUID, p_expected_version INTEGER, p_reason TEXT, p_request_key TEXT, p_amount TEXT, p_kind TEXT, p_method TEXT,
  p_operation_number TEXT, p_paid_at TIMESTAMPTZ, p_evidence UUID, p_notes TEXT, p_overpayment_reason TEXT DEFAULT NULL, p_now TIMESTAMPTZ DEFAULT now()
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  a RECORD;
  old public.order_payments%ROWTYPE;
  nw public.order_payments%ROWTYPE;
  v_amount NUMERIC(12, 2) := public.order_payments_parse_amount(p_amount);
  v_reason TEXT := NULLIF(btrim(p_reason), '');
  v_over TEXT := NULLIF(btrim(p_overpayment_reason), '');
  f public.order_financials%ROWTYPE;
  v_total NUMERIC(12, 2);
  v_pending NUMERIC(12, 2);
  v_excess NUMERIC(12, 2) := 0;
  v_calc JSONB;
  v_calc2 JSONB;
  v_id UUID;
BEGIN
  SELECT * INTO a FROM public.order_payments_actor(p_account, p_actor);
  IF a.actor_role <> 'supervisor' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  SELECT order_id INTO old.order_id FROM public.order_payments x WHERE x.id = p_payment AND x.account_id = p_account;
  IF old.order_id IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  IF v_reason IS NULL OR char_length(v_reason) > 300 OR p_request_key IS NULL OR btrim(p_request_key) = '' OR char_length(p_request_key) > 100
     OR p_kind IS NULL OR p_kind NOT IN ('advance', 'balance', 'full', 'other') OR p_paid_at IS NULL OR p_paid_at > p_now + interval '1 day' THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  PERFORM public.order_payments_lock(old.order_id);

  -- replay of the same correction (double click / retry)
  SELECT * INTO nw FROM public.order_payments x WHERE x.account_id = p_account AND x.request_key = p_request_key;
  IF FOUND THEN
    IF nw.supersedes_payment_id IS DISTINCT FROM p_payment OR nw.amount <> v_amount THEN RAISE EXCEPTION 'request_key_conflict' USING ERRCODE = '22023'; END IF;
    RETURN jsonb_build_object('ok', TRUE, 'changed', FALSE, 'payment_id', nw.id, 'status', nw.status);
  END IF;

  SELECT * INTO old FROM public.order_payments x WHERE x.id = p_payment AND x.account_id = p_account FOR UPDATE;
  IF p_expected_version IS NOT NULL AND old.row_version <> p_expected_version THEN RETURN jsonb_build_object('ok', FALSE, 'reason', 'stale'); END IF;
  IF old.status <> 'confirmed' THEN RETURN jsonb_build_object('ok', FALSE, 'reason', 'not_correctable', 'status', old.status); END IF;
  IF NOT public.order_payments_check_evidence(p_account, old.order_id, p_evidence) THEN RETURN jsonb_build_object('ok', FALSE, 'reason', 'invalid_evidence'); END IF;

  UPDATE public.order_payments SET status = 'voided', voided_by = p_actor, voided_by_name = a.actor_name, voided_at = p_now, voided_reason = v_reason, row_version = row_version + 1 WHERE id = old.id;
  v_calc := public.order_payments_recalc(p_account, old.order_id, p_now);
  PERFORM public.order_payments_log(p_account, old.order_id, old.id, 'payment_voided', p_actor, a.actor_name, old.amount, 'confirmed', 'voided',
    (v_calc->>'paid_before')::NUMERIC, (v_calc->>'paid_after')::NUMERIC, (v_calc->>'balance_before')::NUMERIC, (v_calc->>'balance_after')::NUMERIC,
    v_calc->>'status_before', v_calc->>'status_after', old.evidence_document_id, v_reason, jsonb_build_object('correction', TRUE), p_now);

  SELECT o.price INTO v_total FROM public.order_confirmations o WHERE o.id = old.order_id;
  SELECT * INTO f FROM public.order_financials x WHERE x.order_id = old.order_id;
  v_pending := GREATEST(v_total - f.paid_confirmed, 0);
  IF v_amount > v_pending THEN
    IF v_over IS NULL THEN RAISE EXCEPTION 'overpayment_reason_required' USING ERRCODE = '22023'; END IF;   -- rolls the whole correction back
    v_excess := v_amount - v_pending;
  END IF;

  BEGIN
    INSERT INTO public.order_payments (account_id, order_id, request_key, amount, kind, method, operation_number, paid_at, status, evidence_document_id, notes, source, supersedes_payment_id,
      overpayment_reason, registered_by, registered_by_name, registered_at, confirmed_by, confirmed_by_name, confirmed_at)
    VALUES (p_account, old.order_id, btrim(p_request_key), v_amount, p_kind, NULLIF(btrim(p_method), ''), NULLIF(btrim(p_operation_number), ''), p_paid_at, 'confirmed', p_evidence,
            NULLIF(btrim(p_notes), ''), 'manual', old.id, CASE WHEN v_excess > 0 THEN left(v_over, 300) END, p_actor, a.actor_name, p_now, p_actor, a.actor_name, p_now)
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    IF SQLERRM LIKE '%one_live_evidence%' THEN RAISE EXCEPTION 'duplicate_evidence' USING ERRCODE = '22023'; END IF;
    IF SQLERRM LIKE '%one_live_operation%' THEN RAISE EXCEPTION 'duplicate_operation' USING ERRCODE = '22023'; END IF;
    RAISE;
  END;
  v_calc2 := public.order_payments_recalc(p_account, old.order_id, p_now);
  PERFORM public.order_payments_log(p_account, old.order_id, v_id, 'payment_registered', p_actor, a.actor_name, v_amount, NULL, 'confirmed', f.paid_confirmed, f.paid_confirmed,
    v_pending, v_pending, v_calc->>'status_after', v_calc->>'status_after', p_evidence, v_reason, jsonb_build_object('supersedes', old.id), p_now);
  PERFORM public.order_payments_log(p_account, old.order_id, v_id, 'payment_confirmed', p_actor, a.actor_name, v_amount, 'recorded', 'confirmed',
    (v_calc2->>'paid_before')::NUMERIC, (v_calc2->>'paid_after')::NUMERIC, (v_calc2->>'balance_before')::NUMERIC, (v_calc2->>'balance_after')::NUMERIC,
    v_calc2->>'status_before', v_calc2->>'status_after', p_evidence, NULL, jsonb_build_object('kind', p_kind, 'correction', TRUE), p_now);
  PERFORM public.order_payments_log(p_account, old.order_id, v_id, 'payment_corrected', p_actor, a.actor_name, v_amount, 'confirmed', 'confirmed',
    (v_calc->>'paid_before')::NUMERIC, (v_calc2->>'paid_after')::NUMERIC, (v_calc->>'balance_before')::NUMERIC, (v_calc2->>'balance_after')::NUMERIC,
    v_calc->>'status_before', v_calc2->>'status_after', p_evidence, v_reason, jsonb_build_object('voided_payment', old.id, 'amount_before', old.amount, 'amount_after', v_amount), p_now);
  IF v_excess > 0 THEN
    PERFORM public.order_payments_log(p_account, old.order_id, v_id, 'overpayment_exception', p_actor, a.actor_name, v_amount, 'recorded', 'confirmed',
      (v_calc2->>'paid_before')::NUMERIC, (v_calc2->>'paid_after')::NUMERIC, (v_calc2->>'balance_before')::NUMERIC, (v_calc2->>'balance_after')::NUMERIC,
      v_calc2->>'status_before', v_calc2->>'status_after', p_evidence, v_over, jsonb_build_object('excess', v_excess), p_now);
  END IF;
  PERFORM public.order_payments_after_change(p_account, old.order_id, p_actor, a.actor_name, p_now);
  RETURN jsonb_build_object('ok', TRUE, 'changed', TRUE, 'payment_id', v_id, 'voided_payment_id', old.id, 'status', 'confirmed', 'financial_status', v_calc2->>'status_after',
    'paid_confirmed', (v_calc2->>'paid_after')::NUMERIC, 'pending_balance', (v_calc2->>'balance_after')::NUMERIC, 'overpayment', v_excess > 0);
END;
$$;
ALTER FUNCTION public.correct_order_payment(UUID, UUID, UUID, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, UUID, TEXT, TEXT, TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.correct_order_payment(UUID, UUID, UUID, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, UUID, TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.correct_order_payment(UUID, UUID, UUID, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, UUID, TEXT, TEXT, TIMESTAMPTZ) TO service_role;
