-- ============================================================
-- 20261105000000_contacts_time_filter_bulk_delete
--
-- Contacts page: (1) time filter on contacts.created_at combined with the tag filter, (2) atomic bulk delete.
-- Additive: two NEW functions. The existing filter_contacts_by_tags (migration 025) is NOT touched.
--
-- (1) filter_contacts_by_tags_time: same query as filter_contacts_by_tags plus an optional created_at window
--     [p_created_from, p_created_to). SECURITY INVOKER: RLS scopes it to the caller's account like the original.
--
-- (2) bulk_delete_contacts_internal(account, contact_ids): ONE transaction (a function body is atomic):
--       * every id must belong to p_account_id, otherwise nothing is deleted (CONTACTS_NOT_IN_ACCOUNT);
--       * stops the contacts' active Flow runs and cancels their pending Automation waits (same pattern as
--         block_contact_internal, migration 044) so no worker keeps going on a contact that is gone (flow_runs.contact_id
--         is ON DELETE SET NULL, which would otherwise leave an ACTIVE orphan run);
--       * detaches deals from the conversations about to disappear (deals.conversation_id is NO ACTION and would block the delete);
--         the deals themselves survive (contact_id is already SET NULL);
--       * deletes the contacts; existing FKs cascade conversations -> messages (and tags, notes, custom values, identities...).
--         broadcast_recipients, deals, order_confirmations, flow_runs history, ai_usage_log keep their rows (contact_id SET NULL).
--     Only service_role can execute it (the API route authenticates the user and passes the session's account).
--
-- ROLLBACK (the app that does not know these functions simply never calls them):
--   DROP FUNCTION IF EXISTS public.bulk_delete_contacts_internal(UUID, UUID[]);
--   DROP FUNCTION IF EXISTS public.filter_contacts_by_tags_time(UUID[], TEXT, INT, INT, TIMESTAMPTZ, TIMESTAMPTZ);
-- ORDER: migration -> deploy app.
-- ============================================================

CREATE OR REPLACE FUNCTION public.filter_contacts_by_tags_time(
  p_tag_ids UUID[],
  p_search TEXT DEFAULT NULL,
  p_limit INT DEFAULT 25,
  p_offset INT DEFAULT 0,
  p_created_from TIMESTAMPTZ DEFAULT NULL,
  p_created_to TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (contact contacts, total_count BIGINT)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH matched AS (
    SELECT DISTINCT c.id, c.created_at
    FROM contacts c
    JOIN contact_tags ct ON ct.contact_id = c.id
    WHERE ct.tag_id = ANY(p_tag_ids)
      AND (
        p_search IS NULL
        OR c.name ILIKE '%' || p_search || '%'
        OR c.phone ILIKE '%' || p_search || '%'
        OR c.email ILIKE '%' || p_search || '%'
      )
      AND (p_created_from IS NULL OR c.created_at >= p_created_from)
      AND (p_created_to IS NULL OR c.created_at < p_created_to)
  ),
  page AS (
    SELECT id, count(*) OVER() AS total_count
    FROM matched
    ORDER BY created_at DESC, id
    LIMIT p_limit OFFSET p_offset
  )
  SELECT c AS contact, page.total_count
  FROM page
  JOIN contacts c ON c.id = page.id
  ORDER BY c.created_at DESC, c.id;
$$;

REVOKE ALL ON FUNCTION public.filter_contacts_by_tags_time(UUID[], TEXT, INT, INT, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.filter_contacts_by_tags_time(UUID[], TEXT, INT, INT, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;

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

  -- No worker may keep going on a contact that is about to disappear (same pattern as block_contact_internal).
  UPDATE flow_runs SET status = 'paused_by_agent', ended_at = now(), end_reason = 'contact_deleted'
  WHERE account_id = p_account_id AND contact_id = ANY(v_ids) AND status = 'active';
  GET DIAGNOSTICS v_runs = ROW_COUNT;
  UPDATE automation_pending_executions SET status = 'done'
  WHERE account_id = p_account_id AND contact_id = ANY(v_ids) AND status IN ('pending', 'running');

  -- deals.conversation_id is NO ACTION: detach (never delete) the deals so the cascade of conversations can proceed.
  UPDATE deals SET conversation_id = NULL
  WHERE conversation_id IN (SELECT id FROM conversations WHERE contact_id = ANY(v_ids) AND account_id = p_account_id);

  DELETE FROM contacts WHERE id = ANY(v_ids) AND account_id = p_account_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  IF v_deleted <> cardinality(v_ids) THEN
    RAISE EXCEPTION 'DELETE_COUNT_MISMATCH' USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object('deleted', v_deleted, 'conversations_deleted', v_conversations, 'messages_deleted', v_messages, 'active_runs_stopped', v_runs);
END;
$$;

REVOKE ALL ON FUNCTION public.bulk_delete_contacts_internal(UUID, UUID[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bulk_delete_contacts_internal(UUID, UUID[]) FROM anon;
REVOKE ALL ON FUNCTION public.bulk_delete_contacts_internal(UUID, UUID[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.bulk_delete_contacts_internal(UUID, UUID[]) TO service_role;
