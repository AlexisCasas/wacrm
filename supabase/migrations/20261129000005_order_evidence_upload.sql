-- ============================================================
-- 20261129000005_order_evidence_upload
--
-- PR-04 · packaging evidence UPLOADED by Logística / Supervisor straight from their device (the chat may have no usable file). ADDITIVE and local to
-- PR-04's own objects: it only
--   * relaxes ONE check of order_documents (evidence may now also have source = 'upload'; evidence from the chat is unchanged);
--   * adds the audit event type 'evidence_uploaded' (the origin of the evidence is therefore explicit in the trail);
--   * adds ONE function, register_order_evidence_upload, the twin of select_order_evidence WITHOUT the chat message / conversation requirement.
-- Nothing else is altered: same table (order_documents, kind 'evidence'), same private bucket (order-docs, account/order scoped path), same unique
-- "one active evidence per order", same trigger that ties order_logistics.evidence_document_id to an ACTIVE evidence of THAT order and account.
-- The template send keeps reading order_logistics.evidence_document_id, so it works the same whichever way the evidence arrived.
-- ============================================================

ALTER TABLE public.order_documents DROP CONSTRAINT IF EXISTS order_documents_evidence_shape;
ALTER TABLE public.order_documents ADD CONSTRAINT order_documents_evidence_shape CHECK (
  kind <> 'evidence' OR (
    source IN ('chat_message', 'upload')
    AND order_id IS NOT NULL AND association = 'direct' AND status IN ('active', 'superseded')
    -- an uploaded evidence has no chat message; a chat evidence keeps its (nullable on message deletion) reference
    AND (source = 'chat_message' OR source_message_id IS NULL)
  )
);

ALTER TABLE public.order_logistics_events DROP CONSTRAINT IF EXISTS order_logistics_events_type_check;
ALTER TABLE public.order_logistics_events ADD CONSTRAINT order_logistics_events_type_check CHECK (event_type IN (
  'voucher_uploaded', 'voucher_associated', 'ocr_started', 'ocr_completed', 'ocr_failed',
  'voucher_corrected', 'voucher_validated', 'voucher_rejected', 'voucher_superseded',
  'packaging_started', 'evidence_selected', 'evidence_uploaded',
  'template_send_started', 'template_sent', 'template_failed', 'template_uncertain', 'template_resolved',
  'packaging_completed'
));

CREATE OR REPLACE FUNCTION public.register_order_evidence_upload(
  p_account UUID, p_actor UUID, p_order UUID, p_doc_id UUID, p_request_key TEXT,
  p_storage_path TEXT, p_filename TEXT, p_mime TEXT, p_size BIGINT, p_hash TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name TEXT := public.order_logistics_actor(p_account, p_actor);
  v_existing public.order_documents%ROWTYPE;
  v_active public.order_documents%ROWTYPE;
  l public.order_logistics%ROWTYPE;
BEGIN
  IF p_doc_id IS NULL OR p_request_key IS NULL OR btrim(p_request_key) = '' OR char_length(p_request_key) > 100 THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  -- Re-validates, inside the database: actor of the account, flag ON, logistics/supervisor area, agent+ and an order of THIS account.
  PERFORM public.order_logistics_require_order(p_account, p_order);
  PERFORM public.order_logistics_lock(p_order);

  -- Replay of the same operation.
  SELECT * INTO v_existing FROM public.order_documents d WHERE d.account_id = p_account AND d.request_key = p_request_key;
  IF FOUND THEN
    IF v_existing.kind <> 'evidence' OR v_existing.order_id IS DISTINCT FROM p_order OR v_existing.content_hash IS DISTINCT FROM p_hash THEN
      RAISE EXCEPTION 'request_key_conflict' USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object('ok', TRUE, 'created', FALSE, 'document_id', v_existing.id);
  END IF;

  SELECT * INTO l FROM public.order_logistics x WHERE x.order_id = p_order FOR UPDATE;
  IF NOT FOUND OR l.status IN ('pending_voucher', 'voucher_validated') THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'not_packing');
  END IF;
  IF l.status = 'ready_for_dispatch' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'already_ready');
  END IF;

  -- The evidence of an in-flight send never changes underneath it.
  IF EXISTS (SELECT 1 FROM public.order_template_dispatches t WHERE t.order_id = p_order AND t.status IN ('claimed', 'sending', 'uncertain')) THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'dispatch_open');
  END IF;

  SELECT * INTO v_active FROM public.order_documents d WHERE d.order_id = p_order AND d.kind = 'evidence' AND d.status = 'active' FOR UPDATE;
  -- The very same file is already the active evidence: nothing to do (no duplicated object, no new version).
  IF FOUND AND v_active.content_hash = p_hash THEN
    RETURN jsonb_build_object('ok', TRUE, 'created', FALSE, 'unchanged', TRUE, 'document_id', v_active.id);
  END IF;
  IF FOUND THEN
    UPDATE public.order_documents SET status = 'superseded' WHERE id = v_active.id;
  END IF;

  INSERT INTO public.order_documents
    (id, account_id, order_id, kind, status, association, request_key, storage_path, original_filename, mime_type, size_bytes, content_hash,
     source, source_message_id, uploaded_by)
  VALUES
    (p_doc_id, p_account, p_order, 'evidence', 'active', 'direct', p_request_key, p_storage_path, p_filename, p_mime, p_size, p_hash,
     'upload', NULL, p_actor);

  UPDATE public.order_logistics SET evidence_document_id = p_doc_id, version = version + 1 WHERE order_id = p_order;

  PERFORM public.order_logistics_log(p_account, p_order, p_doc_id, NULL, p_actor, v_name, 'evidence_uploaded', 'ok', NULL, NULL, NULL,
    jsonb_build_object('source', 'upload', 'mime', p_mime, 'size_bytes', p_size, 'replaced', v_active.id IS NOT NULL));
  RETURN jsonb_build_object('ok', TRUE, 'created', TRUE, 'document_id', p_doc_id);
END;
$$;
ALTER FUNCTION public.register_order_evidence_upload(UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.register_order_evidence_upload(UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_order_evidence_upload(UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT) TO service_role;
