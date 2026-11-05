-- ============================================================
-- QA for migration 20261105000000_contacts_time_filter_bulk_delete — run ONLY against a DISPOSABLE database that has the app schema
-- (e.g. a scratch postgres loaded with `pg_dump -s -n public` of the app). It creates its own accounts/users/contacts, never reads production data.
--   docker exec -i <scratch> psql -U postgres -X -v ON_ERROR_STOP=1 < qa/contacts-bulk-delete/scenarios.sql
-- Every scenario asserts with RAISE EXCEPTION; the last line prints PASS.
-- ============================================================
\set ON_ERROR_STOP on
BEGIN;
SET session_replication_role = replica;   -- fixture inserts only: skip user-level triggers (set_updated_at / phone checks)

-- two accounts, A (the caller) and B (someone else)
INSERT INTO auth.users(id) VALUES ('a0000000-0000-4000-8000-000000000001'), ('b0000000-0000-4000-8000-000000000001');
INSERT INTO accounts(id, name, owner_user_id) VALUES ('a1000000-0000-4000-8000-000000000001', 'A', 'a0000000-0000-4000-8000-000000000001'), ('b1000000-0000-4000-8000-000000000001', 'B', 'b0000000-0000-4000-8000-000000000001');
INSERT INTO contacts(id, user_id, account_id, phone, name, created_at) VALUES
  ('c1000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', '51900000001', 'A1 selected',    now() - interval '100 days'),
  ('c1000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', '51900000002', 'A2 selected',    now() - interval '95 days'),
  ('c1000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', '51900000003', 'A3 NOT selected', now() - interval '5 days'),
  ('c2000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', '51900000009', 'B1 other account', now() - interval '100 days');
INSERT INTO conversations(id, user_id, account_id, contact_id) VALUES
  ('d1000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001'),
  ('d1000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000002'),
  ('d1000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000003'),
  ('d2000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001');
INSERT INTO messages(conversation_id, sender_type, content_text) SELECT c, 'customer', 'hola ' || g FROM unnest(ARRAY['d1000000-0000-4000-8000-000000000001','d1000000-0000-4000-8000-000000000002','d1000000-0000-4000-8000-000000000003','d2000000-0000-4000-8000-000000000001']::uuid[]) c, generate_series(1, 3) g;

-- history that must SURVIVE: a deal attached to A1's conversation (NO ACTION fk) and broadcast recipients of A1
INSERT INTO pipelines(id, user_id, account_id, name) VALUES ('f1000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'P');
INSERT INTO pipeline_stages(id, pipeline_id, name) VALUES ('f2000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001', 'S');
INSERT INTO deals(id, user_id, account_id, pipeline_id, stage_id, title, contact_id, conversation_id) VALUES
  ('e1000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'deal of A1', 'c1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001'),
  ('e1000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'deal of A3', 'c1000000-0000-4000-8000-000000000003', 'd1000000-0000-4000-8000-000000000003');
INSERT INTO broadcasts(id, user_id, account_id, name, template_name) VALUES ('bb000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'B', 'tpl');
INSERT INTO broadcast_recipients(id, broadcast_id, contact_id) VALUES ('ba000000-0000-4000-8000-000000000001', 'bb000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001'), ('ba000000-0000-4000-8000-000000000003', 'bb000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000003');

-- A flow with an ACTIVE run (parked on a wait) for A1 and one for A3; a pending automation wait for A1
INSERT INTO flows(id, user_id, account_id, name, trigger_type, status) VALUES ('f3000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'F', 'manual', 'draft');
INSERT INTO flow_runs(id, flow_id, user_id, account_id, contact_id, conversation_id, status, current_node_key, wait_node_key, wait_until) VALUES
  ('f4000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'active', 'w', 'w', now() + interval '1 day'),
  ('f4000000-0000-4000-8000-000000000003', 'f3000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000003', 'd1000000-0000-4000-8000-000000000003', 'active', 'w', 'w', now() + interval '1 day');
INSERT INTO flow_run_events(flow_run_id, event_type) VALUES ('f4000000-0000-4000-8000-000000000001', 'started');
INSERT INTO automations(id, user_id, account_id, name, trigger_type) VALUES ('a5000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'Au', 'keyword_match');
INSERT INTO automation_pending_executions(id, automation_id, user_id, account_id, contact_id, next_step_position, run_at, status) VALUES
  ('a6000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', 0, now() + interval '1 day', 'pending'),
  ('a6000000-0000-4000-8000-000000000003', 'a5000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000003', 0, now() + interval '1 day', 'pending');
SET session_replication_role = origin;

CREATE OR REPLACE FUNCTION pg_temp.expect_error(p_sql text, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN EXECUTE p_sql; RAISE EXCEPTION 'expected error % but none was raised', p_msg;
  EXCEPTION WHEN OTHERS THEN IF SQLERRM <> p_msg THEN RAISE EXCEPTION 'expected %, got %', p_msg, SQLERRM; END IF; END;
END $$;

-- ---------- rejected batches delete NOTHING (atomic / cross-account) ----------
SELECT pg_temp.expect_error($q$SELECT bulk_delete_contacts_internal('a1000000-0000-4000-8000-000000000001', ARRAY['c1000000-0000-4000-8000-000000000001','c2000000-0000-4000-8000-000000000001']::uuid[])$q$, 'CONTACTS_NOT_IN_ACCOUNT');   -- A caller + B contact
SELECT pg_temp.expect_error($q$SELECT bulk_delete_contacts_internal('a1000000-0000-4000-8000-000000000001', ARRAY['c1000000-0000-4000-8000-000000000001','99999999-9999-4999-8999-999999999999']::uuid[])$q$, 'CONTACTS_NOT_IN_ACCOUNT');   -- unknown id
SELECT pg_temp.expect_error($q$SELECT bulk_delete_contacts_internal('a1000000-0000-4000-8000-000000000001', ARRAY[]::uuid[])$q$, 'EMPTY_BATCH');
SELECT pg_temp.expect_error($q$SELECT bulk_delete_contacts_internal('a1000000-0000-4000-8000-000000000001', NULL)$q$, 'EMPTY_BATCH');
SELECT pg_temp.expect_error($q$SELECT bulk_delete_contacts_internal('a1000000-0000-4000-8000-000000000001', (SELECT array_agg(gen_random_uuid()) FROM generate_series(1, 201)))$q$, 'BATCH_TOO_LARGE');
DO $$ BEGIN
  IF (SELECT count(*) FROM contacts) <> 4 OR (SELECT count(*) FROM conversations) <> 4 OR (SELECT count(*) FROM messages) <> 12 THEN RAISE EXCEPTION 'a rejected batch deleted something'; END IF;
  IF EXISTS (SELECT 1 FROM flow_runs WHERE status <> 'active') THEN RAISE EXCEPTION 'a rejected batch touched flow_runs'; END IF;
END $$;

-- ---------- the real delete: A1 + A2 selected, A3 and B1 NOT ----------
DO $$ DECLARE r jsonb; BEGIN
  r := bulk_delete_contacts_internal('a1000000-0000-4000-8000-000000000001', ARRAY['c1000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000002','c1000000-0000-4000-8000-000000000001']::uuid[]);  -- duplicate id collapsed
  IF (r->>'deleted')::int <> 2 OR (r->>'conversations_deleted')::int <> 2 OR (r->>'messages_deleted')::int <> 6 THEN RAISE EXCEPTION 'unexpected counts %', r; END IF;
  -- contacts / conversations / messages: selected gone, not selected stay
  IF EXISTS (SELECT 1 FROM contacts WHERE id IN ('c1000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000002')) THEN RAISE EXCEPTION 'selected contact remains'; END IF;
  IF (SELECT count(*) FROM contacts WHERE id IN ('c1000000-0000-4000-8000-000000000003','c2000000-0000-4000-8000-000000000001')) <> 2 THEN RAISE EXCEPTION 'a NOT selected contact was deleted'; END IF;
  IF EXISTS (SELECT 1 FROM conversations WHERE contact_id IS NULL OR id IN ('d1000000-0000-4000-8000-000000000001','d1000000-0000-4000-8000-000000000002')) THEN RAISE EXCEPTION 'selected conversation remains'; END IF;
  IF (SELECT count(*) FROM conversations WHERE id IN ('d1000000-0000-4000-8000-000000000003','d2000000-0000-4000-8000-000000000001')) <> 2 THEN RAISE EXCEPTION 'a NOT selected conversation was deleted'; END IF;
  IF (SELECT count(*) FROM messages WHERE conversation_id IN ('d1000000-0000-4000-8000-000000000001','d1000000-0000-4000-8000-000000000002')) <> 0 THEN RAISE EXCEPTION 'selected messages remain'; END IF;
  IF (SELECT count(*) FROM messages WHERE conversation_id IN ('d1000000-0000-4000-8000-000000000003','d2000000-0000-4000-8000-000000000001')) <> 6 THEN RAISE EXCEPTION 'NOT selected messages were deleted'; END IF;
  -- history survives with contact_id NULL (deal also detached from the vanished conversation)
  IF (SELECT count(*) FROM deals) <> 2 OR (SELECT contact_id FROM deals WHERE id = 'e1000000-0000-4000-8000-000000000001') IS NOT NULL OR (SELECT conversation_id FROM deals WHERE id = 'e1000000-0000-4000-8000-000000000001') IS NOT NULL THEN RAISE EXCEPTION 'deal history not preserved'; END IF;
  IF (SELECT contact_id FROM deals WHERE id = 'e1000000-0000-4000-8000-000000000003') <> 'c1000000-0000-4000-8000-000000000003' THEN RAISE EXCEPTION 'deal of a NOT selected contact changed'; END IF;
  IF (SELECT count(*) FROM broadcast_recipients) <> 2 OR (SELECT contact_id FROM broadcast_recipients WHERE id = 'ba000000-0000-4000-8000-000000000001') IS NOT NULL THEN RAISE EXCEPTION 'broadcast history not preserved'; END IF;
  IF (SELECT count(*) FROM broadcasts) <> 1 THEN RAISE EXCEPTION 'broadcast deleted'; END IF;
  -- no orphan workers: the selected contact's ACTIVE run is stopped (history kept); the other contact's run is untouched
  IF (SELECT status || '/' || end_reason FROM flow_runs WHERE id = 'f4000000-0000-4000-8000-000000000001') <> 'paused_by_agent/contact_deleted' THEN RAISE EXCEPTION 'active run of a deleted contact not stopped'; END IF;
  IF EXISTS (SELECT 1 FROM flow_runs WHERE status = 'active' AND contact_id IS NULL) THEN RAISE EXCEPTION 'orphan ACTIVE run'; END IF;
  IF (SELECT count(*) FROM flow_run_events) <> 1 THEN RAISE EXCEPTION 'run history lost'; END IF;
  IF (SELECT status FROM flow_runs WHERE id = 'f4000000-0000-4000-8000-000000000003') <> 'active' THEN RAISE EXCEPTION 'run of a NOT selected contact changed'; END IF;
  IF (SELECT status FROM automation_pending_executions WHERE id = 'a6000000-0000-4000-8000-000000000001') <> 'done' THEN RAISE EXCEPTION 'pending wait of a deleted contact not cancelled'; END IF;
  IF (SELECT status FROM automation_pending_executions WHERE id = 'a6000000-0000-4000-8000-000000000003') <> 'pending' THEN RAISE EXCEPTION 'pending wait of a NOT selected contact changed'; END IF;
END $$;

-- ---------- second run on the same ids: they are gone, the batch is rejected, nothing else moves ----------
SELECT pg_temp.expect_error($q$SELECT bulk_delete_contacts_internal('a1000000-0000-4000-8000-000000000001', ARRAY['c1000000-0000-4000-8000-000000000001']::uuid[])$q$, 'CONTACTS_NOT_IN_ACCOUNT');

-- ---------- mid-transaction failure rolls the whole batch back ----------
CREATE FUNCTION pg_temp.boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.id = 'd1000000-0000-4000-8000-000000000003' THEN RAISE EXCEPTION 'boom'; END IF; RETURN OLD; END $$;
CREATE TRIGGER boom BEFORE DELETE ON conversations FOR EACH ROW EXECUTE FUNCTION pg_temp.boom();
INSERT INTO contacts(id, user_id, account_id, phone, name) VALUES ('c1000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', '51900000004', 'A4 fine');
SELECT pg_temp.expect_error($q$SELECT bulk_delete_contacts_internal('a1000000-0000-4000-8000-000000000001', ARRAY['c1000000-0000-4000-8000-000000000004','c1000000-0000-4000-8000-000000000003']::uuid[])$q$, 'boom');
DO $$ BEGIN
  -- the 2-contact batch failed on the second contact: the first one must still exist (savepoint-level atomicity of the function)
  IF (SELECT count(*) FROM contacts WHERE id IN ('c1000000-0000-4000-8000-000000000003','c1000000-0000-4000-8000-000000000004')) <> 2 THEN RAISE EXCEPTION 'partial delete after a failure'; END IF;
  IF (SELECT status FROM flow_runs WHERE id = 'f4000000-0000-4000-8000-000000000003') <> 'active' THEN RAISE EXCEPTION 'run changed although the batch failed'; END IF;
END $$;
DROP TRIGGER boom ON conversations;

-- ---------- time-aware tag filter ----------
INSERT INTO tags(id, user_id, account_id, name, color) VALUES ('7a000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'Cliente', '#000000');
INSERT INTO contacts(id, user_id, account_id, phone, name, created_at) VALUES ('c1000000-0000-4000-8000-000000000005', 'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', '51900000005', 'old tagged', now() - interval '120 days');
INSERT INTO contact_tags(contact_id, tag_id) VALUES ('c1000000-0000-4000-8000-000000000005', '7a000000-0000-4000-8000-000000000001'), ('c1000000-0000-4000-8000-000000000003', '7a000000-0000-4000-8000-000000000001');
DO $$ BEGIN
  IF (SELECT count(*) FROM filter_contacts_by_tags_time(ARRAY['7a000000-0000-4000-8000-000000000001']::uuid[])) <> 2 THEN RAISE EXCEPTION 'no window must equal the plain tag filter'; END IF;
  IF (SELECT count(*) FROM filter_contacts_by_tags_time(ARRAY['7a000000-0000-4000-8000-000000000001']::uuid[], NULL, 25, 0, NULL, now() - interval '90 days')) <> 1 THEN RAISE EXCEPTION 'older than 90 days'; END IF;
  IF (SELECT count(*) FROM filter_contacts_by_tags_time(ARRAY['7a000000-0000-4000-8000-000000000001']::uuid[], NULL, 25, 0, now() - interval '30 days', NULL)) <> 1 THEN RAISE EXCEPTION 'last 30 days'; END IF;
  IF (SELECT total_count FROM filter_contacts_by_tags_time(ARRAY['7a000000-0000-4000-8000-000000000001']::uuid[], 'old', 25, 0, NULL, now() - interval '90 days') LIMIT 1) <> 1 THEN RAISE EXCEPTION 'search + tag + time'; END IF;
  IF (SELECT count(*) FROM filter_contacts_by_tags_time(ARRAY['7a000000-0000-4000-8000-000000000001']::uuid[], 'zzz', 25, 0, NULL, now() - interval '90 days')) <> 0 THEN RAISE EXCEPTION 'search must narrow'; END IF;
  -- the ORIGINAL function still behaves exactly as before
  IF (SELECT count(*) FROM filter_contacts_by_tags(ARRAY['7a000000-0000-4000-8000-000000000001']::uuid[])) <> 2 THEN RAISE EXCEPTION 'original filter_contacts_by_tags changed'; END IF;
END $$;

-- ---------- privileges: only service_role may run the delete ----------
DO $$ BEGIN
  IF has_function_privilege('authenticated', 'bulk_delete_contacts_internal(uuid, uuid[])', 'EXECUTE') OR has_function_privilege('anon', 'bulk_delete_contacts_internal(uuid, uuid[])', 'EXECUTE') THEN RAISE EXCEPTION 'bulk delete callable by a browser role'; END IF;
  IF NOT has_function_privilege('service_role', 'bulk_delete_contacts_internal(uuid, uuid[])', 'EXECUTE') THEN RAISE EXCEPTION 'service_role cannot run it'; END IF;
END $$;

SELECT 'PASS' AS result;
ROLLBACK;
