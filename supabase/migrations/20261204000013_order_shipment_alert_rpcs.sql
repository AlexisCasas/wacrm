-- ============================================================
-- 20261130000004_order_shipment_alert_rpcs
--
-- PR-05 · the internal 15-day "En destino" alert. ADDITIVE; service_role only.
--
-- RULE (closed business decision): 15 CALENDAR days in America/Lima. Day 0 = the day the order entered En destino (Shalom's own date when it gave one,
-- otherwise WACRM's first observation); days 1..14 keep tracking normally; on day 15 ONE alert is generated if it is still En destino. Per EPISODE of
-- En destino (entry -> exit): UNIQUE (order, destination_episode, kind), so cron ticks / workers / polls can never duplicate it.
-- The alert never changes the order status, never stops tracking, never marks Entregado and never creates a conversation. It is evaluated on every cron
-- tick whether or not Shalom answered (the clock does not depend on Shalom being up).
--
-- Recipients: Logística and Supervisor of the SAME account (flag ON, agent+). Commercial / viewers / no area: nobody. The notification is only the channel
-- (read_at); "atendida" is order_shipment_alerts.status.
-- ============================================================

CREATE OR REPLACE FUNCTION public.order_shipments_notify_alert(p_account UUID, p_order UUID, p_days INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_name TEXT; v_rows INTEGER;
BEGIN
  SELECT o.customer_name INTO v_name FROM public.order_confirmations o WHERE o.id = p_order AND o.account_id = p_account;
  INSERT INTO public.notifications (account_id, user_id, type, order_id, actor_user_id, title, body)
  SELECT p_account, p.user_id, 'shipment_destination_alert', p_order, NULL,
         'Pedido en destino hace ' || p_days || ' días',
         'El pedido de ' || COALESCE(NULLIF(btrim(v_name), ''), 'un cliente') || ' sigue En destino. Revisa el seguimiento Shalom.'
    FROM public.profiles p
   WHERE p.account_id = p_account
     AND p.operational_role IN ('logistics', 'supervisor')
     AND p.account_role IN ('owner', 'admin', 'agent');
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$$;
ALTER FUNCTION public.order_shipments_notify_alert(UUID, UUID, INTEGER) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.order_shipments_notify_alert(UUID, UUID, INTEGER) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.evaluate_destination_alerts(p_now TIMESTAMPTZ DEFAULT now(), p_days INTEGER DEFAULT 15)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r RECORD;
  v_id UUID;
  v_created INTEGER := 0;
  v_notified INTEGER := 0;
  v_ids UUID[] := ARRAY[]::UUID[];
  v_due DATE;
BEGIN
  IF p_days IS NULL OR p_days < 1 THEN RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023'; END IF;
  FOR r IN
    SELECT s.id, s.account_id, s.order_id, s.destination_episode, s.destination_entered_at, s.identifier_version
      FROM public.order_shipments s
      JOIN public.order_shipment_settings st ON st.account_id = s.account_id AND st.shalom_tracking_enabled
      JOIN public.order_integration_settings ois ON ois.account_id = s.account_id AND ois.logistics_mvp_enabled
     WHERE s.tracking_state IN ('active', 'requires_attention')
       AND s.logistic_status = 'at_destination' AND s.destination_entered_at IS NOT NULL
       AND (p_now AT TIME ZONE 'America/Lima')::date >= (s.destination_entered_at AT TIME ZONE 'America/Lima')::date + p_days
  LOOP
    v_due := (r.destination_entered_at AT TIME ZONE 'America/Lima')::date + p_days;
    v_id := NULL;
    INSERT INTO public.order_shipment_alerts (account_id, order_id, destination_episode, due_date, created_at)
    VALUES (r.account_id, r.order_id, r.destination_episode, v_due, p_now)
    ON CONFLICT (order_id, destination_episode, kind) DO NOTHING
    RETURNING id INTO v_id;
    IF v_id IS NOT NULL THEN
      v_created := v_created + 1;
      v_ids := v_ids || v_id;
      PERFORM public.order_shipments_log(r.account_id, r.order_id, 'alert_created', NULL, 'at_destination', r.identifier_version, NULL, 'system',
        jsonb_build_object('alert_id', v_id, 'episode', r.destination_episode, 'kind', 'destination_15d', 'due_date', v_due));
      v_notified := v_notified + public.order_shipments_notify_alert(r.account_id, r.order_id, p_days);
    END IF;
  END LOOP;
  RETURN jsonb_build_object('created', v_created, 'notified', v_notified, 'alert_ids', to_jsonb(v_ids));
END;
$$;
ALTER FUNCTION public.evaluate_destination_alerts(TIMESTAMPTZ, INTEGER) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.evaluate_destination_alerts(TIMESTAMPTZ, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.evaluate_destination_alerts(TIMESTAMPTZ, INTEGER) TO service_role;

-- Logística / Supervisor mark the alert as ATTENDED (distinct from the notification being read). Idempotent; audited; history kept.
CREATE OR REPLACE FUNCTION public.acknowledge_shipment_alert(p_account UUID, p_actor UUID, p_alert UUID, p_now TIMESTAMPTZ DEFAULT now())
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name TEXT := public.order_shipments_actor(p_account, p_actor, FALSE);
  a public.order_shipment_alerts%ROWTYPE;
BEGIN
  SELECT * INTO a FROM public.order_shipment_alerts x WHERE x.id = p_alert AND x.account_id = p_account;
  IF NOT FOUND THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  PERFORM public.order_shipments_lock(a.order_id);
  SELECT * INTO a FROM public.order_shipment_alerts x WHERE x.id = p_alert FOR UPDATE;
  IF a.status = 'resolved' THEN RETURN jsonb_build_object('ok', FALSE, 'reason', 'resolved'); END IF;
  IF a.status = 'acknowledged' THEN RETURN jsonb_build_object('ok', TRUE, 'changed', FALSE); END IF;
  UPDATE public.order_shipment_alerts SET status = 'acknowledged', acknowledged_by = p_actor, acknowledged_at = p_now WHERE id = a.id;
  PERFORM public.order_shipments_log(p_account, a.order_id, 'alert_acknowledged', NULL, NULL,
    (SELECT s.identifier_version FROM public.order_shipments s WHERE s.order_id = a.order_id), p_actor, v_name,
    jsonb_build_object('alert_id', a.id, 'episode', a.destination_episode));
  RETURN jsonb_build_object('ok', TRUE, 'changed', TRUE);
END;
$$;
ALTER FUNCTION public.acknowledge_shipment_alert(UUID, UUID, UUID, TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.acknowledge_shipment_alert(UUID, UUID, UUID, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.acknowledge_shipment_alert(UUID, UUID, UUID, TIMESTAMPTZ) TO service_role;
