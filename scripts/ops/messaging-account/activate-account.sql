-- ACTIVATE an account prepared by connect-account.sql, AFTER the (separately authorised) Meta subscription of the app to its messaging account
-- succeeded and the inbound test passed. It only records the fact in WACRM: status 'connected', connected_at and subscribed_apps_at. It does NOT
-- call Meta. Refuses unless the row is exactly a prepared one.
--
--   psql -v ON_ERROR_STOP=1 -v account_id=... -v phone_number_id=... -v messaging_account_id=... -v confirm_subscribed=yes -f activate-account.sql
-- Undo (back to prepared): the matching UPDATE is in the runbook; or disconnect-account.sql after unsubscribing on Meta.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SELECT set_config('wa.account', :'account_id', true), set_config('wa.pn', :'phone_number_id', true), set_config('wa.ma', :'messaging_account_id', true),
       set_config('wa.ack', :'confirm_subscribed', true) \gset
LOCK TABLE public.whatsapp_config IN SHARE ROW EXCLUSIVE MODE;
CREATE TEMP TABLE _wa_before ON COMMIT DROP AS SELECT id, md5(to_jsonb(w)::text) h FROM public.whatsapp_config w;
DO $$
DECLARE n int; r public.whatsapp_config%ROWTYPE;
BEGIN
  IF current_setting('wa.ack') <> 'yes' THEN RAISE EXCEPTION 'guard: confirm_subscribed=yes is required (subscribe the app on Meta and pass the inbound test first)'; END IF;
  SELECT * INTO r FROM public.whatsapp_config WHERE account_id = current_setting('wa.account')::uuid FOR UPDATE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'guard: the account has no configuration'; END IF;
  IF r.phone_number_id <> current_setting('wa.pn') OR r.messaging_account_id IS DISTINCT FROM current_setting('wa.ma') THEN RAISE EXCEPTION 'guard: the configuration is not the one this procedure created'; END IF;
  IF r.status <> 'disconnected' OR r.subscribed_apps_at IS NOT NULL OR r.registered_at IS NOT NULL THEN RAISE EXCEPTION 'guard: the configuration is not in the prepared state'; END IF;
  UPDATE public.whatsapp_config SET status = 'connected', connected_at = now(), subscribed_apps_at = now() WHERE id = r.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'expected exactly 1 row updated, got %', n; END IF;
  SELECT count(*) INTO n FROM public.whatsapp_config w JOIN _wa_before b USING (id) WHERE w.id <> r.id AND md5(to_jsonb(w)::text) <> b.h;
  IF n <> 0 THEN RAISE EXCEPTION 'guard: another configuration changed'; END IF;
  RAISE NOTICE 'ACTIVATED_1_ROW';
END $$;
COMMIT;
