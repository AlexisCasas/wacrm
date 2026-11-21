-- SYNC-03 · Payment/saldo parity adapter for WACRM <-> InkaClick.
-- ADDITIVE and INERT until its RPCs are called by a future transport worker.
-- It does not install triggers, cron jobs, HTTP calls, flags or automatic synchronization.
--
-- Contract: payment.snapshot carries only {total, paid, balance}; no customer PII.
-- Safety rule: a snapshot may only ADVANCE the receiver's confirmed paid amount.
-- A lower remote paid amount, total mismatch, invalid arithmetic, missing tracking row, or disabled feature fails closed as a receipt conflict.
-- Canonical identity remains the WACRM order UUID.

CREATE OR REPLACE FUNCTION public.emit_wacrm_payment_snapshot(
  p_account UUID,
  p_order UUID,
  p_now TIMESTAMPTZ DEFAULT clock_timestamp()
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  f public.order_financials%ROWTYPE;
  v_total NUMERIC(12,2);
  v_balance NUMERIC(12,2);
  v_key TEXT;
  v_origin_event UUID;
  v_record RECORD;
BEGIN
  SELECT x.* INTO f
  FROM public.order_financials x
  WHERE x.account_id = p_account AND x.order_id = p_order;

  IF NOT FOUND THEN RETURN jsonb_build_object('ok', FALSE, 'reason', 'not_tracked'); END IF;

  SELECT o.price INTO v_total
  FROM public.order_confirmations o
  WHERE o.account_id = p_account AND o.id = p_order;

  IF v_total IS NULL THEN RAISE EXCEPTION 'order_not_found' USING ERRCODE = 'P0002'; END IF;

  v_balance := GREATEST(v_total - f.paid_confirmed, 0);
  v_key := 'payment.snapshot:' || p_order::text || ':v' || f.version::text;
  v_origin_event := md5('wacrm|' || v_key)::uuid;

  SELECT * INTO v_record
  FROM public.record_order_sync_event(
    p_order, 'wacrm', v_origin_event, 'payment.snapshot', 1, v_key, COALESCE(f.updated_at, p_now),
    jsonb_build_object('total', v_total, 'paid', f.paid_confirmed, 'balance', v_balance)
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'event_id', v_record.event_id,
    'origin_event_id', v_origin_event,
    'created', v_record.created,
    'financial_version', f.version,
    'total', v_total,
    'paid', f.paid_confirmed,
    'balance', v_balance
  );
END;
$$;
ALTER FUNCTION public.emit_wacrm_payment_snapshot(UUID,UUID,TIMESTAMPTZ) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.apply_inkaclick_payment_snapshot(
  p_origin_event UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  e public.order_sync_events%ROWTYPE;
  r public.order_sync_receipts%ROWTYPE;
  f public.order_financials%ROWTYPE;
  v_account UUID;
  v_total NUMERIC(12,2);
  v_remote_total NUMERIC(12,2);
  v_remote_paid NUMERIC(12,2);
  v_remote_balance NUMERIC(12,2);
  v_delta NUMERIC(12,2);
  v_payment UUID;
  v_calc JSONB;
  v_request_key TEXT;
BEGIN
  SELECT x.* INTO e
  FROM public.order_sync_events x
  WHERE x.origin_system = 'inkaclick'
    AND x.origin_event_id = p_origin_event
    AND x.event_type = 'payment.snapshot';

  IF NOT FOUND THEN RAISE EXCEPTION 'sync_payment_event_not_found' USING ERRCODE = 'P0002'; END IF;

  PERFORM public.ensure_order_sync_receipt('inkaclick', p_origin_event, 'wacrm');

  SELECT x.* INTO r
  FROM public.order_sync_receipts x
  WHERE x.event_id = e.id AND x.consumer_system = 'wacrm'
  FOR UPDATE;

  IF r.status = 'applied' THEN
    RETURN jsonb_build_object('ok', TRUE, 'changed', FALSE, 'status', 'applied');
  END IF;
  IF r.status IN ('dead_letter', 'ignored') THEN
    RETURN jsonb_build_object('ok', FALSE, 'changed', FALSE, 'status', r.status, 'reason', r.last_error_code);
  END IF;

  IF COALESCE(e.payload->>'total','') !~ '^[0-9]{1,7}(\.[0-9]{1,2})?$'
     OR COALESCE(e.payload->>'paid','') !~ '^[0-9]{1,7}(\.[0-9]{1,2})?$'
     OR COALESCE(e.payload->>'balance','') !~ '^[0-9]{1,7}(\.[0-9]{1,2})?$' THEN
    UPDATE public.order_sync_receipts SET status='conflict', last_error_code='invalid_payment_payload', updated_at=clock_timestamp(), applied_at=NULL
    WHERE event_id=e.id AND consumer_system='wacrm';
    RETURN jsonb_build_object('ok', FALSE, 'changed', FALSE, 'status', 'conflict', 'reason', 'invalid_payment_payload');
  END IF;

  v_remote_total := (e.payload->>'total')::NUMERIC(12,2);
  v_remote_paid := (e.payload->>'paid')::NUMERIC(12,2);
  v_remote_balance := (e.payload->>'balance')::NUMERIC(12,2);

  IF v_remote_total <= 0 OR v_remote_paid < 0 OR v_remote_paid > v_remote_total
     OR v_remote_balance <> GREATEST(v_remote_total - v_remote_paid, 0) THEN
    UPDATE public.order_sync_receipts SET status='conflict', last_error_code='invalid_payment_arithmetic', updated_at=clock_timestamp(), applied_at=NULL
    WHERE event_id=e.id AND consumer_system='wacrm';
    RETURN jsonb_build_object('ok', FALSE, 'changed', FALSE, 'status', 'conflict', 'reason', 'invalid_payment_arithmetic');
  END IF;

  SELECT o.account_id, o.price INTO v_account, v_total
  FROM public.order_confirmations o
  WHERE o.id = e.canonical_order_id;

  IF v_account IS NULL THEN
    UPDATE public.order_sync_receipts SET status='conflict', last_error_code='order_not_found', updated_at=clock_timestamp(), applied_at=NULL
    WHERE event_id=e.id AND consumer_system='wacrm';
    RETURN jsonb_build_object('ok', FALSE, 'changed', FALSE, 'status', 'conflict', 'reason', 'order_not_found');
  END IF;

  IF NOT COALESCE((SELECT s.logistics_mvp_enabled FROM public.order_integration_settings s WHERE s.account_id=v_account), FALSE)
     OR NOT COALESCE((SELECT s.order_payments_enabled FROM public.order_payment_settings s WHERE s.account_id=v_account), FALSE) THEN
    UPDATE public.order_sync_receipts SET status='conflict', last_error_code='feature_disabled', updated_at=clock_timestamp(), applied_at=NULL
    WHERE event_id=e.id AND consumer_system='wacrm';
    RETURN jsonb_build_object('ok', FALSE, 'changed', FALSE, 'status', 'conflict', 'reason', 'feature_disabled');
  END IF;

  PERFORM public.order_payments_lock(e.canonical_order_id);

  SELECT x.* INTO f
  FROM public.order_financials x
  WHERE x.account_id=v_account AND x.order_id=e.canonical_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    UPDATE public.order_sync_receipts SET status='conflict', last_error_code='not_tracked', updated_at=clock_timestamp(), applied_at=NULL
    WHERE event_id=e.id AND consumer_system='wacrm';
    RETURN jsonb_build_object('ok', FALSE, 'changed', FALSE, 'status', 'conflict', 'reason', 'not_tracked');
  END IF;

  SELECT o.price INTO v_total FROM public.order_confirmations o WHERE o.id=e.canonical_order_id AND o.account_id=v_account;

  IF v_remote_total <> v_total THEN
    UPDATE public.order_sync_receipts SET status='conflict', last_error_code='total_mismatch', updated_at=clock_timestamp(), applied_at=NULL
    WHERE event_id=e.id AND consumer_system='wacrm';
    RETURN jsonb_build_object('ok', FALSE, 'changed', FALSE, 'status', 'conflict', 'reason', 'total_mismatch', 'local_total', v_total, 'remote_total', v_remote_total);
  END IF;

  IF v_remote_paid < f.paid_confirmed THEN
    UPDATE public.order_sync_receipts SET status='conflict', last_error_code='wacrm_ahead', updated_at=clock_timestamp(), applied_at=NULL
    WHERE event_id=e.id AND consumer_system='wacrm';
    RETURN jsonb_build_object('ok', FALSE, 'changed', FALSE, 'status', 'conflict', 'reason', 'wacrm_ahead', 'local_paid', f.paid_confirmed, 'remote_paid', v_remote_paid);
  END IF;

  IF v_remote_paid = f.paid_confirmed THEN
    UPDATE public.order_sync_receipts SET status='applied', last_error_code=NULL, updated_at=clock_timestamp(), applied_at=clock_timestamp()
    WHERE event_id=e.id AND consumer_system='wacrm';
    RETURN jsonb_build_object('ok', TRUE, 'changed', FALSE, 'status', 'applied', 'paid', f.paid_confirmed, 'balance', GREATEST(v_total-f.paid_confirmed,0));
  END IF;

  v_delta := v_remote_paid - f.paid_confirmed;
  v_request_key := 'sync:inkaclick:' || p_origin_event::text;

  BEGIN
    INSERT INTO public.order_payments (
      account_id, order_id, request_key, amount, currency, kind, method, operation_number, paid_at, status,
      evidence_document_id, notes, source, registered_by, registered_by_name, registered_at,
      confirmed_by, confirmed_by_name, confirmed_at, row_version
    ) VALUES (
      v_account, e.canonical_order_id, v_request_key, v_delta, 'PEN', 'other', 'sync_inkaclick', NULL, e.occurred_at, 'confirmed',
      NULL, NULL, 'inkaclick_sync', NULL, 'InkaClick sync', e.occurred_at,
      NULL, 'InkaClick sync', e.occurred_at, 1
    )
    RETURNING id INTO v_payment;
  EXCEPTION WHEN unique_violation THEN
    SELECT p.id INTO v_payment
    FROM public.order_payments p
    WHERE p.account_id=v_account AND p.request_key=v_request_key AND p.order_id=e.canonical_order_id AND p.amount=v_delta;
    IF v_payment IS NULL THEN RAISE; END IF;
  END;

  v_calc := public.order_payments_recalc(v_account, e.canonical_order_id, e.occurred_at);

  PERFORM public.order_payments_log(
    v_account, e.canonical_order_id, v_payment, 'payment_registered', NULL, 'InkaClick sync', v_delta,
    NULL, 'recorded', (v_calc->>'paid_before')::NUMERIC, (v_calc->>'paid_before')::NUMERIC,
    (v_calc->>'balance_before')::NUMERIC, (v_calc->>'balance_before')::NUMERIC,
    v_calc->>'status_before', v_calc->>'status_before', NULL, NULL,
    jsonb_build_object('source','inkaclick_sync','origin_event_id',p_origin_event), e.occurred_at
  );

  PERFORM public.order_payments_log(
    v_account, e.canonical_order_id, v_payment, 'payment_confirmed', NULL, 'InkaClick sync', v_delta,
    'recorded', 'confirmed', (v_calc->>'paid_before')::NUMERIC, (v_calc->>'paid_after')::NUMERIC,
    (v_calc->>'balance_before')::NUMERIC, (v_calc->>'balance_after')::NUMERIC,
    v_calc->>'status_before', v_calc->>'status_after', NULL, NULL,
    jsonb_build_object('source','inkaclick_sync','origin_event_id',p_origin_event), e.occurred_at
  );

  PERFORM public.order_payments_after_change(v_account, e.canonical_order_id, NULL, 'InkaClick sync', e.occurred_at);

  UPDATE public.order_sync_receipts
  SET status='applied', last_error_code=NULL, updated_at=clock_timestamp(), applied_at=clock_timestamp()
  WHERE event_id=e.id AND consumer_system='wacrm';

  RETURN jsonb_build_object(
    'ok', TRUE, 'changed', TRUE, 'status', 'applied',
    'payment_id', v_payment,
    'delta', v_delta,
    'paid', (v_calc->>'paid_after')::NUMERIC,
    'balance', (v_calc->>'balance_after')::NUMERIC
  );
END;
$$;
ALTER FUNCTION public.apply_inkaclick_payment_snapshot(UUID) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.emit_wacrm_payment_snapshot(UUID,UUID,TIMESTAMPTZ),
  public.apply_inkaclick_payment_snapshot(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.emit_wacrm_payment_snapshot(UUID,UUID,TIMESTAMPTZ),
  public.apply_inkaclick_payment_snapshot(UUID)
  TO service_role;
