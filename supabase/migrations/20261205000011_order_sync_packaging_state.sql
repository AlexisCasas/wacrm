-- SYNC-07 · Packaging state parity without falsifying PR-04 local completion.
--
-- Remote completion is mirrored in a separate table. It never manufactures local evidence,
-- a local template dispatch, packaging_completed_by, or ready_for_dispatch.
-- Local WACRM completion emits packing.completed. Imported InkaClick completion is terminal
-- and blocks new local packaging/template sends to avoid ordinary duplicate communication.

CREATE TABLE IF NOT EXISTS public.order_packaging_sync_state (
  order_id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  source_system TEXT NOT NULL DEFAULT 'inkaclick',
  status TEXT NOT NULL DEFAULT 'completed',
  customer_message_sent BOOLEAN NOT NULL DEFAULT FALSE,
  source_event_id UUID NOT NULL UNIQUE,
  completed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT order_packaging_sync_state_order_fk
    FOREIGN KEY (order_id,account_id)
    REFERENCES public.order_confirmations(id,account_id)
    ON DELETE CASCADE,
  CONSTRAINT order_packaging_sync_state_source_check CHECK (source_system='inkaclick'),
  CONSTRAINT order_packaging_sync_state_status_check CHECK (status='completed')
);

ALTER TABLE public.order_packaging_sync_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.order_packaging_sync_state FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.order_packaging_sync_state TO authenticated;
GRANT ALL ON public.order_packaging_sync_state TO service_role;

DROP POLICY IF EXISTS order_packaging_sync_state_select ON public.order_packaging_sync_state;
CREATE POLICY order_packaging_sync_state_select
  ON public.order_packaging_sync_state
  FOR SELECT
  USING (public.order_logistics_access(account_id));

CREATE OR REPLACE FUNCTION public.emit_wacrm_packaging_completed_after_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public
AS $$
DECLARE
  v_key TEXT;
  v_origin UUID;
BEGIN
  IF NEW.status='ready_for_dispatch'
     AND OLD.status IS DISTINCT FROM 'ready_for_dispatch' THEN
    v_key := 'packing.completed:' || NEW.order_id::text || ':v' || NEW.version::text;
    v_origin := md5('wacrm|' || v_key)::uuid;

    PERFORM public.record_order_sync_event(
      NEW.order_id,
      'wacrm',
      v_origin,
      'packing.completed',
      1,
      v_key,
      COALESCE(NEW.packaging_completed_at,clock_timestamp()),
      jsonb_build_object('customer_message_sent',TRUE)
    );
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.emit_wacrm_packaging_completed_after_change() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.emit_wacrm_packaging_completed_after_change()
  FROM PUBLIC,anon,authenticated,service_role;

DROP TRIGGER IF EXISTS emit_wacrm_packaging_completed_after_change ON public.order_logistics;
CREATE TRIGGER emit_wacrm_packaging_completed_after_change
  AFTER UPDATE OF status ON public.order_logistics
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.emit_wacrm_packaging_completed_after_change();

CREATE OR REPLACE FUNCTION public.apply_inkaclick_packaging_completed(
  p_origin_event UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public
AS $$
DECLARE
  e public.order_sync_events%ROWTYPE;
  v_account UUID;
  v_message_sent BOOLEAN;
  v_inserted INTEGER;
BEGIN
  SELECT x.* INTO e
  FROM public.order_sync_events x
  WHERE x.origin_system='inkaclick'
    AND x.origin_event_id=p_origin_event
    AND x.event_type='packing.completed';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'sync_packaging_event_not_found' USING ERRCODE='P0002';
  END IF;

  IF jsonb_typeof(e.payload) <> 'object'
     OR jsonb_typeof(e.payload->'customer_message_sent') IS DISTINCT FROM 'boolean'
     OR (e.payload - 'customer_message_sent') <> '{}'::jsonb THEN
    RETURN jsonb_build_object('ok',FALSE,'status','conflict','reason','invalid_packaging_payload');
  END IF;
  v_message_sent := (e.payload->>'customer_message_sent')::BOOLEAN;

  SELECT o.account_id INTO v_account
  FROM public.order_confirmations o
  WHERE o.id=e.canonical_order_id;
  IF v_account IS NULL THEN
    RETURN jsonb_build_object('ok',FALSE,'status','conflict','reason','order_not_found');
  END IF;

  IF NOT COALESCE(
    (SELECT s.logistics_mvp_enabled
     FROM public.order_integration_settings s
     WHERE s.account_id=v_account),
    FALSE
  ) THEN
    RETURN jsonb_build_object('ok',FALSE,'status','conflict','reason','feature_disabled');
  END IF;

  PERFORM public.ensure_order_sync_receipt('inkaclick',p_origin_event,'wacrm');
  PERFORM public.order_logistics_lock(e.canonical_order_id);

  INSERT INTO public.order_packaging_sync_state(
    order_id,account_id,source_system,status,customer_message_sent,
    source_event_id,completed_at
  ) VALUES (
    e.canonical_order_id,v_account,'inkaclick','completed',v_message_sent,
    p_origin_event,e.occurred_at
  )
  ON CONFLICT (order_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted=ROW_COUNT;

  IF v_inserted=1 THEN
    INSERT INTO public.order_logistics_events(
      account_id,order_id,event_type,outcome,actor_user_id,actor_name,detail
    ) VALUES (
      v_account,e.canonical_order_id,'packaging_completed','ok',
      NULL,'InkaClick sync',
      jsonb_build_object(
        'source','inkaclick_sync',
        'origin_event_id',p_origin_event,
        'customer_message_sent',v_message_sent
      )
    );
  END IF;

  UPDATE public.order_sync_receipts
  SET status='applied',last_error_code=NULL,updated_at=clock_timestamp(),applied_at=clock_timestamp()
  WHERE event_id=e.id AND consumer_system='wacrm';

  RETURN jsonb_build_object(
    'ok',TRUE,
    'status','applied',
    'changed',v_inserted=1,
    'customer_message_sent',
      (SELECT x.customer_message_sent
       FROM public.order_packaging_sync_state x
       WHERE x.order_id=e.canonical_order_id)
  );
END;
$$;
ALTER FUNCTION public.apply_inkaclick_packaging_completed(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.apply_inkaclick_packaging_completed(UUID)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.apply_inkaclick_packaging_completed(UUID)
  TO service_role;

-- Start/dispatch safety at the database wall. The UI/server precheck gives a friendly 409,
-- while these triggers close the race if remote completion arrives just before a write.
CREATE OR REPLACE FUNCTION public.order_sync_block_local_packaging_after_remote()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path=public
AS $$
DECLARE
  v_order UUID;
BEGIN
  v_order := NEW.order_id;
  IF EXISTS(
    SELECT 1 FROM public.order_packaging_sync_state x
    WHERE x.order_id=v_order AND x.status='completed'
  ) THEN
    RAISE EXCEPTION 'packaging_completed_elsewhere' USING ERRCODE='22023';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.order_sync_block_local_packaging_after_remote() OWNER TO postgres;

DROP TRIGGER IF EXISTS order_sync_block_packing_start ON public.order_logistics;
CREATE TRIGGER order_sync_block_packing_start
  BEFORE UPDATE OF status ON public.order_logistics
  FOR EACH ROW
  WHEN (NEW.status='packing' AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.order_sync_block_local_packaging_after_remote();

DROP TRIGGER IF EXISTS order_sync_block_template_dispatch_insert ON public.order_template_dispatches;
CREATE TRIGGER order_sync_block_template_dispatch_insert
  BEFORE INSERT ON public.order_template_dispatches
  FOR EACH ROW
  WHEN (NEW.status IN ('claimed','sending'))
  EXECUTE FUNCTION public.order_sync_block_local_packaging_after_remote();

DROP TRIGGER IF EXISTS order_sync_block_template_dispatch_update ON public.order_template_dispatches;
CREATE TRIGGER order_sync_block_template_dispatch_update
  BEFORE UPDATE OF status ON public.order_template_dispatches
  FOR EACH ROW
  WHEN (NEW.status IN ('claimed','sending'))
  EXECUTE FUNCTION public.order_sync_block_local_packaging_after_remote();
