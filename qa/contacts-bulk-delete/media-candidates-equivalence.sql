-- Equivalence QA for 20261119000002_contact_chat_media_candidates_exists_probe.sql.
-- SAFE ANYWHERE: every object is a session TEMP object. Temp tables named like the real ones shadow them (pg_temp is first in the function
-- search_path), so no real row is read or written and nothing is persisted. Run with:  psql -v ON_ERROR_STOP=1 -f <this file>
-- Compares the previous implementation (cmc_old, copied from 20261106000000) with the new one (cmc_new, copied from 20261119000002).

CREATE TEMP TABLE contacts (id uuid PRIMARY KEY, account_id uuid NOT NULL);
CREATE TEMP TABLE conversations (id uuid PRIMARY KEY, contact_id uuid, account_id uuid);
CREATE TEMP TABLE messages (id serial PRIMARY KEY, conversation_id uuid, media_url text);
CREATE TEMP TABLE flow_nodes (config jsonb);
CREATE TEMP TABLE automation_steps (step_config jsonb);

CREATE OR REPLACE FUNCTION pg_temp.cmc_old(
  p_account_id UUID,
  p_contact_ids UUID[]
)
RETURNS TABLE (media_url TEXT, shared BOOLEAN, message_count BIGINT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_temp, public
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

CREATE OR REPLACE FUNCTION pg_temp.cmc_new(
  p_account_id UUID,
  p_contact_ids UUID[]
)
RETURNS TABLE (media_url TEXT, shared BOOLEAN, message_count BIGINT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_temp, public
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

-- accounts X=a1.., Y=a2..; batch = contacts cA + cC; cB survives (same account); cY belongs to the other account
INSERT INTO contacts VALUES ('c1000000-0000-4000-8000-00000000000a','a1000000-0000-4000-8000-000000000001'),('c1000000-0000-4000-8000-00000000000b','a1000000-0000-4000-8000-000000000001'),
  ('c1000000-0000-4000-8000-00000000000c','a1000000-0000-4000-8000-000000000001'),('c2000000-0000-4000-8000-00000000000a','a2000000-0000-4000-8000-000000000002');
INSERT INTO conversations VALUES ('d1000000-0000-4000-8000-00000000000a','c1000000-0000-4000-8000-00000000000a','a1000000-0000-4000-8000-000000000001'),
  ('d1000000-0000-4000-8000-0000000000a2','c1000000-0000-4000-8000-00000000000a','a1000000-0000-4000-8000-000000000001'),
  ('d1000000-0000-4000-8000-00000000000b','c1000000-0000-4000-8000-00000000000b','a1000000-0000-4000-8000-000000000001'),
  ('d1000000-0000-4000-8000-00000000000c','c1000000-0000-4000-8000-00000000000c','a1000000-0000-4000-8000-000000000001'),
  ('d2000000-0000-4000-8000-00000000000a','c2000000-0000-4000-8000-00000000000a','a2000000-0000-4000-8000-000000000002');
INSERT INTO messages (conversation_id, media_url) VALUES
  ('d1000000-0000-4000-8000-00000000000a','https://x/storage/v1/object/public/chat-media/only.jpg'),('d1000000-0000-4000-8000-0000000000a2','https://x/storage/v1/object/public/chat-media/only.jpg'),
  ('d1000000-0000-4000-8000-0000000000a2','https://x/storage/v1/object/public/chat-media/only.jpg'),('d1000000-0000-4000-8000-00000000000c','https://x/storage/v1/object/public/chat-media/only.jpg'),
  ('d1000000-0000-4000-8000-00000000000a','https://x/storage/v1/object/public/chat-media/survivor.jpg'),('d1000000-0000-4000-8000-00000000000b','https://x/storage/v1/object/public/chat-media/survivor.jpg'),
  ('d1000000-0000-4000-8000-00000000000a','https://x/storage/v1/object/public/chat-media/flow.jpg'),
  ('d1000000-0000-4000-8000-00000000000a','https://x/storage/v1/object/public/chat-media/step.jpg'),
  ('d1000000-0000-4000-8000-00000000000c','https://x/storage/v1/object/public/chat-media/single.jpg'),
  ('d1000000-0000-4000-8000-00000000000a','https://x/storage/v1/object/public/chat-media/othertenant.jpg'),('d2000000-0000-4000-8000-00000000000a','https://x/storage/v1/object/public/chat-media/othertenant.jpg'),
  ('d1000000-0000-4000-8000-00000000000a',NULL),('d1000000-0000-4000-8000-00000000000a','');
INSERT INTO flow_nodes VALUES ('{"url":"https://x/storage/v1/object/public/chat-media/flow.jpg"}'),('{"url":"https://elsewhere/no-storage"}');
INSERT INTO automation_steps VALUES ('{"media":"https://x/storage/v1/object/public/chat-media/step.jpg"}');

CREATE TEMP TABLE r_old AS SELECT * FROM pg_temp.cmc_old('a1000000-0000-4000-8000-000000000001', ARRAY['c1000000-0000-4000-8000-00000000000a','c1000000-0000-4000-8000-00000000000c']::uuid[]);
CREATE TEMP TABLE r_new AS SELECT * FROM pg_temp.cmc_new('a1000000-0000-4000-8000-000000000001', ARRAY['c1000000-0000-4000-8000-00000000000a','c1000000-0000-4000-8000-00000000000c']::uuid[]);

CREATE FUNCTION pg_temp.check(label text, ok boolean) RETURNS void LANGUAGE plpgsql AS $f$ BEGIN IF NOT ok THEN RAISE EXCEPTION 'FAIL: %', label; END IF; RAISE NOTICE 'ok   %', label; END $f$;
CREATE FUNCTION pg_temp.expect_error(q text, code text) RETURNS void LANGUAGE plpgsql AS $f$ BEGIN EXECUTE q; RAISE EXCEPTION 'FAIL: no error for %', q;
  EXCEPTION WHEN raise_exception THEN IF SQLERRM <> code THEN RAISE EXCEPTION 'FAIL: expected % got %', code, SQLERRM; END IF; RAISE NOTICE 'ok   % rejected (%)', q, code; END $f$;

SELECT pg_temp.check('same rows, shared and message_count as the previous implementation (exact difference 0)',
  NOT EXISTS ((SELECT * FROM r_old EXCEPT SELECT * FROM r_new) UNION ALL (SELECT * FROM r_new EXCEPT SELECT * FROM r_old)) AND (SELECT count(*) FROM r_old) = (SELECT count(*) FROM r_new));
SELECT pg_temp.check('1 used only by chats being deleted -> shared=false, message_count=4', (SELECT NOT shared AND message_count = 4 FROM r_new WHERE media_url LIKE '%only.jpg'));
SELECT pg_temp.check('2 also used by a surviving chat -> shared=true', (SELECT shared AND message_count = 1 FROM r_new WHERE media_url LIKE '%survivor.jpg'));
SELECT pg_temp.check('3 referenced by a flow node -> shared=true', (SELECT shared FROM r_new WHERE media_url LIKE '%flow.jpg'));
SELECT pg_temp.check('4 referenced by an automation step -> shared=true', (SELECT shared FROM r_new WHERE media_url LIKE '%step.jpg'));
SELECT pg_temp.check('5 unshared single use -> shared=false, message_count=1', (SELECT NOT shared AND message_count = 1 FROM r_new WHERE media_url LIKE '%single.jpg'));
SELECT pg_temp.check('same URL in another tenant is still treated as shared (unchanged behaviour)', (SELECT shared FROM r_new WHERE media_url LIKE '%othertenant.jpg'));
SELECT pg_temp.check('NULL and empty media_url ignored; 6 distinct urls returned', (SELECT count(*) = 6 FROM r_new));
SELECT pg_temp.expect_error($q$SELECT * FROM pg_temp.cmc_new('a1000000-0000-4000-8000-000000000001', ARRAY['c2000000-0000-4000-8000-00000000000a']::uuid[])$q$, 'CONTACTS_NOT_IN_ACCOUNT');
SELECT pg_temp.expect_error($q$SELECT * FROM pg_temp.cmc_new('a1000000-0000-4000-8000-000000000001', ARRAY['c1000000-0000-4000-8000-00000000000a','c2000000-0000-4000-8000-00000000000a']::uuid[])$q$, 'CONTACTS_NOT_IN_ACCOUNT');
SELECT pg_temp.expect_error($q$SELECT * FROM pg_temp.cmc_new('a1000000-0000-4000-8000-000000000001', ARRAY['99999999-9999-4999-8999-999999999999']::uuid[])$q$, 'CONTACTS_NOT_IN_ACCOUNT');
SELECT pg_temp.expect_error($q$SELECT * FROM pg_temp.cmc_new('a1000000-0000-4000-8000-000000000001', ARRAY[]::uuid[])$q$, 'EMPTY_BATCH');
SELECT pg_temp.expect_error($q$SELECT * FROM pg_temp.cmc_new('a1000000-0000-4000-8000-000000000001', (SELECT array_agg(gen_random_uuid()) FROM generate_series(1,201)))$q$, 'BATCH_TOO_LARGE');

