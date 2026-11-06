-- ============================================================
-- 20261107000000_contact_media_cleanup_queue  (additive; builds on 20261105000000 and 20261106000000)
--
-- Deleting contacts is now DATABASE-FIRST: the database transaction deletes the contacts AND, in that same transaction, records which Storage
-- objects must be removed afterwards in a durable queue. Storage is touched only after the COMMIT, one object at a time, and a failure there
-- never undoes the deletion: the object just stays pending and can be retried (idempotent: an object that is already gone counts as done).
--
--   * contact_media_cleanup_items: one row per STORAGE OBJECT (account, bucket, exact object path, original url, status, error, timestamps).
--     It stores no contact id, phone, BSUID or username, so it cannot block or identify a future contact: it belongs to the object, not to a
--     person. Service role only (RLS on, no policy).
--   * classify_chat_media_object(url, public_base, account): the ONLY thing that may be queued: a public `chat-media` object under the caller's own
--     `account-<account_id>/` namespace with a conservative file name ([A-Za-z0-9._-] segments, no '.', '..', '%', '?', '#'). Anything else -> NULL
--     (never queued). Every one of the 32,612 chat-media objects and message urls in production matches this rule.
--   * bulk_delete_contacts_internal(account, contact_ids, public_base): REPLACED (the 2-argument form is dropped; a call with 2 arguments still
--     works through the default). Same guarantees as before (one transaction, all ids must belong to the account, history survives) plus:
--       the conversations are locked first, the media of exactly those conversations is resolved, objects shared with a surviving conversation,
--       a Flow or an Automation are left out, the remaining objects are queued, and only then the contacts are deleted.
--     Any failure rolls back everything, including the queue rows.
--
-- ROLLBACK: process or accept the pending items first (dropping the table forgets them), then
--   DROP FUNCTION IF EXISTS public.bulk_delete_contacts_internal(UUID, UUID[], TEXT);
--   DROP FUNCTION IF EXISTS public.classify_chat_media_object(TEXT, TEXT, UUID);
--   re-apply 20261106000000_contacts_full_cleanup.sql (recreates the 2-argument function);   DROP TABLE IF EXISTS public.contact_media_cleanup_items;
-- ORDER: migrations 20261105, 20261106, 20261107 -> deploy app.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.contact_media_cleanup_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id UUID NOT NULL,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  bucket TEXT NOT NULL CHECK (bucket = 'chat-media'),
  object_path TEXT NOT NULL,
  media_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'failed', 'completed')),
  failed_attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_attempt_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  CONSTRAINT contact_media_cleanup_items_path_ck CHECK (object_path LIKE 'account-' || account_id::text || '/%'),
  CONSTRAINT contact_media_cleanup_items_uq UNIQUE (account_id, bucket, object_path)
);
CREATE INDEX IF NOT EXISTS idx_contact_media_cleanup_open ON public.contact_media_cleanup_items (created_at) WHERE status <> 'completed';
CREATE INDEX IF NOT EXISTS idx_contact_media_cleanup_operation ON public.contact_media_cleanup_items (operation_id);
ALTER TABLE public.contact_media_cleanup_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.contact_media_cleanup_items FROM anon, authenticated;
-- no policy: only the service role (the API) reads or writes it

CREATE OR REPLACE FUNCTION public.classify_chat_media_object(p_url TEXT, p_public_base TEXT, p_account_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_prefix TEXT;
  v_rest TEXT;
BEGIN
  IF p_url IS NULL OR p_public_base IS NULL OR btrim(p_public_base) = '' OR p_account_id IS NULL THEN RETURN NULL; END IF;
  v_prefix := rtrim(p_public_base, '/') || '/storage/v1/object/public/chat-media/account-' || p_account_id::text || '/';
  IF left(p_url, length(v_prefix)) <> v_prefix THEN RETURN NULL; END IF;
  v_rest := substring(p_url FROM length(v_prefix) + 1);
  IF v_rest = '' OR v_rest !~ '^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$' THEN RETURN NULL; END IF;
  IF v_rest ~ '(^|/)\.\.?(/|$)' THEN RETURN NULL; END IF;
  RETURN 'account-' || p_account_id::text || '/' || v_rest;
END;
$$;
REVOKE ALL ON FUNCTION public.classify_chat_media_object(TEXT, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.classify_chat_media_object(TEXT, TEXT, UUID) TO service_role;

DROP FUNCTION IF EXISTS public.bulk_delete_contacts_internal(UUID, UUID[]);

CREATE OR REPLACE FUNCTION public.bulk_delete_contacts_internal(
  p_account_id UUID,
  p_contact_ids UUID[],
  p_public_base TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ids UUID[];
  v_found INT;
  v_convs UUID[];
  v_conversations INT;
  v_messages INT;
  v_deleted INT;
  v_runs INT;
  v_active_runs INT;
  v_pending INT;
  v_notifications INT;
  v_operation UUID := gen_random_uuid();
  v_identified INT := 0;
  v_shared INT := 0;
  v_queued INT := 0;
BEGIN
  SELECT array_agg(DISTINCT x) INTO v_ids FROM unnest(p_contact_ids) AS x WHERE x IS NOT NULL;
  IF v_ids IS NULL OR cardinality(v_ids) = 0 THEN
    RAISE EXCEPTION 'EMPTY_BATCH' USING ERRCODE = 'P0001';
  END IF;
  IF cardinality(v_ids) > 200 THEN
    RAISE EXCEPTION 'BATCH_TOO_LARGE' USING ERRCODE = 'P0001';
  END IF;

  -- 1) tenancy: lock the rows and prove ownership; a single foreign / unknown id rejects the whole batch (nothing queued, nothing deleted)
  SELECT count(*) INTO v_found FROM (
    SELECT id FROM contacts WHERE id = ANY(v_ids) AND account_id = p_account_id FOR UPDATE
  ) locked;
  IF v_found <> cardinality(v_ids) THEN
    RAISE EXCEPTION 'CONTACTS_NOT_IN_ACCOUNT' USING ERRCODE = 'P0001';
  END IF;

  -- 2) freeze the chats: a concurrent inbound message needs a KEY SHARE lock on its conversation, so it waits for this commit instead of slipping
  --    a new file between "resolve the media" and "delete the messages"
  SELECT array_agg(id) INTO v_convs FROM (
    SELECT id FROM conversations WHERE contact_id = ANY(v_ids) AND account_id = p_account_id FOR UPDATE
  ) c;
  v_conversations := coalesce(cardinality(v_convs), 0);
  SELECT count(*) INTO v_messages FROM messages WHERE conversation_id = ANY(coalesce(v_convs, ARRAY[]::uuid[]));

  -- 3) resolve the media of exactly those chats and QUEUE the deletable objects (same transaction as the delete below)
  IF v_conversations > 0 THEN
    SELECT count(*) INTO v_identified FROM contact_chat_media_candidates(p_account_id, v_ids);
    SELECT count(*) INTO v_shared FROM contact_chat_media_candidates(p_account_id, v_ids) WHERE shared;
    WITH objs AS (
      SELECT classify_chat_media_object(c.media_url, p_public_base, p_account_id) AS object_path,
             min(c.media_url) AS media_url, bool_or(c.shared) AS shared
      FROM contact_chat_media_candidates(p_account_id, v_ids) c
      GROUP BY 1
    ), ins AS (
      INSERT INTO contact_media_cleanup_items (operation_id, account_id, bucket, object_path, media_url)
      SELECT v_operation, p_account_id, 'chat-media', o.object_path, o.media_url
      FROM objs o WHERE o.object_path IS NOT NULL AND NOT o.shared
      ON CONFLICT (account_id, bucket, object_path) DO UPDATE
        SET status = 'pending', operation_id = EXCLUDED.operation_id, completed_at = NULL, last_error = NULL, failed_attempts = 0
        WHERE contact_media_cleanup_items.status = 'completed'
      RETURNING 1
    )
    SELECT count(*) INTO v_queued FROM ins;
  END IF;

  -- 4) operational data that belongs only to these contacts (flow_run_events / subflow frames cascade)
  SELECT count(*) INTO v_active_runs FROM flow_runs WHERE account_id = p_account_id AND contact_id = ANY(v_ids) AND status = 'active';
  DELETE FROM flow_runs WHERE account_id = p_account_id AND contact_id = ANY(v_ids);
  GET DIAGNOSTICS v_runs = ROW_COUNT;
  DELETE FROM automation_pending_executions WHERE account_id = p_account_id AND contact_id = ANY(v_ids);
  GET DIAGNOSTICS v_pending = ROW_COUNT;
  DELETE FROM notifications WHERE account_id = p_account_id AND contact_id = ANY(v_ids);
  GET DIAGNOSTICS v_notifications = ROW_COUNT;

  -- 5) history that must survive: deals.conversation_id is NO ACTION, so detach (never delete) before the cascade
  UPDATE deals SET conversation_id = NULL WHERE conversation_id = ANY(coalesce(v_convs, ARRAY[]::uuid[]));

  -- 6) the contacts; existing FKs cascade conversations -> messages -> reactions, tags, custom values, notes, identities, ...
  DELETE FROM contacts WHERE id = ANY(v_ids) AND account_id = p_account_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  IF v_deleted <> cardinality(v_ids) THEN
    RAISE EXCEPTION 'DELETE_COUNT_MISMATCH' USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object(
    'deleted', v_deleted, 'conversations_deleted', v_conversations, 'messages_deleted', v_messages,
    'active_runs_stopped', v_active_runs, 'runs_deleted', v_runs, 'pending_automations_deleted', v_pending,
    'notifications_deleted', v_notifications,
    'operation_id', v_operation, 'media_identified', v_identified, 'media_preserved_shared', v_shared, 'media_queued', v_queued
  );
END;
$$;

REVOKE ALL ON FUNCTION public.bulk_delete_contacts_internal(UUID, UUID[], TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bulk_delete_contacts_internal(UUID, UUID[], TEXT) TO service_role;
