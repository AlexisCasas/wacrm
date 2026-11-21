-- SYNC-06 · Voucher parity foundation for WACRM.
-- Allows a validated voucher imported from InkaClick to exist without inventing a human actor,
-- emits PII-free voucher.validated events for locally validated vouchers, and keeps imported
-- documents from bouncing back. File bytes are transported by authenticated server routes.

ALTER TABLE public.order_documents
  ALTER COLUMN uploaded_by DROP NOT NULL;

ALTER TABLE public.order_documents
  DROP CONSTRAINT IF EXISTS order_documents_source_check,
  ADD CONSTRAINT order_documents_source_check
    CHECK (source IN ('upload', 'chat_message', 'sync'));

ALTER TABLE public.order_documents
  DROP CONSTRAINT IF EXISTS order_documents_voucher_shape,
  ADD CONSTRAINT order_documents_voucher_shape CHECK (
    kind <> 'voucher'
    OR (
      source IN ('upload', 'sync')
      AND status IN ('pending_review', 'validated', 'rejected', 'superseded')
    )
  );

ALTER TABLE public.order_documents
  DROP CONSTRAINT IF EXISTS order_documents_validated_shape,
  ADD CONSTRAINT order_documents_validated_shape CHECK (
    status <> 'validated'
    OR (
      order_id IS NOT NULL
      AND validated_at IS NOT NULL
      AND version IS NOT NULL
      AND reviewed_data IS NOT NULL
      AND (source = 'sync' OR validated_by IS NOT NULL)
    )
  );

ALTER TABLE public.order_documents
  DROP CONSTRAINT IF EXISTS order_documents_sync_actor_shape,
  ADD CONSTRAINT order_documents_sync_actor_shape CHECK (
    (
      source = 'sync'
      AND kind = 'voucher'
      AND association = 'direct'
      AND uploaded_by IS NULL
      AND validated_by IS NULL
    )
    OR (
      source <> 'sync'
      AND uploaded_by IS NOT NULL
    )
  );

CREATE OR REPLACE FUNCTION public.emit_wacrm_voucher_snapshot_after_validate()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_number TEXT;
  v_code TEXT;
  v_amount NUMERIC(12,2);
  v_key TEXT;
  v_origin UUID;
BEGIN
  IF NEW.kind <> 'voucher'
     OR NEW.status <> 'validated'
     OR OLD.status = 'validated'
     OR NEW.source = 'sync'
     OR NEW.order_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_number := NULLIF(btrim(COALESCE(NEW.reviewed_data->>'shalom_number','')), '');
  v_code := NULLIF(btrim(COALESCE(NEW.reviewed_data->>'shalom_code','')), '');
  IF COALESCE(NEW.reviewed_data->>'amount','') ~ '^[0-9]{1,7}(\.[0-9]{1,2})?$' THEN
    v_amount := (NEW.reviewed_data->>'amount')::NUMERIC(12,2);
  END IF;

  v_key := 'voucher.validated:' || NEW.id::text || ':v' || COALESCE(NEW.version,1)::text;
  v_origin := md5('wacrm|' || v_key)::uuid;

  PERFORM public.record_order_sync_event(
    NEW.order_id,
    'wacrm',
    v_origin,
    'voucher.validated',
    1,
    v_key,
    COALESCE(NEW.validated_at, clock_timestamp()),
    jsonb_strip_nulls(jsonb_build_object(
      'source_document_id', NEW.id,
      'shalom_number', v_number,
      'shalom_code', v_code,
      'freight_amount', v_amount,
      'mime_type', NEW.mime_type,
      'size_bytes', NEW.size_bytes,
      'content_hash', NEW.content_hash
    ))
  );

  RETURN NEW;
END;
$$;
ALTER FUNCTION public.emit_wacrm_voucher_snapshot_after_validate() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.emit_wacrm_voucher_snapshot_after_validate()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS emit_wacrm_voucher_snapshot_after_validate ON public.order_documents;
CREATE TRIGGER emit_wacrm_voucher_snapshot_after_validate
  AFTER UPDATE OF status ON public.order_documents
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.emit_wacrm_voucher_snapshot_after_validate();

CREATE OR REPLACE FUNCTION public.register_synced_order_voucher(
  p_origin_event UUID,
  p_origin_document UUID,
  p_order UUID,
  p_doc UUID,
  p_storage_path TEXT,
  p_filename TEXT,
  p_mime TEXT,
  p_size BIGINT,
  p_hash TEXT,
  p_shalom_number TEXT DEFAULT NULL,
  p_shalom_code TEXT DEFAULT NULL,
  p_freight_amount NUMERIC DEFAULT NULL,
  p_now TIMESTAMPTZ DEFAULT clock_timestamp()
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  e public.order_sync_events%ROWTYPE;
  v_account UUID;
  v_request_key TEXT;
  d public.order_documents%ROWTYPE;
  old_doc public.order_documents%ROWTYPE;
  l public.order_logistics%ROWTYPE;
  v_version INTEGER;
  v_reviewed JSONB;
BEGIN
  SELECT x.* INTO e
  FROM public.order_sync_events x
  WHERE x.origin_system='inkaclick'
    AND x.origin_event_id=p_origin_event
    AND x.event_type='voucher.validated'
    AND x.canonical_order_id=p_order;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'sync_voucher_event_not_found' USING ERRCODE='P0002';
  END IF;

  IF p_origin_document IS NULL OR p_doc IS NULL OR p_now IS NULL THEN
    RAISE EXCEPTION 'invalid_sync_voucher_identity' USING ERRCODE='22023';
  END IF;

  SELECT o.account_id INTO v_account
  FROM public.order_confirmations o
  WHERE o.id=p_order;
  IF v_account IS NULL THEN
    RETURN jsonb_build_object('ok',FALSE,'reason','order_not_found');
  END IF;

  IF NOT COALESCE(
    (SELECT s.logistics_mvp_enabled FROM public.order_integration_settings s WHERE s.account_id=v_account),
    FALSE
  ) THEN
    RETURN jsonb_build_object('ok',FALSE,'reason','feature_disabled');
  END IF;

  PERFORM public.ensure_order_sync_receipt('inkaclick',p_origin_event,'wacrm');
  v_request_key := 'sync:inkaclick:voucher:' || p_origin_document::text;

  SELECT x.* INTO d
  FROM public.order_documents x
  WHERE x.account_id=v_account AND x.request_key=v_request_key
  FOR UPDATE;

  IF FOUND THEN
    IF d.order_id IS DISTINCT FROM p_order OR d.content_hash IS DISTINCT FROM p_hash THEN
      RETURN jsonb_build_object('ok',FALSE,'reason','sync_identity_conflict');
    END IF;
    UPDATE public.order_sync_receipts
      SET status='applied',last_error_code=NULL,updated_at=clock_timestamp(),applied_at=clock_timestamp()
    WHERE event_id=e.id AND consumer_system='wacrm';
    RETURN jsonb_build_object('ok',TRUE,'changed',FALSE,'document_id',d.id,'status',d.status);
  END IF;

  PERFORM public.order_logistics_lock(p_order);
  SELECT x.* INTO l FROM public.order_logistics x WHERE x.order_id=p_order FOR UPDATE;
  IF FOUND AND l.status IN ('packing','ready_for_dispatch') THEN
    UPDATE public.order_sync_receipts
      SET status='conflict',last_error_code='order_locked',updated_at=clock_timestamp(),applied_at=NULL
    WHERE event_id=e.id AND consumer_system='wacrm';
    RETURN jsonb_build_object('ok',FALSE,'reason','order_locked');
  END IF;

  SELECT x.* INTO old_doc
  FROM public.order_documents x
  WHERE x.order_id=p_order AND x.kind='voucher' AND x.status='validated'
  FOR UPDATE;

  IF FOUND THEN
    UPDATE public.order_documents SET status='superseded' WHERE id=old_doc.id;
    INSERT INTO public.order_logistics_events(
      account_id,order_id,document_id,event_type,outcome,actor_user_id,actor_name,detail
    ) VALUES (
      v_account,p_order,old_doc.id,'voucher_superseded','ok',NULL,'InkaClick sync',
      jsonb_build_object('replaced_by',p_doc,'source','inkaclick_sync')
    );
  END IF;

  SELECT COALESCE(MAX(x.version),0)+1 INTO v_version
  FROM public.order_documents x
  WHERE x.order_id=p_order AND x.kind='voucher';

  v_reviewed := jsonb_strip_nulls(jsonb_build_object(
    'shalom_number',NULLIF(btrim(COALESCE(p_shalom_number,'')),''),
    'shalom_code',NULLIF(btrim(COALESCE(p_shalom_code,'')),''),
    'amount',p_freight_amount
  ));

  INSERT INTO public.order_documents(
    id,account_id,order_id,kind,status,association,version,request_key,
    storage_bucket,storage_path,original_filename,mime_type,size_bytes,content_hash,
    source,ocr_status,reviewed_data,reviewed_at,validated_at,uploaded_by,validated_by
  ) VALUES (
    p_doc,v_account,p_order,'voucher','validated','direct',v_version,v_request_key,
    'order-docs',p_storage_path,p_filename,p_mime,p_size,p_hash,
    'sync','none',v_reviewed,p_now,p_now,NULL,NULL
  );

  IF l.order_id IS NULL THEN
    INSERT INTO public.order_logistics(order_id,account_id,status,voucher_document_id,validated_at,validated_by)
    VALUES(p_order,v_account,'voucher_validated',p_doc,p_now,NULL);
  ELSE
    UPDATE public.order_logistics
      SET status='voucher_validated',voucher_document_id=p_doc,validated_at=p_now,validated_by=NULL,version=version+1
    WHERE order_id=p_order;
  END IF;

  INSERT INTO public.order_logistics_events(
    account_id,order_id,document_id,event_type,outcome,actor_user_id,actor_name,detail
  ) VALUES (
    v_account,p_order,p_doc,'voucher_validated','ok',NULL,'InkaClick sync',
    jsonb_build_object('version',v_version,'association','direct','source','inkaclick_sync','origin_event_id',p_origin_event)
  );

  UPDATE public.order_sync_receipts
    SET status='applied',last_error_code=NULL,updated_at=clock_timestamp(),applied_at=clock_timestamp()
  WHERE event_id=e.id AND consumer_system='wacrm';

  RETURN jsonb_build_object('ok',TRUE,'changed',TRUE,'document_id',p_doc,'status','validated','version',v_version);
END;
$$;
ALTER FUNCTION public.register_synced_order_voucher(
  UUID,UUID,UUID,UUID,TEXT,TEXT,TEXT,BIGINT,TEXT,TEXT,TEXT,NUMERIC,TIMESTAMPTZ
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.register_synced_order_voucher(
  UUID,UUID,UUID,UUID,TEXT,TEXT,TEXT,BIGINT,TEXT,TEXT,TEXT,NUMERIC,TIMESTAMPTZ
) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.register_synced_order_voucher(
  UUID,UUID,UUID,UUID,TEXT,TEXT,TEXT,BIGINT,TEXT,TEXT,TEXT,NUMERIC,TIMESTAMPTZ
) TO service_role;
