-- ============================================================
-- 074_audio_guide_catalog_ops
--
-- "Audios por producto", stage 2: what the catalog API needs on top of migration 073. Additive and compatible: no table is created
-- or dropped, no existing row changes meaning, and nothing runs until the API calls it.
--
--   1. audio_guide_products.revision   optimistic-concurrency token of the whole product (its row AND its audios). Every UPDATE of the
--                                      product, and every insert/update/delete of one of its audios, bumps it by exactly one.
--   2. audio_guide_items.label         the file's display name in the editor (never sent to WhatsApp).
--   3. (product_id, position) unique   made DEFERRABLE so a reorder can swap positions inside one statement.
--   4. Six functions (service role only) that apply ONE catalog change atomically: lock the product row, compare the caller's
--      revision, change, and answer {ok, revision} or {ok:false, reason}. A stale revision never overwrites anything.
--
-- Not added: a settings table (the 5-second pause lives on each item, and the keyword/compuerta settings belong to the Flow), and no
-- second copy of any 073 structure.
-- ============================================================

ALTER TABLE public.audio_guide_products ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE public.audio_guide_items ADD COLUMN label TEXT;
ALTER TABLE public.audio_guide_items ADD CONSTRAINT audio_guide_items_label_form
  CHECK (label IS NULL OR (btrim(label) <> '' AND label = btrim(label) AND char_length(label) <= 120));

ALTER TABLE public.audio_guide_items DROP CONSTRAINT audio_guide_items_product_position_key;
ALTER TABLE public.audio_guide_items ADD CONSTRAINT audio_guide_items_product_position_key
  UNIQUE (product_id, position) DEFERRABLE INITIALLY IMMEDIATE;

-- Any UPDATE of a product moves its revision by exactly one; a client can never choose the value.
CREATE FUNCTION public.audio_guide_products_bump_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.revision := OLD.revision + 1;
  RETURN NEW;
END;
$$;

CREATE TRIGGER audio_guide_products_bump_revision
  BEFORE UPDATE ON public.audio_guide_products
  FOR EACH ROW EXECUTE FUNCTION public.audio_guide_products_bump_revision();

-- A change to an audio is a change to its product: touch the product row (which bumps its revision).
CREATE FUNCTION public.audio_guide_items_touch_product()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_product UUID := COALESCE(NEW.product_id, OLD.product_id);
  v_account UUID := COALESCE(NEW.account_id, OLD.account_id);
BEGIN
  UPDATE public.audio_guide_products SET updated_at = NOW() WHERE id = v_product AND account_id = v_account;
  RETURN NULL;
END;
$$;

CREATE TRIGGER audio_guide_items_touch_product
  AFTER INSERT OR UPDATE OR DELETE ON public.audio_guide_items
  FOR EACH ROW EXECUTE FUNCTION public.audio_guide_items_touch_product();

-- ---------------------------------------------------------------
-- Atomic catalog changes. SECURITY INVOKER + service role only: the API checks the caller's role first, then calls these with the
-- session's account id, never one from the request body. Every function locks the product row, so two writers serialise, and the
-- second one (still holding the old revision) is told `revision_conflict` instead of silently overwriting the first.
-- ---------------------------------------------------------------
CREATE FUNCTION public.audio_guide_lock_product(p_account UUID, p_product UUID, p_expected INTEGER)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_revision INTEGER;
BEGIN
  SELECT revision INTO v_revision FROM public.audio_guide_products
   WHERE id = p_product AND account_id = p_account FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  IF p_expected IS NULL OR v_revision <> p_expected THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'revision_conflict', 'revision', v_revision);
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION public.audio_guide_save_product(
  p_account UUID, p_product UUID, p_expected INTEGER,
  p_display_name TEXT DEFAULT NULL, p_product_key TEXT DEFAULT NULL, p_active BOOLEAN DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_refusal JSONB;
  v_revision INTEGER;
BEGIN
  v_refusal := public.audio_guide_lock_product(p_account, p_product, p_expected);
  IF v_refusal IS NOT NULL THEN RETURN v_refusal; END IF;
  BEGIN
    UPDATE public.audio_guide_products
       SET display_name = COALESCE(p_display_name, display_name),
           product_key  = COALESCE(p_product_key, product_key),
           active       = COALESCE(p_active, active)
     WHERE id = p_product AND account_id = p_account
     RETURNING revision INTO v_revision;
  EXCEPTION
    WHEN unique_violation THEN RETURN jsonb_build_object('ok', false, 'reason', 'duplicate_key');
    WHEN check_violation THEN RETURN jsonb_build_object('ok', false, 'reason', 'invalid_value');
  END;
  RETURN jsonb_build_object('ok', true, 'revision', v_revision);
END;
$$;

CREATE FUNCTION public.audio_guide_delete_product(p_account UUID, p_product UUID, p_expected INTEGER)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_refusal JSONB;
BEGIN
  v_refusal := public.audio_guide_lock_product(p_account, p_product, p_expected);
  IF v_refusal IS NOT NULL THEN RETURN v_refusal; END IF;
  -- The audios go with the product; requests and sends keep their history (their product/item reference is set to NULL, with the hash
  -- snapshot). The stored files are NOT touched: they are shared by hash and may serve another product.
  DELETE FROM public.audio_guide_products WHERE id = p_product AND account_id = p_account;
  RETURN jsonb_build_object('ok', true);
END;
$$;

CREATE FUNCTION public.audio_guide_add_item(
  p_account UUID, p_product UUID, p_expected INTEGER,
  p_sha256 TEXT, p_bytes INTEGER, p_duration_ms INTEGER, p_label TEXT DEFAULT NULL, p_pre_delay SMALLINT DEFAULT 5
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_refusal JSONB;
  v_position INTEGER;
  v_item UUID;
  v_revision INTEGER;
BEGIN
  v_refusal := public.audio_guide_lock_product(p_account, p_product, p_expected);
  IF v_refusal IS NOT NULL THEN RETURN v_refusal; END IF;
  -- A malformed hash is a bad request, whatever the bucket holds (the table's own checks run after the stored-object trigger).
  IF p_sha256 IS NULL OR p_sha256 !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_value');
  END IF;
  SELECT COALESCE(MAX(position), 0) + 1 INTO v_position FROM public.audio_guide_items WHERE product_id = p_product AND account_id = p_account;
  IF v_position > 6 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'limit_reached');
  END IF;
  BEGIN
    -- The path is BUILT from the account and the hash: a caller cannot point an item at another account's file.
    INSERT INTO public.audio_guide_items (account_id, product_id, position, voice_sha256, voice_path, bytes, duration_ms, label, pre_delay_seconds)
    VALUES (p_account, p_product, v_position, p_sha256, 'account-' || p_account::text || '/' || p_sha256 || '.ogg', p_bytes, p_duration_ms, p_label, p_pre_delay)
    RETURNING id INTO v_item;
  EXCEPTION
    WHEN foreign_key_violation THEN RETURN jsonb_build_object('ok', false, 'reason', 'file_not_stored');
    WHEN check_violation THEN RETURN jsonb_build_object('ok', false, 'reason', 'invalid_value');
    WHEN unique_violation THEN RETURN jsonb_build_object('ok', false, 'reason', 'conflict');
  END;
  SELECT revision INTO v_revision FROM public.audio_guide_products WHERE id = p_product;
  RETURN jsonb_build_object('ok', true, 'item_id', v_item, 'position', v_position, 'revision', v_revision);
END;
$$;

CREATE FUNCTION public.audio_guide_update_item(
  p_account UUID, p_item UUID, p_expected INTEGER,
  p_status TEXT DEFAULT NULL, p_pre_delay SMALLINT DEFAULT NULL, p_label TEXT DEFAULT NULL, p_clear_label BOOLEAN DEFAULT FALSE
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_product UUID;
  v_refusal JSONB;
  v_revision INTEGER;
BEGIN
  SELECT product_id INTO v_product FROM public.audio_guide_items WHERE id = p_item AND account_id = p_account;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  v_refusal := public.audio_guide_lock_product(p_account, v_product, p_expected);
  IF v_refusal IS NOT NULL THEN RETURN v_refusal; END IF;
  BEGIN
    UPDATE public.audio_guide_items
       SET status = COALESCE(p_status, status),
           pre_delay_seconds = COALESCE(p_pre_delay, pre_delay_seconds),
           label = CASE WHEN p_clear_label THEN NULL ELSE COALESCE(p_label, label) END
     WHERE id = p_item AND account_id = p_account;
  EXCEPTION
    WHEN check_violation THEN RETURN jsonb_build_object('ok', false, 'reason', 'invalid_value');
  END;
  SELECT revision INTO v_revision FROM public.audio_guide_products WHERE id = v_product;
  RETURN jsonb_build_object('ok', true, 'revision', v_revision);
END;
$$;

CREATE FUNCTION public.audio_guide_remove_item(p_account UUID, p_item UUID, p_expected INTEGER)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_product UUID;
  v_refusal JSONB;
  v_revision INTEGER;
BEGIN
  SELECT product_id INTO v_product FROM public.audio_guide_items WHERE id = p_item AND account_id = p_account;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  v_refusal := public.audio_guide_lock_product(p_account, v_product, p_expected);
  IF v_refusal IS NOT NULL THEN RETURN v_refusal; END IF;
  -- Only the association goes. The stored file stays (shared by hash) and past sends keep their snapshot (item_id becomes NULL).
  DELETE FROM public.audio_guide_items WHERE id = p_item AND account_id = p_account;
  SET CONSTRAINTS public.audio_guide_items_product_position_key DEFERRED;
  UPDATE public.audio_guide_items i SET position = r.rn
    FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY position)::SMALLINT AS rn FROM public.audio_guide_items WHERE product_id = v_product AND account_id = p_account) r
   WHERE i.id = r.id AND i.position <> r.rn;
  SET CONSTRAINTS public.audio_guide_items_product_position_key IMMEDIATE;
  SELECT revision INTO v_revision FROM public.audio_guide_products WHERE id = v_product;
  RETURN jsonb_build_object('ok', true, 'revision', v_revision);
END;
$$;

CREATE FUNCTION public.audio_guide_reorder_items(p_account UUID, p_product UUID, p_expected INTEGER, p_item_ids UUID[])
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_refusal JSONB;
  v_count INTEGER;
  v_revision INTEGER;
BEGIN
  v_refusal := public.audio_guide_lock_product(p_account, p_product, p_expected);
  IF v_refusal IS NOT NULL THEN RETURN v_refusal; END IF;
  SELECT COUNT(*) INTO v_count FROM public.audio_guide_items WHERE product_id = p_product AND account_id = p_account;
  -- The new order must be exactly a permutation of this product's audios: no id missing, extra, repeated or from elsewhere.
  IF p_item_ids IS NULL OR COALESCE(array_length(p_item_ids, 1), 0) <> v_count
     OR (SELECT COUNT(DISTINCT x) FROM unnest(p_item_ids) x) <> v_count
     OR (SELECT COUNT(*) FROM public.audio_guide_items WHERE product_id = p_product AND account_id = p_account AND id = ANY (p_item_ids)) <> v_count THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_order');
  END IF;
  SET CONSTRAINTS public.audio_guide_items_product_position_key DEFERRED;
  UPDATE public.audio_guide_items i SET position = o.ord::SMALLINT
    FROM unnest(p_item_ids) WITH ORDINALITY AS o(id, ord)
   WHERE i.id = o.id AND i.product_id = p_product AND i.account_id = p_account AND i.position <> o.ord;
  SET CONSTRAINTS public.audio_guide_items_product_position_key IMMEDIATE;
  SELECT revision INTO v_revision FROM public.audio_guide_products WHERE id = p_product;
  RETURN jsonb_build_object('ok', true, 'revision', v_revision);
END;
$$;

-- Service role only: these bypass the "members can only read" rule on purpose, so no signed-in user may call them directly.
REVOKE ALL ON FUNCTION public.audio_guide_lock_product(UUID, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.audio_guide_save_product(UUID, UUID, INTEGER, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.audio_guide_delete_product(UUID, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.audio_guide_add_item(UUID, UUID, INTEGER, TEXT, INTEGER, INTEGER, TEXT, SMALLINT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.audio_guide_update_item(UUID, UUID, INTEGER, TEXT, SMALLINT, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.audio_guide_remove_item(UUID, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.audio_guide_reorder_items(UUID, UUID, INTEGER, UUID[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.audio_guide_lock_product(UUID, UUID, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.audio_guide_save_product(UUID, UUID, INTEGER, TEXT, TEXT, BOOLEAN) TO service_role;
GRANT EXECUTE ON FUNCTION public.audio_guide_delete_product(UUID, UUID, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.audio_guide_add_item(UUID, UUID, INTEGER, TEXT, INTEGER, INTEGER, TEXT, SMALLINT) TO service_role;
GRANT EXECUTE ON FUNCTION public.audio_guide_update_item(UUID, UUID, INTEGER, TEXT, SMALLINT, TEXT, BOOLEAN) TO service_role;
GRANT EXECUTE ON FUNCTION public.audio_guide_remove_item(UUID, UUID, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.audio_guide_reorder_items(UUID, UUID, INTEGER, UUID[]) TO service_role;
