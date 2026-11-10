-- The media candidate function scans catalog references.  Calling it three
-- times made a multi-contact delete substantially slower than a one-contact
-- delete and could exhaust the route's request budget.  Keep the same atomic
-- and tenant-checked operation, but materialize candidates once per batch.

CREATE OR REPLACE FUNCTION public.bulk_delete_contacts_internal(
  p_account_id UUID,
  p_contact_ids UUID[],
  p_public_base TEXT DEFAULT NULL
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_ids UUID[]; v_found INT; v_convs UUID[]; v_conversations INT; v_messages INT; v_deleted INT;
  v_runs INT; v_active_runs INT; v_pending INT; v_notifications INT; v_operation UUID := gen_random_uuid();
  v_identified INT := 0; v_shared INT := 0; v_queued INT := 0;
BEGIN
  SELECT array_agg(DISTINCT x) INTO v_ids FROM unnest(p_contact_ids) AS x WHERE x IS NOT NULL;
  IF v_ids IS NULL OR cardinality(v_ids) = 0 THEN RAISE EXCEPTION 'EMPTY_BATCH' USING ERRCODE = 'P0001'; END IF;
  IF cardinality(v_ids) > 200 THEN RAISE EXCEPTION 'BATCH_TOO_LARGE' USING ERRCODE = 'P0001'; END IF;

  SELECT count(*) INTO v_found FROM (SELECT id FROM contacts WHERE id = ANY(v_ids) AND account_id = p_account_id FOR UPDATE) locked;
  IF v_found <> cardinality(v_ids) THEN RAISE EXCEPTION 'CONTACTS_NOT_IN_ACCOUNT' USING ERRCODE = 'P0001'; END IF;

  SELECT array_agg(id) INTO v_convs FROM (SELECT id FROM conversations WHERE contact_id = ANY(v_ids) AND account_id = p_account_id FOR UPDATE) c;
  v_conversations := coalesce(cardinality(v_convs), 0);
  SELECT count(*) INTO v_messages FROM messages WHERE conversation_id = ANY(coalesce(v_convs, ARRAY[]::uuid[]));

  IF v_conversations > 0 THEN
    WITH candidates AS MATERIALIZED (
      SELECT * FROM contact_chat_media_candidates(p_account_id, v_ids)
    ), stats AS (
      SELECT count(*)::INT AS identified, count(*) FILTER (WHERE shared)::INT AS shared FROM candidates
    ), objs AS (
      SELECT classify_chat_media_object(c.media_url, p_public_base, p_account_id) AS object_path,
             min(c.media_url) AS media_url, bool_or(c.shared) AS shared
      FROM candidates c GROUP BY 1
    ), ins AS (
      INSERT INTO contact_media_cleanup_items (operation_id, account_id, bucket, object_path, media_url)
      SELECT v_operation, p_account_id, 'chat-media', o.object_path, o.media_url
      FROM objs o WHERE o.object_path IS NOT NULL AND NOT o.shared
      ON CONFLICT (account_id, bucket, object_path) DO UPDATE
        SET status = 'pending', operation_id = EXCLUDED.operation_id, completed_at = NULL, last_error = NULL, failed_attempts = 0
        WHERE contact_media_cleanup_items.status = 'completed'
      RETURNING 1
    )
    SELECT s.identified, s.shared, (SELECT count(*)::INT FROM ins)
      INTO v_identified, v_shared, v_queued FROM stats s;
  END IF;

  SELECT count(*) INTO v_active_runs FROM flow_runs WHERE account_id = p_account_id AND contact_id = ANY(v_ids) AND status = 'active';
  DELETE FROM flow_runs WHERE account_id = p_account_id AND contact_id = ANY(v_ids); GET DIAGNOSTICS v_runs = ROW_COUNT;
  DELETE FROM automation_pending_executions WHERE account_id = p_account_id AND contact_id = ANY(v_ids); GET DIAGNOSTICS v_pending = ROW_COUNT;
  DELETE FROM notifications WHERE account_id = p_account_id AND contact_id = ANY(v_ids); GET DIAGNOSTICS v_notifications = ROW_COUNT;
  UPDATE deals SET conversation_id = NULL WHERE conversation_id = ANY(coalesce(v_convs, ARRAY[]::uuid[]));
  DELETE FROM contacts WHERE id = ANY(v_ids) AND account_id = p_account_id; GET DIAGNOSTICS v_deleted = ROW_COUNT;
  IF v_deleted <> cardinality(v_ids) THEN RAISE EXCEPTION 'DELETE_COUNT_MISMATCH' USING ERRCODE = 'P0001'; END IF;

  RETURN jsonb_build_object('deleted', v_deleted, 'conversations_deleted', v_conversations, 'messages_deleted', v_messages,
    'active_runs_stopped', v_active_runs, 'runs_deleted', v_runs, 'pending_automations_deleted', v_pending,
    'notifications_deleted', v_notifications, 'operation_id', v_operation, 'media_identified', v_identified,
    'media_preserved_shared', v_shared, 'media_queued', v_queued);
END;
$$;

REVOKE ALL ON FUNCTION public.bulk_delete_contacts_internal(UUID, UUID[], TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bulk_delete_contacts_internal(UUID, UUID[], TEXT) TO service_role;
