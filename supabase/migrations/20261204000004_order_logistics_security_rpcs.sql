-- ============================================================
-- 20261129000001_order_logistics_security_rpcs
--
-- PR-04 · STAGE 2/2 of the database half: access helper, RLS, and the ONLY writers of the PR-04 tables (RPCs). Purely additive.
--
-- Access model (same philosophy as PR-02 / PR-03):
--   * The browser can only READ (RLS), and only when the account has logistics_mvp_enabled = TRUE and the caller is an operational
--     logistics / supervisor member (account_role owner|admin|agent). Commercial, no-area users, viewers and other accounts see NOTHING.
--     conversation_routing (PR-03) is NOT consulted: a `shared` chat grants no logistic permission.
--   * Every write goes through a SECURITY DEFINER RPC that only service_role can execute. The backend derives the actor / account from the
--     session and passes them; the RPC RE-VALIDATES them in the database (flag, membership, operational area, role, ownership of the order),
--     so a bug or a forged parameter in the application layer cannot widen access. Cross-account and non-existent ids are indistinguishable (42501).
--   * Business refusals (order locked, duplicate, stale version, ...) return {"ok": false, "reason": ...}; authorization / shape errors RAISE.
--   * Operations on one order are serialized with a transaction-level advisory lock, so two operators / double clicks never interleave.
--
-- Nothing here creates settings, activates a flag or touches an existing object.
-- ============================================================

-- ---------------------------------------------------------------
-- Access helper used by RLS (auth.uid() based).
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.order_logistics_access(p_account_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.profiles p
      JOIN public.order_integration_settings s ON s.account_id = p.account_id AND s.logistics_mvp_enabled
     WHERE p.user_id = auth.uid()
       AND p.account_id = p_account_id
       AND p.operational_role IN ('logistics', 'supervisor')
       AND p.account_role IN ('owner', 'admin', 'agent')
  )
$$;
ALTER FUNCTION public.order_logistics_access(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.order_logistics_access(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.order_logistics_access(UUID) TO authenticated, service_role;

-- ---------------------------------------------------------------
-- RLS: SELECT only. (No INSERT / UPDATE / DELETE policy exists and no such privilege is granted.)
-- ---------------------------------------------------------------
GRANT SELECT ON public.order_logistics_settings, public.order_documents, public.order_template_dispatches, public.order_logistics, public.order_logistics_events
  TO authenticated;

DROP POLICY IF EXISTS order_logistics_settings_select ON public.order_logistics_settings;
CREATE POLICY order_logistics_settings_select ON public.order_logistics_settings
  FOR SELECT USING (public.order_logistics_access(account_id));
DROP POLICY IF EXISTS order_documents_select ON public.order_documents;
CREATE POLICY order_documents_select ON public.order_documents
  FOR SELECT USING (public.order_logistics_access(account_id));
DROP POLICY IF EXISTS order_template_dispatches_select ON public.order_template_dispatches;
CREATE POLICY order_template_dispatches_select ON public.order_template_dispatches
  FOR SELECT USING (public.order_logistics_access(account_id));
DROP POLICY IF EXISTS order_logistics_select ON public.order_logistics;
CREATE POLICY order_logistics_select ON public.order_logistics
  FOR SELECT USING (public.order_logistics_access(account_id));
DROP POLICY IF EXISTS order_logistics_events_select ON public.order_logistics_events;
CREATE POLICY order_logistics_events_select ON public.order_logistics_events
  FOR SELECT USING (public.order_logistics_access(account_id));

-- ---------------------------------------------------------------
-- Internal helpers (not callable by browser roles or service_role directly; only by the RPCs below, which run as the owner).
-- ---------------------------------------------------------------

-- Validates the (account, actor) pair the backend derived from the session and returns the actor's display name.
CREATE OR REPLACE FUNCTION public.order_logistics_actor(p_account UUID, p_actor UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role public.operational_role_enum;
  v_account_role public.account_role_enum;
  v_name TEXT;
  v_enabled BOOLEAN;
BEGIN
  IF p_account IS NULL OR p_actor IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT p.operational_role, p.account_role, COALESCE(NULLIF(btrim(p.full_name), ''), NULLIF(btrim(p.email), ''), 'unknown')
    INTO v_role, v_account_role, v_name
    FROM public.profiles p WHERE p.user_id = p_actor AND p.account_id = p_account;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT COALESCE((SELECT s.logistics_mvp_enabled FROM public.order_integration_settings s WHERE s.account_id = p_account), FALSE) INTO v_enabled;
  IF NOT v_enabled THEN
    RAISE EXCEPTION 'feature_disabled' USING ERRCODE = '42501';
  END IF;
  -- Viewers are read-only everywhere in WACRM; routing (PR-03) is deliberately NOT consulted.
  IF v_role IS NULL OR v_role NOT IN ('logistics', 'supervisor') OR v_account_role NOT IN ('owner', 'admin', 'agent') THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  RETURN v_name;
END;
$$;
ALTER FUNCTION public.order_logistics_actor(UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.order_logistics_actor(UUID, UUID) FROM PUBLIC, anon, authenticated, service_role;

-- Serializes every operation on one order (works even before an order_logistics row exists).
CREATE OR REPLACE FUNCTION public.order_logistics_lock(p_order UUID)
RETURNS VOID
LANGUAGE sql
AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('order_logistics:' || p_order::text, 0))
$$;
ALTER FUNCTION public.order_logistics_lock(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.order_logistics_lock(UUID) FROM PUBLIC, anon, authenticated, service_role;

-- The order must belong to the account; otherwise indistinguishable from "does not exist".
CREATE OR REPLACE FUNCTION public.order_logistics_require_order(p_account UUID, p_order UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_order IS NULL OR NOT EXISTS (SELECT 1 FROM public.order_confirmations o WHERE o.id = p_order AND o.account_id = p_account) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
END;
$$;
ALTER FUNCTION public.order_logistics_require_order(UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.order_logistics_require_order(UUID, UUID) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.order_logistics_log(
  p_account UUID, p_order UUID, p_document UUID, p_dispatch UUID, p_actor UUID, p_actor_name TEXT,
  p_type TEXT, p_outcome TEXT, p_attempt INTEGER, p_error_code TEXT, p_provider TEXT, p_detail JSONB
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.order_logistics_events
    (account_id, order_id, document_id, dispatch_id, event_type, outcome, attempt, error_code, provider, detail, actor_user_id, actor_name)
  VALUES
    (p_account, p_order, p_document, p_dispatch, p_type, COALESCE(p_outcome, 'ok'), p_attempt, p_error_code, p_provider,
     COALESCE(p_detail, '{}'::jsonb), p_actor, COALESCE(NULLIF(btrim(p_actor_name), ''), 'unknown'));
END;
$$;
ALTER FUNCTION public.order_logistics_log(UUID, UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, JSONB) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.order_logistics_log(UUID, UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------
-- register_order_document: records an ALREADY-UPLOADED voucher file. The backend uploads to the private bucket first (so a refused / duplicate
-- registration leaves at most a private orphan object, never a row pointing to a missing file).
--   p_order given  -> direct association (the order is known from where the operator is working; no matching).
--   p_order NULL   -> bulk upload: pending association.
-- Idempotent on (account, request_key). Same hash in the account (still open / validated) is reported as `duplicate` unless p_allow_duplicate.
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.register_order_document(
  p_account UUID, p_actor UUID, p_doc_id UUID, p_order UUID, p_batch UUID, p_request_key TEXT,
  p_storage_path TEXT, p_filename TEXT, p_mime TEXT, p_size BIGINT, p_hash TEXT, p_allow_duplicate BOOLEAN DEFAULT FALSE
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name TEXT := public.order_logistics_actor(p_account, p_actor);
  v_existing public.order_documents%ROWTYPE;
  v_dup RECORD;
  v_status TEXT;
  v_assoc TEXT;
BEGIN
  IF p_doc_id IS NULL OR p_request_key IS NULL OR btrim(p_request_key) = '' OR char_length(p_request_key) > 100 THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_existing FROM public.order_documents d WHERE d.account_id = p_account AND d.request_key = p_request_key;
  IF FOUND THEN
    IF v_existing.content_hash IS DISTINCT FROM p_hash THEN
      RAISE EXCEPTION 'request_key_conflict' USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object('ok', TRUE, 'created', FALSE, 'document_id', v_existing.id, 'order_id', v_existing.order_id,
                              'association', v_existing.association, 'status', v_existing.status);
  END IF;

  IF p_order IS NOT NULL THEN
    PERFORM public.order_logistics_require_order(p_account, p_order);
    PERFORM public.order_logistics_lock(p_order);
    SELECT l.status INTO v_status FROM public.order_logistics l WHERE l.order_id = p_order;
    IF v_status IN ('packing', 'ready_for_dispatch') THEN
      RETURN jsonb_build_object('ok', FALSE, 'reason', 'order_locked');
    END IF;
  END IF;

  IF NOT COALESCE(p_allow_duplicate, FALSE) THEN
    SELECT d.id, d.order_id INTO v_dup FROM public.order_documents d
     WHERE d.account_id = p_account AND d.kind = 'voucher' AND d.content_hash = p_hash AND d.status IN ('pending_review', 'validated')
     ORDER BY d.created_at LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object('ok', FALSE, 'reason', 'duplicate', 'duplicate_of', v_dup.id, 'duplicate_order_id', v_dup.order_id);
    END IF;
  END IF;

  v_assoc := CASE WHEN p_order IS NULL THEN 'pending' ELSE 'direct' END;
  BEGIN
    INSERT INTO public.order_documents
      (id, account_id, order_id, kind, status, association, batch_id, request_key, storage_path, original_filename, mime_type, size_bytes,
       content_hash, source, uploaded_by)
    VALUES
      (p_doc_id, p_account, p_order, 'voucher', 'pending_review', v_assoc, p_batch, p_request_key, p_storage_path, p_filename, p_mime, p_size,
       p_hash, 'upload', p_actor);
  EXCEPTION WHEN unique_violation THEN
    -- A concurrent call with the same request_key won the race: behave as the idempotent replay.
    SELECT * INTO v_existing FROM public.order_documents d WHERE d.account_id = p_account AND d.request_key = p_request_key;
    IF FOUND AND v_existing.content_hash = p_hash THEN
      RETURN jsonb_build_object('ok', TRUE, 'created', FALSE, 'document_id', v_existing.id, 'order_id', v_existing.order_id,
                                'association', v_existing.association, 'status', v_existing.status);
    END IF;
    RAISE;
  END;

  PERFORM public.order_logistics_log(p_account, p_order, p_doc_id, NULL, p_actor, v_name, 'voucher_uploaded', 'ok', NULL, NULL, NULL,
    jsonb_build_object('association', v_assoc, 'bulk', p_batch IS NOT NULL, 'size_bytes', p_size, 'mime', p_mime));
  RETURN jsonb_build_object('ok', TRUE, 'created', TRUE, 'document_id', p_doc_id, 'order_id', p_order, 'association', v_assoc, 'status', 'pending_review');
END;
$$;
ALTER FUNCTION public.register_order_document(UUID, UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, BOOLEAN) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.register_order_document(UUID, UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_order_document(UUID, UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, BOOLEAN) TO service_role;

-- ---------------------------------------------------------------
-- OCR attempt lifecycle. The OCR provider is external and swappable; these three RPCs only record the attempt and the NORMALIZED result.
-- A validated / rejected / superseded document is never re-processed (a new version is a new document).
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.begin_document_ocr(p_account UUID, p_actor UUID, p_doc UUID, p_stale_seconds INTEGER DEFAULT 120)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name TEXT := public.order_logistics_actor(p_account, p_actor);
  d public.order_documents%ROWTYPE;
BEGIN
  SELECT * INTO d FROM public.order_documents x WHERE x.id = p_doc AND x.account_id = p_account FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF d.kind <> 'voucher' OR d.status <> 'pending_review' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'frozen');
  END IF;
  IF d.ocr_status = 'pending' AND d.ocr_claimed_at > now() - make_interval(secs => GREATEST(COALESCE(p_stale_seconds, 120), 1)) THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'in_progress', 'attempt', d.ocr_attempts);
  END IF;
  UPDATE public.order_documents
     SET ocr_status = 'pending', ocr_attempts = d.ocr_attempts + 1, ocr_claimed_at = now(), ocr_error_code = NULL
   WHERE id = p_doc;
  PERFORM public.order_logistics_log(p_account, d.order_id, p_doc, NULL, p_actor, v_name, 'ocr_started', 'ok', d.ocr_attempts + 1, NULL, NULL, '{}'::jsonb);
  RETURN jsonb_build_object('ok', TRUE, 'attempt', d.ocr_attempts + 1);
END;
$$;
ALTER FUNCTION public.begin_document_ocr(UUID, UUID, UUID, INTEGER) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.begin_document_ocr(UUID, UUID, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_document_ocr(UUID, UUID, UUID, INTEGER) TO service_role;

-- p_result contract (intentionally loose until real vouchers are sampled): {"fields": {"<name>": {"value": <any>, "confidence": 0..1}}, ...}
CREATE OR REPLACE FUNCTION public.complete_document_ocr(p_account UUID, p_actor UUID, p_doc UUID, p_attempt INTEGER, p_provider TEXT, p_result JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name TEXT := public.order_logistics_actor(p_account, p_actor);
  d public.order_documents%ROWTYPE;
  v_field RECORD;
  v_count INTEGER := 0;
  v_min NUMERIC;
  v_conf NUMERIC;
BEGIN
  IF p_result IS NULL OR jsonb_typeof(p_result) <> 'object' OR jsonb_typeof(p_result -> 'fields') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'invalid_ocr_result' USING ERRCODE = '22023';
  END IF;
  FOR v_field IN SELECT key, value FROM jsonb_each(p_result -> 'fields') LOOP
    IF jsonb_typeof(v_field.value) <> 'object' THEN
      RAISE EXCEPTION 'invalid_ocr_result' USING ERRCODE = '22023';
    END IF;
    IF v_field.value ? 'confidence' THEN
      IF jsonb_typeof(v_field.value -> 'confidence') <> 'number' THEN
        RAISE EXCEPTION 'invalid_ocr_result' USING ERRCODE = '22023';
      END IF;
      v_conf := (v_field.value ->> 'confidence')::numeric;
      IF v_conf < 0 OR v_conf > 1 THEN
        RAISE EXCEPTION 'invalid_ocr_result' USING ERRCODE = '22023';
      END IF;
      v_min := LEAST(COALESCE(v_min, v_conf), v_conf);
    END IF;
    v_count := v_count + 1;
  END LOOP;

  SELECT * INTO d FROM public.order_documents x WHERE x.id = p_doc AND x.account_id = p_account FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF d.kind <> 'voucher' OR d.status <> 'pending_review' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'frozen');
  END IF;
  IF d.ocr_status <> 'pending' OR d.ocr_attempts <> p_attempt THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'stale_attempt');
  END IF;

  UPDATE public.order_documents
     SET ocr_status = 'done', ocr_result = p_result, ocr_provider = p_provider, ocr_error_code = NULL
   WHERE id = p_doc;
  PERFORM public.order_logistics_log(p_account, d.order_id, p_doc, NULL, p_actor, v_name, 'ocr_completed', 'ok', p_attempt, NULL, p_provider,
    jsonb_build_object('fields', v_count, 'min_confidence', v_min));
  RETURN jsonb_build_object('ok', TRUE, 'attempt', p_attempt);
END;
$$;
ALTER FUNCTION public.complete_document_ocr(UUID, UUID, UUID, INTEGER, TEXT, JSONB) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.complete_document_ocr(UUID, UUID, UUID, INTEGER, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_document_ocr(UUID, UUID, UUID, INTEGER, TEXT, JSONB) TO service_role;

CREATE OR REPLACE FUNCTION public.fail_document_ocr(p_account UUID, p_actor UUID, p_doc UUID, p_attempt INTEGER, p_provider TEXT, p_error_code TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name TEXT := public.order_logistics_actor(p_account, p_actor);
  d public.order_documents%ROWTYPE;
BEGIN
  IF p_error_code IS NULL OR p_error_code !~ '^[a-z0-9_]{1,40}$' THEN
    RAISE EXCEPTION 'invalid_error_code' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO d FROM public.order_documents x WHERE x.id = p_doc AND x.account_id = p_account FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF d.kind <> 'voucher' OR d.status <> 'pending_review' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'frozen');
  END IF;
  IF d.ocr_status <> 'pending' OR d.ocr_attempts <> p_attempt THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'stale_attempt');
  END IF;
  UPDATE public.order_documents
     SET ocr_status = 'failed', ocr_error_code = p_error_code, ocr_provider = p_provider
   WHERE id = p_doc;
  PERFORM public.order_logistics_log(p_account, d.order_id, p_doc, NULL, p_actor, v_name, 'ocr_failed', 'error', p_attempt, p_error_code, p_provider, '{}'::jsonb);
  RETURN jsonb_build_object('ok', TRUE, 'attempt', p_attempt);
END;
$$;
ALTER FUNCTION public.fail_document_ocr(UUID, UUID, UUID, INTEGER, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fail_document_ocr(UUID, UUID, UUID, INTEGER, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_document_ocr(UUID, UUID, UUID, INTEGER, TEXT, TEXT) TO service_role;

-- ---------------------------------------------------------------
-- associate_order_document: links a PENDING (bulk) voucher to an order. The candidate selection (matching rule) is application code; the
-- database only records WHO / HOW ('auto' = the conservative rule found exactly one candidate, 'manual' = a person chose) and refuses what is
-- unsafe. An association never validates: a human still has to validate the voucher.
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.associate_order_document(p_account UUID, p_actor UUID, p_doc UUID, p_order UUID, p_method TEXT, p_signals JSONB DEFAULT '[]'::jsonb)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name TEXT := public.order_logistics_actor(p_account, p_actor);
  d public.order_documents%ROWTYPE;
  v_status TEXT;
BEGIN
  IF p_method IS NULL OR p_method NOT IN ('auto', 'manual') THEN
    RAISE EXCEPTION 'invalid_method' USING ERRCODE = '22023';
  END IF;
  IF p_signals IS NULL OR jsonb_typeof(p_signals) <> 'array' OR jsonb_array_length(p_signals) > 10
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_signals) e WHERE jsonb_typeof(e) <> 'string' OR char_length(e #>> '{}') > 40) THEN
    RAISE EXCEPTION 'invalid_signals' USING ERRCODE = '22023';
  END IF;
  PERFORM public.order_logistics_require_order(p_account, p_order);
  PERFORM public.order_logistics_lock(p_order);

  SELECT * INTO d FROM public.order_documents x WHERE x.id = p_doc AND x.account_id = p_account FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF d.kind <> 'voucher' OR d.status <> 'pending_review' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'frozen');
  END IF;
  IF d.association = 'direct' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'direct_locked');
  END IF;
  IF p_method = 'auto' AND d.association <> 'pending' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'not_pending');
  END IF;
  IF d.order_id = p_order AND d.association = p_method THEN
    RETURN jsonb_build_object('ok', TRUE, 'changed', FALSE, 'order_id', p_order);
  END IF;
  SELECT l.status INTO v_status FROM public.order_logistics l WHERE l.order_id = p_order;
  IF v_status IN ('packing', 'ready_for_dispatch') THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'order_locked');
  END IF;

  UPDATE public.order_documents SET order_id = p_order, association = p_method WHERE id = p_doc;
  PERFORM public.order_logistics_log(p_account, p_order, p_doc, NULL, p_actor, v_name, 'voucher_associated', 'ok', NULL, NULL, NULL,
    jsonb_build_object('method', p_method, 'signals', p_signals, 'reassigned', d.order_id IS NOT NULL));
  RETURN jsonb_build_object('ok', TRUE, 'changed', TRUE, 'order_id', p_order);
END;
$$;
ALTER FUNCTION public.associate_order_document(UUID, UUID, UUID, UUID, TEXT, JSONB) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.associate_order_document(UUID, UUID, UUID, UUID, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.associate_order_document(UUID, UUID, UUID, UUID, TEXT, JSONB) TO service_role;

-- ---------------------------------------------------------------
-- review_order_document: human review of a voucher. Actions: correct | validate | reject.
--   * `correct` stores reviewed_data (the OCR result is never overwritten).
--   * `validate` freezes accepted OCR + reviewed_data, supersedes the previous validated voucher of the order (kept), assigns the version and moves
--     the order to voucher_validated. Refused once packaging started. A voucher still pending association can NOT be validated.
--   * Idempotent: repeating validate / reject on an already validated / rejected document returns ok without changes.
--   * p_expected_row_version (optional) protects against two operators reviewing the same document.
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.review_order_document(
  p_account UUID, p_actor UUID, p_doc UUID, p_action TEXT, p_expected_row_version INTEGER DEFAULT NULL, p_reviewed_data JSONB DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name TEXT := public.order_logistics_actor(p_account, p_actor);
  d public.order_documents%ROWTYPE;
  v_prev public.order_documents%ROWTYPE;
  v_final JSONB;
  v_keys JSONB;
  v_status TEXT;
  v_version INTEGER;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('correct', 'validate', 'reject') THEN
    RAISE EXCEPTION 'invalid_action' USING ERRCODE = '22023';
  END IF;
  IF p_reviewed_data IS NOT NULL AND (jsonb_typeof(p_reviewed_data) <> 'object' OR octet_length(p_reviewed_data::text) > 20000) THEN
    RAISE EXCEPTION 'invalid_reviewed_data' USING ERRCODE = '22023';
  END IF;

  -- Resolve the order first (lock order -> document: the same order everywhere, no deadlock between operators).
  SELECT x.order_id INTO v_prev.order_id FROM public.order_documents x WHERE x.id = p_doc AND x.account_id = p_account;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF v_prev.order_id IS NOT NULL THEN
    PERFORM public.order_logistics_lock(v_prev.order_id);
  END IF;

  SELECT * INTO d FROM public.order_documents x WHERE x.id = p_doc AND x.account_id = p_account FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF d.kind <> 'voucher' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'not_a_voucher');
  END IF;

  -- Idempotent replays.
  IF p_action = 'validate' AND d.status = 'validated' THEN
    RETURN jsonb_build_object('ok', TRUE, 'changed', FALSE, 'status', d.status, 'row_version', d.row_version);
  END IF;
  IF p_action = 'reject' AND d.status = 'rejected' THEN
    RETURN jsonb_build_object('ok', TRUE, 'changed', FALSE, 'status', d.status, 'row_version', d.row_version);
  END IF;
  IF d.status <> 'pending_review' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'frozen');
  END IF;
  IF p_expected_row_version IS NOT NULL AND p_expected_row_version <> d.row_version THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'stale', 'row_version', d.row_version);
  END IF;

  IF p_action = 'correct' THEN
    IF p_reviewed_data IS NULL OR p_reviewed_data = '{}'::jsonb THEN
      RAISE EXCEPTION 'invalid_reviewed_data' USING ERRCODE = '22023';
    END IF;
    SELECT COALESCE(jsonb_agg(k.key ORDER BY k.key), '[]'::jsonb) INTO v_keys
      FROM jsonb_each(p_reviewed_data) k
     WHERE d.reviewed_data IS NULL OR (d.reviewed_data -> k.key) IS DISTINCT FROM k.value;
    UPDATE public.order_documents SET reviewed_data = p_reviewed_data, reviewed_by = p_actor, reviewed_at = now() WHERE id = p_doc;
    PERFORM public.order_logistics_log(p_account, d.order_id, p_doc, NULL, p_actor, v_name, 'voucher_corrected', 'ok', NULL, NULL, NULL,
      jsonb_build_object('fields', v_keys));
    RETURN jsonb_build_object('ok', TRUE, 'changed', TRUE, 'status', 'pending_review', 'row_version', d.row_version + 1);
  END IF;

  IF p_action = 'reject' THEN
    UPDATE public.order_documents SET status = 'rejected', reviewed_by = p_actor, reviewed_at = now() WHERE id = p_doc;
    PERFORM public.order_logistics_log(p_account, d.order_id, p_doc, NULL, p_actor, v_name, 'voucher_rejected', 'ok', NULL, NULL, NULL, '{}'::jsonb);
    RETURN jsonb_build_object('ok', TRUE, 'changed', TRUE, 'status', 'rejected', 'row_version', d.row_version + 1);
  END IF;

  -- validate ---------------------------------------------------
  IF d.order_id IS NULL OR d.association = 'pending' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'association_required');
  END IF;
  v_final := COALESCE(p_reviewed_data, d.reviewed_data);
  IF v_final IS NULL OR v_final = '{}'::jsonb THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'reviewed_data_required');
  END IF;
  SELECT l.status INTO v_status FROM public.order_logistics l WHERE l.order_id = d.order_id FOR UPDATE;
  IF v_status IN ('packing', 'ready_for_dispatch') THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'order_locked');
  END IF;

  SELECT * INTO v_prev FROM public.order_documents x WHERE x.order_id = d.order_id AND x.kind = 'voucher' AND x.status = 'validated' FOR UPDATE;
  IF FOUND THEN
    UPDATE public.order_documents SET status = 'superseded' WHERE id = v_prev.id;
    PERFORM public.order_logistics_log(p_account, d.order_id, v_prev.id, NULL, p_actor, v_name, 'voucher_superseded', 'ok', NULL, NULL, NULL,
      jsonb_build_object('version', v_prev.version, 'replaced_by', d.id));
  END IF;
  SELECT COALESCE(MAX(x.version), 0) + 1 INTO v_version FROM public.order_documents x WHERE x.order_id = d.order_id AND x.kind = 'voucher';

  UPDATE public.order_documents
     SET status = 'validated', version = v_version, reviewed_data = v_final,
         reviewed_by = p_actor, reviewed_at = now(), validated_by = p_actor, validated_at = now()
   WHERE id = p_doc;

  IF v_status IS NULL THEN
    INSERT INTO public.order_logistics (order_id, account_id, status, voucher_document_id, validated_at, validated_by)
    VALUES (d.order_id, p_account, 'voucher_validated', p_doc, now(), p_actor);
  ELSE
    UPDATE public.order_logistics
       SET status = 'voucher_validated', voucher_document_id = p_doc, validated_at = now(), validated_by = p_actor, version = version + 1
     WHERE order_id = d.order_id;
  END IF;

  PERFORM public.order_logistics_log(p_account, d.order_id, p_doc, NULL, p_actor, v_name, 'voucher_validated', 'ok', NULL, NULL, d.ocr_provider,
    jsonb_build_object('version', v_version, 'association', d.association, 'ocr_status', d.ocr_status));
  RETURN jsonb_build_object('ok', TRUE, 'changed', TRUE, 'status', 'validated', 'version', v_version, 'row_version', d.row_version + 1);
END;
$$;
ALTER FUNCTION public.review_order_document(UUID, UUID, UUID, TEXT, INTEGER, JSONB) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.review_order_document(UUID, UUID, UUID, TEXT, INTEGER, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.review_order_document(UUID, UUID, UUID, TEXT, INTEGER, JSONB) TO service_role;

-- ---------------------------------------------------------------
-- start_order_packaging: voucher_validated -> packing. Idempotent (already packing = ok, unchanged).
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.start_order_packaging(p_account UUID, p_actor UUID, p_order UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name TEXT := public.order_logistics_actor(p_account, p_actor);
  l public.order_logistics%ROWTYPE;
BEGIN
  PERFORM public.order_logistics_require_order(p_account, p_order);
  PERFORM public.order_logistics_lock(p_order);
  SELECT * INTO l FROM public.order_logistics x WHERE x.order_id = p_order FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'voucher_required');
  END IF;
  IF l.status = 'packing' THEN
    RETURN jsonb_build_object('ok', TRUE, 'changed', FALSE, 'status', 'packing');
  END IF;
  IF l.status = 'ready_for_dispatch' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'already_ready');
  END IF;
  IF l.status <> 'voucher_validated' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'voucher_required');
  END IF;
  UPDATE public.order_logistics
     SET status = 'packing', packaging_started_at = now(), packaging_started_by = p_actor, version = version + 1
   WHERE order_id = p_order;
  PERFORM public.order_logistics_log(p_account, p_order, NULL, NULL, p_actor, v_name, 'packaging_started', 'ok', NULL, NULL, NULL, '{}'::jsonb);
  RETURN jsonb_build_object('ok', TRUE, 'changed', TRUE, 'status', 'packing');
END;
$$;
ALTER FUNCTION public.start_order_packaging(UUID, UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.start_order_packaging(UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.start_order_packaging(UUID, UUID, UUID) TO service_role;
