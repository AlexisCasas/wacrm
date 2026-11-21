-- SYNC-08 · Remote Shalom guide/tracking mirror for WACRM.
-- Local order_shipments remains owned by PR-05 and its poller. InkaClick facts are stored separately.

CREATE TABLE IF NOT EXISTS public.order_shipment_sync_state (
  order_id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  source_system TEXT NOT NULL DEFAULT 'inkaclick' CHECK (source_system='inkaclick'),
  tracking_number TEXT NOT NULL CHECK (tracking_number ~ '^[0-9]{6,12}$'),
  tracking_code TEXT NOT NULL CHECK (tracking_code ~ '^[A-Z0-9]{3,6}$'),
  logistic_status TEXT CHECK (logistic_status IS NULL OR logistic_status IN ('at_origin','in_transit','at_destination','delivered')),
  source_event_id UUID NOT NULL,
  source_updated_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT order_shipment_sync_state_order_fk FOREIGN KEY(order_id,account_id)
    REFERENCES public.order_confirmations(id,account_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS order_shipment_sync_state_source_event_uidx
  ON public.order_shipment_sync_state(source_event_id);

ALTER TABLE public.order_shipment_sync_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.order_shipment_sync_state FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.order_shipment_sync_state TO authenticated;
GRANT ALL ON public.order_shipment_sync_state TO service_role;
DROP POLICY IF EXISTS order_shipment_sync_state_select ON public.order_shipment_sync_state;
CREATE POLICY order_shipment_sync_state_select ON public.order_shipment_sync_state
  FOR SELECT USING(public.order_shipments_access(account_id));

CREATE OR REPLACE FUNCTION public.order_sync_shipment_rank(p_status TEXT)
RETURNS INTEGER LANGUAGE sql IMMUTABLE SET search_path=public AS $$
 SELECT CASE p_status WHEN 'at_origin' THEN 1 WHEN 'in_transit' THEN 2
  WHEN 'at_destination' THEN 3 WHEN 'delivered' THEN 4 ELSE 0 END
$$;
ALTER FUNCTION public.order_sync_shipment_rank(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.order_sync_shipment_rank(TEXT) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.emit_wacrm_shipment_snapshot_after_change()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_key TEXT; v_origin UUID; v_when TIMESTAMPTZ;
BEGIN
  IF TG_OP='UPDATE'
    AND NEW.tracking_number IS NOT DISTINCT FROM OLD.tracking_number
    AND NEW.tracking_code IS NOT DISTINCT FROM OLD.tracking_code
    AND NEW.identifier_version IS NOT DISTINCT FROM OLD.identifier_version
    AND NEW.logistic_status IS NOT DISTINCT FROM OLD.logistic_status THEN
    RETURN NEW;
  END IF;
  v_when:=COALESCE(NEW.status_changed_at,NEW.updated_at,NEW.created_at,clock_timestamp());
  v_key:='shipment.snapshot:'||NEW.order_id::text||':v'||NEW.identifier_version::text||':'||
    NEW.tracking_number||':'||NEW.tracking_code||':'||COALESCE(NEW.logistic_status,'pending');
  v_origin:=md5('wacrm|'||v_key)::uuid;
  PERFORM public.record_order_sync_event(
    NEW.order_id,'wacrm',v_origin,'shipment.snapshot',1,v_key,v_when,
    jsonb_build_object('tracking_number',NEW.tracking_number,'tracking_code',NEW.tracking_code,'status',NEW.logistic_status)
  );
  RETURN NEW;
END $$;
ALTER FUNCTION public.emit_wacrm_shipment_snapshot_after_change() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.emit_wacrm_shipment_snapshot_after_change() FROM PUBLIC,anon,authenticated,service_role;

DROP TRIGGER IF EXISTS emit_wacrm_shipment_snapshot_after_insert ON public.order_shipments;
CREATE TRIGGER emit_wacrm_shipment_snapshot_after_insert AFTER INSERT ON public.order_shipments
 FOR EACH ROW EXECUTE FUNCTION public.emit_wacrm_shipment_snapshot_after_change();
DROP TRIGGER IF EXISTS emit_wacrm_shipment_snapshot_after_update ON public.order_shipments;
CREATE TRIGGER emit_wacrm_shipment_snapshot_after_update
 AFTER UPDATE OF tracking_number,tracking_code,identifier_version,logistic_status ON public.order_shipments
 FOR EACH ROW EXECUTE FUNCTION public.emit_wacrm_shipment_snapshot_after_change();

CREATE OR REPLACE FUNCTION public.apply_inkaclick_shipment_snapshot(p_origin_event UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
 e public.order_sync_events%ROWTYPE; v_account UUID; v_number TEXT; v_code TEXT; v_status TEXT;
 x public.order_shipment_sync_state%ROWTYPE; same_guide BOOLEAN; incoming_rank INTEGER; existing_rank INTEGER;
 changed BOOLEAN:=FALSE;
BEGIN
 SELECT q.* INTO e FROM public.order_sync_events q
 WHERE q.origin_system='inkaclick' AND q.origin_event_id=p_origin_event AND q.event_type='shipment.snapshot';
 IF NOT FOUND THEN RAISE EXCEPTION 'sync_shipment_event_not_found' USING ERRCODE='P0002'; END IF;

 IF jsonb_typeof(e.payload)<>'object' OR (e.payload-ARRAY['tracking_number','tracking_code','status']::TEXT[])<>'{}'::jsonb THEN
  RETURN jsonb_build_object('ok',FALSE,'status','conflict','reason','invalid_shipment_payload');
 END IF;
 v_number:=NULLIF(btrim(COALESCE(e.payload->>'tracking_number','')),'');
 v_code:=upper(NULLIF(btrim(COALESCE(e.payload->>'tracking_code','')),''));
 v_status:=NULLIF(btrim(COALESCE(e.payload->>'status','')),'');
 IF v_number IS NULL OR v_number!~'^[0-9]{6,12}$' OR v_code IS NULL OR v_code!~'^[A-Z0-9]{3,6}$'
   OR (v_status IS NOT NULL AND v_status NOT IN('at_origin','in_transit','at_destination','delivered')) THEN
  RETURN jsonb_build_object('ok',FALSE,'status','conflict','reason','invalid_shipment_payload');
 END IF;

 SELECT o.account_id INTO v_account FROM public.order_confirmations o WHERE o.id=e.canonical_order_id;
 IF v_account IS NULL THEN RETURN jsonb_build_object('ok',FALSE,'status','conflict','reason','order_not_found'); END IF;
 IF NOT COALESCE((SELECT s.logistics_mvp_enabled FROM public.order_integration_settings s WHERE s.account_id=v_account),FALSE)
 OR NOT COALESCE((SELECT s.shalom_tracking_enabled FROM public.order_shipment_settings s WHERE s.account_id=v_account),FALSE) THEN
  RETURN jsonb_build_object('ok',FALSE,'status','conflict','reason','feature_disabled');
 END IF;

 PERFORM public.ensure_order_sync_receipt('inkaclick',p_origin_event,'wacrm');
 PERFORM public.order_shipments_lock(e.canonical_order_id);
 SELECT q.* INTO x FROM public.order_shipment_sync_state q WHERE q.order_id=e.canonical_order_id FOR UPDATE;

 IF NOT FOUND THEN
  INSERT INTO public.order_shipment_sync_state(order_id,account_id,tracking_number,tracking_code,logistic_status,source_event_id,source_updated_at)
  VALUES(e.canonical_order_id,v_account,v_number,v_code,v_status,p_origin_event,e.occurred_at);
  changed:=TRUE;
 ELSE
  same_guide:=x.tracking_number=v_number AND x.tracking_code=v_code;
  IF same_guide THEN
   incoming_rank:=public.order_sync_shipment_rank(v_status);
   existing_rank:=public.order_sync_shipment_rank(x.logistic_status);
   IF incoming_rank>existing_rank OR (incoming_rank=existing_rank AND e.occurred_at>x.source_updated_at) THEN
    UPDATE public.order_shipment_sync_state SET
      logistic_status=CASE WHEN incoming_rank>existing_rank THEN v_status ELSE logistic_status END,
      source_event_id=p_origin_event,source_updated_at=GREATEST(source_updated_at,e.occurred_at),updated_at=clock_timestamp()
    WHERE order_id=e.canonical_order_id;
    changed:=TRUE;
   END IF;
  ELSIF e.occurred_at>x.source_updated_at THEN
   UPDATE public.order_shipment_sync_state SET tracking_number=v_number,tracking_code=v_code,logistic_status=v_status,
     source_event_id=p_origin_event,source_updated_at=e.occurred_at,updated_at=clock_timestamp()
   WHERE order_id=e.canonical_order_id;
   changed:=TRUE;
  END IF;
 END IF;

 UPDATE public.order_sync_receipts SET status='applied',last_error_code=NULL,updated_at=clock_timestamp(),applied_at=clock_timestamp()
 WHERE event_id=e.id AND consumer_system='wacrm';

 RETURN jsonb_build_object('ok',TRUE,'status','applied','changed',changed,
  'tracking_number',(SELECT tracking_number FROM public.order_shipment_sync_state WHERE order_id=e.canonical_order_id),
  'tracking_code',(SELECT tracking_code FROM public.order_shipment_sync_state WHERE order_id=e.canonical_order_id),
  'logistic_status',(SELECT logistic_status FROM public.order_shipment_sync_state WHERE order_id=e.canonical_order_id));
END $$;
ALTER FUNCTION public.apply_inkaclick_shipment_snapshot(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.apply_inkaclick_shipment_snapshot(UUID) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.apply_inkaclick_shipment_snapshot(UUID) TO service_role;
