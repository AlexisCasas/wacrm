-- ============================================================
-- 20261106000000_contacts_full_cleanup  (builds on 20261105000000_contacts_time_filter_bulk_delete)
--
-- Deleting a contact now also cleans its operational data and tells the API which chat media (Storage) belonged to its conversations,
-- so the files can be removed too. Nothing is blocked afterwards: no tombstone, no blacklist, no blocked flag; the same phone / BSUID can
-- be recreated as a brand-new contact by the normal inbound find-or-create.
--
-- 1) contact_chat_media_candidates(account, contact_ids): read-only. Rejects ids that are not in the account (CONTACTS_NOT_IN_ACCOUNT) and lists the
--    DISTINCT messages.media_url of the contacts' conversations with a `shared` flag. `shared` = the same url is also used by a message of a
--    conversation that is NOT being deleted (any account), or appears in flow_nodes.config / automation_steps.step_config.
--    The API decides what is a managed, deletable object; the database only reports usage.
-- 2) bulk_delete_contacts_internal (same signature, REPLACED): everything it did before, plus
--       * DELETE flow_runs of the contacts (flow_run_events / flow_run_subflow_frames cascade; flows.execution_count is a separate counter),
--       * DELETE automation_pending_executions of the contacts (instead of marking them done),
--       * DELETE notifications of the contacts (the ones tied to a conversation already cascade),
--       * returns the media list (computed BEFORE deleting) so the API can clean any file that arrived after its own plan.
--    Still ONE transaction; deals / broadcast_recipients / order_confirmations / audio_guide_requests / automation_logs / ai_usage_log keep their
--    rows (contact_id SET NULL); contact_identity_audit (no FK, audit trail) is kept.
--
-- ROLLBACK: re-apply 20261105000000 (it replaces bulk_delete_contacts_internal with the previous behaviour), then
--   DROP FUNCTION IF EXISTS public.contact_chat_media_candidates(UUID, UUID[]);
-- ORDER: migration -> deploy app.
-- ============================================================

CREATE OR REPLACE FUNCTION public.contact_chat_media_candidates(
  p_account_id UUID,
  p_contact_ids UUID[]
)
RETURNS TABLE (media_url TEXT, shared BOOLEAN, message_count BIGINT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ids UUID[];
  v_found INT;
  v_convs UUID[];
  v_flow_refs TEXT[];
  v_step_refs TEXT[];
BEGIN
  SELECT array_agg(DISTINCT x) INTO v_ids FROM unnest(p_contact_ids) AS x WHERE x IS NOT NULL;
  IF v_ids IS NULL OR cardinality(v_ids) = 0 THEN RAISE EXCEPTION 'EMPTY_BATCH' USING ERRCODE = 'P0001'; END IF;
  IF cardinality(v_ids) > 200 THEN RAISE EXCEPTION 'BATCH_TOO_LARGE' USING ERRCODE = 'P0001'; END IF;
  SELECT count(*) INTO v_found FROM contacts WHERE id = ANY(v_ids) AND account_id = p_account_id;
  IF v_found <> cardinality(v_ids) THEN RAISE EXCEPTION 'CONTACTS_NOT_IN_ACCOUNT' USING ERRCODE = 'P0001'; END IF;

  SELECT array_agg(id) INTO v_convs FROM conversations WHERE contact_id = ANY(v_ids) AND account_id = p_account_id;
  IF v_convs IS NULL THEN RETURN; END IF;

  -- catalog references (only rows that mention a Storage object at all are kept; ~3 s for 3000 distinct urls on the production catalog)
  SELECT coalesce(array_agg(config::text), ARRAY[]::text[]) INTO v_flow_refs FROM flow_nodes WHERE config::text LIKE '%/storage/v1/object/%';
  SELECT coalesce(array_agg(step_config::text), ARRAY[]::text[]) INTO v_step_refs FROM automation_steps WHERE step_config::text LIKE '%/storage/v1/object/%';

  RETURN QUERY
  WITH mine AS (
    SELECT m.media_url AS url, count(*) AS n
    FROM messages m
    WHERE m.conversation_id = ANY(v_convs) AND m.media_url IS NOT NULL AND m.media_url <> ''
    GROUP BY m.media_url
  ),
  used_elsewhere AS (
    SELECT DISTINCT m.media_url AS url
    FROM messages m
    WHERE m.media_url IN (SELECT url FROM mine) AND m.conversation_id <> ALL(v_convs)
  )
  SELECT mine.url, (
      EXISTS (SELECT 1 FROM used_elsewhere u WHERE u.url = mine.url)
      OR EXISTS (SELECT 1 FROM unnest(v_flow_refs) r WHERE position(mine.url IN r) > 0)
      OR EXISTS (SELECT 1 FROM unnest(v_step_refs) r WHERE position(mine.url IN r) > 0)
    ) AS shared, mine.n AS message_count
  FROM mine
  ORDER BY mine.url;
END;
$$;

REVOKE ALL ON FUNCTION public.contact_chat_media_candidates(UUID, UUID[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.contact_chat_media_candidates(UUID, UUID[]) FROM anon;
REVOKE ALL ON FUNCTION public.contact_chat_media_candidates(UUID, UUID[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.contact_chat_media_candidates(UUID, UUID[]) TO service_role;

CREATE OR REPLACE FUNCTION public.bulk_delete_contacts_internal(
  p_account_id UUID,
  p_contact_ids UUID[]
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ids UUID[];
  v_found INT;
  v_conversations INT;
  v_messages INT;
  v_deleted INT;
  v_runs INT;
  v_active_runs INT;
  v_pending INT;
  v_notifications INT;
  v_media JSONB;
BEGIN
  SELECT array_agg(DISTINCT x) INTO v_ids FROM unnest(p_contact_ids) AS x WHERE x IS NOT NULL;
  IF v_ids IS NULL OR cardinality(v_ids) = 0 THEN
    RAISE EXCEPTION 'EMPTY_BATCH' USING ERRCODE = 'P0001';
  END IF;
  IF cardinality(v_ids) > 200 THEN
    RAISE EXCEPTION 'BATCH_TOO_LARGE' USING ERRCODE = 'P0001';
  END IF;

  -- Lock the rows and prove ownership: a single foreign / unknown id rejects the whole batch.
  SELECT count(*) INTO v_found FROM (
    SELECT id FROM contacts WHERE id = ANY(v_ids) AND account_id = p_account_id FOR UPDATE
  ) locked;
  IF v_found <> cardinality(v_ids) THEN
    RAISE EXCEPTION 'CONTACTS_NOT_IN_ACCOUNT' USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*) INTO v_conversations FROM conversations WHERE contact_id = ANY(v_ids) AND account_id = p_account_id;
  SELECT count(*) INTO v_messages FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE contact_id = ANY(v_ids) AND account_id = p_account_id);

  -- Media seen at the moment of deletion (the API removes the files; anything that arrived after its own plan is cleaned in a second pass).
  SELECT coalesce(jsonb_agg(jsonb_build_object('media_url', c.media_url, 'shared', c.shared)), '[]'::jsonb) INTO v_media
  FROM contact_chat_media_candidates(p_account_id, v_ids) c;

  -- Operational data that belongs only to these contacts. flow_runs go (events and subflow frames cascade); an active one is counted first.
  SELECT count(*) INTO v_active_runs FROM flow_runs WHERE account_id = p_account_id AND contact_id = ANY(v_ids) AND status = 'active';
  DELETE FROM flow_runs WHERE account_id = p_account_id AND contact_id = ANY(v_ids);
  GET DIAGNOSTICS v_runs = ROW_COUNT;
  DELETE FROM automation_pending_executions WHERE account_id = p_account_id AND contact_id = ANY(v_ids);
  GET DIAGNOSTICS v_pending = ROW_COUNT;
  DELETE FROM notifications WHERE account_id = p_account_id AND contact_id = ANY(v_ids);
  GET DIAGNOSTICS v_notifications = ROW_COUNT;

  -- deals.conversation_id is NO ACTION: detach (never delete) the deals so the cascade of conversations can proceed.
  UPDATE deals SET conversation_id = NULL
  WHERE conversation_id IN (SELECT id FROM conversations WHERE contact_id = ANY(v_ids) AND account_id = p_account_id);

  -- Existing FKs cascade: conversations -> messages -> reactions, contact_tags, custom values, notes, identities, manychat links,
  -- block events, automation settings, bsuid authorizations. History tables keep their rows (contact_id SET NULL).
  DELETE FROM contacts WHERE id = ANY(v_ids) AND account_id = p_account_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  IF v_deleted <> cardinality(v_ids) THEN
    RAISE EXCEPTION 'DELETE_COUNT_MISMATCH' USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object(
    'deleted', v_deleted, 'conversations_deleted', v_conversations, 'messages_deleted', v_messages,
    'active_runs_stopped', v_active_runs, 'runs_deleted', v_runs, 'pending_automations_deleted', v_pending,
    'notifications_deleted', v_notifications, 'media', v_media
  );
END;
$$;

REVOKE ALL ON FUNCTION public.bulk_delete_contacts_internal(UUID, UUID[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bulk_delete_contacts_internal(UUID, UUID[]) FROM anon;
REVOKE ALL ON FUNCTION public.bulk_delete_contacts_internal(UUID, UUID[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.bulk_delete_contacts_internal(UUID, UUID[]) TO service_role;
