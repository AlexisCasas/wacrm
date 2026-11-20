-- ============================================================
-- 20261129000003_order_evidence_rpc
--
-- PR-04 · the ONLY writer of order EVIDENCE: the durable, private snapshot of a media message that already lives in the order's own chat
-- (same conversation_id, same history). Purely additive: one new function. Nothing existing is altered; no table, policy or bucket changes.
--
-- The backend reads the chat media (never moved, never deleted, chat-media untouched), stores a private copy in `order-docs` and calls this RPC
-- to register it. The database re-validates actor, account, flag, area, order ownership AND that the message belongs to the order's conversation
-- (a message of another conversation / account is refused even if the backend were wrong).
--
--   * Only while the order is `packing` (voucher validated + packaging started). Evidence of an order that is not packing is refused.
--   * Idempotent: same request_key = same operation; selecting the SAME message again changes nothing.
--   * Choosing a different message supersedes the previous evidence (kept as history) and repoints the order, unless a template dispatch is open
--     (claimed / sending / uncertain): the evidence of an in-flight send never changes underneath it.
--   * Evidence is per ORDER (no per-item structure).
-- ============================================================

CREATE OR REPLACE FUNCTION public.select_order_evidence(
  p_account UUID, p_actor UUID, p_order UUID, p_message UUID, p_doc_id UUID, p_request_key TEXT,
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
  v_conversation UUID;
BEGIN
  IF p_doc_id IS NULL OR p_message IS NULL OR p_request_key IS NULL OR btrim(p_request_key) = '' OR char_length(p_request_key) > 100 THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
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

  SELECT o.conversation_id INTO v_conversation FROM public.order_confirmations o WHERE o.id = p_order AND o.account_id = p_account;
  IF v_conversation IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'order_without_conversation');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.messages m JOIN public.conversations c ON c.id = m.conversation_id
     WHERE m.id = p_message AND c.id = v_conversation AND c.account_id = p_account
  ) THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'message_not_in_conversation');
  END IF;

  IF EXISTS (SELECT 1 FROM public.order_template_dispatches t WHERE t.order_id = p_order AND t.status IN ('claimed', 'sending', 'uncertain')) THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'dispatch_open');
  END IF;

  SELECT * INTO v_active FROM public.order_documents d WHERE d.order_id = p_order AND d.kind = 'evidence' AND d.status = 'active' FOR UPDATE;
  IF FOUND AND v_active.source_message_id IS NOT DISTINCT FROM p_message THEN
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
     'chat_message', p_message, p_actor);

  UPDATE public.order_logistics SET evidence_document_id = p_doc_id, version = version + 1 WHERE order_id = p_order;

  PERFORM public.order_logistics_log(p_account, p_order, p_doc_id, NULL, p_actor, v_name, 'evidence_selected', 'ok', NULL, NULL, NULL,
    jsonb_build_object('message_id', p_message, 'mime', p_mime, 'size_bytes', p_size, 'replaced', v_active.id IS NOT NULL));
  RETURN jsonb_build_object('ok', TRUE, 'created', TRUE, 'document_id', p_doc_id);
END;
$$;
ALTER FUNCTION public.select_order_evidence(UUID, UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.select_order_evidence(UUID, UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.select_order_evidence(UUID, UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT) TO service_role;
