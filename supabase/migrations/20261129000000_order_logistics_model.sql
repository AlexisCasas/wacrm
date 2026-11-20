-- ============================================================
-- 20261129000000_order_logistics_model
--
-- PR-04 (Voucher + OCR + validacion + embalaje + evidencia + plantilla operativa) · STAGE 1/2: DATA MODEL ONLY.
-- Purely additive: five NEW tables, their constraints, indexes and guard triggers. No existing table, column, policy, function or
-- migration is altered. Inert until an account has order_integration_settings.logistics_mvp_enabled = TRUE (nothing here activates any account).
-- Security (helpers, RLS, RPCs) lives in 20261129000001; the private bucket in 20261129000002.
--
--   1. order_logistics_settings     per-account PR-04 configuration (operational template to send). No functional value is hardcoded.
--   2. order_documents              vouchers and (chat) evidence snapshots of an order. One row per file. Private storage reference.
--   3. order_template_dispatches    DURABLE, IDEMPOTENT operational state of the operational WhatsApp template send (mutable on purpose).
--   4. order_logistics              logistic axis of an order, 1 row per order. NO ROW = pending_voucher (no backfill, no hook in order creation).
--   5. order_logistics_events       append-only audit (who / what / which order / when / result). Never used as operational state.
--
-- Visible logistic status (order_logistics.status):  pending_voucher -> voucher_validated -> packing -> ready_for_dispatch.
-- Technical internals (never a visible order status): documents.ocr_status / status / association, dispatches.status.
-- NOT touched: order_confirmations.delivery_status (WACRM -> InkaClick outbox), conversation_routing (PR-03), financial axis (PR-06),
-- Shalom tracking (PR-05).
--
-- Every row of every table carries account_id; the order, the documents, the dispatches and the source chat message are cross-checked against it
-- by guard triggers (so a bug in any writer still cannot link rows of two accounts). The order id is the ONLY functional key to the order;
-- DNI / phone / name / amount are matching signals and are never keys.
-- ============================================================

-- ---------------------------------------------------------------
-- 1. order_logistics_settings
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.order_logistics_settings (
  account_id UUID PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  -- The operational template is resolved from the EXISTING message_templates of the account. Nothing is defaulted here.
  packaging_template_name TEXT,
  packaging_template_language TEXT,
  -- Ordered list of order fields that fill the template body variables {{1}}, {{2}}, ... (e.g. ["customer_name","product"]); resolved in code.
  packaging_template_params JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  CONSTRAINT order_logistics_settings_template_pair CHECK ((packaging_template_name IS NULL) = (packaging_template_language IS NULL)),
  CONSTRAINT order_logistics_settings_template_form CHECK (
    packaging_template_name IS NULL
    OR (btrim(packaging_template_name) <> '' AND char_length(packaging_template_name) <= 512 AND btrim(packaging_template_language) <> '' AND char_length(packaging_template_language) <= 20)
  ),
  CONSTRAINT order_logistics_settings_params_form CHECK (
    packaging_template_params IS NULL
    OR (jsonb_typeof(packaging_template_params) = 'array' AND jsonb_array_length(packaging_template_params) <= 20)
  )
);
COMMENT ON TABLE public.order_logistics_settings IS
  'PR-04 per-account configuration. Absent row / NULL template = the operational template is not configured yet (sending is refused, nothing hardcoded).';

-- ---------------------------------------------------------------
-- 2. order_documents
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.order_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  -- NULL only while a bulk-uploaded voucher is "pending association" (association = 'pending').
  order_id UUID,
  kind TEXT NOT NULL,
  -- Technical document lifecycle: vouchers pending_review -> validated | rejected, validated -> superseded; evidence active -> superseded.
  status TEXT NOT NULL,
  association TEXT NOT NULL,
  -- Per (order, kind), assigned when a voucher becomes the validated one (new legitimate version = version + 1; the old one is superseded, kept).
  version INTEGER,
  -- Optimistic concurrency for review actions.
  row_version INTEGER NOT NULL DEFAULT 1,
  -- Groups the documents of one bulk upload (no batch table: resumable by querying this column).
  batch_id UUID,
  request_key TEXT NOT NULL,

  storage_bucket TEXT NOT NULL DEFAULT 'order-docs',
  storage_path TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  content_hash TEXT NOT NULL,
  source TEXT NOT NULL,
  -- Evidence snapshots only: the chat message the file was taken from (never moved or deleted there).
  source_message_id UUID REFERENCES public.messages(id) ON DELETE SET NULL,

  -- OCR: ocr_result is the LAST normalized result (the contract of its fields is intentionally not frozen: no real samples yet).
  -- Every attempt is audited in order_logistics_events.
  ocr_status TEXT NOT NULL DEFAULT 'none',
  ocr_attempts INTEGER NOT NULL DEFAULT 0,
  ocr_claimed_at TIMESTAMPTZ,
  ocr_provider TEXT,
  ocr_result JSONB,
  ocr_error_code TEXT,
  -- Human-corrected / accepted data. Never overwrites ocr_result.
  reviewed_data JSONB,
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  validated_by UUID,
  validated_at TIMESTAMPTZ,

  uploaded_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Composite FK: the database itself refuses a document whose account differs from its order's account (MATCH SIMPLE: skipped while order_id IS NULL).
  CONSTRAINT order_documents_order_fk FOREIGN KEY (order_id, account_id) REFERENCES public.order_confirmations (id, account_id) ON DELETE CASCADE,
  CONSTRAINT order_documents_request_key UNIQUE (account_id, request_key),
  CONSTRAINT order_documents_request_key_form CHECK (btrim(request_key) <> '' AND char_length(request_key) <= 100),
  CONSTRAINT order_documents_kind_check CHECK (kind IN ('voucher', 'evidence')),
  CONSTRAINT order_documents_status_check CHECK (status IN ('pending_review', 'validated', 'rejected', 'superseded', 'active')),
  CONSTRAINT order_documents_association_check CHECK (association IN ('direct', 'auto', 'manual', 'pending')),
  CONSTRAINT order_documents_source_check CHECK (source IN ('upload', 'chat_message')),
  CONSTRAINT order_documents_ocr_status_check CHECK (ocr_status IN ('none', 'pending', 'done', 'failed')),
  -- Pending association <=> no order yet.
  CONSTRAINT order_documents_association_order CHECK ((association = 'pending') = (order_id IS NULL)),
  -- Vouchers come from an upload; evidence (PR-04) only from the order's own chat and always belongs to an order.
  CONSTRAINT order_documents_voucher_shape CHECK (
    kind <> 'voucher' OR (source = 'upload' AND status IN ('pending_review', 'validated', 'rejected', 'superseded'))
  ),
  CONSTRAINT order_documents_evidence_shape CHECK (
    kind <> 'evidence' OR (source = 'chat_message' AND order_id IS NOT NULL AND association = 'direct' AND status IN ('active', 'superseded'))
  ),
  CONSTRAINT order_documents_validated_shape CHECK (
    status <> 'validated' OR (order_id IS NOT NULL AND validated_by IS NOT NULL AND validated_at IS NOT NULL AND version IS NOT NULL AND reviewed_data IS NOT NULL)
  ),
  CONSTRAINT order_documents_bucket_check CHECK (storage_bucket = 'order-docs'),
  CONSTRAINT order_documents_path_check CHECK (starts_with(storage_path, 'account-' || account_id::text || '/') AND char_length(storage_path) <= 600),
  CONSTRAINT order_documents_file_check CHECK (
    btrim(original_filename) <> '' AND char_length(original_filename) <= 200
    AND btrim(mime_type) <> '' AND char_length(mime_type) <= 100
    AND size_bytes > 0 AND size_bytes <= 20971520
    AND content_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT order_documents_ocr_check CHECK (
    ocr_attempts >= 0
    AND (ocr_result IS NULL OR (jsonb_typeof(ocr_result) = 'object' AND octet_length(ocr_result::text) <= 20000))
    AND (reviewed_data IS NULL OR (jsonb_typeof(reviewed_data) = 'object' AND octet_length(reviewed_data::text) <= 20000))
    AND (ocr_error_code IS NULL OR ocr_error_code ~ '^[a-z0-9_]{1,40}$')
    AND (ocr_provider IS NULL OR ocr_provider ~ '^[a-z0-9_.-]{1,40}$')
  ),
  CONSTRAINT order_documents_version_check CHECK (version IS NULL OR version >= 1)
);

-- At most ONE validated voucher and ONE active evidence per order; a version number is never reused.
CREATE UNIQUE INDEX IF NOT EXISTS order_documents_one_validated_voucher
  ON public.order_documents (order_id) WHERE kind = 'voucher' AND status = 'validated';
CREATE UNIQUE INDEX IF NOT EXISTS order_documents_one_active_evidence
  ON public.order_documents (order_id) WHERE kind = 'evidence' AND status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS order_documents_version_unique
  ON public.order_documents (order_id, kind, version) WHERE version IS NOT NULL;
CREATE INDEX IF NOT EXISTS order_documents_order_idx ON public.order_documents (order_id, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS order_documents_batch_idx ON public.order_documents (account_id, batch_id, created_at) WHERE batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS order_documents_hash_idx ON public.order_documents (account_id, content_hash);
CREATE INDEX IF NOT EXISTS order_documents_pending_idx ON public.order_documents (account_id, created_at DESC) WHERE association = 'pending' AND status = 'pending_review';

-- ---------------------------------------------------------------
-- 3. order_template_dispatches
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.order_template_dispatches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  order_id UUID NOT NULL,
  -- Same request_key = same operation (double click, HTTP retry). A legitimate future send uses a NEW key.
  request_key TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  -- claimed -> sending -> sent | failed | uncertain ; failed -> claimed (retry, attempt + 1) ; uncertain -> sent | failed (manual resolution only).
  status TEXT NOT NULL DEFAULT 'claimed',
  evidence_document_id UUID NOT NULL REFERENCES public.order_documents(id),
  conversation_id UUID REFERENCES public.conversations(id) ON DELETE SET NULL,
  template_name TEXT NOT NULL,
  template_language TEXT NOT NULL,
  actor_user_id UUID NOT NULL,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sending_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  -- messages.id of the persisted outbound message (same conversation) and Meta's wamid, when they exist.
  message_row_id UUID REFERENCES public.messages(id) ON DELETE SET NULL,
  wamid TEXT,
  error_code TEXT,
  -- Sanitized by the application: never a name, DNI, phone or token.
  error_detail TEXT,
  resolution TEXT,
  resolved_by UUID,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT order_template_dispatches_order_fk FOREIGN KEY (order_id, account_id) REFERENCES public.order_confirmations (id, account_id) ON DELETE CASCADE,
  CONSTRAINT order_template_dispatches_request_key UNIQUE (account_id, order_id, request_key),
  CONSTRAINT order_template_dispatches_request_key_form CHECK (btrim(request_key) <> '' AND char_length(request_key) <= 100),
  CONSTRAINT order_template_dispatches_status_check CHECK (status IN ('claimed', 'sending', 'sent', 'failed', 'uncertain')),
  CONSTRAINT order_template_dispatches_attempt_check CHECK (attempt >= 1),
  CONSTRAINT order_template_dispatches_resolution_check CHECK (resolution IS NULL OR resolution IN ('confirmed_sent', 'confirmed_not_sent')),
  CONSTRAINT order_template_dispatches_sent_shape CHECK (status <> 'sent' OR wamid IS NOT NULL OR resolution = 'confirmed_sent'),
  CONSTRAINT order_template_dispatches_error_check CHECK (
    (error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,40}$') AND (error_detail IS NULL OR char_length(error_detail) <= 300)
  ),
  CONSTRAINT order_template_dispatches_form CHECK (btrim(template_name) <> '' AND btrim(template_language) <> '')
);
CREATE UNIQUE INDEX IF NOT EXISTS order_template_dispatches_attempt_unique ON public.order_template_dispatches (order_id, request_key, attempt);
-- ONE unresolved dispatch per order: a double click, a second operator or a retry can never run two sends at once, and an `uncertain`
-- dispatch blocks any further send until a person resolves it.
CREATE UNIQUE INDEX IF NOT EXISTS order_template_dispatches_one_open
  ON public.order_template_dispatches (order_id) WHERE status IN ('claimed', 'sending', 'uncertain');
-- A given wamid belongs to a single dispatch.
CREATE UNIQUE INDEX IF NOT EXISTS order_template_dispatches_wamid_unique ON public.order_template_dispatches (wamid) WHERE wamid IS NOT NULL;
CREATE INDEX IF NOT EXISTS order_template_dispatches_order_idx ON public.order_template_dispatches (order_id, created_at DESC);

-- ---------------------------------------------------------------
-- 4. order_logistics
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.order_logistics (
  order_id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  voucher_document_id UUID REFERENCES public.order_documents(id),
  validated_at TIMESTAMPTZ,
  validated_by UUID,
  evidence_document_id UUID REFERENCES public.order_documents(id),
  packaging_started_at TIMESTAMPTZ,
  packaging_started_by UUID,
  packaging_completed_at TIMESTAMPTZ,
  packaging_completed_by UUID,
  completed_dispatch_id UUID REFERENCES public.order_template_dispatches(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT order_logistics_order_fk FOREIGN KEY (order_id, account_id) REFERENCES public.order_confirmations (id, account_id) ON DELETE CASCADE,
  CONSTRAINT order_logistics_status_check CHECK (status IN ('pending_voucher', 'voucher_validated', 'packing', 'ready_for_dispatch')),
  CONSTRAINT order_logistics_version_check CHECK (version >= 1),
  CONSTRAINT order_logistics_status_shape CHECK (
    (status = 'pending_voucher' AND voucher_document_id IS NULL AND evidence_document_id IS NULL AND packaging_started_at IS NULL AND packaging_completed_at IS NULL AND completed_dispatch_id IS NULL)
    OR (status = 'voucher_validated' AND voucher_document_id IS NOT NULL AND validated_at IS NOT NULL AND evidence_document_id IS NULL AND packaging_started_at IS NULL AND packaging_completed_at IS NULL AND completed_dispatch_id IS NULL)
    OR (status = 'packing' AND voucher_document_id IS NOT NULL AND packaging_started_at IS NOT NULL AND packaging_completed_at IS NULL AND completed_dispatch_id IS NULL)
    OR (status = 'ready_for_dispatch' AND voucher_document_id IS NOT NULL AND evidence_document_id IS NOT NULL AND packaging_started_at IS NOT NULL
        AND packaging_completed_at IS NOT NULL AND packaging_completed_by IS NOT NULL AND completed_dispatch_id IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS order_logistics_account_status_idx ON public.order_logistics (account_id, status, updated_at DESC);

-- ---------------------------------------------------------------
-- 5. order_logistics_events (append-only audit)
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.order_logistics_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  -- NULL only for events of a not-yet-associated bulk document.
  order_id UUID,
  -- Plain references (no FK on purpose: the audit is append-only and must never block, or be shaped by, the rows it describes).
  document_id UUID,
  dispatch_id UUID,
  event_type TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'ok',
  attempt INTEGER,
  error_code TEXT,
  provider TEXT,
  -- No sensitive data: no DNI, phone, name, voucher content or tokens. Field NAMES / counts / codes only.
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- No FK to auth.users on purpose (the audit survives the user), same as conversation_routing_events.
  actor_user_id UUID,
  actor_name TEXT NOT NULL DEFAULT 'unknown',
  -- clock_timestamp(): strict ordering of events even inside one transaction.
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT order_logistics_events_order_fk FOREIGN KEY (order_id, account_id) REFERENCES public.order_confirmations (id, account_id) ON DELETE CASCADE,
  CONSTRAINT order_logistics_events_type_check CHECK (event_type IN (
    'voucher_uploaded', 'voucher_associated', 'ocr_started', 'ocr_completed', 'ocr_failed',
    'voucher_corrected', 'voucher_validated', 'voucher_rejected', 'voucher_superseded',
    'packaging_started', 'evidence_selected',
    'template_send_started', 'template_sent', 'template_failed', 'template_uncertain', 'template_resolved',
    'packaging_completed'
  )),
  CONSTRAINT order_logistics_events_outcome_check CHECK (outcome IN ('ok', 'error')),
  CONSTRAINT order_logistics_events_shape CHECK (
    (error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,40}$')
    AND (provider IS NULL OR provider ~ '^[a-z0-9_.-]{1,40}$')
    AND jsonb_typeof(detail) = 'object' AND octet_length(detail::text) <= 2000
  )
);
CREATE INDEX IF NOT EXISTS order_logistics_events_order_idx ON public.order_logistics_events (order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS order_logistics_events_document_idx ON public.order_logistics_events (document_id, created_at DESC) WHERE document_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS order_logistics_events_account_idx ON public.order_logistics_events (account_id, created_at DESC);

-- ============================================================
-- GUARD TRIGGERS
-- ============================================================

-- History is protected: a row of the PR-04 tables can only disappear when its parent is already gone (FK cascade from the order or the
-- account). A direct DELETE is always rejected. (Plain function, shared by the trigger functions below: a trigger function cannot be called directly.)
CREATE OR REPLACE FUNCTION public.order_logistics_history_protected(p_account UUID, p_order UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = p_account)
     AND (p_order IS NULL OR EXISTS (SELECT 1 FROM public.order_confirmations o WHERE o.id = p_order))
$$;
ALTER FUNCTION public.order_logistics_history_protected(UUID, UUID) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.order_logistics_delete_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF public.order_logistics_history_protected(OLD.account_id, (to_jsonb(OLD) ->> 'order_id')::uuid) THEN
    RAISE EXCEPTION '% rows cannot be deleted', TG_TABLE_NAME USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END;
$$;
ALTER FUNCTION public.order_logistics_delete_guard() OWNER TO postgres;

-- order_logistics_events: append-only.
CREATE OR REPLACE FUNCTION public.order_logistics_events_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'order_logistics_events is append-only' USING ERRCODE = '42501';
  END IF;
  IF public.order_logistics_history_protected(OLD.account_id, OLD.order_id) THEN
    RAISE EXCEPTION 'order_logistics_events rows cannot be deleted' USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END;
$$;
ALTER FUNCTION public.order_logistics_events_guard() OWNER TO postgres;

DROP TRIGGER IF EXISTS order_logistics_events_guard ON public.order_logistics_events;
CREATE TRIGGER order_logistics_events_guard
  BEFORE UPDATE OR DELETE ON public.order_logistics_events
  FOR EACH ROW EXECUTE FUNCTION public.order_logistics_events_guard();

-- The audit row must reference an order of the SAME account.
CREATE OR REPLACE FUNCTION public.order_logistics_events_insert_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.order_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.order_confirmations o WHERE o.id = NEW.order_id AND o.account_id = NEW.account_id) THEN
    RAISE EXCEPTION 'order does not belong to the account' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.order_logistics_events_insert_guard() OWNER TO postgres;

DROP TRIGGER IF EXISTS order_logistics_events_insert_guard ON public.order_logistics_events;
CREATE TRIGGER order_logistics_events_insert_guard
  BEFORE INSERT ON public.order_logistics_events
  FOR EACH ROW EXECUTE FUNCTION public.order_logistics_events_insert_guard();

-- order_documents: same-account links, immutable identity, frozen once validated / rejected / superseded.
CREATE OR REPLACE FUNCTION public.order_documents_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_order_account UUID;
  v_order_conversation UUID;
  v_msg_account UUID;
  v_msg_conversation UUID;
  v_identity TEXT[] := ARRAY['id', 'account_id', 'kind', 'request_key', 'storage_bucket', 'storage_path', 'original_filename', 'mime_type',
                             'size_bytes', 'content_hash', 'source', 'uploaded_by', 'batch_id', 'created_at'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.order_id IS NOT NULL THEN
      SELECT o.account_id, o.conversation_id INTO v_order_account, v_order_conversation FROM public.order_confirmations o WHERE o.id = NEW.order_id;
      IF v_order_account IS DISTINCT FROM NEW.account_id THEN
        RAISE EXCEPTION 'order does not belong to the account' USING ERRCODE = '42501';
      END IF;
    END IF;
    IF NEW.source_message_id IS NOT NULL THEN
      SELECT c.account_id, c.id INTO v_msg_account, v_msg_conversation
        FROM public.messages m JOIN public.conversations c ON c.id = m.conversation_id WHERE m.id = NEW.source_message_id;
      IF v_msg_account IS DISTINCT FROM NEW.account_id OR v_msg_conversation IS DISTINCT FROM v_order_conversation THEN
        RAISE EXCEPTION 'message is not part of the order conversation' USING ERRCODE = '42501';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE ------------------------------------------------------
  IF (SELECT jsonb_object_agg(k, to_jsonb(NEW) -> k) FROM unnest(v_identity) k)
     IS DISTINCT FROM (SELECT jsonb_object_agg(k, to_jsonb(OLD) -> k) FROM unnest(v_identity) k) THEN
    RAISE EXCEPTION 'document identity is immutable' USING ERRCODE = '42501';
  END IF;
  -- source_message_id may only go to NULL (the chat message was deleted), never be re-pointed.
  IF NEW.source_message_id IS DISTINCT FROM OLD.source_message_id AND NEW.source_message_id IS NOT NULL THEN
    RAISE EXCEPTION 'document identity is immutable' USING ERRCODE = '42501';
  END IF;

  IF OLD.status IN ('validated', 'rejected', 'superseded', 'active') THEN
    -- Frozen: only the status may move (validated|active -> superseded), plus bookkeeping.
    IF (to_jsonb(NEW) - 'status' - 'row_version' - 'updated_at' - 'source_message_id')
       IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'row_version' - 'updated_at' - 'source_message_id') THEN
      RAISE EXCEPTION 'a validated, rejected or superseded document is frozen' USING ERRCODE = '42501';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status IN ('validated', 'active') AND NEW.status = 'superseded') THEN
      RAISE EXCEPTION 'illegal document status transition % -> %', OLD.status, NEW.status USING ERRCODE = '22023';
    END IF;
  ELSE
    -- pending_review: free to be reviewed / re-associated, may become validated or rejected only.
    IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status NOT IN ('validated', 'rejected') THEN
      RAISE EXCEPTION 'illegal document status transition % -> %', OLD.status, NEW.status USING ERRCODE = '22023';
    END IF;
    IF NEW.order_id IS DISTINCT FROM OLD.order_id AND NEW.order_id IS NOT NULL THEN
      SELECT o.account_id INTO v_order_account FROM public.order_confirmations o WHERE o.id = NEW.order_id;
      IF v_order_account IS DISTINCT FROM NEW.account_id THEN
        RAISE EXCEPTION 'order does not belong to the account' USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status OR NEW.order_id IS DISTINCT FROM OLD.order_id OR NEW.reviewed_data IS DISTINCT FROM OLD.reviewed_data THEN
    NEW.row_version := OLD.row_version + 1;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.order_documents_guard() OWNER TO postgres;

DROP TRIGGER IF EXISTS order_documents_guard ON public.order_documents;
CREATE TRIGGER order_documents_guard
  BEFORE INSERT OR UPDATE ON public.order_documents
  FOR EACH ROW EXECUTE FUNCTION public.order_documents_guard();

DROP TRIGGER IF EXISTS order_documents_delete_guard ON public.order_documents;
CREATE TRIGGER order_documents_delete_guard
  BEFORE DELETE ON public.order_documents
  FOR EACH ROW EXECUTE FUNCTION public.order_logistics_delete_guard();

-- order_template_dispatches: same-account links, immutable identity, legal status transitions only.
CREATE OR REPLACE FUNCTION public.order_template_dispatches_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_order_account UUID;
  v_order_conversation UUID;
  v_doc RECORD;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT o.account_id, o.conversation_id INTO v_order_account, v_order_conversation FROM public.order_confirmations o WHERE o.id = NEW.order_id;
    IF v_order_account IS DISTINCT FROM NEW.account_id THEN
      RAISE EXCEPTION 'order does not belong to the account' USING ERRCODE = '42501';
    END IF;
    SELECT d.account_id, d.order_id, d.kind, d.status INTO v_doc FROM public.order_documents d WHERE d.id = NEW.evidence_document_id;
    IF v_doc.account_id IS DISTINCT FROM NEW.account_id OR v_doc.order_id IS DISTINCT FROM NEW.order_id
       OR v_doc.kind IS DISTINCT FROM 'evidence' OR v_doc.status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'evidence does not belong to the order' USING ERRCODE = '42501';
    END IF;
    IF NEW.conversation_id IS DISTINCT FROM v_order_conversation THEN
      RAISE EXCEPTION 'dispatch must use the order conversation' USING ERRCODE = '42501';
    END IF;
    IF NEW.status <> 'claimed' THEN
      RAISE EXCEPTION 'a dispatch starts as claimed' USING ERRCODE = '22023';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.request_key IS DISTINCT FROM OLD.request_key OR NEW.evidence_document_id IS DISTINCT FROM OLD.evidence_document_id
     OR NEW.template_name IS DISTINCT FROM OLD.template_name OR NEW.template_language IS DISTINCT FROM OLD.template_language
     OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (NEW.conversation_id IS DISTINCT FROM OLD.conversation_id AND NEW.conversation_id IS NOT NULL)
     OR (NEW.message_row_id IS DISTINCT FROM OLD.message_row_id AND OLD.message_row_id IS NOT NULL AND NEW.message_row_id IS NOT NULL)
     OR (NEW.wamid IS DISTINCT FROM OLD.wamid AND OLD.wamid IS NOT NULL) THEN
    RAISE EXCEPTION 'dispatch identity is immutable' USING ERRCODE = '42501';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      (OLD.status = 'claimed' AND NEW.status IN ('sending', 'failed'))
      OR (OLD.status = 'sending' AND NEW.status IN ('sent', 'failed', 'uncertain'))
      OR (OLD.status = 'uncertain' AND NEW.status IN ('sent', 'failed') AND NEW.resolution IS NOT NULL AND NEW.resolved_by IS NOT NULL)
      OR (OLD.status = 'failed' AND NEW.status = 'claimed' AND NEW.attempt = OLD.attempt + 1)
    ) THEN
      RAISE EXCEPTION 'illegal dispatch status transition % -> %', OLD.status, NEW.status USING ERRCODE = '22023';
    END IF;
  ELSIF OLD.status = 'sent' THEN
    RAISE EXCEPTION 'a sent dispatch is final' USING ERRCODE = '42501';
  ELSIF NEW.attempt IS DISTINCT FROM OLD.attempt THEN
    RAISE EXCEPTION 'attempt only changes on a retry' USING ERRCODE = '22023';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.order_template_dispatches_guard() OWNER TO postgres;

DROP TRIGGER IF EXISTS order_template_dispatches_guard ON public.order_template_dispatches;
CREATE TRIGGER order_template_dispatches_guard
  BEFORE INSERT OR UPDATE ON public.order_template_dispatches
  FOR EACH ROW EXECUTE FUNCTION public.order_template_dispatches_guard();

DROP TRIGGER IF EXISTS order_template_dispatches_delete_guard ON public.order_template_dispatches;
CREATE TRIGGER order_template_dispatches_delete_guard
  BEFORE DELETE ON public.order_template_dispatches
  FOR EACH ROW EXECUTE FUNCTION public.order_logistics_delete_guard();

-- order_logistics: same-account order, referenced rows really belong to the order, forward-only status, frozen at ready_for_dispatch.
CREATE OR REPLACE FUNCTION public.order_logistics_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_order_account UUID;
  v_doc RECORD;
  v_dispatch RECORD;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT o.account_id INTO v_order_account FROM public.order_confirmations o WHERE o.id = NEW.order_id;
    IF v_order_account IS DISTINCT FROM NEW.account_id THEN
      RAISE EXCEPTION 'order does not belong to the account' USING ERRCODE = '42501';
    END IF;
  ELSE
    IF NEW.order_id IS DISTINCT FROM OLD.order_id OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'order_logistics identity is immutable' USING ERRCODE = '42501';
    END IF;
    IF OLD.status = 'ready_for_dispatch' THEN
      RAISE EXCEPTION 'a ready_for_dispatch order is final for PR-04' USING ERRCODE = '42501';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
      (OLD.status = 'pending_voucher' AND NEW.status = 'voucher_validated')
      OR (OLD.status = 'voucher_validated' AND NEW.status = 'packing')
      OR (OLD.status = 'packing' AND NEW.status = 'ready_for_dispatch')
    ) THEN
      RAISE EXCEPTION 'illegal logistics status transition % -> %', OLD.status, NEW.status USING ERRCODE = '22023';
    END IF;
    IF OLD.status IN ('packing') AND NEW.voucher_document_id IS DISTINCT FROM OLD.voucher_document_id THEN
      RAISE EXCEPTION 'the voucher is frozen once packaging started' USING ERRCODE = '22023';
    END IF;
    IF NEW.version <= OLD.version THEN
      RAISE EXCEPTION 'version must increase' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF NEW.voucher_document_id IS NOT NULL THEN
    SELECT d.account_id, d.order_id, d.kind, d.status INTO v_doc FROM public.order_documents d WHERE d.id = NEW.voucher_document_id;
    IF v_doc.account_id IS DISTINCT FROM NEW.account_id OR v_doc.order_id IS DISTINCT FROM NEW.order_id
       OR v_doc.kind IS DISTINCT FROM 'voucher' OR v_doc.status IS DISTINCT FROM 'validated' THEN
      RAISE EXCEPTION 'voucher does not belong to the order or is not validated' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF NEW.evidence_document_id IS NOT NULL THEN
    SELECT d.account_id, d.order_id, d.kind, d.status INTO v_doc FROM public.order_documents d WHERE d.id = NEW.evidence_document_id;
    IF v_doc.account_id IS DISTINCT FROM NEW.account_id OR v_doc.order_id IS DISTINCT FROM NEW.order_id
       OR v_doc.kind IS DISTINCT FROM 'evidence' OR v_doc.status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'evidence does not belong to the order' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF NEW.completed_dispatch_id IS NOT NULL THEN
    SELECT t.account_id, t.order_id, t.status INTO v_dispatch FROM public.order_template_dispatches t WHERE t.id = NEW.completed_dispatch_id;
    IF v_dispatch.account_id IS DISTINCT FROM NEW.account_id OR v_dispatch.order_id IS DISTINCT FROM NEW.order_id OR v_dispatch.status IS DISTINCT FROM 'sent' THEN
      RAISE EXCEPTION 'dispatch does not belong to the order or was not sent' USING ERRCODE = '42501';
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.order_logistics_guard() OWNER TO postgres;

DROP TRIGGER IF EXISTS order_logistics_guard ON public.order_logistics;
CREATE TRIGGER order_logistics_guard
  BEFORE INSERT OR UPDATE ON public.order_logistics
  FOR EACH ROW EXECUTE FUNCTION public.order_logistics_guard();

DROP TRIGGER IF EXISTS order_logistics_delete_guard ON public.order_logistics;
CREATE TRIGGER order_logistics_delete_guard
  BEFORE DELETE ON public.order_logistics
  FOR EACH ROW EXECUTE FUNCTION public.order_logistics_delete_guard();

-- Row-level security is ENABLED here (deny by default, even for a role that was granted something by mistake); the policies, grants and the
-- access helper are defined in the next migration. Until then no browser role can read or write any of these tables.
ALTER TABLE public.order_logistics_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_template_dispatches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_logistics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_logistics_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.order_logistics_settings, public.order_documents, public.order_template_dispatches, public.order_logistics, public.order_logistics_events
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.order_logistics_settings, public.order_documents, public.order_template_dispatches, public.order_logistics, public.order_logistics_events
  TO service_role;
