-- ============================================================
-- 076_audio_guide_selection
--
-- "Audios por producto", selection: classify each audio of a product by PURPOSE (Provincia, Pago, ...) and IDENTIFIER (Principal, ...), so a
-- Flow node can send ONE named audio instead of the whole sequence. Purposes and identifiers are managed per account; everything refers to them by
-- their internal id, never by their visible name, so renaming one breaks nothing.
--
-- PURELY ADDITIVE. No existing row changes meaning and no existing function changes:
--   * every new column is NULL and every new table starts empty: the audios already loaded stay unclassified and keep working exactly as before
--     ("send every active audio" ignores classification);
--   * the functions of 073/074/075 are untouched, so the previous application image keeps working against this schema (image-only rollback);
--   * nothing runs until the application calls the new functions.
--
--   1. audio_guide_purposes       per-account purposes (visible name, normalised key, active)
--   2. audio_guide_identifiers    per-account identifiers (same shape)
--   3. audio_guide_items          + purpose_id, identifier_id (both set or both NULL), same-account composite keys, and ONE unique index:
--                                 (product, purpose, identifier), inactive audios included, so reactivating an audio can never create ambiguity.
--   4. audio_guide_requests       + selection_mode / purpose / identifier / names seen / node_key: what the request asked for (audit; prepares G6)
--   5. Functions (service role only): save/delete purpose and identifier, classify_item, open_selected_request, record_selected_skip.
--
-- Limits kept on purpose: at most 6 audios per product, position 1..6, pause 5..30 s (073). Nothing here widens them.
-- ============================================================

-- ---------------------------------------------------------------
-- 1 + 2. Purposes and identifiers (per account)
-- ---------------------------------------------------------------
CREATE TABLE public.audio_guide_purposes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  -- Visible, editable. The stable reference is `id`.
  name TEXT NOT NULL,
  -- Normalised by the application (lower case, no accents, single spaces): two names that differ only in case, accents or spacing are the same.
  name_key TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT audio_guide_purposes_name_form CHECK (btrim(name) <> '' AND name = btrim(name) AND char_length(name) <= 60),
  CONSTRAINT audio_guide_purposes_key_form CHECK (
    name_key = lower(btrim(name_key)) AND name_key ~ '^[^[:space:]]+( [^[:space:]]+)*$' AND char_length(name_key) <= 60
  ),
  CONSTRAINT audio_guide_purposes_account_key UNIQUE (account_id, name_key),
  CONSTRAINT audio_guide_purposes_id_account_key UNIQUE (id, account_id)
);

CREATE TABLE public.audio_guide_identifiers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT audio_guide_identifiers_name_form CHECK (btrim(name) <> '' AND name = btrim(name) AND char_length(name) <= 60),
  CONSTRAINT audio_guide_identifiers_key_form CHECK (
    name_key = lower(btrim(name_key)) AND name_key ~ '^[^[:space:]]+( [^[:space:]]+)*$' AND char_length(name_key) <= 60
  ),
  CONSTRAINT audio_guide_identifiers_account_key UNIQUE (account_id, name_key),
  CONSTRAINT audio_guide_identifiers_id_account_key UNIQUE (id, account_id)
);

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.audio_guide_purposes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.audio_guide_identifiers
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---------------------------------------------------------------
-- 3. Classification of the audios
-- ---------------------------------------------------------------
ALTER TABLE public.audio_guide_items ADD COLUMN purpose_id UUID;
ALTER TABLE public.audio_guide_items ADD COLUMN identifier_id UUID;

-- Composite keys: the reference can only point at a purpose / identifier of the SAME account as the audio (the audio is already tied to its
-- product by audio_guide_items_product_fkey). RESTRICT: a purpose or identifier in use cannot be deleted.
ALTER TABLE public.audio_guide_items ADD CONSTRAINT audio_guide_items_purpose_fkey
  FOREIGN KEY (purpose_id, account_id) REFERENCES public.audio_guide_purposes (id, account_id) ON DELETE RESTRICT;
ALTER TABLE public.audio_guide_items ADD CONSTRAINT audio_guide_items_identifier_fkey
  FOREIGN KEY (identifier_id, account_id) REFERENCES public.audio_guide_identifiers (id, account_id) ON DELETE RESTRICT;
-- An audio is classified by purpose AND identifier, or by neither.
ALTER TABLE public.audio_guide_items ADD CONSTRAINT audio_guide_items_classified_both
  CHECK ((purpose_id IS NULL) = (identifier_id IS NULL));

-- Product + purpose + identifier identify ONE audio, active or not (an inactive audio keeps its place: reactivating it cannot create ambiguity).
CREATE UNIQUE INDEX audio_guide_items_classification_key
  ON public.audio_guide_items (product_id, purpose_id, identifier_id) WHERE purpose_id IS NOT NULL;

-- ---------------------------------------------------------------
-- 4. What a request asked for (audit; also what a later "one sequence per attention" rule will need)
-- ---------------------------------------------------------------
ALTER TABLE public.audio_guide_requests ADD COLUMN selection_mode TEXT;
ALTER TABLE public.audio_guide_requests ADD COLUMN purpose_id UUID;
ALTER TABLE public.audio_guide_requests ADD COLUMN identifier_id UUID;
ALTER TABLE public.audio_guide_requests ADD COLUMN purpose_name TEXT;
ALTER TABLE public.audio_guide_requests ADD COLUMN identifier_name TEXT;
ALTER TABLE public.audio_guide_requests ADD COLUMN node_key TEXT;

-- NULL selection_mode means "every active audio" (every request that exists today).
ALTER TABLE public.audio_guide_requests ADD CONSTRAINT audio_guide_requests_selection_mode CHECK (selection_mode IS NULL OR selection_mode = 'single');
ALTER TABLE public.audio_guide_requests ADD CONSTRAINT audio_guide_requests_selection_text CHECK (
  (purpose_name IS NULL OR char_length(purpose_name) <= 60)
  AND (identifier_name IS NULL OR char_length(identifier_name) <= 60)
  AND (node_key IS NULL OR char_length(node_key) <= 120)
);
-- The names are a copy taken at the time, so the history survives a rename or a deletion; the ids are cleared if the row is deleted.
ALTER TABLE public.audio_guide_requests ADD CONSTRAINT audio_guide_requests_purpose_fkey
  FOREIGN KEY (purpose_id, account_id) REFERENCES public.audio_guide_purposes (id, account_id) ON DELETE SET NULL (purpose_id);
ALTER TABLE public.audio_guide_requests ADD CONSTRAINT audio_guide_requests_identifier_fkey
  FOREIGN KEY (identifier_id, account_id) REFERENCES public.audio_guide_identifiers (id, account_id) ON DELETE SET NULL (identifier_id);

-- ---------------------------------------------------------------
-- RLS and grants: members read their own account; the server writes (same as the rest of the catalog).
-- ---------------------------------------------------------------
ALTER TABLE public.audio_guide_purposes    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audio_guide_identifiers ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.audio_guide_purposes    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.audio_guide_identifiers FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.audio_guide_purposes    TO authenticated;
GRANT SELECT ON TABLE public.audio_guide_identifiers TO authenticated;
GRANT ALL ON TABLE public.audio_guide_purposes    TO service_role;
GRANT ALL ON TABLE public.audio_guide_identifiers TO service_role;

CREATE POLICY audio_guide_purposes_select ON public.audio_guide_purposes
  FOR SELECT USING (public.is_account_member(account_id));
CREATE POLICY audio_guide_identifiers_select ON public.audio_guide_identifiers
  FOR SELECT USING (public.is_account_member(account_id));

-- ---------------------------------------------------------------
-- 5. Functions. SECURITY INVOKER + service role only, like 074/075: the API checks the caller's role first and passes the session's account.
-- ---------------------------------------------------------------

-- Create (p_id NULL) or change (rename and/or switch on/off) a purpose. Names are 1..60 characters; at most 50 purposes per account.
CREATE FUNCTION public.audio_guide_save_purpose(
  p_account UUID, p_id UUID, p_name TEXT DEFAULT NULL, p_name_key TEXT DEFAULT NULL, p_active BOOLEAN DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  IF (p_name IS NULL) <> (p_name_key IS NULL) THEN RETURN jsonb_build_object('ok', false, 'reason', 'invalid_value'); END IF;
  BEGIN
    IF p_id IS NULL THEN
      IF p_name IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'invalid_value'); END IF;
      PERFORM pg_advisory_xact_lock(hashtextextended('audio_guide_purposes:' || p_account::text, 0));
      IF (SELECT COUNT(*) FROM public.audio_guide_purposes WHERE account_id = p_account) >= 50 THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'limit_reached');
      END IF;
      INSERT INTO public.audio_guide_purposes (account_id, name, name_key, active)
      VALUES (p_account, p_name, p_name_key, COALESCE(p_active, TRUE)) RETURNING id INTO v_id;
    ELSE
      UPDATE public.audio_guide_purposes
         SET name = COALESCE(p_name, name), name_key = COALESCE(p_name_key, name_key), active = COALESCE(p_active, active)
       WHERE id = p_id AND account_id = p_account RETURNING id INTO v_id;
      IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    END IF;
  EXCEPTION
    WHEN unique_violation THEN RETURN jsonb_build_object('ok', false, 'reason', 'duplicate_name');
    WHEN check_violation THEN RETURN jsonb_build_object('ok', false, 'reason', 'invalid_value');
  END;
  RETURN jsonb_build_object('ok', true, 'id', v_id);
END;
$$;

CREATE FUNCTION public.audio_guide_save_identifier(
  p_account UUID, p_id UUID, p_name TEXT DEFAULT NULL, p_name_key TEXT DEFAULT NULL, p_active BOOLEAN DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  IF (p_name IS NULL) <> (p_name_key IS NULL) THEN RETURN jsonb_build_object('ok', false, 'reason', 'invalid_value'); END IF;
  BEGIN
    IF p_id IS NULL THEN
      IF p_name IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'invalid_value'); END IF;
      PERFORM pg_advisory_xact_lock(hashtextextended('audio_guide_identifiers:' || p_account::text, 0));
      IF (SELECT COUNT(*) FROM public.audio_guide_identifiers WHERE account_id = p_account) >= 100 THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'limit_reached');
      END IF;
      INSERT INTO public.audio_guide_identifiers (account_id, name, name_key, active)
      VALUES (p_account, p_name, p_name_key, COALESCE(p_active, TRUE)) RETURNING id INTO v_id;
    ELSE
      UPDATE public.audio_guide_identifiers
         SET name = COALESCE(p_name, name), name_key = COALESCE(p_name_key, name_key), active = COALESCE(p_active, active)
       WHERE id = p_id AND account_id = p_account RETURNING id INTO v_id;
      IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    END IF;
  EXCEPTION
    WHEN unique_violation THEN RETURN jsonb_build_object('ok', false, 'reason', 'duplicate_name');
    WHEN check_violation THEN RETURN jsonb_build_object('ok', false, 'reason', 'invalid_value');
  END;
  RETURN jsonb_build_object('ok', true, 'id', v_id);
END;
$$;

-- Delete only when no audio uses it (RESTRICT turns the attempt into `in_use`; past requests keep the name they saw).
CREATE FUNCTION public.audio_guide_delete_purpose(p_account UUID, p_id UUID) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  BEGIN
    DELETE FROM public.audio_guide_purposes WHERE id = p_id AND account_id = p_account;
  EXCEPTION WHEN foreign_key_violation THEN RETURN jsonb_build_object('ok', false, 'reason', 'in_use');
  END;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  RETURN jsonb_build_object('ok', true);
END;
$$;

CREATE FUNCTION public.audio_guide_delete_identifier(p_account UUID, p_id UUID) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  BEGIN
    DELETE FROM public.audio_guide_identifiers WHERE id = p_id AND account_id = p_account;
  EXCEPTION WHEN foreign_key_violation THEN RETURN jsonb_build_object('ok', false, 'reason', 'in_use');
  END;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- Classify an audio (or clear its classification with both NULL). Same protocol as the other catalog changes: lock the product, refuse a stale
-- revision. Purpose and identifier must be of this account and ACTIVE when they change; keeping the ones the audio already has is always allowed.
CREATE FUNCTION public.audio_guide_classify_item(
  p_account UUID, p_item UUID, p_expected INTEGER, p_purpose UUID, p_identifier UUID
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_product UUID;
  v_old_purpose UUID;
  v_old_identifier UUID;
  v_refusal JSONB;
  v_active BOOLEAN;
  v_conflict UUID;
  v_revision INTEGER;
BEGIN
  SELECT product_id, purpose_id, identifier_id INTO v_product, v_old_purpose, v_old_identifier
    FROM public.audio_guide_items WHERE id = p_item AND account_id = p_account;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  v_refusal := public.audio_guide_lock_product(p_account, v_product, p_expected);
  IF v_refusal IS NOT NULL THEN RETURN v_refusal; END IF;
  IF (p_purpose IS NULL) <> (p_identifier IS NULL) THEN RETURN jsonb_build_object('ok', false, 'reason', 'invalid_value'); END IF;
  IF p_purpose IS NOT NULL AND p_purpose IS DISTINCT FROM v_old_purpose THEN
    SELECT active INTO v_active FROM public.audio_guide_purposes WHERE id = p_purpose AND account_id = p_account;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'purpose_not_found'); END IF;
    IF NOT v_active THEN RETURN jsonb_build_object('ok', false, 'reason', 'purpose_inactive'); END IF;
  END IF;
  IF p_identifier IS NOT NULL AND p_identifier IS DISTINCT FROM v_old_identifier THEN
    SELECT active INTO v_active FROM public.audio_guide_identifiers WHERE id = p_identifier AND account_id = p_account;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'identifier_not_found'); END IF;
    IF NOT v_active THEN RETURN jsonb_build_object('ok', false, 'reason', 'identifier_inactive'); END IF;
  END IF;
  BEGIN
    UPDATE public.audio_guide_items SET purpose_id = p_purpose, identifier_id = p_identifier WHERE id = p_item AND account_id = p_account;
  EXCEPTION WHEN unique_violation THEN
    SELECT id INTO v_conflict FROM public.audio_guide_items
     WHERE product_id = v_product AND purpose_id = p_purpose AND identifier_id = p_identifier AND id <> p_item;
    RETURN jsonb_build_object('ok', false, 'reason', 'duplicate_classification', 'conflict_item', v_conflict);
  END;
  SELECT revision INTO v_revision FROM public.audio_guide_products WHERE id = v_product;
  RETURN jsonb_build_object('ok', true, 'revision', v_revision);
END;
$$;

-- Like audio_guide_open_request, but the request holds ONE audio: the one classified (purpose, identifier) in the product. Idempotent per trigger
-- (the application passes `<message id>#<node key>`, so two nodes of one Flow do not collide). It re-checks everything atomically; a request is
-- created only when the audio exists, is active and its purpose and identifier are active. Nothing is ever substituted.
CREATE FUNCTION public.audio_guide_open_selected_request(
  p_account UUID, p_contact UUID, p_conversation UUID, p_run UUID, p_trigger TEXT, p_product_key TEXT, p_expected_revision INTEGER,
  p_purpose UUID, p_identifier UUID, p_node_key TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_product public.audio_guide_products%ROWTYPE;
  v_purpose public.audio_guide_purposes%ROWTYPE;
  v_identifier public.audio_guide_identifiers%ROWTYPE;
  v_item public.audio_guide_items%ROWTYPE;
  v_request UUID;
  v_status TEXT;
BEGIN
  SELECT id, status INTO v_request, v_status FROM public.audio_guide_requests WHERE account_id = p_account AND trigger_message_id = p_trigger;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'created', false, 'request_id', v_request, 'status', v_status);
  END IF;
  SELECT * INTO v_product FROM public.audio_guide_products WHERE account_id = p_account AND product_key = p_product_key FOR SHARE;
  IF NOT FOUND OR NOT v_product.active THEN RETURN jsonb_build_object('ok', false, 'reason', 'product_unavailable'); END IF;
  IF p_expected_revision IS NOT NULL AND v_product.revision <> p_expected_revision THEN RETURN jsonb_build_object('ok', false, 'reason', 'catalog_changed'); END IF;
  SELECT * INTO v_purpose FROM public.audio_guide_purposes WHERE id = p_purpose AND account_id = p_account;
  IF NOT FOUND OR NOT v_purpose.active THEN RETURN jsonb_build_object('ok', false, 'reason', 'purpose_unavailable'); END IF;
  SELECT * INTO v_identifier FROM public.audio_guide_identifiers WHERE id = p_identifier AND account_id = p_account;
  IF NOT FOUND OR NOT v_identifier.active THEN RETURN jsonb_build_object('ok', false, 'reason', 'identifier_unavailable'); END IF;
  SELECT * INTO v_item FROM public.audio_guide_items
   WHERE account_id = p_account AND product_id = v_product.id AND purpose_id = p_purpose AND identifier_id = p_identifier;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'audio_not_found'); END IF;
  IF v_item.status <> 'active' THEN RETURN jsonb_build_object('ok', false, 'reason', 'audio_disabled'); END IF;
  BEGIN
    INSERT INTO public.audio_guide_requests (
      account_id, contact_id, conversation_id, flow_run_id, trigger_message_id, product_id, product_key, status,
      selection_mode, purpose_id, identifier_id, purpose_name, identifier_name, node_key
    ) VALUES (
      p_account, p_contact, p_conversation, p_run, p_trigger, v_product.id, v_product.product_key, 'claimed',
      'single', v_purpose.id, v_identifier.id, v_purpose.name, v_identifier.name, left(p_node_key, 120)
    ) RETURNING id INTO v_request;
  EXCEPTION WHEN unique_violation THEN
    SELECT id, status INTO v_request, v_status FROM public.audio_guide_requests WHERE account_id = p_account AND trigger_message_id = p_trigger;
    RETURN jsonb_build_object('ok', true, 'created', false, 'request_id', v_request, 'status', v_status);
  END;
  -- ONE send: position 1, with the audio's own pause before it.
  INSERT INTO public.audio_guide_sends (account_id, request_id, item_id, position, voice_sha256, status, pre_delay_seconds, not_before)
  VALUES (p_account, v_request, v_item.id, 1, v_item.voice_sha256, 'pending', v_item.pre_delay_seconds, NOW() + make_interval(secs => v_item.pre_delay_seconds));
  RETURN jsonb_build_object('ok', true, 'created', true, 'request_id', v_request, 'status', 'claimed', 'sends', 1);
END;
$$;

-- Why nothing was sent for a selection (audio missing or off, purpose/identifier unavailable). Same idempotency as audio_guide_record_skip. The
-- ids are kept only when they exist in this account; the visible names seen at the time are copied.
CREATE FUNCTION public.audio_guide_record_selected_skip(
  p_account UUID, p_contact UUID, p_conversation UUID, p_run UUID, p_trigger TEXT, p_product_key TEXT, p_reason TEXT,
  p_purpose UUID, p_identifier UUID, p_node_key TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_purpose public.audio_guide_purposes%ROWTYPE;
  v_identifier public.audio_guide_identifiers%ROWTYPE;
  v_request UUID;
BEGIN
  SELECT * INTO v_purpose FROM public.audio_guide_purposes WHERE id = p_purpose AND account_id = p_account;
  SELECT * INTO v_identifier FROM public.audio_guide_identifiers WHERE id = p_identifier AND account_id = p_account;
  INSERT INTO public.audio_guide_requests (
    account_id, contact_id, conversation_id, flow_run_id, trigger_message_id, product_key, status, reason, finished_at,
    selection_mode, purpose_id, identifier_id, purpose_name, identifier_name, node_key
  ) VALUES (
    p_account, p_contact, p_conversation, p_run, p_trigger, left(p_product_key, 120), 'skipped', left(p_reason, 200), NOW(),
    'single', v_purpose.id, v_identifier.id, v_purpose.name, v_identifier.name, left(p_node_key, 120)
  )
  ON CONFLICT (account_id, trigger_message_id) DO NOTHING
  RETURNING id INTO v_request;
  RETURN jsonb_build_object('ok', true, 'created', v_request IS NOT NULL);
END;
$$;

REVOKE ALL ON FUNCTION public.audio_guide_save_purpose(UUID, UUID, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.audio_guide_save_identifier(UUID, UUID, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.audio_guide_delete_purpose(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.audio_guide_delete_identifier(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.audio_guide_classify_item(UUID, UUID, INTEGER, UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.audio_guide_open_selected_request(UUID, UUID, UUID, UUID, TEXT, TEXT, INTEGER, UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.audio_guide_record_selected_skip(UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.audio_guide_save_purpose(UUID, UUID, TEXT, TEXT, BOOLEAN) TO service_role;
GRANT EXECUTE ON FUNCTION public.audio_guide_save_identifier(UUID, UUID, TEXT, TEXT, BOOLEAN) TO service_role;
GRANT EXECUTE ON FUNCTION public.audio_guide_delete_purpose(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.audio_guide_delete_identifier(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.audio_guide_classify_item(UUID, UUID, INTEGER, UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.audio_guide_open_selected_request(UUID, UUID, UUID, UUID, TEXT, TEXT, INTEGER, UUID, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.audio_guide_record_selected_skip(UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, UUID, UUID, TEXT) TO service_role;
