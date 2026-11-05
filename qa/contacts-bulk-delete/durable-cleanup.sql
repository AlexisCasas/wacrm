-- ============================================================
-- QA for migration 20261107000000_contact_media_cleanup_queue — DISPOSABLE database only (app schema + the three contact migrations applied).
--   docker exec -i <scratch> psql -U postgres -X -v ON_ERROR_STOP=1 < qa/contacts-bulk-delete/durable-cleanup.sql
-- Proves: the cleanup manifest is written in the SAME transaction as the delete (all or nothing), is bound to exact object paths, never
-- remembers who the contact was (no phone / BSUID / contact id), cannot be created for another account, and does not stop a contact from being
-- recreated. (The Storage calls and the retry loop are covered by the API tests; here: the database half.)
-- ============================================================
\set ON_ERROR_STOP on
BEGIN;
SET session_replication_role = replica;
INSERT INTO auth.users(id) VALUES ('a0000000-0000-4000-8000-000000000001'), ('b0000000-0000-4000-8000-000000000001');
INSERT INTO accounts(id, name, owner_user_id) VALUES ('a1000000-0000-4000-8000-000000000001', 'A', 'a0000000-0000-4000-8000-000000000001'), ('b1000000-0000-4000-8000-000000000001', 'B', 'b0000000-0000-4000-8000-000000000001');
INSERT INTO contacts(id, user_id, account_id, phone, name) VALUES
  ('c1000000-0000-4000-8000-0000000000b1', 'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', '51999999999', 'Old'),
  ('c1000000-0000-4000-8000-0000000000b2', 'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', '51988888888', 'Unselected'),
  ('c2000000-0000-4000-8000-0000000000b1', 'b0000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', '51977777777', 'Other account');
INSERT INTO conversations(id, user_id, account_id, contact_id) VALUES
  ('d1000000-0000-4000-8000-0000000000b1', 'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-0000000000b1'),
  ('d1000000-0000-4000-8000-0000000000b2', 'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-0000000000b2'),
  ('d2000000-0000-4000-8000-0000000000b1', 'b0000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-0000000000b1');
\set base 'https://s.example/storage/v1/object/public'
INSERT INTO messages(conversation_id, sender_type, content_text, media_url) VALUES
  ('d1000000-0000-4000-8000-0000000000b1', 'customer', 'old audio', :'base' || '/chat-media/account-a1000000-0000-4000-8000-000000000001/inbound/old-audio.ogg'),
  ('d1000000-0000-4000-8000-0000000000b1', 'customer', 'old image', :'base' || '/chat-media/account-a1000000-0000-4000-8000-000000000001/old-image.jpg'),
  ('d1000000-0000-4000-8000-0000000000b2', 'customer', 'unselected', :'base' || '/chat-media/account-a1000000-0000-4000-8000-000000000001/inbound/unselected.jpg'),
  ('d2000000-0000-4000-8000-0000000000b1', 'customer', 'other account', :'base' || '/chat-media/account-b1000000-0000-4000-8000-000000000001/inbound/other.jpg');
SET session_replication_role = origin;

CREATE OR REPLACE FUNCTION pg_temp.expect_error(p_sql text, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN EXECUTE p_sql; RAISE EXCEPTION 'expected error % but none was raised', p_msg;
  EXCEPTION WHEN OTHERS THEN IF SQLERRM <> p_msg THEN RAISE EXCEPTION 'expected %, got %', p_msg, SQLERRM; END IF; END;
END $$;

-- ---------- the classifier: what may ever be queued ----------
DO $$ DECLARE a uuid := 'a1000000-0000-4000-8000-000000000001'; b text := 'https://s.example'; p text := 'https://s.example/storage/v1/object/public/'; BEGIN
  IF classify_chat_media_object(p || 'chat-media/account-' || a || '/inbound/x-1.jpg', b, a) IS DISTINCT FROM 'account-' || a || '/inbound/x-1.jpg' THEN RAISE EXCEPTION 'own chat-media must be accepted'; END IF;
  IF classify_chat_media_object(p || 'chat-media/account-' || a || '/inbound/x-1.jpg', b || '/', a) IS NULL THEN RAISE EXCEPTION 'a trailing slash on the base must be tolerated'; END IF;
  IF classify_chat_media_object(p || 'chat-media/account-b1000000-0000-4000-8000-000000000001/x.jpg', b, a) IS NOT NULL THEN RAISE EXCEPTION 'another account namespace accepted'; END IF;
  IF classify_chat_media_object(p || 'flow-media/account-' || a || '/catalog.png', b, a) IS NOT NULL THEN RAISE EXCEPTION 'flow-media accepted'; END IF;
  IF classify_chat_media_object(p || 'voice-notes/account-' || a || '/v.ogg', b, a) IS NOT NULL THEN RAISE EXCEPTION 'voice-notes accepted'; END IF;
  IF classify_chat_media_object('https://evil.example/storage/v1/object/public/chat-media/account-' || a || '/x.jpg', b, a) IS NOT NULL THEN RAISE EXCEPTION 'external host accepted'; END IF;
  IF classify_chat_media_object('https://s.example.evil.io/storage/v1/object/public/chat-media/account-' || a || '/x.jpg', b, a) IS NOT NULL THEN RAISE EXCEPTION 'lookalike host accepted'; END IF;
  IF classify_chat_media_object('/api/whatsapp/media/123', b, a) IS NOT NULL THEN RAISE EXCEPTION 'whatsapp proxy accepted'; END IF;
  IF classify_chat_media_object(p || 'chat-media/account-' || a || '/../account-b1000000-0000-4000-8000-000000000001/x.jpg', b, a) IS NOT NULL THEN RAISE EXCEPTION 'traversal accepted'; END IF;
  IF classify_chat_media_object(p || 'chat-media/account-' || a || '/a%2Fb.jpg', b, a) IS NOT NULL THEN RAISE EXCEPTION 'encoded slash accepted'; END IF;
  IF classify_chat_media_object(p || 'chat-media/account-' || a || '/x.jpg?token=1', b, a) IS NOT NULL THEN RAISE EXCEPTION 'query string accepted'; END IF;
  IF classify_chat_media_object(p || 'chat-media/account-' || a || '/', b, a) IS NOT NULL THEN RAISE EXCEPTION 'namespace only accepted'; END IF;
  IF classify_chat_media_object(p || 'chat-media/account-' || a || '/x.jpg', NULL, a) IS NOT NULL THEN RAISE EXCEPTION 'unknown base must queue nothing (fail closed)'; END IF;
  IF classify_chat_media_object(p || 'sign/chat-media/account-' || a || '/x.jpg', b, a) IS NOT NULL THEN RAISE EXCEPTION 'signed url accepted'; END IF;
END $$;

-- ---------- Case A: the transaction fails -> NOTHING queued, nothing deleted ----------
CREATE FUNCTION pg_temp.boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$;
CREATE TRIGGER boom BEFORE DELETE ON contacts FOR EACH ROW EXECUTE FUNCTION pg_temp.boom();
SELECT pg_temp.expect_error($q$SELECT bulk_delete_contacts_internal('a1000000-0000-4000-8000-000000000001', ARRAY['c1000000-0000-4000-8000-0000000000b1']::uuid[], 'https://s.example')$q$, 'boom');
DROP TRIGGER boom ON contacts;
DO $$ BEGIN
  IF (SELECT count(*) FROM contact_media_cleanup_items) <> 0 THEN RAISE EXCEPTION 'a failed delete left cleanup items behind'; END IF;
  IF (SELECT count(*) FROM contacts) <> 3 OR (SELECT count(*) FROM messages) <> 4 THEN RAISE EXCEPTION 'a failed delete removed data'; END IF;
END $$;

-- ---------- Case F: cross-account -> nothing queued, nothing deleted ----------
SELECT pg_temp.expect_error($q$SELECT bulk_delete_contacts_internal('a1000000-0000-4000-8000-000000000001', ARRAY['c1000000-0000-4000-8000-0000000000b1','c2000000-0000-4000-8000-0000000000b1']::uuid[], 'https://s.example')$q$, 'CONTACTS_NOT_IN_ACCOUNT');
SELECT pg_temp.expect_error($q$SELECT bulk_delete_contacts_internal('b1000000-0000-4000-8000-000000000001', ARRAY['c1000000-0000-4000-8000-0000000000b1']::uuid[], 'https://s.example')$q$, 'CONTACTS_NOT_IN_ACCOUNT');
DO $$ BEGIN
  IF (SELECT count(*) FROM contact_media_cleanup_items) <> 0 OR (SELECT count(*) FROM contacts) <> 3 THEN RAISE EXCEPTION 'cross-account attempt changed something'; END IF;
END $$;

-- ---------- success: DB delete + durable manifest in the same commit ----------
CREATE TEMP TABLE _op AS SELECT (bulk_delete_contacts_internal('a1000000-0000-4000-8000-000000000001', ARRAY['c1000000-0000-4000-8000-0000000000b1']::uuid[], 'https://s.example')->>'operation_id')::uuid AS id;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM contacts WHERE id = 'c1000000-0000-4000-8000-0000000000b1') THEN RAISE EXCEPTION 'contact not deleted'; END IF;
  IF (SELECT count(*) FROM contact_media_cleanup_items WHERE operation_id = (SELECT id FROM _op) AND status = 'pending') <> 2 THEN RAISE EXCEPTION 'expected 2 pending items'; END IF;
  IF (SELECT array_agg(object_path ORDER BY object_path) FROM contact_media_cleanup_items) IS DISTINCT FROM ARRAY[
      'account-a1000000-0000-4000-8000-000000000001/inbound/old-audio.ogg', 'account-a1000000-0000-4000-8000-000000000001/old-image.jpg'] THEN RAISE EXCEPTION 'manifest holds other objects'; END IF;
  IF EXISTS (SELECT 1 FROM contact_media_cleanup_items WHERE account_id <> 'a1000000-0000-4000-8000-000000000001' OR bucket <> 'chat-media') THEN RAISE EXCEPTION 'foreign item queued'; END IF;
  -- the unselected contact's and the other account's files are not in the manifest
  IF EXISTS (SELECT 1 FROM contact_media_cleanup_items WHERE object_path LIKE '%unselected%' OR object_path LIKE '%other.jpg') THEN RAISE EXCEPTION 'media of a NOT selected contact / other account queued'; END IF;
  -- the queue knows paths only: nothing that identifies or blocks a person
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'contact_media_cleanup_items' AND column_name IN ('contact_id', 'phone', 'bsuid', 'username', 'conversation_id', 'blocked')) THEN RAISE EXCEPTION 'the queue must not reference the contact'; END IF;
END $$;

-- ---------- Case E: the same phone writes again; new media is NOT in the old manifest ----------
DO $$ DECLARE newc uuid; newconv uuid; BEGIN
  INSERT INTO contacts(account_id, user_id, phone, name) VALUES ('a1000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', '51999999999', 'Old again') RETURNING id INTO newc;
  INSERT INTO conversations(account_id, user_id, contact_id) VALUES ('a1000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', newc) RETURNING id INTO newconv;
  INSERT INTO messages(conversation_id, sender_type, content_text, media_url) VALUES (newconv, 'customer', 'new audio', 'https://s.example/storage/v1/object/public/chat-media/account-a1000000-0000-4000-8000-000000000001/inbound/new-audio.ogg');
  IF newc IS NULL THEN RAISE EXCEPTION 'contact not recreated'; END IF;
  IF EXISTS (SELECT 1 FROM contact_media_cleanup_items WHERE object_path LIKE '%new-audio%') THEN RAISE EXCEPTION 'new media is in the old manifest'; END IF;
  IF (SELECT count(*) FROM contact_media_cleanup_items WHERE status = 'pending') <> 2 THEN RAISE EXCEPTION 'manifest changed by the new contact'; END IF;
END $$;

-- ---------- re-queue rules: a pending/failed item is kept as is, a completed one is queued again only for a freshly deleted object ----------
UPDATE contact_media_cleanup_items SET status = 'failed', failed_attempts = 3, last_error = 'x' WHERE object_path LIKE '%old-image.jpg';
UPDATE contact_media_cleanup_items SET status = 'completed', completed_at = now() WHERE object_path LIKE '%old-audio.ogg';
DO $$ DECLARE c uuid; conv uuid; r jsonb; BEGIN
  INSERT INTO contacts(account_id, user_id, phone, name) VALUES ('a1000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', '51955555555', 'Third') RETURNING id INTO c;
  INSERT INTO conversations(account_id, user_id, contact_id) VALUES ('a1000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', c) RETURNING id INTO conv;
  -- this chat (hypothetically) references the SAME two objects again
  INSERT INTO messages(conversation_id, sender_type, media_url) VALUES (conv, 'customer', 'https://s.example/storage/v1/object/public/chat-media/account-a1000000-0000-4000-8000-000000000001/inbound/old-audio.ogg'), (conv, 'customer', 'https://s.example/storage/v1/object/public/chat-media/account-a1000000-0000-4000-8000-000000000001/old-image.jpg');
  r := bulk_delete_contacts_internal('a1000000-0000-4000-8000-000000000001', ARRAY[c]::uuid[], 'https://s.example');
  IF (SELECT count(*) FROM contact_media_cleanup_items) <> 2 THEN RAISE EXCEPTION 'duplicate rows for the same object'; END IF;
  IF (SELECT status FROM contact_media_cleanup_items WHERE object_path LIKE '%old-audio.ogg') <> 'pending' THEN RAISE EXCEPTION 'completed item must be queued again'; END IF;
  IF (SELECT status || failed_attempts FROM contact_media_cleanup_items WHERE object_path LIKE '%old-image.jpg') <> 'failed3' THEN RAISE EXCEPTION 'a failed item must keep its retry state'; END IF;
END $$;

-- ---------- privileges: browser roles can neither run the delete nor read the queue ----------
DO $$ BEGIN
  IF has_function_privilege('authenticated', 'bulk_delete_contacts_internal(uuid, uuid[], text)', 'EXECUTE') OR has_function_privilege('anon', 'bulk_delete_contacts_internal(uuid, uuid[], text)', 'EXECUTE') THEN RAISE EXCEPTION 'bulk delete callable by a browser role'; END IF;
  IF has_table_privilege('authenticated', 'contact_media_cleanup_items', 'SELECT') OR has_table_privilege('anon', 'contact_media_cleanup_items', 'SELECT') THEN RAISE EXCEPTION 'queue readable by a browser role'; END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE relname = 'contact_media_cleanup_items') THEN RAISE EXCEPTION 'RLS off'; END IF;
END $$;

SELECT 'PASS' AS result;
ROLLBACK;
