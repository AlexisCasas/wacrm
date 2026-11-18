-- FIX 04: controlled, audited and rate-limited contact deletion.
--
-- Additive except for the access it deliberately closes. What this migration does:
--   1. Audit tables contact_deletion_operations / contact_deletion_items (append-only, minimal personal data).
--   2. contact_delete_limits(): the single place where the limits live.
--   3. contact_delete_impact(): read-only preview of what a deletion would remove.
--   4. bulk_delete_contacts_internal(...5 args): checks the actor's role IN THE DATABASE, applies the limits under a
--      per-account advisory lock, protects contacts with orders / recent chats / blocks, writes the audit and deletes,
--      all in ONE transaction (an audit failure rolls the deletion back).
--   5. The old 3-argument signature stays but FAILS CLOSED (an older application image cannot delete without controls).
--   6. purge_contact_deletion_audit(): retention (180 days details / 24 months operations). NOT scheduled here.
--   7. Closes the direct paths: no DELETE policy / DELETE / TRUNCATE on contacts for API roles, and no public EXECUTE on
--      merge_duplicate_contacts() / merge_duplicate_conversations().
--
-- Supabase grants EXECUTE on every new public function to anon/authenticated by default, so every function below revokes
-- explicitly. Re-applying this file is a no-op. Rolling the application back does NOT reopen anything (see the shim).

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Audit tables (no names, no full phones, no emails, no BSUID values: recover a contact by id from a backup)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.contact_deletion_operations (
  id                     uuid PRIMARY KEY,
  account_id             uuid NOT NULL,
  actor_user_id          uuid NOT NULL,
  actor_role             public.account_role_enum NOT NULL,
  mode                   text NOT NULL CHECK (mode IN ('single', 'bulk')),
  requested_count        integer NOT NULL CHECK (requested_count > 0),
  deleted_count          integer NOT NULL CHECK (deleted_count > 0),
  conversations_deleted  integer NOT NULL DEFAULT 0,
  messages_deleted       integer NOT NULL DEFAULT 0,
  orders_unlinked        integer NOT NULL DEFAULT 0,
  blocked_deleted        integer NOT NULL DEFAULT 0,
  protected_acknowledged boolean NOT NULL DEFAULT false,
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_contact_deletion_ops_account_time ON public.contact_deletion_operations (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contact_deletion_ops_actor_time ON public.contact_deletion_operations (actor_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.contact_deletion_items (
  operation_id       uuid NOT NULL REFERENCES public.contact_deletion_operations (id),
  contact_id         uuid NOT NULL,
  contact_created_at timestamptz,
  phone_last3        text,
  had_bsuid          boolean NOT NULL DEFAULT false,
  was_blocked        boolean NOT NULL DEFAULT false,
  conversations      integer NOT NULL DEFAULT 0,
  messages           integer NOT NULL DEFAULT 0,
  orders             integer NOT NULL DEFAULT 0,
  last_message_at    timestamptz,
  PRIMARY KEY (operation_id, contact_id)
);
CREATE INDEX IF NOT EXISTS idx_contact_deletion_items_contact ON public.contact_deletion_items (contact_id);

ALTER TABLE public.contact_deletion_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contact_deletion_items ENABLE ROW LEVEL SECURITY;

-- Supabase default privileges grant ALL on new tables to the API roles: take everything away, then give back only reads.
REVOKE ALL ON TABLE public.contact_deletion_operations, public.contact_deletion_items FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.contact_deletion_operations, public.contact_deletion_items TO authenticated, service_role;

DROP POLICY IF EXISTS contact_deletion_operations_select ON public.contact_deletion_operations;
CREATE POLICY contact_deletion_operations_select ON public.contact_deletion_operations
  FOR SELECT TO authenticated USING (public.is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS contact_deletion_items_select ON public.contact_deletion_items;
CREATE POLICY contact_deletion_items_select ON public.contact_deletion_items
  FOR SELECT TO authenticated USING (EXISTS (
    SELECT 1 FROM public.contact_deletion_operations o WHERE o.id = operation_id AND public.is_account_member(o.account_id, 'admin')));

-- Append-only, even for a role that somehow holds the privilege: only the retention function (below) may delete.
CREATE OR REPLACE FUNCTION public.contact_deletion_audit_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.contact_audit_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'contact deletion audit is append-only' USING ERRCODE = '42501';
END;
$$;
REVOKE ALL ON FUNCTION public.contact_deletion_audit_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS contact_deletion_ops_append_only ON public.contact_deletion_operations;
CREATE TRIGGER contact_deletion_ops_append_only BEFORE UPDATE OR DELETE ON public.contact_deletion_operations
  FOR EACH ROW EXECUTE FUNCTION public.contact_deletion_audit_guard();
DROP TRIGGER IF EXISTS contact_deletion_ops_no_truncate ON public.contact_deletion_operations;
CREATE TRIGGER contact_deletion_ops_no_truncate BEFORE TRUNCATE ON public.contact_deletion_operations
  FOR EACH STATEMENT EXECUTE FUNCTION public.contact_deletion_audit_guard();
DROP TRIGGER IF EXISTS contact_deletion_items_append_only ON public.contact_deletion_items;
CREATE TRIGGER contact_deletion_items_append_only BEFORE UPDATE OR DELETE ON public.contact_deletion_items
  FOR EACH ROW EXECUTE FUNCTION public.contact_deletion_audit_guard();
DROP TRIGGER IF EXISTS contact_deletion_items_no_truncate ON public.contact_deletion_items;
CREATE TRIGGER contact_deletion_items_no_truncate BEFORE TRUNCATE ON public.contact_deletion_items
  FOR EACH STATEMENT EXECUTE FUNCTION public.contact_deletion_audit_guard();

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Limits (one place; initial values, adjustable by a later migration)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.contact_delete_limits() RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT jsonb_build_object('per_operation', 100, 'account_24h', 1000, 'agent_hour', 10, 'recent_days', 30)
$$;
REVOKE ALL ON FUNCTION public.contact_delete_limits() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.contact_delete_limits() TO service_role;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Read-only impact preview
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.contact_delete_impact(p_account_id uuid, p_contact_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_ids uuid[]; v_found int; v_lim jsonb := public.contact_delete_limits();
  v_recent_days int := (public.contact_delete_limits() ->> 'recent_days')::int;
BEGIN
  SELECT array_agg(DISTINCT x) INTO v_ids FROM unnest(p_contact_ids) AS x WHERE x IS NOT NULL;
  IF v_ids IS NULL OR cardinality(v_ids) = 0 THEN RAISE EXCEPTION 'EMPTY_BATCH' USING ERRCODE = 'P0001'; END IF;
  IF cardinality(v_ids) > (v_lim ->> 'per_operation')::int THEN RAISE EXCEPTION 'BATCH_TOO_LARGE' USING ERRCODE = 'P0001'; END IF;
  SELECT count(*) INTO v_found FROM contacts WHERE id = ANY(v_ids) AND account_id = p_account_id;
  IF v_found <> cardinality(v_ids) THEN RAISE EXCEPTION 'CONTACTS_NOT_IN_ACCOUNT' USING ERRCODE = 'P0001'; END IF;

  RETURN jsonb_build_object(
    'contacts', v_found,
    'conversations', (SELECT count(*) FROM conversations WHERE account_id = p_account_id AND contact_id = ANY(v_ids)),
    'messages', (SELECT count(*) FROM messages m JOIN conversations v ON v.id = m.conversation_id
                  WHERE v.account_id = p_account_id AND v.contact_id = ANY(v_ids)),
    'orders', (SELECT count(*) FROM order_confirmations WHERE account_id = p_account_id AND contact_id = ANY(v_ids)),
    'contacts_with_orders', (SELECT count(DISTINCT contact_id) FROM order_confirmations WHERE account_id = p_account_id AND contact_id = ANY(v_ids)),
    'blocked', (SELECT count(*) FROM contacts WHERE account_id = p_account_id AND id = ANY(v_ids) AND blocked),
    'recent_conversations', (SELECT count(DISTINCT contact_id) FROM conversations
                              WHERE account_id = p_account_id AND contact_id = ANY(v_ids)
                                AND last_message_at > now() - make_interval(days => v_recent_days)),
    'with_bsuid', (SELECT count(DISTINCT contact_id) FROM contact_identities
                    WHERE account_id = p_account_id AND contact_id = ANY(v_ids) AND kind = 'bsuid'),
    'limits', v_lim,
    'account_24h_used', (SELECT coalesce(sum(deleted_count), 0) FROM contact_deletion_operations
                          WHERE account_id = p_account_id AND created_at > now() - interval '24 hours')
  );
END;
$$;
REVOKE ALL ON FUNCTION public.contact_delete_impact(uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.contact_delete_impact(uuid, uuid[]) TO service_role;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. The controlled deletion (5 arguments). Same deletion semantics as before, plus authorization, limits,
--    protection and audit, in one transaction.
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bulk_delete_contacts_internal(
  p_account_id uuid, p_contact_ids uuid[], p_public_base text, p_actor_user_id uuid, p_ack_protected boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_lim jsonb := public.contact_delete_limits();
  v_ids uuid[]; v_found int; v_convs uuid[]; v_conversations int; v_messages int; v_deleted int;
  v_runs int; v_active_runs int; v_pending int; v_notifications int; v_operation uuid := gen_random_uuid();
  v_identified int := 0; v_shared int := 0; v_queued int := 0;
  v_role public.account_role_enum; v_rank int; v_mode text;
  v_used24 int; v_usedhour int;
  v_with_orders int; v_orders int; v_recent int; v_blocked int;
BEGIN
  -- Who is acting: proven against profiles, never trusted from the caller. Only service_role can reach this function.
  IF p_actor_user_id IS NULL THEN RAISE EXCEPTION 'ACTOR_REQUIRED' USING ERRCODE = 'P0001'; END IF;
  SELECT account_role INTO v_role FROM profiles WHERE user_id = p_actor_user_id AND account_id = p_account_id;
  IF v_role IS NULL THEN RAISE EXCEPTION 'ACTOR_NOT_AUTHORIZED' USING ERRCODE = 'P0001'; END IF;
  v_rank := CASE v_role WHEN 'owner' THEN 4 WHEN 'admin' THEN 3 WHEN 'agent' THEN 2 ELSE 1 END;
  IF v_rank < 2 THEN RAISE EXCEPTION 'ACTOR_NOT_AUTHORIZED' USING ERRCODE = 'P0001'; END IF;

  SELECT array_agg(DISTINCT x) INTO v_ids FROM unnest(p_contact_ids) AS x WHERE x IS NOT NULL;
  IF v_ids IS NULL OR cardinality(v_ids) = 0 THEN RAISE EXCEPTION 'EMPTY_BATCH' USING ERRCODE = 'P0001'; END IF;
  IF cardinality(v_ids) > (v_lim ->> 'per_operation')::int THEN RAISE EXCEPTION 'BATCH_TOO_LARGE' USING ERRCODE = 'P0001'; END IF;
  v_mode := CASE WHEN cardinality(v_ids) = 1 THEN 'single' ELSE 'bulk' END;
  IF v_mode = 'bulk' AND v_rank < 3 THEN RAISE EXCEPTION 'BULK_REQUIRES_ADMIN' USING ERRCODE = 'P0001'; END IF;

  -- One deletion at a time per account: the windows below are counted AFTER taking this lock, so parallel requests
  -- (several agents, repeated batches) cannot jointly exceed a limit.
  PERFORM pg_advisory_xact_lock(hashtextextended('contact_delete:' || p_account_id::text, 0));

  SELECT count(*) INTO v_found FROM (SELECT id FROM contacts WHERE id = ANY(v_ids) AND account_id = p_account_id FOR UPDATE) locked;
  IF v_found <> cardinality(v_ids) THEN RAISE EXCEPTION 'CONTACTS_NOT_IN_ACCOUNT' USING ERRCODE = 'P0001'; END IF;

  SELECT coalesce(sum(deleted_count), 0)::int INTO v_used24 FROM contact_deletion_operations
    WHERE account_id = p_account_id AND created_at > now() - interval '24 hours';
  IF v_used24 + cardinality(v_ids) > (v_lim ->> 'account_24h')::int THEN
    RAISE EXCEPTION 'RATE_LIMIT_ACCOUNT' USING ERRCODE = 'P0001',
      DETAIL = jsonb_build_object('limit', (v_lim ->> 'account_24h')::int, 'used', v_used24, 'requested', cardinality(v_ids))::text;
  END IF;
  IF v_rank = 2 THEN
    SELECT coalesce(sum(deleted_count), 0)::int INTO v_usedhour FROM contact_deletion_operations
      WHERE actor_user_id = p_actor_user_id AND actor_role = 'agent' AND created_at > now() - interval '1 hour';
    IF v_usedhour + cardinality(v_ids) > (v_lim ->> 'agent_hour')::int THEN
      RAISE EXCEPTION 'RATE_LIMIT_USER' USING ERRCODE = 'P0001',
        DETAIL = jsonb_build_object('limit', (v_lim ->> 'agent_hour')::int, 'used', v_usedhour, 'requested', cardinality(v_ids))::text;
    END IF;
  END IF;

  -- Protected contacts: orders (agents never), recent chats, active blocks (deleting a block would silently reopen the contact).
  SELECT count(DISTINCT contact_id), count(*) INTO v_with_orders, v_orders
    FROM order_confirmations WHERE account_id = p_account_id AND contact_id = ANY(v_ids);
  SELECT count(DISTINCT contact_id) INTO v_recent FROM conversations
    WHERE account_id = p_account_id AND contact_id = ANY(v_ids)
      AND last_message_at > now() - make_interval(days => (v_lim ->> 'recent_days')::int);
  SELECT count(*) INTO v_blocked FROM contacts WHERE account_id = p_account_id AND id = ANY(v_ids) AND blocked;
  IF v_with_orders > 0 AND v_rank < 3 THEN RAISE EXCEPTION 'ORDERS_REQUIRE_ADMIN' USING ERRCODE = 'P0001'; END IF;
  IF (v_with_orders > 0 OR v_recent > 0 OR v_blocked > 0) AND NOT coalesce(p_ack_protected, false) THEN
    RAISE EXCEPTION 'PROTECTED_CONTACTS' USING ERRCODE = 'P0001',
      DETAIL = jsonb_build_object('contacts_with_orders', v_with_orders, 'recent_conversations', v_recent, 'blocked', v_blocked)::text;
  END IF;

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

  -- Audit BEFORE the delete, in this same transaction: if either insert fails, nothing is deleted.
  INSERT INTO contact_deletion_operations (id, account_id, actor_user_id, actor_role, mode, requested_count, deleted_count,
                                           conversations_deleted, messages_deleted, orders_unlinked, blocked_deleted, protected_acknowledged)
  VALUES (v_operation, p_account_id, p_actor_user_id, v_role, v_mode, cardinality(p_contact_ids), cardinality(v_ids),
          v_conversations, v_messages, v_orders, v_blocked, coalesce(p_ack_protected, false));
  INSERT INTO contact_deletion_items (operation_id, contact_id, contact_created_at, phone_last3, had_bsuid, was_blocked,
                                      conversations, messages, orders, last_message_at)
  SELECT v_operation, c.id, c.created_at,
         nullif(right(regexp_replace(coalesce(c.phone, ''), '\D', '', 'g'), 3), ''),
         EXISTS (SELECT 1 FROM contact_identities i WHERE i.contact_id = c.id AND i.kind = 'bsuid'),
         c.blocked,
         (SELECT count(*) FROM conversations v WHERE v.contact_id = c.id),
         (SELECT count(*) FROM messages m JOIN conversations v ON v.id = m.conversation_id WHERE v.contact_id = c.id),
         (SELECT count(*) FROM order_confirmations o WHERE o.contact_id = c.id),
         (SELECT max(v.last_message_at) FROM conversations v WHERE v.contact_id = c.id)
  FROM contacts c WHERE c.id = ANY(v_ids) AND c.account_id = p_account_id;

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
    'media_preserved_shared', v_shared, 'media_queued', v_queued,
    'mode', v_mode, 'orders_unlinked', v_orders, 'blocked_deleted', v_blocked);
END;
$$;
REVOKE ALL ON FUNCTION public.bulk_delete_contacts_internal(uuid, uuid[], text, uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bulk_delete_contacts_internal(uuid, uuid[], text, uuid, boolean) TO service_role;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. The retired 3-argument signature fails closed: an older application image gets an error, never an unaudited delete.
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bulk_delete_contacts_internal(p_account_id uuid, p_contact_ids uuid[], p_public_base text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'ACTOR_REQUIRED' USING ERRCODE = 'P0001',
    DETAIL = 'This signature was retired by FIX 04: call bulk_delete_contacts_internal with p_actor_user_id.';
END;
$$;
REVOKE ALL ON FUNCTION public.bulk_delete_contacts_internal(uuid, uuid[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bulk_delete_contacts_internal(uuid, uuid[], text) TO service_role;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. Retention. Not scheduled by this migration (a cron is installed only after separate approval).
--    Guards stop a mistaken call from wiping recent evidence.
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.purge_contact_deletion_audit(
  p_items_older_than interval DEFAULT interval '180 days', p_operations_older_than interval DEFAULT interval '24 months'
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_items int; v_ops int;
BEGIN
  IF p_items_older_than < interval '30 days' OR p_operations_older_than < interval '6 months' THEN
    RAISE EXCEPTION 'RETENTION_TOO_SHORT' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.contact_audit_purge', 'on', true);
  DELETE FROM contact_deletion_items i USING contact_deletion_operations o
    WHERE o.id = i.operation_id AND o.created_at < now() - p_items_older_than;
  GET DIAGNOSTICS v_items = ROW_COUNT;
  DELETE FROM contact_deletion_items i USING contact_deletion_operations o
    WHERE o.id = i.operation_id AND o.created_at < now() - p_operations_older_than;
  DELETE FROM contact_deletion_operations o WHERE o.created_at < now() - p_operations_older_than;
  GET DIAGNOSTICS v_ops = ROW_COUNT;
  PERFORM set_config('app.contact_audit_purge', 'off', true);
  RETURN jsonb_build_object('items_deleted', v_items, 'operations_deleted', v_ops);
END;
$$;
REVOKE ALL ON FUNCTION public.purge_contact_deletion_audit(interval, interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_contact_deletion_audit(interval, interval) TO service_role;

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. Close the direct paths. Deleting contacts now only happens through the controlled function above.
-- ---------------------------------------------------------------------------------------------------------------------
DROP POLICY IF EXISTS contacts_delete ON public.contacts;
REVOKE DELETE, TRUNCATE ON TABLE public.contacts FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.merge_duplicate_contacts() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.merge_duplicate_conversations() FROM PUBLIC, anon, authenticated;
