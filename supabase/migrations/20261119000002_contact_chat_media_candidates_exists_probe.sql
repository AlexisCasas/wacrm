-- Bulk delete timed out (SQLSTATE 57014, 8 s API statement_timeout). Besides the foreign-key indexes (20261119000000), the remaining
-- bottleneck is the "is this Storage object still used by ANOTHER chat" check of contact_chat_media_candidates(): the used_elsewhere CTE
-- (SELECT DISTINCT ... WHERE media_url IN (...) AND conversation_id <> ALL(...)) fetches every message that shares a URL and scans all of
-- `messages` (~1.56 M rows, ~61 k pages). It is replaced by a per-URL EXISTS probe that can stop at the first message outside the batch and
-- uses idx_messages_media_url (20261119000001). Same result for every input; ONLY that predicate changes.
-- Unchanged on purpose: signature, return columns, SECURITY DEFINER, STABLE, search_path, tenant check (CONTACTS_NOT_IN_ACCOUNT), limits,
-- flow_nodes / automation_steps reference detection, ordering. CREATE OR REPLACE keeps the existing owner and ACL (service_role only), so no
-- GRANT/REVOKE is repeated here. ORDER: apply 20261119000001 (index) first, then this file.

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
  )
  SELECT mine.url, (
      EXISTS (SELECT 1 FROM messages o WHERE o.media_url = mine.url AND o.conversation_id <> ALL(v_convs))
      OR EXISTS (SELECT 1 FROM unnest(v_flow_refs) r WHERE position(mine.url IN r) > 0)
      OR EXISTS (SELECT 1 FROM unnest(v_step_refs) r WHERE position(mine.url IN r) > 0)
    ) AS shared, mine.n AS message_count
  FROM mine
  ORDER BY mine.url;
END;
$$;
