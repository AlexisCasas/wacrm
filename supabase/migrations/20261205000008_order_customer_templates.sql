-- Manual customer communications from a VALIDATED order voucher.
-- Additive/inert until template names are configured per account.
-- These sends are independent from packaging and MUST NOT move order_logistics.status.

ALTER TABLE public.order_logistics_settings
  ADD COLUMN IF NOT EXISTS summary_template_name TEXT,
  ADD COLUMN IF NOT EXISTS summary_template_language TEXT,
  ADD COLUMN IF NOT EXISTS voucher_customer_template_name TEXT,
  ADD COLUMN IF NOT EXISTS voucher_customer_template_language TEXT;

ALTER TABLE public.order_logistics_settings DROP CONSTRAINT IF EXISTS order_logistics_settings_summary_template_pair;
ALTER TABLE public.order_logistics_settings ADD CONSTRAINT order_logistics_settings_summary_template_pair
  CHECK ((summary_template_name IS NULL) = (summary_template_language IS NULL));

ALTER TABLE public.order_logistics_settings DROP CONSTRAINT IF EXISTS order_logistics_settings_voucher_customer_template_pair;
ALTER TABLE public.order_logistics_settings ADD CONSTRAINT order_logistics_settings_voucher_customer_template_pair
  CHECK ((voucher_customer_template_name IS NULL) = (voucher_customer_template_language IS NULL));

CREATE TABLE IF NOT EXISTS public.order_customer_template_dispatches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  order_id UUID NOT NULL,
  voucher_document_id UUID NOT NULL REFERENCES public.order_documents(id),
  kind TEXT NOT NULL CHECK (kind IN ('summary','voucher')),
  status TEXT NOT NULL DEFAULT 'claimed' CHECK (status IN ('claimed','sending','sent','failed','uncertain')),
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  conversation_id UUID NOT NULL REFERENCES public.conversations(id),
  template_name TEXT NOT NULL,
  template_language TEXT NOT NULL,
  actor_user_id UUID NOT NULL,
  message_row_id UUID REFERENCES public.messages(id) ON DELETE SET NULL,
  wamid TEXT,
  error_code TEXT,
  resolution TEXT CHECK (resolution IS NULL OR resolution IN ('confirmed_sent','confirmed_not_sent')),
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sending_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  resolved_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT order_customer_template_dispatches_order_fk
    FOREIGN KEY (order_id, account_id) REFERENCES public.order_confirmations(id, account_id) ON DELETE CASCADE,
  CONSTRAINT order_customer_template_dispatches_unique
    UNIQUE (account_id, order_id, voucher_document_id, kind),
  CONSTRAINT order_customer_template_dispatches_error_form
    CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,40}$')
);

CREATE INDEX IF NOT EXISTS order_customer_template_dispatches_order_idx
  ON public.order_customer_template_dispatches(account_id, order_id, created_at DESC);

ALTER TABLE public.order_customer_template_dispatches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.order_customer_template_dispatches FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.order_customer_template_dispatches TO authenticated;
GRANT ALL ON public.order_customer_template_dispatches TO service_role;

DROP POLICY IF EXISTS order_customer_template_dispatches_select ON public.order_customer_template_dispatches;
CREATE POLICY order_customer_template_dispatches_select
  ON public.order_customer_template_dispatches FOR SELECT
  USING (
    public.order_logistics_access(account_id)
    AND EXISTS (
      SELECT 1 FROM public.order_confirmations o
      WHERE o.id = order_id AND o.account_id = account_id
    )
  );

CREATE OR REPLACE FUNCTION public.begin_order_customer_template(
  p_account UUID, p_actor UUID, p_order UUID, p_kind TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_name TEXT := public.order_logistics_actor(p_account, p_actor);
  v_log public.order_logistics%ROWTYPE;
  v_doc public.order_documents%ROWTYPE;
  v_conv UUID;
  v_name TEXT;
  v_lang TEXT;
  v_row public.order_customer_template_dispatches%ROWTYPE;
BEGIN
  IF p_kind NOT IN ('summary','voucher') THEN
    RAISE EXCEPTION 'invalid_kind' USING ERRCODE='22023';
  END IF;

  PERFORM public.order_logistics_require_order(p_account, p_order);
  SELECT * INTO v_log FROM public.order_logistics l
    WHERE l.account_id=p_account AND l.order_id=p_order;
  IF NOT FOUND OR v_log.voucher_document_id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','voucher_required');
  END IF;

  SELECT * INTO v_doc FROM public.order_documents d
    WHERE d.id=v_log.voucher_document_id AND d.account_id=p_account
      AND d.order_id=p_order AND d.kind='voucher' AND d.status='validated';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','voucher_required');
  END IF;

  SELECT conversation_id INTO v_conv FROM public.order_confirmations
    WHERE id=p_order AND account_id=p_account;
  IF v_conv IS NULL THEN RETURN jsonb_build_object('ok',false,'reason','order_without_conversation'); END IF;

  SELECT
    CASE p_kind WHEN 'summary' THEN summary_template_name ELSE voucher_customer_template_name END,
    CASE p_kind WHEN 'summary' THEN summary_template_language ELSE voucher_customer_template_language END
    INTO v_name, v_lang
    FROM public.order_logistics_settings WHERE account_id=p_account;

  IF v_name IS NULL OR v_lang IS NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','template_not_configured');
  END IF;

  SELECT * INTO v_row FROM public.order_customer_template_dispatches d
    WHERE d.account_id=p_account AND d.order_id=p_order
      AND d.voucher_document_id=v_doc.id AND d.kind=p_kind
    FOR UPDATE;

  IF FOUND THEN
    IF v_row.status='sent' THEN
      RETURN jsonb_build_object('ok',false,'reason','already_sent','dispatch_id',v_row.id);
    ELSIF v_row.status IN ('claimed','sending') THEN
      IF COALESCE(v_row.sending_at,v_row.claimed_at) < now()-interval '10 minutes' THEN
        UPDATE public.order_customer_template_dispatches
          SET status='uncertain', finished_at=now(), error_code='send_interrupted'
          WHERE id=v_row.id;
        RETURN jsonb_build_object('ok',false,'reason','uncertain','dispatch_id',v_row.id);
      END IF;
      RETURN jsonb_build_object('ok',false,'reason','in_progress','dispatch_id',v_row.id);
    ELSIF v_row.status='uncertain' THEN
      RETURN jsonb_build_object('ok',false,'reason','uncertain','dispatch_id',v_row.id);
    ELSE
      UPDATE public.order_customer_template_dispatches
        SET status='claimed', attempt=attempt+1, claimed_at=now(), sending_at=NULL,
            finished_at=NULL, error_code=NULL, resolution=NULL, resolved_at=NULL, resolved_by=NULL,
            actor_user_id=p_actor, template_name=v_name, template_language=v_lang
        WHERE id=v_row.id RETURNING * INTO v_row;
    END IF;
  ELSE
    INSERT INTO public.order_customer_template_dispatches(
      account_id,order_id,voucher_document_id,kind,conversation_id,
      template_name,template_language,actor_user_id
    ) VALUES (
      p_account,p_order,v_doc.id,p_kind,v_conv,v_name,v_lang,p_actor
    ) RETURNING * INTO v_row;
  END IF;

  RETURN jsonb_build_object(
    'ok',true,'dispatch_id',v_row.id,'attempt',v_row.attempt,
    'conversation_id',v_row.conversation_id,'voucher_document_id',v_row.voucher_document_id,
    'template_name',v_row.template_name,'template_language',v_row.template_language
  );
END;
$$;

REVOKE ALL ON FUNCTION public.begin_order_customer_template(UUID,UUID,UUID,TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.begin_order_customer_template(UUID,UUID,UUID,TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.mark_order_customer_template_sending(
  p_account UUID,p_actor UUID,p_dispatch UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_name TEXT := public.order_logistics_actor(p_account,p_actor);
BEGIN
  UPDATE public.order_customer_template_dispatches
    SET status='sending',sending_at=now()
    WHERE id=p_dispatch AND account_id=p_account AND status='claimed';
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','invalid_state'); END IF;
  RETURN jsonb_build_object('ok',true);
END;
$$;
REVOKE ALL ON FUNCTION public.mark_order_customer_template_sending(UUID,UUID,UUID) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.mark_order_customer_template_sending(UUID,UUID,UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.finish_order_customer_template(
  p_account UUID,p_actor UUID,p_dispatch UUID,p_outcome TEXT,
  p_message_row UUID DEFAULT NULL,p_wamid TEXT DEFAULT NULL,p_error_code TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_name TEXT := public.order_logistics_actor(p_account,p_actor);
  v_row public.order_customer_template_dispatches%ROWTYPE;
BEGIN
  IF p_outcome NOT IN ('sent','failed','uncertain') THEN RAISE EXCEPTION 'invalid_outcome' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_row FROM public.order_customer_template_dispatches
    WHERE id=p_dispatch AND account_id=p_account FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
  IF v_row.status NOT IN ('claimed','sending') THEN
    RETURN jsonb_build_object('ok',false,'reason','invalid_state','status',v_row.status);
  END IF;
  IF p_outcome IN ('sent','uncertain') AND v_row.status<>'sending' THEN
    RETURN jsonb_build_object('ok',false,'reason','invalid_state','status',v_row.status);
  END IF;
  UPDATE public.order_customer_template_dispatches SET
    status=p_outcome,finished_at=now(),message_row_id=COALESCE(p_message_row,message_row_id),
    wamid=COALESCE(p_wamid,wamid),error_code=p_error_code
    WHERE id=p_dispatch;
  RETURN jsonb_build_object('ok',true,'status',p_outcome);
END;
$$;
REVOKE ALL ON FUNCTION public.finish_order_customer_template(UUID,UUID,UUID,TEXT,UUID,TEXT,TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.finish_order_customer_template(UUID,UUID,UUID,TEXT,UUID,TEXT,TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.resolve_order_customer_template(
  p_account UUID,p_actor UUID,p_dispatch UUID,p_resolution TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_name TEXT := public.order_logistics_actor(p_account,p_actor);
  v_status TEXT;
BEGIN
  IF p_resolution NOT IN ('confirmed_sent','confirmed_not_sent') THEN
    RAISE EXCEPTION 'invalid_resolution' USING ERRCODE='22023';
  END IF;
  SELECT status INTO v_status FROM public.order_customer_template_dispatches
    WHERE id=p_dispatch AND account_id=p_account FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
  IF v_status<>'uncertain' THEN RETURN jsonb_build_object('ok',false,'reason','not_uncertain'); END IF;
  UPDATE public.order_customer_template_dispatches SET
    status=CASE p_resolution WHEN 'confirmed_sent' THEN 'sent' ELSE 'failed' END,
    resolution=p_resolution,resolved_by=p_actor,resolved_at=now(),finished_at=now(),
    error_code=CASE p_resolution WHEN 'confirmed_sent' THEN NULL ELSE 'confirmed_not_sent' END
    WHERE id=p_dispatch;
  RETURN jsonb_build_object('ok',true,'status',CASE p_resolution WHEN 'confirmed_sent' THEN 'sent' ELSE 'failed' END);
END;
$$;
REVOKE ALL ON FUNCTION public.resolve_order_customer_template(UUID,UUID,UUID,TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_order_customer_template(UUID,UUID,UUID,TEXT) TO service_role;
