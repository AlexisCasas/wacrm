-- PR-06 · evidence of a payment REUSES order_documents + the private bucket `order-docs` (account-scoped, order-scoped, signed URLs only). Additive:
--   * order_documents.kind gains 'payment_proof' (voucher / evidence keep their exact shapes, indexes and PR-04 functions; every PR-04 RPC is kind-checked and
--     refuses a payment_proof, every PR-04 panel query filters by kind);
--   * a payment_proof is always an UPLOAD of an order, direct, and ACTIVE (never reviewed / OCR'd / validated: it is just a file a person links to a payment);
--   * a PR-04 voucher can ALSO be linked as evidence (order_payments_check_evidence), without copying the file and WITHOUT creating any payment.

ALTER TABLE public.order_documents DROP CONSTRAINT IF EXISTS order_documents_kind_check;
ALTER TABLE public.order_documents ADD CONSTRAINT order_documents_kind_check CHECK (kind IN ('voucher', 'evidence', 'payment_proof'));
ALTER TABLE public.order_documents DROP CONSTRAINT IF EXISTS order_documents_payment_proof_shape;
ALTER TABLE public.order_documents ADD CONSTRAINT order_documents_payment_proof_shape
  CHECK (kind <> 'payment_proof' OR (source = 'upload' AND order_id IS NOT NULL AND association = 'direct' AND status IN ('active', 'superseded') AND source_message_id IS NULL AND version IS NULL));

-- Registers the uploaded file (the backend already stored it in the private bucket). Idempotent on request_key; the same file (hash) of the same order is one proof.
CREATE OR REPLACE FUNCTION public.register_payment_proof(
  p_account UUID, p_actor UUID, p_order UUID, p_doc_id UUID, p_request_key TEXT, p_storage_path TEXT, p_filename TEXT, p_mime TEXT, p_size BIGINT, p_hash TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  a RECORD;
  v_existing public.order_documents%ROWTYPE;
  v_same public.order_documents%ROWTYPE;
BEGIN
  SELECT * INTO a FROM public.order_payments_actor(p_account, p_actor);
  IF p_doc_id IS NULL OR p_request_key IS NULL OR btrim(p_request_key) = '' OR char_length(p_request_key) > 100 THEN RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023'; END IF;
  PERFORM public.order_logistics_require_order(p_account, p_order);
  IF p_storage_path IS NULL OR NOT starts_with(p_storage_path, 'account-' || p_account::text || '/orders/' || p_order::text || '/payment-proofs/') THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  PERFORM public.order_payments_lock(p_order);

  SELECT * INTO v_existing FROM public.order_documents d WHERE d.account_id = p_account AND d.request_key = p_request_key;
  IF FOUND THEN
    IF v_existing.kind <> 'payment_proof' OR v_existing.order_id IS DISTINCT FROM p_order OR v_existing.content_hash IS DISTINCT FROM p_hash THEN
      RAISE EXCEPTION 'request_key_conflict' USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object('ok', TRUE, 'created', FALSE, 'document_id', v_existing.id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.order_financials f WHERE f.order_id = p_order AND f.account_id = p_account) THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'not_tracked');
  END IF;
  -- the very same file for the same order is the same proof (no duplicate row, the caller drops its stored copy)
  SELECT * INTO v_same FROM public.order_documents d WHERE d.account_id = p_account AND d.order_id = p_order AND d.kind = 'payment_proof' AND d.status = 'active' AND d.content_hash = p_hash ORDER BY d.created_at LIMIT 1;
  IF FOUND THEN RETURN jsonb_build_object('ok', TRUE, 'created', FALSE, 'document_id', v_same.id); END IF;

  BEGIN
    INSERT INTO public.order_documents (id, account_id, order_id, kind, status, association, request_key, storage_path, original_filename, mime_type, size_bytes, content_hash, source, uploaded_by)
    VALUES (p_doc_id, p_account, p_order, 'payment_proof', 'active', 'direct', btrim(p_request_key), p_storage_path, p_filename, p_mime, p_size, p_hash, 'upload', p_actor);
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO v_existing FROM public.order_documents d WHERE d.account_id = p_account AND d.request_key = p_request_key;
    IF FOUND AND v_existing.content_hash = p_hash THEN RETURN jsonb_build_object('ok', TRUE, 'created', FALSE, 'document_id', v_existing.id); END IF;
    RAISE;
  END;
  RETURN jsonb_build_object('ok', TRUE, 'created', TRUE, 'document_id', p_doc_id);
END;
$$;
ALTER FUNCTION public.register_payment_proof(UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.register_payment_proof(UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_payment_proof(UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT) TO service_role;
