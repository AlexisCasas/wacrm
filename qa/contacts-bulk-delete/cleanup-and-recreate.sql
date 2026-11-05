-- ============================================================
-- QA for migrations 20261106000000_contacts_full_cleanup + 20261107000000_contact_media_cleanup_queue — DISPOSABLE database only (app schema + the three contact migrations applied).
--   docker exec -i <scratch> psql -U postgres -X -v ON_ERROR_STOP=1 < qa/contacts-bulk-delete/cleanup-and-recreate.sql
-- Covers: media candidates (exclusive / shared / catalog), full per-contact cleanup, history preserved, and that the SAME phone and the SAME
-- BSUID can be recreated as brand-new contacts (replaying the statements of findOrCreateContact / findOrCreateConversation and calling the real
-- resolve_bsuid_contact). Nothing is blocked or remembered.
-- ============================================================
\set ON_ERROR_STOP on
BEGIN;
SET session_replication_role = replica;
INSERT INTO auth.users(id) VALUES ('a0000000-0000-4000-8000-000000000001'), ('b0000000-0000-4000-8000-000000000001');
INSERT INTO accounts(id, name, owner_user_id) VALUES ('a1000000-0000-4000-8000-000000000001', 'A', 'a0000000-0000-4000-8000-000000000001'), ('b1000000-0000-4000-8000-000000000001', 'B', 'b0000000-0000-4000-8000-000000000001');

-- P = the contact that will be deleted (phone 51999999999). U = NOT selected. X = another account.
INSERT INTO contacts(id, user_id, account_id, phone, name) VALUES
  ('c1000000-0000-4000-8000-0000000000a1', 'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', '51999999999', 'P'),
  ('c1000000-0000-4000-8000-0000000000a2', 'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', '51988888888', 'U unselected'),
  ('c2000000-0000-4000-8000-0000000000a1', 'b0000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', '51977777777', 'X other account');
INSERT INTO conversations(id, user_id, account_id, contact_id) VALUES
  ('d1000000-0000-4000-8000-0000000000a1', 'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-0000000000a1'),
  ('d1000000-0000-4000-8000-0000000000a2', 'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-0000000000a2'),
  ('d2000000-0000-4000-8000-0000000000a1', 'b0000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-0000000000a1');
\set base 'https://s.example/storage/v1/object/public'
INSERT INTO messages(id, conversation_id, sender_type, content_text, media_url, media_type) VALUES
  ('a0000000-0000-4000-8000-00000000f001', 'd1000000-0000-4000-8000-0000000000a1', 'customer', 'foto',  :'base' || '/chat-media/account-a1000000-0000-4000-8000-000000000001/inbound/img-1.jpg', 'image/jpeg'),
  ('a0000000-0000-4000-8000-00000000f002', 'd1000000-0000-4000-8000-0000000000a1', 'customer', 'audio', :'base' || '/chat-media/account-a1000000-0000-4000-8000-000000000001/aud-1.ogg', 'audio/ogg'),
  ('a0000000-0000-4000-8000-00000000f003', 'd1000000-0000-4000-8000-0000000000a1', 'customer', 'video', :'base' || '/chat-media/account-a1000000-0000-4000-8000-000000000001/vid-1.mp4', 'video/mp4'),
  ('a0000000-0000-4000-8000-00000000f004', 'd1000000-0000-4000-8000-0000000000a1', 'customer', 'doc',   :'base' || '/chat-media/account-a1000000-0000-4000-8000-000000000001/doc-1.pdf', 'application/pdf'),
  ('a0000000-0000-4000-8000-00000000f005', 'd1000000-0000-4000-8000-0000000000a1', 'customer', 'compartida', :'base' || '/chat-media/account-a1000000-0000-4000-8000-000000000001/shared.jpg', 'image/jpeg'),
  ('a0000000-0000-4000-8000-00000000f006', 'd1000000-0000-4000-8000-0000000000a1', 'agent', 'catalogo', :'base' || '/flow-media/account-a1000000-0000-4000-8000-000000000001/catalog.png', 'image/png'),
  ('a0000000-0000-4000-8000-00000000f007', 'd1000000-0000-4000-8000-0000000000a1', 'customer', 'externa', 'https://example.org/x.jpg', 'image/jpeg'),
  ('a0000000-0000-4000-8000-00000000f008', 'd1000000-0000-4000-8000-0000000000a1', 'customer', 'proxy', '/api/whatsapp/media/123', 'image/jpeg'),
  ('a0000000-0000-4000-8000-00000000f009', 'd1000000-0000-4000-8000-0000000000a1', 'customer', 'solo texto', NULL, NULL),
  ('a0000000-0000-4000-8000-00000000f101', 'd1000000-0000-4000-8000-0000000000a2', 'customer', 'foto de U', :'base' || '/chat-media/account-a1000000-0000-4000-8000-000000000001/inbound/img-U.jpg', 'image/jpeg'),
  ('a0000000-0000-4000-8000-00000000f102', 'd1000000-0000-4000-8000-0000000000a2', 'customer', 'compartida', :'base' || '/chat-media/account-a1000000-0000-4000-8000-000000000001/shared.jpg', 'image/jpeg'),
  ('b0000000-0000-4000-8000-00000000f201', 'd2000000-0000-4000-8000-0000000000a1', 'customer', 'foto de X', :'base' || '/chat-media/account-b1000000-0000-4000-8000-000000000001/inbound/img-X.jpg', 'image/jpeg');
-- the flow catalog references its own file (flow-media) the way flow_nodes do
INSERT INTO flows(id, user_id, account_id, name, trigger_type, status) VALUES ('f3000000-0000-4000-8000-0000000000a1', 'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'F', 'manual', 'draft');
INSERT INTO flow_nodes(flow_id, node_key, node_type, config) VALUES ('f3000000-0000-4000-8000-0000000000a1', 'm', 'send_media', jsonb_build_object('media_url', :'base' || '/flow-media/account-a1000000-0000-4000-8000-000000000001/catalog.png'));

-- per-contact data of P (and of U to prove it stays)
INSERT INTO tags(id, user_id, account_id, name) VALUES ('7a000000-0000-4000-8000-0000000000a1', 'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'Cliente');
INSERT INTO contact_tags(contact_id, tag_id) VALUES ('c1000000-0000-4000-8000-0000000000a1', '7a000000-0000-4000-8000-0000000000a1'), ('c1000000-0000-4000-8000-0000000000a2', '7a000000-0000-4000-8000-0000000000a1');
INSERT INTO custom_fields(id, user_id, account_id, field_name) VALUES ('cf000000-0000-4000-8000-0000000000a1', 'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'Destino');
INSERT INTO contact_custom_values(contact_id, custom_field_id, value) VALUES ('c1000000-0000-4000-8000-0000000000a1', 'cf000000-0000-4000-8000-0000000000a1', 'Lima'), ('c1000000-0000-4000-8000-0000000000a2', 'cf000000-0000-4000-8000-0000000000a1', 'Cusco');
INSERT INTO contact_notes(contact_id, user_id, account_id, note_text) VALUES ('c1000000-0000-4000-8000-0000000000a1', 'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'nota P'), ('c1000000-0000-4000-8000-0000000000a2', 'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'nota U');
INSERT INTO contact_identities(account_id, contact_id, kind, value) VALUES ('a1000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-0000000000a1', 'bsuid', 'BS.P.OLD'), ('a1000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-0000000000a2', 'bsuid', 'BS.U');
INSERT INTO message_reactions(message_id, conversation_id, actor_type, emoji) VALUES ('a0000000-0000-4000-8000-00000000f001', 'd1000000-0000-4000-8000-0000000000a1', 'customer', '👍'), ('a0000000-0000-4000-8000-00000000f101', 'd1000000-0000-4000-8000-0000000000a2', 'customer', '👍');
INSERT INTO notifications(account_id, user_id, title, conversation_id, contact_id) VALUES
  ('a1000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'msg P', 'd1000000-0000-4000-8000-0000000000a1', 'c1000000-0000-4000-8000-0000000000a1'),
  ('a1000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'note about P (no conversation)', NULL, 'c1000000-0000-4000-8000-0000000000a1'),
  ('a1000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'msg U', 'd1000000-0000-4000-8000-0000000000a2', 'c1000000-0000-4000-8000-0000000000a2');
-- history that must survive
INSERT INTO pipelines(id, user_id, account_id, name) VALUES ('f1000000-0000-4000-8000-0000000000a1', 'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'P');
INSERT INTO pipeline_stages(id, pipeline_id, name) VALUES ('f2000000-0000-4000-8000-0000000000a1', 'f1000000-0000-4000-8000-0000000000a1', 'S');
INSERT INTO deals(id, user_id, account_id, pipeline_id, stage_id, title, contact_id, conversation_id, value) VALUES ('e1000000-0000-4000-8000-0000000000a1', 'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-0000000000a1', 'f2000000-0000-4000-8000-0000000000a1', 'deal P', 'c1000000-0000-4000-8000-0000000000a1', 'd1000000-0000-4000-8000-0000000000a1', 250);
INSERT INTO broadcasts(id, user_id, account_id, name, template_name) VALUES ('bb000000-0000-4000-8000-0000000000a1', 'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'B', 'tpl');
INSERT INTO broadcast_recipients(id, broadcast_id, contact_id) VALUES ('ba000000-0000-4000-8000-0000000000a1', 'bb000000-0000-4000-8000-0000000000a1', 'c1000000-0000-4000-8000-0000000000a1');
INSERT INTO order_confirmations(id, account_id, customer_name, phone, product, quantity, price, destination, seller_name, confirmed_by_name, request_key, contact_id, conversation_id) VALUES ('0c000000-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-000000000001', 'P', '51999999999', 'taladro', 1, 100, 'Lima', 's', 'c', 'req-1', 'c1000000-0000-4000-8000-0000000000a1', 'd1000000-0000-4000-8000-0000000000a1');
INSERT INTO automations(id, user_id, account_id, name, trigger_type) VALUES ('a5000000-0000-4000-8000-0000000000a1', 'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'Au', 'keyword_match');
INSERT INTO automation_logs(id, automation_id, user_id, account_id, contact_id, trigger_event, status) VALUES ('a7000000-0000-4000-8000-0000000000a1', 'a5000000-0000-4000-8000-0000000000a1', 'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-0000000000a1', 'keyword_match', 'success');
SET session_replication_role = origin;

-- ---------- media candidates (what the API will classify) ----------
DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM contact_chat_media_candidates('a1000000-0000-4000-8000-000000000001', ARRAY['c1000000-0000-4000-8000-0000000000a1']::uuid[]);
  IF n <> 8 THEN RAISE EXCEPTION 'expected 8 distinct media urls (text-only message excluded), got %', n; END IF;
  IF (SELECT shared FROM contact_chat_media_candidates('a1000000-0000-4000-8000-000000000001', ARRAY['c1000000-0000-4000-8000-0000000000a1']::uuid[]) WHERE media_url LIKE '%/img-1.jpg') THEN RAISE EXCEPTION 'exclusive image flagged shared'; END IF;
  IF NOT (SELECT shared FROM contact_chat_media_candidates('a1000000-0000-4000-8000-000000000001', ARRAY['c1000000-0000-4000-8000-0000000000a1']::uuid[]) WHERE media_url LIKE '%/shared.jpg') THEN RAISE EXCEPTION 'media shared with another conversation not flagged'; END IF;
  IF NOT (SELECT shared FROM contact_chat_media_candidates('a1000000-0000-4000-8000-000000000001', ARRAY['c1000000-0000-4000-8000-0000000000a1']::uuid[]) WHERE media_url LIKE '%/catalog.png') THEN RAISE EXCEPTION 'flow catalog media not flagged shared'; END IF;
  -- selecting BOTH owners of shared.jpg makes it exclusive to the deleted set
  IF (SELECT shared FROM contact_chat_media_candidates('a1000000-0000-4000-8000-000000000001', ARRAY['c1000000-0000-4000-8000-0000000000a1','c1000000-0000-4000-8000-0000000000a2']::uuid[]) WHERE media_url LIKE '%/shared.jpg') THEN RAISE EXCEPTION 'media shared only among selected contacts must be deletable'; END IF;
END $$;
DO $$ BEGIN
  PERFORM contact_chat_media_candidates('a1000000-0000-4000-8000-000000000001', ARRAY['c2000000-0000-4000-8000-0000000000a1']::uuid[]);
  RAISE EXCEPTION 'cross-account candidates must be rejected';
EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'CONTACTS_NOT_IN_ACCOUNT' THEN RAISE; END IF; END $$;

-- ---------- delete P ----------
CREATE TEMP TABLE _old AS SELECT 'c1000000-0000-4000-8000-0000000000a1'::uuid AS contact_id, 'd1000000-0000-4000-8000-0000000000a1'::uuid AS conversation_id;
DO $$ DECLARE r jsonb; BEGIN
  r := bulk_delete_contacts_internal('a1000000-0000-4000-8000-000000000001', ARRAY['c1000000-0000-4000-8000-0000000000a1']::uuid[], 'https://s.example');
  IF (r->>'deleted')::int <> 1 OR (r->>'conversations_deleted')::int <> 1 OR (r->>'messages_deleted')::int <> 9 OR (r->>'notifications_deleted')::int <> 2 THEN RAISE EXCEPTION 'counts %', r; END IF;
  -- the API reads these: 8 distinct urls seen, 1 shared with another chat + the flow catalog = 2 preserved, 4 chat-media objects queued
  IF (r->>'media_identified')::int <> 8 OR (r->>'media_queued')::int <> 4 OR (r->>'media_preserved_shared')::int <> 2 THEN RAISE EXCEPTION 'media summary %', r; END IF;
  IF (SELECT count(*) FROM contact_media_cleanup_items WHERE operation_id = (r->>'operation_id')::uuid AND status = 'pending') <> 4 THEN RAISE EXCEPTION 'cleanup items not queued'; END IF;
  -- selected contact: nothing left, anywhere
  IF EXISTS (SELECT 1 FROM contacts WHERE id = 'c1000000-0000-4000-8000-0000000000a1')
     OR EXISTS (SELECT 1 FROM conversations WHERE contact_id = 'c1000000-0000-4000-8000-0000000000a1')
     OR EXISTS (SELECT 1 FROM messages WHERE conversation_id = 'd1000000-0000-4000-8000-0000000000a1')
     OR EXISTS (SELECT 1 FROM message_reactions WHERE conversation_id = 'd1000000-0000-4000-8000-0000000000a1')
     OR EXISTS (SELECT 1 FROM contact_tags WHERE contact_id = 'c1000000-0000-4000-8000-0000000000a1')
     OR EXISTS (SELECT 1 FROM contact_custom_values WHERE contact_id = 'c1000000-0000-4000-8000-0000000000a1')
     OR EXISTS (SELECT 1 FROM contact_notes WHERE contact_id = 'c1000000-0000-4000-8000-0000000000a1')
     OR EXISTS (SELECT 1 FROM contact_identities WHERE contact_id = 'c1000000-0000-4000-8000-0000000000a1')
     OR EXISTS (SELECT 1 FROM notifications WHERE contact_id = 'c1000000-0000-4000-8000-0000000000a1' OR conversation_id = 'd1000000-0000-4000-8000-0000000000a1')
  THEN RAISE EXCEPTION 'per-contact data of the selected contact remains'; END IF;
  -- NOT selected / other account: untouched
  IF (SELECT count(*) FROM messages WHERE conversation_id IN ('d1000000-0000-4000-8000-0000000000a2','d2000000-0000-4000-8000-0000000000a1')) <> 3 THEN RAISE EXCEPTION 'messages of other contacts changed'; END IF;
  IF (SELECT count(*) FROM contact_tags WHERE contact_id = 'c1000000-0000-4000-8000-0000000000a2') <> 1 OR (SELECT count(*) FROM contact_custom_values WHERE contact_id = 'c1000000-0000-4000-8000-0000000000a2') <> 1
     OR (SELECT count(*) FROM contact_notes WHERE contact_id = 'c1000000-0000-4000-8000-0000000000a2') <> 1 OR (SELECT count(*) FROM contact_identities WHERE contact_id = 'c1000000-0000-4000-8000-0000000000a2') <> 1
     OR (SELECT count(*) FROM message_reactions) <> 1 OR (SELECT count(*) FROM notifications) <> 1 THEN RAISE EXCEPTION 'data of the NOT selected contact changed'; END IF;
  -- history survives with no link to the deleted contact
  IF (SELECT contact_id IS NULL AND conversation_id IS NULL AND value = 250 FROM deals WHERE id = 'e1000000-0000-4000-8000-0000000000a1') IS NOT TRUE THEN RAISE EXCEPTION 'deal history not preserved'; END IF;
  IF (SELECT contact_id FROM broadcast_recipients WHERE id = 'ba000000-0000-4000-8000-0000000000a1') IS NOT NULL OR (SELECT count(*) FROM broadcasts) <> 1 THEN RAISE EXCEPTION 'broadcast history not preserved'; END IF;
  IF (SELECT contact_id IS NULL FROM order_confirmations WHERE id = '0c000000-0000-4000-8000-0000000000a1') IS NOT TRUE THEN RAISE EXCEPTION 'order history not preserved'; END IF;
  IF (SELECT contact_id FROM automation_logs WHERE id = 'a7000000-0000-4000-8000-0000000000a1') IS NOT NULL THEN RAISE EXCEPTION 'automation log link not cleared'; END IF;
  -- no tombstone / blocklist: nothing remembers the contact
  IF EXISTS (SELECT 1 FROM contacts WHERE blocked) THEN RAISE EXCEPTION 'a blocked contact appeared'; END IF;
END $$;

-- ---------- the SAME phone comes back: normal find-or-create ----------
DO $$ DECLARE newc uuid; newconv uuid; oldc uuid := (SELECT contact_id FROM _old); oldconv uuid := (SELECT conversation_id FROM _old); BEGIN
  IF EXISTS (SELECT 1 FROM contacts WHERE account_id = 'a1000000-0000-4000-8000-000000000001' AND phone = '51999999999') THEN RAISE EXCEPTION 'findExistingContact would still find the old one'; END IF;
  -- statement of findOrCreateContact
  INSERT INTO contacts(account_id, user_id, phone, name) VALUES ('a1000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', '51999999999', 'P again') RETURNING id INTO newc;
  -- statement of findOrCreateConversation (no existing conversation -> insert)
  IF EXISTS (SELECT 1 FROM conversations WHERE account_id = 'a1000000-0000-4000-8000-000000000001' AND contact_id = newc) THEN RAISE EXCEPTION 'unexpected existing conversation'; END IF;
  INSERT INTO conversations(account_id, user_id, contact_id) VALUES ('a1000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', newc) RETURNING id INTO newconv;
  INSERT INTO messages(conversation_id, sender_type, content_text) VALUES (newconv, 'customer', 'hola otra vez');
  IF newc = oldc OR newconv = oldconv THEN RAISE EXCEPTION 'ids were reused'; END IF;
  IF (SELECT count(*) FROM messages WHERE conversation_id = newconv) <> 1 THEN RAISE EXCEPTION 'new inbound not stored'; END IF;
  -- starts from zero: nothing of the old state is restored
  IF EXISTS (SELECT 1 FROM contact_tags WHERE contact_id = newc) OR EXISTS (SELECT 1 FROM contact_custom_values WHERE contact_id = newc) OR EXISTS (SELECT 1 FROM contact_notes WHERE contact_id = newc)
     OR EXISTS (SELECT 1 FROM flow_runs WHERE contact_id = newc) OR EXISTS (SELECT 1 FROM deals WHERE contact_id = newc) OR EXISTS (SELECT 1 FROM messages WHERE conversation_id = newconv AND media_url IS NOT NULL)
  THEN RAISE EXCEPTION 'old state was restored'; END IF;
END $$;

-- ---------- BSUID-only contact: create with the REAL resolver, chat, delete, same BSUID comes back ----------
DO $$ DECLARE c1 uuid; c2 uuid; v1 uuid; v2 uuid; created1 boolean; created2 boolean; r jsonb; BEGIN
  SELECT contact_id, created INTO c1, created1 FROM resolve_bsuid_contact('a1000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'BS.NEW.001', NULL, 'maria.u', 'Maria');
  IF c1 IS NULL OR NOT created1 THEN RAISE EXCEPTION 'resolver did not create the BSUID contact'; END IF;
  INSERT INTO conversations(account_id, user_id, contact_id) VALUES ('a1000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', c1) RETURNING id INTO v1;
  INSERT INTO messages(conversation_id, sender_type, content_text) VALUES (v1, 'customer', 'hola');
  INSERT INTO contact_tags(contact_id, tag_id) VALUES (c1, '7a000000-0000-4000-8000-0000000000a1');
  IF NOT EXISTS (SELECT 1 FROM contact_identities WHERE contact_id = c1 AND kind = 'bsuid' AND value = 'BS.NEW.001') THEN RAISE EXCEPTION 'identity not created'; END IF;

  r := bulk_delete_contacts_internal('a1000000-0000-4000-8000-000000000001', ARRAY[c1]::uuid[], 'https://s.example');
  IF (r->>'deleted')::int <> 1 THEN RAISE EXCEPTION 'bsuid contact not deleted %', r; END IF;
  IF EXISTS (SELECT 1 FROM contact_identities WHERE kind = 'bsuid' AND value = 'BS.NEW.001') THEN RAISE EXCEPTION 'BSUID mapping still reserved'; END IF;

  SELECT contact_id, created INTO c2, created2 FROM resolve_bsuid_contact('a1000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'BS.NEW.001', NULL, 'maria.u', 'Maria');
  IF c2 IS NULL OR NOT created2 OR c2 = c1 THEN RAISE EXCEPTION 'same BSUID did not create a NEW contact'; END IF;
  INSERT INTO conversations(account_id, user_id, contact_id) VALUES ('a1000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', c2) RETURNING id INTO v2;
  INSERT INTO messages(conversation_id, sender_type, content_text) VALUES (v2, 'customer', 'hola de nuevo');
  IF v2 = v1 OR (SELECT count(*) FROM messages WHERE conversation_id = v2) <> 1 THEN RAISE EXCEPTION 'new conversation / inbound not stored'; END IF;
  IF EXISTS (SELECT 1 FROM contact_tags WHERE contact_id = c2) THEN RAISE EXCEPTION 'old tag restored'; END IF;
END $$;

SELECT 'PASS' AS result;
ROLLBACK;
