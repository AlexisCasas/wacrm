-- Behaviour test for 20261129000000_order_logistics_model.sql + 20261129000001_order_logistics_security_rpcs.sql (PR-04: voucher / OCR / review /
-- packaging data layer). Run against a database that already has ALL migrations applied:
--   psql -v ON_ERROR_STOP=1 -f supabase/ci/order-logistics-test.sql
-- One transaction that ends in ROLLBACK, synthetic users/accounts only: nothing persists, no existing row is touched.
BEGIN;

CREATE TEMP TABLE ids (k text PRIMARY KEY, v uuid NOT NULL);

DO $$
DECLARE kk text; u uuid; acc uuid; acc_f uuid; c uuid; conv uuid;
BEGIN
  FOREACH kk IN ARRAY ARRAY['owner','sup','comm','logi','logiv','none','foreign'] LOOP
    u := gen_random_uuid();
    INSERT INTO auth.users (id, email) VALUES (u, 'olg-' || kk || '@example.invalid');
    INSERT INTO ids VALUES (kk, u);
  END LOOP;
  SELECT account_id INTO acc   FROM profiles WHERE user_id = (SELECT v FROM ids WHERE k = 'owner');
  SELECT account_id INTO acc_f FROM profiles WHERE user_id = (SELECT v FROM ids WHERE k = 'foreign');
  INSERT INTO ids VALUES ('acc', acc), ('acc_f', acc_f);
  UPDATE profiles SET account_id = acc, account_role = 'agent' WHERE user_id IN (SELECT v FROM ids WHERE k IN ('sup','comm','logi','none'));
  UPDATE profiles SET account_id = acc, account_role = 'viewer' WHERE user_id = (SELECT v FROM ids WHERE k = 'logiv');
  UPDATE profiles SET operational_role = 'supervisor' WHERE user_id = (SELECT v FROM ids WHERE k = 'sup');
  UPDATE profiles SET operational_role = 'commercial' WHERE user_id = (SELECT v FROM ids WHERE k = 'comm');
  UPDATE profiles SET operational_role = 'logistics'  WHERE user_id IN (SELECT v FROM ids WHERE k IN ('logi','logiv'));
  UPDATE profiles SET operational_role = 'supervisor' WHERE user_id = (SELECT v FROM ids WHERE k = 'foreign');
  INSERT INTO order_integration_settings (account_id, confirm_enabled, logistics_mvp_enabled, multiproduct_enabled) VALUES (acc, TRUE, TRUE, TRUE), (acc_f, TRUE, TRUE, FALSE)
    ON CONFLICT (account_id) DO UPDATE SET confirm_enabled = TRUE, logistics_mvp_enabled = TRUE, multiproduct_enabled = EXCLUDED.multiproduct_enabled;

  -- conversations c1 (order o1), c2 (order o2), c3 (multiproduct order), cf (foreign account)
  FOREACH kk IN ARRAY ARRAY['c1','c2','c3','cf'] LOOP
    c := gen_random_uuid(); conv := gen_random_uuid();
    INSERT INTO contacts (id, user_id, account_id, phone, name)
      VALUES (c, (SELECT v FROM ids WHERE k = CASE WHEN kk = 'cf' THEN 'foreign' ELSE 'owner' END), CASE WHEN kk = 'cf' THEN acc_f ELSE acc END, '5196' || floor(random()*1e8)::int, 'OLG ' || kk);
    INSERT INTO conversations (id, user_id, account_id, contact_id)
      VALUES (conv, (SELECT v FROM ids WHERE k = CASE WHEN kk = 'cf' THEN 'foreign' ELSE 'owner' END), CASE WHEN kk = 'cf' THEN acc_f ELSE acc END, c);
    INSERT INTO ids VALUES ('conv_' || kk, conv), ('contact_' || kk, c);
  END LOOP;

  -- plain orders inserted directly (as they exist for any account)
  INSERT INTO ids SELECT 'o1', gen_random_uuid(); INSERT INTO ids SELECT 'o2', gen_random_uuid(); INSERT INTO ids SELECT 'o3', gen_random_uuid(); INSERT INTO ids SELECT 'of', gen_random_uuid();
  INSERT INTO order_confirmations (id, account_id, conversation_id, customer_name, phone, product, quantity, price, destination, seller_name, confirmed_by_name, request_key, delivery_status)
    VALUES ((SELECT v FROM ids WHERE k='o1'), acc, (SELECT v FROM ids WHERE k='conv_c1'), 'OLG one', '900000001', 'Prod', 1, 10, 'Lima', 'Seller', 'Seller', 'OLG-o1', 'held'),
           ((SELECT v FROM ids WHERE k='o2'), acc, (SELECT v FROM ids WHERE k='conv_c2'), 'OLG two', '900000002', 'Prod', 1, 10, 'Lima', 'Seller', 'Seller', 'OLG-o2', 'held'),
           ((SELECT v FROM ids WHERE k='o3'), acc, NULL, 'OLG three', '900000003', 'Prod', 1, 10, 'Lima', 'Seller', 'Seller', 'OLG-o3', 'held'),
           ((SELECT v FROM ids WHERE k='of'), acc_f, (SELECT v FROM ids WHERE k='conv_cf'), 'OLG foreign', '900000004', 'Prod', 1, 10, 'Lima', 'Seller', 'Seller', 'OLG-of', 'held');

  -- chat media: m1 in c1, m2 in c2, mf in the foreign conversation
  INSERT INTO ids SELECT 'm1', gen_random_uuid(); INSERT INTO ids SELECT 'm2', gen_random_uuid(); INSERT INTO ids SELECT 'mf', gen_random_uuid();
  INSERT INTO messages (id, conversation_id, sender_type, content_type, media_url) VALUES
    ((SELECT v FROM ids WHERE k='m1'), (SELECT v FROM ids WHERE k='conv_c1'), 'customer', 'image', 'https://example.invalid/m1.jpg'),
    ((SELECT v FROM ids WHERE k='m2'), (SELECT v FROM ids WHERE k='conv_c2'), 'customer', 'image', 'https://example.invalid/m2.jpg'),
    ((SELECT v FROM ids WHERE k='mf'), (SELECT v FROM ids WHERE k='conv_cf'), 'customer', 'image', 'https://example.invalid/mf.jpg');
END $$;

CREATE FUNCTION pg_temp.uid(p text) RETURNS uuid LANGUAGE sql AS $$ SELECT v FROM ids WHERE k = p $$;

-- Browser-role probe (authenticated session, RLS applies).
CREATE FUNCTION pg_temp.run(p_caller text, p_sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE c uuid := pg_temp.uid(p_caller); r text; n bigint;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', c, 'role', 'authenticated')::text, TRUE);
  PERFORM set_config('request.jwt.claim.sub', c::text, TRUE);
  SET LOCAL ROLE authenticated;
  BEGIN
    IF p_sql ILIKE 'select%' THEN
      EXECUTE p_sql INTO r;
    ELSIF p_sql ILIKE 'update%' OR p_sql ILIKE 'delete%' THEN
      EXECUTE p_sql; GET DIAGNOSTICS n = ROW_COUNT; r := n::text;
    ELSE
      EXECUTE p_sql; r := 'OK';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    r := 'ERR:' || SQLSTATE || ':' || SQLERRM;
  END;
  RESET ROLE;
  RETURN r;
END $$;

CREATE FUNCTION pg_temp.expect(p_name text, p_actual text, p_expected text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_actual IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'FAIL %: got [%] expected [%]', p_name, p_actual, p_expected; END IF;
  RAISE NOTICE 'PASS %', p_name;
END $$;

CREATE FUNCTION pg_temp.expect(p_name text, p_actual boolean, p_expected text) RETURNS void LANGUAGE sql AS $$ SELECT pg_temp.expect(p_name, p_actual::text, p_expected) $$;

-- Service-role path (the RPCs): errors are returned as {"err": "SQLSTATE:message"} instead of aborting the test.
CREATE FUNCTION pg_temp.rpc(p_sql text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  BEGIN
    EXECUTE p_sql INTO r;
  EXCEPTION WHEN OTHERS THEN
    r := jsonb_build_object('err', SQLSTATE || ':' || SQLERRM);
  END;
  RETURN r;
END $$;

-- One-line summary of an RPC result.
CREATE FUNCTION pg_temp.sm(j jsonb) RETURNS text LANGUAGE sql AS $$
  SELECT CASE
    WHEN j ? 'err' THEN 'ERR:' || (j->>'err')
    WHEN (j->>'ok') = 'true' THEN 'ok' || COALESCE(':created=' || (j->>'created'), '') || COALESCE(':changed=' || (j->>'changed'), '')
    ELSE 'no:' || COALESCE(j->>'reason', '?')
  END $$;

CREATE FUNCTION pg_temp.h(p text) RETURNS text LANGUAGE sql AS $$ SELECT encode(sha256(convert_to(p, 'UTF8')), 'hex') $$;

-- register a voucher: actor key, account key, order key (or NULL = bulk), request key, content seed
CREATE FUNCTION pg_temp.reg(p_actor text, p_acc text, p_order text, p_key text, p_seed text, p_batch uuid DEFAULT NULL, p_allow boolean DEFAULT FALSE) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE d uuid := gen_random_uuid(); o uuid := CASE WHEN p_order IS NULL THEN NULL ELSE pg_temp.uid(p_order) END; r jsonb;
BEGIN
  r := pg_temp.rpc(format('select public.register_order_document(%L,%L,%L,%L,%L,%L,%L,%L,%L,%s,%L,%L)',
    pg_temp.uid(p_acc), pg_temp.uid(p_actor), d, o, p_batch, p_key,
    'account-' || pg_temp.uid(p_acc) || '/orders/' || COALESCE(p_order, 'unassigned') || '/vouchers/' || d || '/v.pdf', 'v.pdf', 'application/pdf', 1000, pg_temp.h(p_seed), p_allow));
  RETURN r;
END $$;

CREATE FUNCTION pg_temp.cnt(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE r text; BEGIN EXECUTE 'select count(*)::text from ' || p_sql INTO r; RETURN r; END $$;
CREATE FUNCTION pg_temp.docid(p_key text) RETURNS uuid LANGUAGE sql AS $$ SELECT id FROM public.order_documents WHERE request_key = p_key $$;
CREATE FUNCTION pg_temp.drow(p_key text, p_col text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE r text; BEGIN EXECUTE format('select %I::text from public.order_documents where request_key = %L', p_col, p_key) INTO r; RETURN r; END $$;
CREATE FUNCTION pg_temp.lrow(p_order text, p_col text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE r text; BEGIN EXECUTE format('select %I::text from public.order_logistics where order_id = %L', p_col, pg_temp.uid(p_order)) INTO r; RETURN COALESCE(r, 'none'); END $$;
CREATE FUNCTION pg_temp.ev(p_where text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE r text; BEGIN EXECUTE format('select COALESCE(string_agg(event_type || case when outcome = ''error'' then ''!'' else '''' end, '','' order by created_at, id), ''-'') from public.order_logistics_events where %s', p_where) INTO r; RETURN r; END $$;
CREATE FUNCTION pg_temp.review(p_actor text, p_key text, p_action text, p_data text DEFAULT NULL, p_expected int DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$
  SELECT pg_temp.rpc(format('select public.review_order_document(%L,%L,%L,%L,%L,%L)', pg_temp.uid('acc'), pg_temp.uid(p_actor), pg_temp.docid(p_key), p_action, p_expected, p_data)) $$;

DO $$
DECLARE
  acc text := 'acc'; f uuid; a uuid; b uuid; r text; n int;
  fn text;
BEGIN
  -- ================= CATALOG: RLS + privileges =================
  PERFORM pg_temp.expect('RLS enabled on the five PR-04 tables',
    (SELECT count(*)::text FROM pg_class WHERE relrowsecurity AND relname IN ('order_logistics_settings','order_documents','order_template_dispatches','order_logistics','order_logistics_events')), '5');
  PERFORM pg_temp.expect('browser roles hold no write privilege on any PR-04 table',
    (SELECT count(*)::text FROM unnest(ARRAY['order_logistics_settings','order_documents','order_template_dispatches','order_logistics','order_logistics_events']) t,
            unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE']) p
      WHERE has_table_privilege('authenticated', 'public.' || t, p) OR has_table_privilege('anon', 'public.' || t, p)), '0');
  PERFORM pg_temp.expect('anon reads nothing, authenticated may SELECT (RLS decides)',
    (SELECT count(*)::text FROM unnest(ARRAY['order_logistics_settings','order_documents','order_template_dispatches','order_logistics','order_logistics_events']) t
      WHERE has_table_privilege('anon', 'public.' || t, 'SELECT'))
    || '/' || (SELECT count(*)::text FROM unnest(ARRAY['order_logistics_settings','order_documents','order_template_dispatches','order_logistics','order_logistics_events']) t
      WHERE has_table_privilege('authenticated', 'public.' || t, 'SELECT')), '0/5');
  FOREACH fn IN ARRAY ARRAY[
    'public.register_order_document(uuid,uuid,uuid,uuid,uuid,text,text,text,text,bigint,text,boolean)',
    'public.begin_document_ocr(uuid,uuid,uuid,integer)',
    'public.complete_document_ocr(uuid,uuid,uuid,integer,text,jsonb)',
    'public.fail_document_ocr(uuid,uuid,uuid,integer,text,text)',
    'public.associate_order_document(uuid,uuid,uuid,uuid,text,jsonb)',
    'public.review_order_document(uuid,uuid,uuid,text,integer,jsonb)',
    'public.start_order_packaging(uuid,uuid,uuid)'] LOOP
    PERFORM pg_temp.expect('RPC is service-role only: ' || fn,
      (has_function_privilege('authenticated', fn, 'EXECUTE') OR has_function_privilege('anon', fn, 'EXECUTE'))::text || '/' || has_function_privilege('service_role', fn, 'EXECUTE')::text, 'false/true');
  END LOOP;
  PERFORM pg_temp.expect('internal helpers are not callable by service_role / browser',
    (has_function_privilege('service_role', 'public.order_logistics_actor(uuid,uuid)', 'EXECUTE') OR has_function_privilege('authenticated', 'public.order_logistics_lock(uuid)', 'EXECUTE'))::text, 'false');

  -- ================= ACTOR VALIDATION (the database re-validates what the backend derived) =================
  PERFORM pg_temp.expect('commercial actor refused', pg_temp.sm(pg_temp.reg('comm', 'acc', 'o1', 'k-comm', 'x1')), 'ERR:42501:forbidden');
  PERFORM pg_temp.expect('no-area actor refused', pg_temp.sm(pg_temp.reg('none', 'acc', 'o1', 'k-none', 'x2')), 'ERR:42501:forbidden');
  PERFORM pg_temp.expect('viewer with logistics area refused (read-only)', pg_temp.sm(pg_temp.reg('logiv', 'acc', 'o1', 'k-viewer', 'x3')), 'ERR:42501:forbidden');
  PERFORM pg_temp.expect('owner without operational area refused', pg_temp.sm(pg_temp.reg('owner', 'acc', 'o1', 'k-owner', 'x4')), 'ERR:42501:forbidden');
  PERFORM pg_temp.expect('supervisor of ANOTHER account refused on this account', pg_temp.sm(pg_temp.reg('foreign', 'acc', 'o1', 'k-foreign', 'x5')), 'ERR:42501:forbidden');
  PERFORM pg_temp.expect('logistics cannot use an order of ANOTHER account', pg_temp.sm(pg_temp.reg('logi', 'acc', 'of', 'k-xacc', 'x6')), 'ERR:42501:forbidden');
  PERFORM pg_temp.expect('non-existent order is indistinguishable from foreign', pg_temp.sm(pg_temp.rpc(format('select public.register_order_document(%L,%L,%L,%L,NULL,%L,%L,%L,%L,10,%L,false)',
    pg_temp.uid('acc'), pg_temp.uid('logi'), gen_random_uuid(), gen_random_uuid(), 'k-ghost', 'account-' || pg_temp.uid('acc') || '/x', 'v.pdf', 'application/pdf', pg_temp.h('g')))), 'ERR:42501:forbidden');
  PERFORM pg_temp.expect('nothing was written by the refused calls', (SELECT count(*)::text FROM order_documents) || '/' || (SELECT count(*)::text FROM order_logistics_events), '0/0');

  -- ================= REGISTER: direct association, idempotency, duplicates =================
  PERFORM pg_temp.expect('logistics registers a voucher on a known order (direct)', pg_temp.sm(pg_temp.reg('logi', 'acc', 'o1', 'k1', 'seed-1')), 'ok:created=true');
  PERFORM pg_temp.expect('document is direct + pending_review + same account', pg_temp.drow('k1', 'association') || '/' || pg_temp.drow('k1', 'status') || '/' || (pg_temp.drow('k1', 'account_id') = pg_temp.uid('acc')::text)::text, 'direct/pending_review/true');
  PERFORM pg_temp.expect('same request_key + same content = idempotent replay', pg_temp.sm(pg_temp.reg('logi', 'acc', 'o1', 'k1', 'seed-1')), 'ok:created=false');
  PERFORM pg_temp.expect('replay did not duplicate document or event', (SELECT count(*)::text FROM order_documents) || '/' || pg_temp.ev('true'), '1/voucher_uploaded');
  PERFORM pg_temp.expect('same request_key + DIFFERENT content is refused', pg_temp.sm(pg_temp.reg('logi', 'acc', 'o1', 'k1', 'other-seed')), 'ERR:22023:request_key_conflict');
  PERFORM pg_temp.expect('same file under another key is reported as duplicate (not inserted)', pg_temp.sm(pg_temp.reg('logi', 'acc', 'o1', 'k1b', 'seed-1')), 'no:duplicate');
  PERFORM pg_temp.expect('same file in ANOTHER order is also a duplicate (account-wide hash)', pg_temp.sm(pg_temp.reg('sup', 'acc', 'o2', 'k1c', 'seed-1')), 'no:duplicate');
  PERFORM pg_temp.expect('a deliberate duplicate is allowed explicitly', pg_temp.sm(pg_temp.reg('logi', 'acc', 'o1', 'k1d', 'seed-1', NULL, TRUE)), 'ok:created=true');
  PERFORM pg_temp.expect('supervisor may register too', pg_temp.sm(pg_temp.reg('sup', 'acc', 'o2', 'k2', 'seed-2')), 'ok:created=true');
  PERFORM pg_temp.expect('bulk voucher (no order) is pending association', pg_temp.sm(pg_temp.reg('logi', 'acc', NULL, 'kb1', 'seed-b1', gen_random_uuid())) || '/' || pg_temp.drow('kb1', 'association') || '/' || COALESCE(pg_temp.drow('kb1', 'order_id'), 'null'), 'ok:created=true/pending/null');

  -- ================= RLS READS =================
  PERFORM pg_temp.expect('logistics reads documents', pg_temp.run('logi', 'select count(*) from public.order_documents'), '4');
  PERFORM pg_temp.expect('supervisor reads documents', pg_temp.run('sup', 'select count(*) from public.order_documents'), '4');
  PERFORM pg_temp.expect('commercial reads NOTHING (also with routing shared / any stage)', pg_temp.run('comm', 'select count(*) from public.order_documents') || '/' || pg_temp.run('comm', 'select count(*) from public.order_logistics_events'), '0/0');
  PERFORM pg_temp.expect('no-area / owner without area read NOTHING', pg_temp.run('none', 'select count(*) from public.order_documents') || '/' || pg_temp.run('owner', 'select count(*) from public.order_documents'), '0/0');
  PERFORM pg_temp.expect('another account supervisor reads NOTHING (cross-account)', pg_temp.run('foreign', 'select count(*) from public.order_documents') || '/' || pg_temp.run('foreign', 'select count(*) from public.order_logistics_events'), '0/0');
  PERFORM pg_temp.expect('viewer with logistics area reads NOTHING (same bar as PR-02: agent+)', pg_temp.run('logiv', 'select count(*) from public.order_documents'), '0');
  PERFORM pg_temp.expect('browser cannot write documents / events / logistics',
    CASE WHEN pg_temp.run('logi', 'insert into public.order_documents (account_id, kind, status, association, request_key, storage_path, original_filename, mime_type, size_bytes, content_hash, source, uploaded_by) select account_id, ''voucher'', ''pending_review'', ''pending'', ''hack'', ''account-x/y'', ''a'', ''b'', 1, repeat(''a'', 64), ''upload'', user_id from public.profiles limit 1') LIKE 'ERR:42501%' THEN 'denied' ELSE 'LEAK' END
    || '/' || CASE WHEN pg_temp.run('sup', 'update public.order_documents set status = ''validated''') LIKE 'ERR:42501%' THEN 'denied' ELSE 'LEAK' END
    || '/' || CASE WHEN pg_temp.run('sup', 'delete from public.order_logistics_events') LIKE 'ERR:42501%' THEN 'denied' ELSE 'LEAK' END
    || '/' || CASE WHEN pg_temp.run('sup', 'insert into public.order_logistics (order_id, account_id, status) select id, account_id, ''pending_voucher'' from public.order_confirmations limit 1') LIKE 'ERR:42501%' THEN 'denied' ELSE 'LEAK' END,
    'denied/denied/denied/denied');
  UPDATE order_integration_settings SET logistics_mvp_enabled = FALSE WHERE account_id = pg_temp.uid('acc');
  PERFORM pg_temp.expect('flag OFF: logistics reads nothing and RPC refuses (legacy account untouched)', pg_temp.run('logi', 'select count(*) from public.order_documents') || '/' || pg_temp.sm(pg_temp.reg('logi', 'acc', 'o1', 'k-off', 'seed-off')), '0/ERR:42501:feature_disabled');
  UPDATE order_integration_settings SET logistics_mvp_enabled = TRUE WHERE account_id = pg_temp.uid('acc');
  PERFORM pg_temp.expect('flag ON again: logistics reads again', pg_temp.run('logi', 'select count(*) from public.order_documents'), '4');

  -- ================= OCR attempts =================
  a := pg_temp.docid('k1');
  PERFORM pg_temp.expect('begin OCR -> attempt 1', pg_temp.rpc(format('select public.begin_document_ocr(%L,%L,%L)', pg_temp.uid('acc'), pg_temp.uid('logi'), a))->>'attempt', '1');
  PERFORM pg_temp.expect('second begin while one is in flight -> in_progress (no double OCR)', pg_temp.sm(pg_temp.rpc(format('select public.begin_document_ocr(%L,%L,%L)', pg_temp.uid('acc'), pg_temp.uid('sup'), a))), 'no:in_progress');
  PERFORM pg_temp.expect('stale attempt number is rejected', pg_temp.sm(pg_temp.rpc(format('select public.complete_document_ocr(%L,%L,%L,2,%L,%L)', pg_temp.uid('acc'), pg_temp.uid('logi'), a, 'fake', '{"fields":{"dni":{"value":"1","confidence":0.9}}}'))), 'no:stale_attempt');
  PERFORM pg_temp.expect('confidence outside 0..1 is rejected', pg_temp.sm(pg_temp.rpc(format('select public.complete_document_ocr(%L,%L,%L,1,%L,%L)', pg_temp.uid('acc'), pg_temp.uid('logi'), a, 'fake', '{"fields":{"dni":{"value":"1","confidence":1.5}}}'))), 'ERR:22023:invalid_ocr_result');
  PERFORM pg_temp.expect('result without fields is rejected', pg_temp.sm(pg_temp.rpc(format('select public.complete_document_ocr(%L,%L,%L,1,%L,%L)', pg_temp.uid('acc'), pg_temp.uid('logi'), a, 'fake', '{"x":1}'))), 'ERR:22023:invalid_ocr_result');
  PERFORM pg_temp.expect('complete OCR (fake provider)', pg_temp.sm(pg_temp.rpc(format('select public.complete_document_ocr(%L,%L,%L,1,%L,%L)', pg_temp.uid('acc'), pg_temp.uid('logi'), a, 'fake', '{"fields":{"dni":{"value":"12345678","confidence":0.9},"phone":{"value":"51900000001","confidence":0.4}}}'))), 'ok');
  PERFORM pg_temp.expect('OCR stored, last normalized result only', pg_temp.drow('k1', 'ocr_status') || '/' || pg_temp.drow('k1', 'ocr_attempts') || '/' || pg_temp.drow('k1', 'ocr_provider') || '/' || (SELECT ocr_result->'fields'->'dni'->>'value' FROM order_documents WHERE id = a), 'done/1/fake/12345678');
  PERFORM pg_temp.expect('OCR audit has no PII (counts / min confidence only)', (SELECT detail::text FROM order_logistics_events WHERE document_id = a AND event_type = 'ocr_completed'), '{"fields": 2, "min_confidence": 0.4}');
  PERFORM pg_temp.expect('retry OCR after done -> attempt 2', pg_temp.rpc(format('select public.begin_document_ocr(%L,%L,%L)', pg_temp.uid('acc'), pg_temp.uid('logi'), a))->>'attempt', '2');
  PERFORM pg_temp.expect('invalid error code refused', pg_temp.sm(pg_temp.rpc(format('select public.fail_document_ocr(%L,%L,%L,2,%L,%L)', pg_temp.uid('acc'), pg_temp.uid('logi'), a, 'fake', 'Bad Code!'))), 'ERR:22023:invalid_error_code');
  PERFORM pg_temp.expect('OCR failure recorded', pg_temp.sm(pg_temp.rpc(format('select public.fail_document_ocr(%L,%L,%L,2,%L,%L)', pg_temp.uid('acc'), pg_temp.uid('logi'), a, 'fake', 'ocr_timeout'))) || '/' || pg_temp.drow('k1', 'ocr_status') || '/' || pg_temp.drow('k1', 'ocr_error_code'), 'ok/failed/ocr_timeout');
  PERFORM pg_temp.expect('a failed OCR keeps the previous normalized result (no silent overwrite)', (SELECT ocr_result->'fields'->'dni'->>'value' FROM order_documents WHERE id = a), '12345678');
  PERFORM pg_temp.expect('OCR timeout: a claim older than the stale window can be retaken', (
    SELECT pg_temp.rpc(format('select public.begin_document_ocr(%L,%L,%L)', pg_temp.uid('acc'), pg_temp.uid('logi'), a))->>'attempt'), '3');
  UPDATE order_documents SET ocr_claimed_at = now() - interval '10 minutes' WHERE id = a;
  PERFORM pg_temp.expect('stale pending claim (provider hung) -> new attempt allowed', pg_temp.rpc(format('select public.begin_document_ocr(%L,%L,%L)', pg_temp.uid('acc'), pg_temp.uid('logi'), a))->>'attempt', '4');
  PERFORM pg_temp.expect('OCR of another account document is refused', pg_temp.sm(pg_temp.rpc(format('select public.begin_document_ocr(%L,%L,%L)', pg_temp.uid('acc_f'), pg_temp.uid('foreign'), a))), 'ERR:42501:forbidden');
  PERFORM pg_temp.expect('OCR audit trail of the document',
    pg_temp.ev('document_id = ' || quote_literal(a) || ' AND event_type LIKE ''ocr_%'''), 'ocr_started,ocr_completed,ocr_started,ocr_failed!,ocr_started,ocr_started');

  -- ================= ASSOCIATION =================
  b := pg_temp.docid('kb1');
  PERFORM pg_temp.expect('a voucher pending association can NOT be validated', pg_temp.sm(pg_temp.review('logi', 'kb1', 'validate', '{"dni":"1"}')), 'no:association_required');
  PERFORM pg_temp.expect('auto association to an order of another account is refused', pg_temp.sm(pg_temp.rpc(format('select public.associate_order_document(%L,%L,%L,%L,%L,%L)', pg_temp.uid('acc'), pg_temp.uid('logi'), b, pg_temp.uid('of'), 'auto', '["dni","phone"]'))), 'ERR:42501:forbidden');
  PERFORM pg_temp.expect('invalid signal payload refused', pg_temp.sm(pg_temp.rpc(format('select public.associate_order_document(%L,%L,%L,%L,%L,%L)', pg_temp.uid('acc'), pg_temp.uid('logi'), b, pg_temp.uid('o2'), 'auto', '{"a":1}'))), 'ERR:22023:invalid_signals');
  PERFORM pg_temp.expect('auto association (single safe candidate) is recorded', pg_temp.sm(pg_temp.rpc(format('select public.associate_order_document(%L,%L,%L,%L,%L,%L)', pg_temp.uid('acc'), pg_temp.uid('logi'), b, pg_temp.uid('o2'), 'auto', '["dni","phone"]')))
    || '/' || pg_temp.drow('kb1', 'association') || '/' || (pg_temp.drow('kb1', 'order_id') = pg_temp.uid('o2')::text)::text, 'ok:changed=true/auto/true');
  PERFORM pg_temp.expect('auto association stays unvalidated (a human must still validate)', pg_temp.drow('kb1', 'status') || '/' || pg_temp.lrow('o2', 'status'), 'pending_review/none');
  PERFORM pg_temp.expect('auto on an already associated document is refused', pg_temp.sm(pg_temp.rpc(format('select public.associate_order_document(%L,%L,%L,%L,%L)', pg_temp.uid('acc'), pg_temp.uid('logi'), b, pg_temp.uid('o1'), 'auto'))), 'no:not_pending');
  PERFORM pg_temp.expect('manual re-association by a person is allowed before validation', pg_temp.sm(pg_temp.rpc(format('select public.associate_order_document(%L,%L,%L,%L,%L)', pg_temp.uid('acc'), pg_temp.uid('sup'), b, pg_temp.uid('o1'), 'manual'))) || '/' || pg_temp.drow('kb1', 'association'), 'ok:changed=true/manual');
  PERFORM pg_temp.expect('same manual association again is idempotent', pg_temp.sm(pg_temp.rpc(format('select public.associate_order_document(%L,%L,%L,%L,%L)', pg_temp.uid('acc'), pg_temp.uid('sup'), b, pg_temp.uid('o1'), 'manual'))), 'ok:changed=false');
  PERFORM pg_temp.expect('a direct (order-screen) voucher can not be re-associated', pg_temp.sm(pg_temp.rpc(format('select public.associate_order_document(%L,%L,%L,%L,%L)', pg_temp.uid('acc'), pg_temp.uid('sup'), pg_temp.docid('k2'), pg_temp.uid('o1'), 'manual'))), 'no:direct_locked');
  PERFORM pg_temp.expect('association audit', pg_temp.ev('document_id = ' || quote_literal(b)), 'voucher_uploaded,voucher_associated,voucher_associated');

  -- ================= REVIEW / VALIDATION =================
  PERFORM pg_temp.expect('validate without reviewed data is refused', pg_temp.sm(pg_temp.review('logi', 'k2', 'validate')), 'no:reviewed_data_required');
  PERFORM pg_temp.expect('manual correction stores reviewed_data and bumps row_version', pg_temp.sm(pg_temp.review('logi', 'k2', 'correct', '{"dni":"87654321","amount":"30.00"}')) || '/' || pg_temp.drow('k2', 'row_version') || '/' || ((pg_temp.drow('k2', 'reviewed_data'))::jsonb ->> 'dni'), 'ok:changed=true/2/87654321');
  PERFORM pg_temp.expect('correction audit lists field NAMES only', (SELECT detail::text FROM order_logistics_events WHERE event_type = 'voucher_corrected' AND document_id = pg_temp.docid('k2')), '{"fields": ["amount", "dni"]}');
  PERFORM pg_temp.expect('stale expected row_version refused (two operators)', pg_temp.sm(pg_temp.review('sup', 'k2', 'validate', NULL, 1)), 'no:stale');
  PERFORM pg_temp.expect('validate OK -> voucher_validated, version 1', pg_temp.sm(pg_temp.review('logi', 'k2', 'validate', NULL, 2)) || '/' || pg_temp.drow('k2', 'status') || '/' || pg_temp.drow('k2', 'version') || '/' || pg_temp.lrow('o2', 'status'), 'ok:changed=true/validated/1/voucher_validated');
  PERFORM pg_temp.expect('order_logistics points at the validated voucher', (pg_temp.lrow('o2', 'voucher_document_id') = pg_temp.docid('k2')::text)::text || '/' || (pg_temp.lrow('o2', 'validated_by') = pg_temp.uid('logi')::text)::text, 'true/true');
  PERFORM pg_temp.expect('validate twice is idempotent (no second event)', pg_temp.sm(pg_temp.review('sup', 'k2', 'validate')) || '/' || pg_temp.ev('document_id = ' || quote_literal(pg_temp.docid('k2')) || ' AND event_type = ''voucher_validated'''), 'ok:changed=false/voucher_validated');
  PERFORM pg_temp.expect('validated voucher can not be corrected / rejected / re-OCRd', pg_temp.sm(pg_temp.review('logi', 'k2', 'correct', '{"dni":"1"}')) || '/' || pg_temp.sm(pg_temp.review('logi', 'k2', 'reject'))
    || '/' || pg_temp.sm(pg_temp.rpc(format('select public.begin_document_ocr(%L,%L,%L)', pg_temp.uid('acc'), pg_temp.uid('logi'), pg_temp.docid('k2')))), 'no:frozen/no:frozen/no:frozen');
  PERFORM pg_temp.expect('validated data is frozen even for a privileged writer', pg_temp.sm(pg_temp.rpc(format('with u as (update public.order_documents set reviewed_data = %L where request_key = ''k2'' returning 1) select jsonb_build_object(''ok'', true) from u', '{"dni":"tampered"}'))), 'ERR:42501:a validated, rejected or superseded document is frozen');
  PERFORM pg_temp.expect('one-sided OCR rewrite of a validated voucher is also blocked', pg_temp.sm(pg_temp.rpc('with u as (update public.order_documents set ocr_result = ''{"fields":{}}'' where request_key = ''k2'' returning 1) select jsonb_build_object(''ok'', true) from u')), 'ERR:42501:a validated, rejected or superseded document is frozen');
  PERFORM pg_temp.expect('reject a voucher (wrong file)', pg_temp.sm(pg_temp.review('logi', 'kb1', 'reject')) || '/' || pg_temp.drow('kb1', 'status'), 'ok:changed=true/rejected');
  PERFORM pg_temp.expect('rejected is final', pg_temp.sm(pg_temp.review('logi', 'kb1', 'validate', '{"x":1}')), 'no:frozen');

  -- new legitimate VERSION of the voucher (order still voucher_validated)
  PERFORM pg_temp.expect('new voucher version can be uploaded before packaging', pg_temp.sm(pg_temp.reg('logi', 'acc', 'o2', 'k2v2', 'seed-2-v2')), 'ok:created=true');
  PERFORM pg_temp.expect('validating v2 supersedes v1 (kept) and repoints the order', pg_temp.sm(pg_temp.review('logi', 'k2v2', 'validate', '{"dni":"87654321"}'))
    || '/' || pg_temp.drow('k2', 'status') || '/' || pg_temp.drow('k2v2', 'version') || '/' || (pg_temp.lrow('o2', 'voucher_document_id') = pg_temp.docid('k2v2')::text)::text || '/' || pg_temp.lrow('o2', 'version'),
    'ok:changed=true/superseded/2/true/2');
  PERFORM pg_temp.expect('exactly one validated voucher per order; nothing deleted', (SELECT count(*)::text FROM order_documents WHERE order_id = pg_temp.uid('o2') AND status = 'validated') || '/' || (SELECT count(*)::text FROM order_documents WHERE order_id = pg_temp.uid('o2') AND kind = 'voucher'), '1/2');
  PERFORM pg_temp.expect('supersede audit', pg_temp.ev('order_id = ' || quote_literal(pg_temp.uid('o2')) || ' AND event_type IN (''voucher_superseded'', ''voucher_validated'')'), 'voucher_validated,voucher_superseded,voucher_validated');

  -- ================= PACKAGING GATE =================
  PERFORM pg_temp.expect('packaging needs a validated voucher', pg_temp.sm(pg_temp.rpc(format('select public.start_order_packaging(%L,%L,%L)', pg_temp.uid('acc'), pg_temp.uid('logi'), pg_temp.uid('o3')))), 'no:voucher_required');
  PERFORM pg_temp.expect('commercial cannot start packaging', pg_temp.sm(pg_temp.rpc(format('select public.start_order_packaging(%L,%L,%L)', pg_temp.uid('acc'), pg_temp.uid('comm'), pg_temp.uid('o2')))), 'ERR:42501:forbidden');
  PERFORM pg_temp.expect('cross-account packaging refused', pg_temp.sm(pg_temp.rpc(format('select public.start_order_packaging(%L,%L,%L)', pg_temp.uid('acc'), pg_temp.uid('logi'), pg_temp.uid('of')))), 'ERR:42501:forbidden');
  PERFORM pg_temp.expect('start packaging: voucher_validated -> packing', pg_temp.sm(pg_temp.rpc(format('select public.start_order_packaging(%L,%L,%L)', pg_temp.uid('acc'), pg_temp.uid('logi'), pg_temp.uid('o2')))) || '/' || pg_temp.lrow('o2', 'status'), 'ok:changed=true/packing');
  PERFORM pg_temp.expect('start packaging twice is idempotent', pg_temp.sm(pg_temp.rpc(format('select public.start_order_packaging(%L,%L,%L)', pg_temp.uid('acc'), pg_temp.uid('sup'), pg_temp.uid('o2')))) || '/' || pg_temp.ev('event_type = ''packaging_started'''), 'ok:changed=false/packaging_started');
  PERFORM pg_temp.expect('once packing: new voucher / association / validation are locked',
    pg_temp.sm(pg_temp.reg('logi', 'acc', 'o2', 'k2v3', 'seed-2-v3')) || '/' || pg_temp.sm(pg_temp.reg('logi', 'acc', NULL, 'kb2', 'seed-b2'))
    || '/' || pg_temp.sm(pg_temp.rpc(format('select public.associate_order_document(%L,%L,%L,%L,%L)', pg_temp.uid('acc'), pg_temp.uid('logi'), pg_temp.docid('kb2'), pg_temp.uid('o2'), 'manual'))), 'no:order_locked/ok:created=true/no:order_locked');
  PERFORM pg_temp.expect('the validated voucher of a packing order is frozen', pg_temp.sm(pg_temp.rpc(format('with u as (update public.order_logistics set voucher_document_id = %L where order_id = %L returning 1) select jsonb_build_object(''ok'', true) from u', pg_temp.docid('k2'), pg_temp.uid('o2')))), 'ERR:22023:the voucher is frozen once packaging started');

  -- ================= GUARD TRIGGERS (direct writes, as a privileged role) =================
  INSERT INTO order_logistics (order_id, account_id, status) VALUES (pg_temp.uid('o3'), pg_temp.uid('acc'), 'pending_voucher');
  PERFORM pg_temp.expect('illegal status jump pending_voucher -> packing is blocked', pg_temp.sm(pg_temp.rpc(format('with u as (update public.order_logistics set status = ''packing'', packaging_started_at = now() where order_id = %L returning 1) select jsonb_build_object(''ok'', true) from u', pg_temp.uid('o3')))), 'ERR:22023:illegal logistics status transition pending_voucher -> packing');
  PERFORM pg_temp.expect('a logistics row can not move to another account / order', pg_temp.sm(pg_temp.rpc(format('with u as (update public.order_logistics set account_id = %L where order_id = %L returning 1) select jsonb_build_object(''ok'', true) from u', pg_temp.uid('acc_f'), pg_temp.uid('o3')))), 'ERR:42501:order_logistics identity is immutable');
  PERFORM pg_temp.expect('a logistics row for an order of ANOTHER account is blocked', pg_temp.sm(pg_temp.rpc(format('with i as (insert into public.order_logistics (order_id, account_id, status) values (%L,%L,''pending_voucher'') returning 1) select jsonb_build_object(''ok'', true) from i', pg_temp.uid('of'), pg_temp.uid('acc')))), 'ERR:42501:order does not belong to the account');
  PERFORM pg_temp.expect('ready_for_dispatch requires a SENT dispatch (shape check)', pg_temp.sm(pg_temp.rpc(format('with u as (update public.order_logistics set status = ''ready_for_dispatch'', version = version + 1, packaging_completed_at = now(), packaging_completed_by = %L where order_id = %L returning 1) select jsonb_build_object(''ok'', true) from u', pg_temp.uid('logi'), pg_temp.uid('o2')))) LIKE 'ERR:23514%', 'true');
  PERFORM pg_temp.expect('events are append-only (UPDATE)', pg_temp.sm(pg_temp.rpc('with u as (update public.order_logistics_events set outcome = ''error'' returning 1) select jsonb_build_object(''ok'', true) from u')), 'ERR:42501:order_logistics_events is append-only');
  PERFORM pg_temp.expect('events are append-only (DELETE)', pg_temp.sm(pg_temp.rpc('with d as (delete from public.order_logistics_events returning 1) select jsonb_build_object(''ok'', true) from d')) LIKE 'ERR:42501:order_logistics_events rows cannot be deleted%', 'true');
  PERFORM pg_temp.expect('documents cannot be deleted directly', pg_temp.sm(pg_temp.rpc('with d as (delete from public.order_documents returning 1) select jsonb_build_object(''ok'', true) from d')) LIKE 'ERR:42501:order_documents rows cannot be deleted%', 'true');
  PERFORM pg_temp.expect('document of account A pointing to an order of account B is blocked at the table', pg_temp.sm(pg_temp.rpc(format('with i as (insert into public.order_documents (account_id, order_id, kind, status, association, request_key, storage_path, original_filename, mime_type, size_bytes, content_hash, source, uploaded_by) values (%L,%L,''voucher'',''pending_review'',''direct'',''raw-x'',%L,''a'',''b'',1,%L,''upload'',%L) returning 1) select jsonb_build_object(''ok'', true) from i',
    pg_temp.uid('acc'), pg_temp.uid('of'), 'account-' || pg_temp.uid('acc') || '/x', repeat('a', 64), pg_temp.uid('logi')))), 'ERR:42501:order does not belong to the account');
  PERFORM pg_temp.expect('storage path of another account is blocked (check)', pg_temp.sm(pg_temp.rpc(format('with i as (insert into public.order_documents (account_id, order_id, kind, status, association, request_key, storage_path, original_filename, mime_type, size_bytes, content_hash, source, uploaded_by) values (%L,%L,''voucher'',''pending_review'',''direct'',''raw-y'',%L,''a'',''b'',1,%L,''upload'',%L) returning 1) select jsonb_build_object(''ok'', true) from i',
    pg_temp.uid('acc'), pg_temp.uid('o1'), 'account-' || pg_temp.uid('acc_f') || '/x', repeat('a', 64), pg_temp.uid('logi')))) LIKE 'ERR:23514%', 'true');
  PERFORM pg_temp.expect('events of account A on an order of account B are blocked', pg_temp.sm(pg_temp.rpc(format('with i as (insert into public.order_logistics_events (account_id, order_id, event_type) values (%L,%L,''packaging_started'') returning 1) select jsonb_build_object(''ok'', true) from i', pg_temp.uid('acc'), pg_temp.uid('of')))), 'ERR:42501:order does not belong to the account');

  -- evidence snapshots (chat media): the message must belong to the ORDER'S conversation
  PERFORM pg_temp.expect('evidence from the order conversation is accepted by the table', pg_temp.sm(pg_temp.rpc(format('with i as (insert into public.order_documents (account_id, order_id, kind, status, association, request_key, storage_path, original_filename, mime_type, size_bytes, content_hash, source, source_message_id, uploaded_by) values (%L,%L,''evidence'',''active'',''direct'',''ev-1'',%L,''e.jpg'',''image/jpeg'',10,%L,''chat_message'',%L,%L) returning 1) select jsonb_build_object(''ok'', true) from i',
    pg_temp.uid('acc'), pg_temp.uid('o1'), 'account-' || pg_temp.uid('acc') || '/orders/o1/evidence/e1/e.jpg', pg_temp.h('e1'), pg_temp.uid('m1'), pg_temp.uid('logi')))), 'ok');
  PERFORM pg_temp.expect('evidence from ANOTHER conversation of the same account is blocked', pg_temp.sm(pg_temp.rpc(format('with i as (insert into public.order_documents (account_id, order_id, kind, status, association, request_key, storage_path, original_filename, mime_type, size_bytes, content_hash, source, source_message_id, uploaded_by) values (%L,%L,''evidence'',''active'',''direct'',''ev-2'',%L,''e.jpg'',''image/jpeg'',10,%L,''chat_message'',%L,%L) returning 1) select jsonb_build_object(''ok'', true) from i',
    pg_temp.uid('acc'), pg_temp.uid('o1'), 'account-' || pg_temp.uid('acc') || '/orders/o1/evidence/e2/e.jpg', pg_temp.h('e2'), pg_temp.uid('m2'), pg_temp.uid('logi')))), 'ERR:42501:message is not part of the order conversation');
  PERFORM pg_temp.expect('evidence from ANOTHER ACCOUNT is blocked', pg_temp.sm(pg_temp.rpc(format('with i as (insert into public.order_documents (account_id, order_id, kind, status, association, request_key, storage_path, original_filename, mime_type, size_bytes, content_hash, source, source_message_id, uploaded_by) values (%L,%L,''evidence'',''active'',''direct'',''ev-3'',%L,''e.jpg'',''image/jpeg'',10,%L,''chat_message'',%L,%L) returning 1) select jsonb_build_object(''ok'', true) from i',
    pg_temp.uid('acc'), pg_temp.uid('o1'), 'account-' || pg_temp.uid('acc') || '/orders/o1/evidence/e3/e.jpg', pg_temp.h('e3'), pg_temp.uid('mf'), pg_temp.uid('logi')))), 'ERR:42501:message is not part of the order conversation');
  PERFORM pg_temp.expect('evidence can not be an upload and needs an order (shape)', pg_temp.sm(pg_temp.rpc(format('with i as (insert into public.order_documents (account_id, order_id, kind, status, association, request_key, storage_path, original_filename, mime_type, size_bytes, content_hash, source, uploaded_by) values (%L,%L,''evidence'',''active'',''direct'',''ev-4'',%L,''e.jpg'',''image/jpeg'',10,%L,''upload'',%L) returning 1) select jsonb_build_object(''ok'', true) from i',
    pg_temp.uid('acc'), pg_temp.uid('o1'), 'account-' || pg_temp.uid('acc') || '/x', pg_temp.h('e4'), pg_temp.uid('logi')))) LIKE 'ERR:23514%', 'true');
  PERFORM pg_temp.expect('one active evidence per order', pg_temp.sm(pg_temp.rpc(format('with i as (insert into public.order_documents (account_id, order_id, kind, status, association, request_key, storage_path, original_filename, mime_type, size_bytes, content_hash, source, source_message_id, uploaded_by) values (%L,%L,''evidence'',''active'',''direct'',''ev-5'',%L,''e.jpg'',''image/jpeg'',10,%L,''chat_message'',%L,%L) returning 1) select jsonb_build_object(''ok'', true) from i',
    pg_temp.uid('acc'), pg_temp.uid('o1'), 'account-' || pg_temp.uid('acc') || '/orders/o1/evidence/e5/e.jpg', pg_temp.h('e5'), pg_temp.uid('m1'), pg_temp.uid('logi')))) LIKE 'ERR:23505%', 'true');
  PERFORM pg_temp.expect('deleting the chat message keeps the evidence snapshot (source_message_id -> NULL)', pg_temp.sm(pg_temp.rpc(format('with d as (delete from public.messages where id = %L returning 1) select jsonb_build_object(''ok'', true) from d', pg_temp.uid('m1')))) || '/' || (pg_temp.drow('ev-1', 'source_message_id') IS NULL)::text || '/' || pg_temp.drow('ev-1', 'status'), 'ok/true/active');

  -- dispatch table guards (the RPCs of the send arrive with the packaging stage; the table rules are already enforced)
  INSERT INTO ids SELECT 'ev1', id FROM order_documents WHERE request_key = 'ev-1';
  PERFORM pg_temp.expect('dispatch requires evidence of the same order + the order conversation', pg_temp.sm(pg_temp.rpc(format('with i as (insert into public.order_template_dispatches (account_id, order_id, request_key, evidence_document_id, conversation_id, template_name, template_language, actor_user_id) values (%L,%L,''d-1'',%L,%L,''t'',''es'',%L) returning 1) select jsonb_build_object(''ok'', true) from i',
    pg_temp.uid('acc'), pg_temp.uid('o2'), pg_temp.uid('ev1'), pg_temp.uid('conv_c2'), pg_temp.uid('logi')))), 'ERR:42501:evidence does not belong to the order');
  PERFORM pg_temp.expect('dispatch claimed for o1 (conversation of the order)', pg_temp.sm(pg_temp.rpc(format('with i as (insert into public.order_template_dispatches (account_id, order_id, request_key, evidence_document_id, conversation_id, template_name, template_language, actor_user_id) values (%L,%L,''d-1'',%L,%L,''t'',''es'',%L) returning 1) select jsonb_build_object(''ok'', true) from i',
    pg_temp.uid('acc'), pg_temp.uid('o1'), pg_temp.uid('ev1'), pg_temp.uid('conv_c1'), pg_temp.uid('logi')))), 'ok');
  PERFORM pg_temp.expect('a second OPEN dispatch for the same order is impossible (double click / two operators)', pg_temp.sm(pg_temp.rpc(format('with i as (insert into public.order_template_dispatches (account_id, order_id, request_key, evidence_document_id, conversation_id, template_name, template_language, actor_user_id) values (%L,%L,''d-2'',%L,%L,''t'',''es'',%L) returning 1) select jsonb_build_object(''ok'', true) from i',
    pg_temp.uid('acc'), pg_temp.uid('o1'), pg_temp.uid('ev1'), pg_temp.uid('conv_c1'), pg_temp.uid('logi')))) LIKE 'ERR:23505%', 'true');
  PERFORM pg_temp.expect('same request_key twice is impossible', pg_temp.sm(pg_temp.rpc(format('with i as (insert into public.order_template_dispatches (account_id, order_id, request_key, evidence_document_id, conversation_id, template_name, template_language, actor_user_id) values (%L,%L,''d-1'',%L,%L,''t'',''es'',%L) returning 1) select jsonb_build_object(''ok'', true) from i',
    pg_temp.uid('acc'), pg_temp.uid('o1'), pg_temp.uid('ev1'), pg_temp.uid('conv_c1'), pg_temp.uid('logi')))) LIKE 'ERR:23505%', 'true');
  PERFORM pg_temp.expect('claimed -> sent directly is illegal', pg_temp.sm(pg_temp.rpc('with u as (update public.order_template_dispatches set status = ''sent'', wamid = ''w1'' returning 1) select jsonb_build_object(''ok'', true) from u')), 'ERR:22023:illegal dispatch status transition claimed -> sent');
  UPDATE order_template_dispatches SET status = 'sending', sending_at = now() WHERE request_key = 'd-1';
  UPDATE order_template_dispatches SET status = 'uncertain', finished_at = now(), error_code = 'persist_failed' WHERE request_key = 'd-1';
  PERFORM pg_temp.expect('uncertain keeps blocking new dispatches', pg_temp.sm(pg_temp.rpc(format('with i as (insert into public.order_template_dispatches (account_id, order_id, request_key, evidence_document_id, conversation_id, template_name, template_language, actor_user_id) values (%L,%L,''d-3'',%L,%L,''t'',''es'',%L) returning 1) select jsonb_build_object(''ok'', true) from i',
    pg_temp.uid('acc'), pg_temp.uid('o1'), pg_temp.uid('ev1'), pg_temp.uid('conv_c1'), pg_temp.uid('logi')))) LIKE 'ERR:23505%', 'true');
  PERFORM pg_temp.expect('uncertain can not resolve silently (needs resolution + person)', pg_temp.sm(pg_temp.rpc('with u as (update public.order_template_dispatches set status = ''sent'', wamid = ''w9'' where request_key = ''d-1'' returning 1) select jsonb_build_object(''ok'', true) from u')), 'ERR:22023:illegal dispatch status transition uncertain -> sent');
  UPDATE order_template_dispatches SET status = 'failed', resolution = 'confirmed_not_sent', resolved_by = pg_temp.uid('sup'), resolved_at = now() WHERE request_key = 'd-1';
  PERFORM pg_temp.expect('failed -> claimed is the retry (attempt + 1) and only that', pg_temp.sm(pg_temp.rpc('with u as (update public.order_template_dispatches set status = ''claimed'' where request_key = ''d-1'' returning 1) select jsonb_build_object(''ok'', true) from u')), 'ERR:22023:illegal dispatch status transition failed -> claimed');
  UPDATE order_template_dispatches SET status = 'claimed', attempt = attempt + 1 WHERE request_key = 'd-1';
  UPDATE order_template_dispatches SET status = 'sending', sending_at = now() WHERE request_key = 'd-1';
  UPDATE order_template_dispatches SET status = 'sent', wamid = 'wamid.test1', finished_at = now() WHERE request_key = 'd-1';
  PERFORM pg_temp.expect('sent is final and the wamid is unique', pg_temp.sm(pg_temp.rpc('with u as (update public.order_template_dispatches set error_code = ''x'' where request_key = ''d-1'' returning 1) select jsonb_build_object(''ok'', true) from u')), 'ERR:42501:a sent dispatch is final');
  PERFORM pg_temp.expect('attempt count kept across the retry', (SELECT attempt::text || '/' || status FROM order_template_dispatches WHERE request_key = 'd-1'), '2/sent');

  -- settings
  PERFORM pg_temp.expect('settings: template name and language go together', pg_temp.sm(pg_temp.rpc(format('with i as (insert into public.order_logistics_settings (account_id, packaging_template_name) values (%L,''t'') returning 1) select jsonb_build_object(''ok'', true) from i', pg_temp.uid('acc')))) LIKE 'ERR:23514%', 'true');
  INSERT INTO order_logistics_settings (account_id, packaging_template_name, packaging_template_language, packaging_template_params) VALUES (pg_temp.uid('acc'), 'tpl_test', 'es', '["customer_name","product"]');
  PERFORM pg_temp.expect('settings readable by logistics only (and only of its account)', pg_temp.run('logi', 'select count(*) from public.order_logistics_settings') || '/' || pg_temp.run('comm', 'select count(*) from public.order_logistics_settings') || '/' || pg_temp.run('foreign', 'select count(*) from public.order_logistics_settings'), '1/0/0');

  -- ================= MULTIPRODUCT: still ONE logistic row / voucher per order =================
  PERFORM pg_temp.expect('multiproduct order created by the real function', (SELECT count(*)::text FROM public.create_order_confirmation(
    pg_temp.uid('acc'), pg_temp.uid('contact_c3'), pg_temp.uid('conv_c3'), pg_temp.uid('comm'), 'Comercial QA', 'olg-multi', pg_temp.uid('comm'),
    jsonb_build_object('customer_name', 'OLG multi', 'phone', '900000005', 'product', E'1 x A\n2 x B', 'quantity', '3', 'price', '20.00', 'destination', 'Lima',
      'items', jsonb_build_array(jsonb_build_object('product_name', 'A', 'quantity', '1', 'unit_price', '10.00'), jsonb_build_object('product_name', 'B', 'quantity', '2', 'unit_price', '5.00'))))), '1');
  INSERT INTO ids SELECT 'omulti', id FROM order_confirmations WHERE request_key = 'olg-multi';
  PERFORM pg_temp.expect('the multiproduct order has 2 items', (SELECT count(*)::text FROM order_confirmation_items WHERE order_id = pg_temp.uid('omulti')), '2');
  PERFORM pg_temp.expect('voucher + validation + packaging on a multiproduct order: one document, one logistic row (no per-item structure)',
    pg_temp.sm(pg_temp.reg('logi', 'acc', 'omulti', 'km', 'seed-multi')) || '/' || pg_temp.sm(pg_temp.review('logi', 'km', 'validate', '{"dni":"1"}'))
    || '/' || pg_temp.sm(pg_temp.rpc(format('select public.start_order_packaging(%L,%L,%L)', pg_temp.uid('acc'), pg_temp.uid('logi'), pg_temp.uid('omulti'))))
    || '/' || pg_temp.cnt('order_documents WHERE order_id = ' || quote_literal(pg_temp.uid('omulti'))) || '/' || pg_temp.cnt('order_logistics WHERE order_id = ' || quote_literal(pg_temp.uid('omulti'))),
    'ok:created=true/ok:changed=true/ok:changed=true/1/1');
  PERFORM pg_temp.expect('PR-03 routing is untouched by PR-04 (order confirmation still routes the chat to logistics)', (SELECT stage FROM conversation_routing WHERE conversation_id = pg_temp.uid('conv_c3')), 'logistics');

  -- ================= FLAG OFF ACCOUNT: PR-04 leaves it exactly as before =================
  UPDATE order_integration_settings SET logistics_mvp_enabled = FALSE WHERE account_id = pg_temp.uid('acc_f');
  PERFORM pg_temp.expect('flag-OFF account: the real order flow still works', (SELECT count(*)::text FROM public.create_order_confirmation(
    pg_temp.uid('acc_f'), pg_temp.uid('contact_cf'), pg_temp.uid('conv_cf'), pg_temp.uid('foreign'), 'Foreign QA', 'olg-off', pg_temp.uid('foreign'),
    jsonb_build_object('customer_name', 'OLG off', 'phone', '900000006', 'product', 'Prod', 'quantity', '1', 'price', '10.00', 'destination', 'Lima'))), '1');
  PERFORM pg_temp.expect('flag-OFF account: PR-04 writes NOTHING (no row, no document, no dispatch, no event) and refuses operations', (
    SELECT (SELECT count(*) FROM order_logistics WHERE account_id = pg_temp.uid('acc_f')) + (SELECT count(*) FROM order_documents WHERE account_id = pg_temp.uid('acc_f'))
         + (SELECT count(*) FROM order_template_dispatches WHERE account_id = pg_temp.uid('acc_f')) + (SELECT count(*) FROM order_logistics_events WHERE account_id = pg_temp.uid('acc_f')))::text
    || '/' || pg_temp.sm(pg_temp.reg('foreign', 'acc_f', 'of', 'kf-off', 'seed-foreign-off')), '0/ERR:42501:feature_disabled');
  UPDATE order_integration_settings SET logistics_mvp_enabled = TRUE WHERE account_id = pg_temp.uid('acc_f');
  PERFORM pg_temp.expect('the foreign account (flag ON) can operate its own order and sees only its own data',
    pg_temp.sm(pg_temp.reg('foreign', 'acc_f', 'of', 'kf', 'seed-foreign')) || '/' || pg_temp.run('foreign', 'select count(*) from public.order_documents') || '/' || pg_temp.run('logi', 'select count(*) from public.order_documents where request_key = ''kf'''), 'ok:created=true/1/0');

  -- ================= CASCADE: deleting an order removes its PR-04 rows (the only way history disappears) =================
  INSERT INTO ids SELECT 'ocasc', gen_random_uuid();
  INSERT INTO order_confirmations (id, account_id, customer_name, phone, product, quantity, price, destination, seller_name, confirmed_by_name, request_key, delivery_status)
    VALUES (pg_temp.uid('ocasc'), pg_temp.uid('acc'), 'OLG cascade', '900000007', 'Prod', 1, 10, 'Lima', 'Seller', 'Seller', 'OLG-ocasc', 'held');
  PERFORM pg_temp.expect('cascade fixture: voucher validated on a throwaway order', pg_temp.sm(pg_temp.reg('logi', 'acc', 'ocasc', 'kc', 'seed-casc')) || '/' || pg_temp.sm(pg_temp.review('logi', 'kc', 'validate', '{"dni":"1"}')), 'ok:created=true/ok:changed=true');
  PERFORM pg_temp.expect('order delete cascades documents / logistics / events (history goes with its order only)', (
    SELECT pg_temp.sm(pg_temp.rpc(format('with d as (delete from public.order_confirmations where id = %L returning 1) select jsonb_build_object(''ok'', true) from d', pg_temp.uid('ocasc'))))
    || '/' || pg_temp.cnt('order_documents WHERE order_id = ' || quote_literal(pg_temp.uid('ocasc'))) || '/' || pg_temp.cnt('order_logistics WHERE order_id = ' || quote_literal(pg_temp.uid('ocasc')))
    || '/' || pg_temp.cnt('order_logistics_events WHERE order_id = ' || quote_literal(pg_temp.uid('ocasc')))), 'ok/0/0/0');
END $$;

-- ================= EVIDENCE FROM THE ORDER'S CHAT (select_order_evidence) =================
CREATE FUNCTION pg_temp.evsel(p_actor text, p_acc text, p_order text, p_msg text, p_key text, p_seed text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE d uuid := gen_random_uuid();
BEGIN
  RETURN pg_temp.rpc(format('select public.select_order_evidence(%L,%L,%L,%L,%L,%L,%L,%L,%L,%s,%L)',
    pg_temp.uid(p_acc), pg_temp.uid(p_actor), pg_temp.uid(p_order), pg_temp.uid(p_msg), d, p_key,
    'account-' || pg_temp.uid(p_acc) || '/orders/' || p_order || '/evidence/' || d || '/e.jpg', 'e.jpg', 'image/jpeg', 2048, pg_temp.h(p_seed)));
END $$;

DO $$
BEGIN
  -- new chat media: m3 lives in c1 (order o1's conversation, NOT o2's), m2b in c2 (o2's conversation)
  INSERT INTO ids SELECT 'm3', gen_random_uuid();
  INSERT INTO ids SELECT 'm2b', gen_random_uuid();
  INSERT INTO messages (id, conversation_id, sender_type, content_type, media_url) VALUES
    (pg_temp.uid('m3'), pg_temp.uid('conv_c1'), 'customer', 'image', 'https://example.invalid/m3.jpg'),
    (pg_temp.uid('m2b'), pg_temp.uid('conv_c2'), 'customer', 'image', 'https://example.invalid/m2b.jpg');

  PERFORM pg_temp.expect('evidence RPC is service-role only',
    (has_function_privilege('authenticated', 'public.select_order_evidence(uuid,uuid,uuid,uuid,uuid,text,text,text,text,bigint,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.select_order_evidence(uuid,uuid,uuid,uuid,uuid,text,text,text,text,bigint,text)', 'EXECUTE'))::text
    || '/' || has_function_privilege('service_role', 'public.select_order_evidence(uuid,uuid,uuid,uuid,uuid,text,text,text,text,bigint,text)', 'EXECUTE')::text, 'false/true');

  PERFORM pg_temp.expect('evidence: commercial / viewer / no-area / other-account actors are refused',
    pg_temp.sm(pg_temp.evsel('comm', 'acc', 'o2', 'm2', 'ev-k-comm', 'e0')) || '/' || pg_temp.sm(pg_temp.evsel('logiv', 'acc', 'o2', 'm2', 'ev-k-viewer', 'e0'))
    || '/' || pg_temp.sm(pg_temp.evsel('none', 'acc', 'o2', 'm2', 'ev-k-none', 'e0')) || '/' || pg_temp.sm(pg_temp.evsel('foreign', 'acc', 'o2', 'm2', 'ev-k-foreign', 'e0')),
    'ERR:42501:forbidden/ERR:42501:forbidden/ERR:42501:forbidden/ERR:42501:forbidden');
  PERFORM pg_temp.expect('evidence: an order of another account is indistinguishable from a non-existent one', pg_temp.sm(pg_temp.evsel('logi', 'acc', 'of', 'mf', 'ev-k-xacc', 'e0')), 'ERR:42501:forbidden');
  PERFORM pg_temp.expect('evidence needs a PACKING order (pending_voucher / no row is refused)', pg_temp.sm(pg_temp.evsel('logi', 'acc', 'o3', 'm2', 'ev-k-np', 'e0')), 'no:not_packing');

  PERFORM pg_temp.expect('a message of ANOTHER conversation of the same account is refused', pg_temp.sm(pg_temp.evsel('logi', 'acc', 'o2', 'm3', 'ev-k-wc', 'e1')), 'no:message_not_in_conversation');
  PERFORM pg_temp.expect('a message of ANOTHER ACCOUNT is refused', pg_temp.sm(pg_temp.evsel('logi', 'acc', 'o2', 'mf', 'ev-k-wa', 'e2')), 'no:message_not_in_conversation');
  PERFORM pg_temp.expect('a message that does not exist is refused', pg_temp.sm(pg_temp.rpc(format('select public.select_order_evidence(%L,%L,%L,%L,%L,%L,%L,%L,%L,10,%L)',
    pg_temp.uid('acc'), pg_temp.uid('logi'), pg_temp.uid('o2'), gen_random_uuid(), gen_random_uuid(), 'ev-k-ghost', 'account-' || pg_temp.uid('acc') || '/x', 'e.jpg', 'image/jpeg', pg_temp.h('e3')))), 'no:message_not_in_conversation');
  PERFORM pg_temp.expect('refusals wrote nothing', pg_temp.cnt('order_documents WHERE order_id = ' || quote_literal(pg_temp.uid('o2')) || ' AND kind = ''evidence'''), '0');

  PERFORM pg_temp.expect('select evidence from the order chat (packing order)', pg_temp.sm(pg_temp.evsel('logi', 'acc', 'o2', 'm2', 'ev-k-1', 'ev-seed-1')), 'ok:created=true');
  PERFORM pg_temp.expect('snapshot row: evidence / chat_message / direct / active, tied to the message and to the order',
    pg_temp.drow('ev-k-1', 'kind') || '/' || pg_temp.drow('ev-k-1', 'source') || '/' || pg_temp.drow('ev-k-1', 'association') || '/' || pg_temp.drow('ev-k-1', 'status')
    || '/' || (pg_temp.drow('ev-k-1', 'source_message_id') = pg_temp.uid('m2')::text)::text || '/' || (pg_temp.drow('ev-k-1', 'order_id') = pg_temp.uid('o2')::text)::text, 'evidence/chat_message/direct/active/true/true');
  PERFORM pg_temp.expect('the order points at its evidence', (pg_temp.lrow('o2', 'evidence_document_id') = pg_temp.docid('ev-k-1')::text)::text, 'true');
  PERFORM pg_temp.expect('same request_key + same content = idempotent replay', pg_temp.sm(pg_temp.evsel('logi', 'acc', 'o2', 'm2', 'ev-k-1', 'ev-seed-1')) || '/' || pg_temp.cnt('order_documents WHERE order_id = ' || quote_literal(pg_temp.uid('o2')) || ' AND kind = ''evidence'''), 'ok:created=false/1');
  PERFORM pg_temp.expect('same request_key + DIFFERENT content is refused', pg_temp.sm(pg_temp.evsel('logi', 'acc', 'o2', 'm2', 'ev-k-1', 'other')), 'ERR:22023:request_key_conflict');
  PERFORM pg_temp.expect('selecting the SAME message again (new key) changes nothing', pg_temp.sm(pg_temp.evsel('sup', 'acc', 'o2', 'm2', 'ev-k-2', 'ev-seed-1b')) || '/' || pg_temp.cnt('order_documents WHERE order_id = ' || quote_literal(pg_temp.uid('o2')) || ' AND kind = ''evidence'''), 'ok:created=false/1');
  PERFORM pg_temp.expect('a DIFFERENT message supersedes the previous evidence (kept) and repoints the order', pg_temp.sm(pg_temp.evsel('logi', 'acc', 'o2', 'm2b', 'ev-k-3', 'ev-seed-3'))
    || '/' || pg_temp.drow('ev-k-1', 'status') || '/' || pg_temp.drow('ev-k-3', 'status') || '/' || (pg_temp.lrow('o2', 'evidence_document_id') = pg_temp.docid('ev-k-3')::text)::text
    || '/' || pg_temp.cnt('order_documents WHERE order_id = ' || quote_literal(pg_temp.uid('o2')) || ' AND kind = ''evidence'' AND status = ''active'''), 'ok:created=true/superseded/active/true/1');
  PERFORM pg_temp.expect('evidence audit keeps ids only (no media url / content)', pg_temp.ev('order_id = ' || quote_literal(pg_temp.uid('o2')) || ' AND event_type = ''evidence_selected'''), 'evidence_selected,evidence_selected');
  PERFORM pg_temp.expect('evidence audit detail carries the message id, never the media url',
    (SELECT bool_and(detail ? 'message_id' AND detail::text NOT LIKE '%example.invalid%')::text FROM order_logistics_events WHERE event_type = 'evidence_selected' AND order_id = pg_temp.uid('o2')), 'true');
  PERFORM pg_temp.expect('the evidence of one order can never be reused by another order (guard)', pg_temp.sm(pg_temp.rpc(format('with u as (update public.order_logistics set evidence_document_id = %L, version = version + 1 where order_id = %L returning 1) select jsonb_build_object(''ok'', true) from u', pg_temp.docid('ev-k-3'), pg_temp.uid('omulti')))), 'ERR:42501:evidence does not belong to the order');

  -- an open dispatch freezes the evidence it is using
  INSERT INTO ids SELECT 'ev3', id FROM order_documents WHERE request_key = 'ev-k-3';
  INSERT INTO order_template_dispatches (account_id, order_id, request_key, evidence_document_id, conversation_id, template_name, template_language, actor_user_id)
    VALUES (pg_temp.uid('acc'), pg_temp.uid('o2'), 'dsp-o2', pg_temp.uid('ev3'), pg_temp.uid('conv_c2'), 't', 'es', pg_temp.uid('logi'));
  PERFORM pg_temp.expect('with an open dispatch the evidence can not change underneath it', pg_temp.sm(pg_temp.evsel('logi', 'acc', 'o2', 'm2', 'ev-k-4', 'ev-seed-4')), 'no:dispatch_open');

  UPDATE order_integration_settings SET logistics_mvp_enabled = FALSE WHERE account_id = pg_temp.uid('acc');
  PERFORM pg_temp.expect('flag OFF: the evidence RPC refuses', pg_temp.sm(pg_temp.evsel('logi', 'acc', 'o2', 'm2b', 'ev-k-off', 'ev-seed-off')), 'ERR:42501:feature_disabled');
  UPDATE order_integration_settings SET logistics_mvp_enabled = TRUE WHERE account_id = pg_temp.uid('acc');
END $$;

ROLLBACK;
